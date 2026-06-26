import { copyFile } from 'node:fs/promises';
import { atomicWriteText } from './fs';
import { MANAGED_END, normalizeInstructionText, normalizedSha256 } from './instruction-bridge';

/**
 * Managed-block merge core. Pure string transforms plus thin fs helpers that
 * ditto setup/teardown build on. Markers reuse instruction-bridge's
 * `<!-- ditto:managed:start source=<name> sha256=<hex> -->` … `<!-- ditto:managed:end -->`
 * convention so blocks round-trip with the instruction-bridge reader.
 */

const START_RE_G = /<!--\s*ditto:managed:start\s+source=[^\s]+\s+sha256=[a-f0-9]{64}\s*-->/g;
const END_RE_G = /<!--\s*ditto:managed:end\s*-->/g;

/** Result of a managed-block transform: success, or corruption with the original kept intact. */
export type ManagedResult =
  | { kind: 'ok'; content: string }
  | { kind: 'corrupted'; original: string };

interface BlockBounds {
  start: number;
  end: number;
}

/**
 * Locate exactly one well-formed managed block. Returns its bounds, `null` when
 * there is no block, or `'corrupted'` when markers are unbalanced/malformed
 * (multiple starts, start without end, or end before start).
 */
function locateBlock(content: string): BlockBounds | null | 'corrupted' {
  const starts = [...content.matchAll(START_RE_G)];
  const ends = [...content.matchAll(END_RE_G)];
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length !== 1 || ends.length !== 1) return 'corrupted';
  const startMatch = starts[0];
  const endMatch = ends[0];
  if (startMatch?.index === undefined || endMatch?.index === undefined) return 'corrupted';
  if (endMatch.index < startMatch.index) return 'corrupted';
  return { start: startMatch.index, end: endMatch.index + endMatch[0].length };
}

/**
 * Locate the span to REPLACE on upsert. Like locateBlock for a single block, but
 * collapses several stacked/nested ditto blocks into one span [first start, last
 * end]. ditto never writes more than one block on purpose, so multiple blocks are
 * the residue of a past double-wrap (e.g. a global CLAUDE.md whose projection
 * re-wrapped an already-wrapped AGENTS.md) — safe to replace as a single unit on
 * the next write. Only used by upsert (the WRITE path); strip/teardown keeps the
 * strict single-block `locateBlock` so REMOVAL never destroys content that might
 * sit between two blocks.
 */
function locateManagedSpan(content: string): BlockBounds | null | 'corrupted' {
  const starts = [...content.matchAll(START_RE_G)];
  const ends = [...content.matchAll(END_RE_G)];
  if (starts.length === 0 && ends.length === 0) return null;
  // A marker missing its pair is genuinely malformed — preserve the file untouched.
  if (starts.length !== ends.length) return 'corrupted';
  const firstStart = starts[0];
  const lastEnd = ends[ends.length - 1];
  if (firstStart?.index === undefined || lastEnd?.index === undefined) return 'corrupted';
  // Reject a stray end before the first start, or a stray start after the last end.
  if ((ends[0]?.index ?? -1) < firstStart.index) return 'corrupted';
  const lastStart = starts[starts.length - 1];
  if ((lastStart?.index ?? -1) > lastEnd.index) return 'corrupted';
  return { start: firstStart.index, end: lastEnd.index + lastEnd[0].length };
}

/** Build the managed block text for `managedBody`, sourced from `source` (default AGENTS.md). */
export function buildManagedBlock(managedBody: string, source = 'AGENTS.md'): string {
  const body = normalizeInstructionText(managedBody);
  const sha256 = normalizedSha256(managedBody);
  // Guarantee exactly one newline between the body and the end marker so
  // MANAGED_END always sits on its own line, even when the body lacks a
  // trailing newline.
  const bodyWithBreak = body.endsWith('\n') ? body : `${body}\n`;
  return `<!-- ditto:managed:start source=${source} sha256=${sha256} -->\n${bodyWithBreak}${MANAGED_END}`;
}

/**
 * Insert or replace the ditto-managed block, preserving all content outside it
 * verbatim. Returns `corrupted` (original kept) on unbalanced markers.
 */
