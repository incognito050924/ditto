import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ADR_ID_EXTRACT_RE, ADR_TITLE_PREFIX_RE } from '~/schemas/adr-id';
import { atomicWriteText } from './fs';
import type { AdrStatusAtHead } from './gates';
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

// Deliberately lenient (wi_260714aaq, #29): reads ONLY `entries[].forbidden_abbreviations`,
// ignoring every other field. A schema-version-skewed or otherwise-evolved glossary still
// yields its forbidden_abbreviations (tolerant read), so a version bump never silently drops
// the opaque-vocab signal.
const glossaryVocabSchema = z.object({
  entries: z
    .array(z.object({ forbidden_abbreviations: z.array(z.string()).default([]) }))
    .default([]),
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

/** Parsed `- 상태:` / `- status:` list line of an ADR body. */
export interface AdrStatusLine {
  /** Full status value text after the label (trimmed), e.g. `superseded by ADR-…`. */
  status: string;
  /** Successor ADR id when the value reads `superseded by <id>`. */
  supersededBy?: string;
}

// LINE-anchored status-line matchers (the `- 상태:` / `- status:` list line; the
// list dash is optional but the label must open its own line). Deliberately NOT a
// whole-body substring match: accepted ADR bodies legitimately contain the word
// 'superseded' (and even '상태:') in prose, and a substring match would let prose
// fake a supersede verdict. `상태:` wins; `status:` is the case-insensitive fallback.
const ADR_STATUS_LINE_KO_RE = /^\s*(?:[-*]\s+)?상태:\s*(.+)$/m;
const ADR_STATUS_LINE_EN_RE = /^\s*(?:[-*]\s+)?status:\s*(.+)$/im;

/**
 * Parse an ADR body's status LINE — the single shared parser for the knowledge
 * projection (`adrHeadline`) and the decision-conflict resolution verification
 * (`splitResolvedConflicts` consumers), so projection and gate can never disagree
 * about what an ADR's status is. Returns the full status value plus the successor
 * id extracted from a `superseded by <id>` value (ADR_ID_EXTRACT_RE prefix, so a
 * trailing annotation after the id is tolerated). null = no parseable status line.
 */
export function parseAdrStatusLine(body: string): AdrStatusLine | null {
  const value = body.match(ADR_STATUS_LINE_KO_RE)?.[1] ?? body.match(ADR_STATUS_LINE_EN_RE)?.[1];
  if (value === undefined) return null;
  const status = value.trim();
  if (status.length === 0) return null;
  const after = status.match(/superseded by\s+(.+)$/i)?.[1];
  const supersededBy = after?.match(ADR_ID_EXTRACT_RE)?.[0];
  return { status, ...(supersededBy !== undefined ? { supersededBy } : {}) };
}

const ADR_DIR_AT_HEAD = '.ditto/knowledge/adr';

/**
 * Read an ADR's status at the HEAD COMMIT (not the working tree — an uncommitted
 * local edit is never landed positive evidence). Lookup by id: a new-form id IS
 * its filename stem (`<id>.md`); a legacy `ADR-NNNN` resolves via the prefix glob
 * `ADR-NNNN-*.md` (trailing hyphen, so ADR-0016 never matches ADR-00160-*).
 * MULTIPLE matches fail closed as 'ambiguous' (never pick-first). argv-array git
 * (no shell interpolation), and EVERY throw — git absent, not a repo, unborn
 * HEAD, permissions — is contained and mapped to 'absent': a throw escaping into
 * the hook runtime catch-all would exit 0 = fail-OPEN, which is forbidden.
 */
export function readAdrStatusAtHead(repoRoot: string, adrId: string): AdrStatusAtHead {
  try {
    const listed = execFileSync(
      'git',
      ['ls-tree', '-r', '--name-only', 'HEAD', '--', ADR_DIR_AT_HEAD],
      { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const names = listed
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    const matches = names
      .filter((path) => {
        const name = path.slice(path.lastIndexOf('/') + 1);
        return name === `${adrId}.md` || (name.startsWith(`${adrId}-`) && name.endsWith('.md'));
      })
      .sort();
    const first = matches[0];
    if (first === undefined) return { status: 'absent' };
    if (matches.length > 1) return { status: 'ambiguous', matches };
    const body = execFileSync('git', ['show', `HEAD:${first}`], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = parseAdrStatusLine(body);
    if (parsed === null) return { status: 'malformed' };
    return {
      status: 'ok',
      adr_status: parsed.status,
      ...(parsed.supersededBy !== undefined ? { superseded_by: parsed.supersededBy } : {}),
    };
  } catch {
    // No git / not a repo / unborn HEAD / permissions — verification is impossible,
    // which the gate treats as fail-closed 'absent' (block stays), never a throw.
    return { status: 'absent' };
  }
}

function adrHeadline(filename: string, body: string): string {
  const id = filename.match(ADR_ID_EXTRACT_RE)?.[0] ?? filename;
  const titleLine = body.split('\n').find((l) => l.startsWith('# '));
  const title = titleLine ? titleLine.replace(/^#\s*/, '').trim() : '';
  // Same parser as the gate-side verification (parseAdrStatusLine) so projection
  // and gate agree; the headline keeps only the first token (`superseded`,
  // `accepted (…)` → `accepted`) exactly as the previous inline regex did.
  const status = parseAdrStatusLine(body)?.status.split(/\s+/)[0] ?? '';
  const parts = [id];
  if (status) parts.push(status);
  if (title) parts.push(title.replace(ADR_TITLE_PREFIX_RE, ''));
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

/**
 * Read the glossary's `forbidden_abbreviations` (the schema field designed to be REJECTED in
 * user-facing output — glossary.ts:30-33) as the caller-injected opaque-vocab set for the
 * question-face leak detector (wi_260714aaq, #29 — `findUnexplainedIdentifiers`'s injected
 * param). Shaped like {@link loadFarFieldTaxonomy} (coverage-taxonomy.ts): missing file → `[]`
 * (the detector's hardcoded OPAQUE_VOCAB_FLOOR still applies, so the effective vocab is
 * floor-only); `try/catch` + `safeParse`; on malformed → `onMalformed()` + `[]` — NO silent
 * zero-signal fail-open. This loader is FAIL-OPEN by construction (a bad glossary can never
 * crash the interview gate), unlike the unguarded `JSON.parse` in loadKnowledgeSources (:86).
 *
 * Only NON-EMPTY (trimmed) forbidden_abbreviations are returned. Glossary `aliases` and `term`s
 * are DELIBERATELY excluded (coverage OBJ-1): they include common words that would invert the
 * field contract and false-positive on ordinary prose.
 */
export async function loadGlossaryVocab(
  repoRoot: string,
  onMalformed?: () => void,
): Promise<string[]> {
  const file = Bun.file(join(repoRoot, KNOWLEDGE_DIR, 'glossary.json'));
  if (!(await file.exists())) return [];
  try {
    const parsed = glossaryVocabSchema.safeParse(JSON.parse(await file.text()));
    if (!parsed.success) {
      onMalformed?.();
      return [];
    }
    return parsed.data.entries
      .flatMap((e) => e.forbidden_abbreviations)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  } catch {
    onMalformed?.();
    return [];
  }
}

/**
 * Default `onMalformed` for {@link loadGlossaryVocab} (wi_260714aaq, #29 — the glossary twin of
 * {@link warnMalformedTaxonomy}): a malformed glossary fails open to the floor WITH a signal,
 * never silently, so a broken file does not look like it "did nothing".
 */
export function warnMalformedGlossary(repoRoot: string): void {
  console.warn(
    `ditto: malformed ${join(repoRoot, KNOWLEDGE_DIR, 'glossary.json')} — ignoring glossary-sourced opaque vocabulary and applying only the built-in floor (fix the file to re-enable it)`,
  );
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
