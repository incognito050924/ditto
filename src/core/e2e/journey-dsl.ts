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
 * plus STRUCTURE from the body. DESIGN BOUNDARY: the machine extracts structure
 * only — step ids, `블록:` call targets, `## 케이스` table case names — and
 * never interprets step semantics (verbs/objects stay human-read). The
 * structural set was widened from "step ids only" by dialectic-1 (wi_260611uzs
 * O-13/O-14): gates need block-call and case-name existence checks, which are
 * id-level facts, not semantics.
 */

export type ParsedDoc<F> = { ok: true; frontMatter: F; stepIds: string[] } | ParseFailure;
export interface ParseFailure {
  ok: false;
  error: string;
}

/** Step line shape: `N. [s<번호>] …` (journeys) / `N. [b<번호>] …` (blocks). */
const stepLine = /^\s*\d+\.\s+\[([sb]\d+)\]/;

/** Step line invoking a reusable block: `N. [sN] (조건)? 블록: <block-id> …`. */
const blockCallLine = /^\s*\d+\.\s+\[[sb]\d+\]\s*(?:\([^)]*\)\s*)?블록:\s*([^\s(]+)/;

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

/** Extract the block ids invoked by `블록:` step lines, in body order. */
export function extractBlockCalls(body: string): string[] {
  const ids: string[] = [];
  for (const line of body.split('\n')) {
    const m = blockCallLine.exec(line);
    if (m?.[1]) ids.push(m[1]);
  }
  return ids;
}

/**
 * Extract the case names (first table column) declared under the `## 케이스`
 * heading. Header and separator rows are skipped; the table ends at the next
 * heading. No table → empty list.
 */
export function extractCaseNames(body: string): string[] {
  const lines = body.split('\n');
  const start = lines.findIndex((l) => /^##\s*케이스\s*$/.test(l.trim()));
  if (start < 0) return [];
  const names: string[] = [];
  let sawHeader = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (line.startsWith('#')) break;
    if (!line.startsWith('|')) {
      if (names.length > 0 || sawHeader) break;
      if (line === '') continue;
      break;
    }
    if (/^\|[\s\-:|]+\|?$/.test(line)) continue; // separator row
    if (!sawHeader) {
      sawHeader = true; // first table row is the column header
      continue;
    }
    const first = line.split('|')[1]?.trim();
    if (first !== undefined && first !== '') names.push(first);
  }
  return names;
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
  const stepIds = extractStepIds(split.body);
  // O-5: duplicate step ids would silently merge two distinct steps into one
  // traceability ref (one marker satisfies both) — refuse at parse time.
  const seen = new Set<string>();
  for (const id of stepIds) {
    if (seen.has(id)) {
      return { ok: false, error: `duplicate step id [${id}] — step ids must be unique` };
    }
    seen.add(id);
  }
  return { ok: true, frontMatter: parsed.data, stepIds };
}

/** Parse an `e2e/journeys/<slug>.journey.md` document. */
export function parseJourneyDoc(text: string): ParsedDoc<JourneyFrontMatter> {
  return parseDoc(text, journeyFrontMatter);
}

/** Parse an `e2e/journeys/blocks/<block-id>.block.md` document. */
export function parseBlockDoc(text: string): ParsedDoc<BlockFrontMatter> {
  return parseDoc(text, blockFrontMatter);
}