export function upsertManagedBlock(
  originalContent: string,
  managedBody: string,
  source = 'AGENTS.md',
): ManagedResult {
  const block = buildManagedBlock(managedBody, source);
  const bounds = locateManagedSpan(originalContent);
  if (bounds === 'corrupted') return { kind: 'corrupted', original: originalContent };
  if (bounds === null) {
    if (originalContent.length === 0) return { kind: 'ok', content: `${block}\n` };
    const separator = originalContent.endsWith('\n') ? '\n' : '\n\n';
    return { kind: 'ok', content: `${originalContent}${separator}${block}\n` };
  }
  const next = `${originalContent.slice(0, bounds.start)}${block}${originalContent.slice(bounds.end)}`;
  return { kind: 'ok', content: next };
}

/**
 * Remove the ditto-managed block entirely (teardown semantics A: strip-only),
 * preserving everything outside. Returns `corrupted` (original kept) on
 * unbalanced markers; never restores from backup.
 */
export function stripManagedBlock(content: string): ManagedResult {
  const bounds = locateBlock(content);
  if (bounds === 'corrupted') return { kind: 'corrupted', original: content };
  if (bounds === null) return { kind: 'ok', content };
  const before = content.slice(0, bounds.start);
  const after = content.slice(bounds.end);
  // Collapse only the blank-line run AT THE SEAM created by removing the block
  // (trailing newlines of `before` + leading newlines of `after`), leaving the
  // user's whitespace elsewhere untouched. A run of 3+ newlines straddling the
  // seam becomes a single blank line (\n\n).
  const beforeTail = before.match(/\n*$/)?.[0] ?? '';
  const afterHead = after.match(/^\n*/)?.[0] ?? '';
  let seam = beforeTail + afterHead;
  if (seam.length >= 3) seam = '\n\n';
  const next =
    before.slice(0, before.length - beforeTail.length) + seam + after.slice(afterHead.length);
  return { kind: 'ok', content: next };
}

/** A line that is exactly a ditto managed marker (start or end), modulo surrounding whitespace. */
const MARKER_LINE_RE =
  /^\s*<!--\s*ditto:managed:(?:start\s+source=[^\s]+\s+sha256=[a-f0-9]{64}|end)\s*-->\s*$/;

/**
 * Strip every ditto-managed marker line, keeping the wrapped body and all other
 * content. Heals a file that must be RAW (the canonical global AGENTS.md source)
 * but that an older version wrapped in a managed block — which then made the
 * sibling CLAUDE.md projection double-wrap. Returns the content unchanged when
 * there are no managed marker lines.
 */
export function unwrapManagedBlock(content: string): string {
  const lines = content.split('\n');
  const kept = lines.filter((line) => !MARKER_LINE_RE.test(line));
  if (kept.length === lines.length) return content;
  return kept.join('\n');
}

const BACKUP_SUFFIX = '.ditto_bak';

/**
 * Copy `targetPath` to `targetPath + '.ditto_bak'` only if the backup does not
 * already exist (idempotent — keeps the FIRST original). Returns the backup
 * path when written, or `null` if the target is missing or already backed up.
 */
export async function writeBackupOnce(targetPath: string): Promise<string | null> {
  const bakPath = `${targetPath}${BACKUP_SUFFIX}`;
  if (await Bun.file(bakPath).exists()) return null;
  if (!(await Bun.file(targetPath).exists())) return null;
  await copyFile(targetPath, bakPath);
  return bakPath;
}

/** Result of applying a managed file: success with the backup made, or corruption. */
export type ApplyManagedResult =
  | { kind: 'ok'; path: string; backupPath: string | null }
  | { kind: 'corrupted'; path: string };

/**
 * Back up `targetPath` once, upsert the managed block into its content, and
 * atomically write the result. Refuses to write (preserving the file) when the
 * existing content has unbalanced markers.
 */
export async function applyManagedFile(
  targetPath: string,
  managedBody: string,
  source = 'AGENTS.md',
): Promise<ApplyManagedResult> {
  const exists = await Bun.file(targetPath).exists();
  const current = exists ? await Bun.file(targetPath).text() : '';
  const merged = upsertManagedBlock(current, managedBody, source);
  if (merged.kind === 'corrupted') return { kind: 'corrupted', path: targetPath };
  const backupPath = await writeBackupOnce(targetPath);
  await atomicWriteText(targetPath, merged.content);
  return { kind: 'ok', path: targetPath, backupPath };
}
