import {
  type BlockFrontMatter,
  type JourneyFrontMatter,
  blockFrontMatter,
  journeyFrontMatter,
} from '~/schemas/journey-dsl';
import { parseYaml } from '../hosts/shared';

/**
 * Journey DSL v1 file parser (wi_260610p9h). Reads `*.journey.md` / `*.block.md`
 * documents: YAML front-matter (validated through the zod schemas — ADR-0002)
 * plus the step-id set from the body. DESIGN BOUNDARY: the machine extracts step
 * ids ONLY — it never interprets body semantics (verbs/objects stay human-read).
 */

export type ParsedDoc<F> = { ok: true; frontMatter: F; stepIds: string[] } | ParseFailure;
export interface ParseFailure {
  ok: false;
  error: string;
}

/** Step line shape: `N. [s<번호>] …` (journeys) / `N. [b<번호>] …` (blocks). */
const stepLine = /^\s*\d+\.\s+\[([sb]\d+)\]/;

/** Generated-spec marker: `// @step <journey-id|block-id>/<step-id> <DSL 원문>`. */
const stepMarker = /^\s*\/\/\s*@step\s+(\S+\/[sb]\d+)\b/;

/**
 * Split a markdown document into its leading `---`…`---` front-matter block and
 * the remaining body. Returns null when the fences are absent.
 */
export function splitFrontMatter(text: string): { frontMatter: string; body: string } | null {
  const lines = text.split('\n');
  if ((lines[0] ?? '').trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === '---') {
      return { frontMatter: lines.slice(1, i).join('\n'), body: lines.slice(i + 1).join('\n') };
    }
  }
  return null;
}

/** Extract the ordered step-id list (`[sN]`/`[bN]`) from a DSL body. */
export function extractStepIds(body: string): string[] {
  const ids: string[] = [];
  for (const line of body.split('\n')) {
    const m = stepLine.exec(line);
    if (m?.[1]) ids.push(m[1]);
  }
  return ids;
}

/** Extract `<owner-id>/<step-id>` refs from `// @step` markers in a generated spec. */
export function extractStepMarkers(generated: string): string[] {
  const refs: string[] = [];
  for (const line of generated.split('\n')) {
    const m = stepMarker.exec(line);
    if (m?.[1]) refs.push(m[1]);
  }
  return refs;
}

function parseDoc<F>(
  text: string,
  schema: {
    safeParse: (
      v: unknown,
    ) => { success: true; data: F } | { success: false; error: { message: string } };
  },
): ParsedDoc<F> {
  const split = splitFrontMatter(text);
  if (!split) return { ok: false, error: 'no leading ---…--- front-matter block' };
  let raw: unknown;
  try {
    raw = parseYaml(split.frontMatter);
  } catch (err) {
    return {
      ok: false,
      error: `front-matter YAML parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: parsed.error.message };
  return { ok: true, frontMatter: parsed.data, stepIds: extractStepIds(split.body) };
}

/** Parse an `e2e/journeys/<slug>.journey.md` document. */
export function parseJourneyDoc(text: string): ParsedDoc<JourneyFrontMatter> {
  return parseDoc(text, journeyFrontMatter);
}

/** Parse an `e2e/journeys/blocks/<block-id>.block.md` document. */
export function parseBlockDoc(text: string): ParsedDoc<BlockFrontMatter> {
  return parseDoc(text, blockFrontMatter);
}
