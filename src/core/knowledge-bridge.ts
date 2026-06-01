import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { atomicWriteText } from './fs';
import { normalizeInstructionText, normalizedSha256 } from './instruction-bridge';

/**
 * Knowledge projection (M6 runtime).
 *
 * The durable knowledge under `.ditto/knowledge/` (CONTEXT.md, glossary.json,
 * adr/*.md) is summarized into CLAUDE.md so the assistant carries it without
 * re-reading the bodies. This MUST use a SEPARATE marker family
 * (`ditto:knowledge:start/end`), NOT a second `ditto:managed` block: the
 * instruction bridge HARD-REFUSES more than one `ditto:managed` block
 * (instruction-bridge.ts), and CLAUDE.md already carries exactly one
 * `ditto:managed` block sourced from AGENTS.md.
 *
 * Form + drift only: this module asserts the projection is sha256-current with
 * its sources. Which terms are "agreed" (promotion judgment) stays with the
 * LLM KnowledgeCurator — no heuristic term extraction here.
 */

export const KNOWLEDGE_START_RE = /<!--\s*ditto:knowledge:start\s+sha256=([a-f0-9]{64})\s*-->/;
export const KNOWLEDGE_END = '<!-- ditto:knowledge:end -->';
const KNOWLEDGE_BLOCK_RE_G =
  /<!--\s*ditto:knowledge:start\s+sha256=([a-f0-9]{64})\s*-->\n?([\s\S]*?)<!--\s*ditto:knowledge:end\s*-->/g;

const glossarySummarySchema = z.object({
  entries: z.array(z.object({ term: z.string(), status: z.string().optional() })).default([]),
});

export interface KnowledgeSources {
  contextPath: string;
  glossaryPath: string;
  adrDir: string;
  /** Sorted ADR headline summaries (id · status · title). */
  adrHeadlines: string[];
  /** Sorted glossary term headlines. */
  termHeadlines: string[];
}

export type KnowledgeSyncAction =
  | 'created'
  | 'updated'
  | 'unchanged'
  | 'would-create'
  | 'would-update'
  | 'would-be-unchanged'
  | 'refused-multiple-markers';

export interface KnowledgeSyncResult {
  path: string;
  action: KnowledgeSyncAction;
  oldSha256: string | null;
  newSha256: string;
  message?: string;
}

const KNOWLEDGE_DIR = join('.ditto', 'knowledge');

function adrHeadline(filename: string, body: string): string {
  const id = filename.match(/ADR-\d{4}/)?.[0] ?? filename;
  const titleLine = body.split('\n').find((l) => l.startsWith('# '));
  const title = titleLine ? titleLine.replace(/^#\s*/, '').trim() : '';
  const status = body.match(/상태:\s*(\S+)/)?.[1] ?? body.match(/status:\s*(\S+)/i)?.[1] ?? '';
  const parts = [id];
  if (status) parts.push(status);
  if (title) parts.push(title.replace(/^ADR-\d{4}:\s*/, ''));
  return parts.join(' · ');
}

/**
 * Read the real `.ditto/knowledge` sources and build the summary inputs.
 * Bodies stay as path references; only headlines are summarized.
 */
export async function loadKnowledgeSources(repoRoot: string): Promise<KnowledgeSources> {
  const dir = join(repoRoot, KNOWLEDGE_DIR);
  const contextPath = join(KNOWLEDGE_DIR, 'CONTEXT.md');
  const glossaryPath = join(KNOWLEDGE_DIR, 'glossary.json');
  const adrDir = join(KNOWLEDGE_DIR, 'adr');

  let termHeadlines: string[] = [];
  const glossaryFile = Bun.file(join(dir, 'glossary.json'));
  if (await glossaryFile.exists()) {
    const parsed = glossarySummarySchema.safeParse(JSON.parse(await glossaryFile.text()));
    if (parsed.success) {
      termHeadlines = parsed.data.entries
        .map((e) => (e.status && e.status !== 'agreed' ? `${e.term} (${e.status})` : e.term))
        .sort();
    }
  }

  const adrHeadlines: string[] = [];
  const adrPath = join(dir, 'adr');
  let adrEntries: string[] = [];
  try {
    adrEntries = (await readdir(adrPath)).filter((f) => /^ADR-\d{4}.*\.md$/.test(f));
  } catch {
    adrEntries = [];
  }
  for (const rel of adrEntries) {
    const body = await Bun.file(join(adrPath, rel)).text();
    adrHeadlines.push(adrHeadline(rel, body));
  }
  adrHeadlines.sort();

  return { contextPath, glossaryPath, adrDir, adrHeadlines, termHeadlines };
}

/** Build the summary body (the text inside the managed block). */
export function renderKnowledgeSummary(sources: KnowledgeSources): string {
  const lines: string[] = [];
  lines.push('# DITTO Knowledge (projected — do not edit by hand)');
  lines.push('');
  lines.push(
    'Durable project knowledge. Bodies live under `.ditto/knowledge/`; this is a summary.',
  );
  lines.push('');
  lines.push(`- context: \`${sources.contextPath}\``);
  lines.push(`- glossary: \`${sources.glossaryPath}\``);
  lines.push(`- decisions: \`${sources.adrDir}/\``);
  lines.push('');
  lines.push('## Glossary terms');
  if (sources.termHeadlines.length === 0) lines.push('- (none)');
  for (const t of sources.termHeadlines) lines.push(`- ${t}`);
  lines.push('');
  lines.push('## Architecture decisions');
  if (sources.adrHeadlines.length === 0) lines.push('- (none)');
  for (const a of sources.adrHeadlines) lines.push(`- ${a}`);
  lines.push('');
  return normalizeInstructionText(lines.join('\n'));
}

/** sha256 of the normalized summary body — the drift key. */
export function knowledgeSummarySha256(summary: string): string {
  return normalizedSha256(summary);
}

function knowledgeBlock(summary: string, sha256: string): string {
  return `<!-- ditto:knowledge:start sha256=${sha256} -->\n${summary}\n${KNOWLEDGE_END}`;
}

interface KnowledgeProjection {
  kind: 'missing' | 'no_marker' | 'multiple_markers' | 'ok';
  content?: string;
  count?: number;
  markerSha256?: string;
  actualSha256?: string;
  startIndex?: number;
  endIndex?: number;
}

function loadKnowledgeProjection(content: string | null): KnowledgeProjection {
  if (content === null) return { kind: 'missing' };
  const matches = [...content.matchAll(KNOWLEDGE_BLOCK_RE_G)];
  if (matches.length === 0) return { kind: 'no_marker', content };
  if (matches.length > 1) return { kind: 'multiple_markers', content, count: matches.length };
  const match = matches[0];
  if (!match || match.index === undefined) return { kind: 'no_marker', content };
  const body = match[2] ?? '';
  return {
    kind: 'ok',
    content,
    markerSha256: match[1] ?? '',
    actualSha256: normalizedSha256(body),
    startIndex: match.index,
    endIndex: match.index + match[0].length,
  };
}

/**
 * Project the knowledge summary into CLAUDE.md under the `ditto:knowledge:*`
 * block. Appends below any existing content (e.g. the AGENTS.md `ditto:managed`
 * block), never touching the `ditto:managed` block. `check: true` is dry-run.
 */
export async function syncKnowledgeProjection(
  repoRoot: string,
  options: { check?: boolean } = {},
): Promise<KnowledgeSyncResult> {
  const sources = await loadKnowledgeSources(repoRoot);
  const summary = renderKnowledgeSummary(sources);
  const sha256 = knowledgeSummarySha256(summary);
  const block = knowledgeBlock(summary, sha256);
  const path = join(repoRoot, 'CLAUDE.md');
  const check = options.check === true;

  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : null;
  const projection = loadKnowledgeProjection(existing);

  if (projection.kind === 'missing') {
    if (!check) await atomicWriteText(path, `${block}\n`);
    return {
      path,
      action: check ? 'would-create' : 'created',
      oldSha256: null,
      newSha256: sha256,
      message: 'created new knowledge block',
    };
  }

  if (projection.kind === 'no_marker') {
    const base = projection.content ?? '';
    const separator = base.endsWith('\n') ? '\n' : '\n\n';
    const next = `${base}${separator}${block}\n`;
    if (!check) await atomicWriteText(path, next);
    return {
      path,
      action: check ? 'would-update' : 'updated',
      oldSha256: null,
      newSha256: sha256,
      message: 'appended new knowledge block',
    };
  }

  if (projection.kind === 'multiple_markers') {
    return {
      path,
      action: 'refused-multiple-markers',
      oldSha256: null,
      newSha256: sha256,
      message: `CLAUDE.md contains ${projection.count} ditto:knowledge blocks; clean up to exactly one before re-running`,
    };
  }

  const content = projection.content ?? '';
  const next = `${content.slice(0, projection.startIndex)}${block}${content.slice(projection.endIndex)}`;
  const unchanged = next === content;
  if (!unchanged && !check) await atomicWriteText(path, next);
  return {
    path,
    action: unchanged
      ? check
        ? 'would-be-unchanged'
        : 'unchanged'
      : check
        ? 'would-update'
        : 'updated',
    oldSha256: projection.markerSha256 ?? null,
    newSha256: sha256,
  };
}

/** True when CLAUDE.md's knowledge block sha256 matches the current sources (drift 0). */
export async function knowledgeProjectionDrift(repoRoot: string): Promise<number> {
  const result = await syncKnowledgeProjection(repoRoot, { check: true });
  return result.action === 'would-be-unchanged' ? 0 : 1;
}
