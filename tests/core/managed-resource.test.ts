import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MANAGED_END, MANAGED_START_RE, loadProjection } from '~/core/instruction-bridge';
import {
  applyManagedFile,
  buildManagedBlock,
  stripManagedBlock,
  unwrapManagedBlock,
  upsertManagedBlock,
  writeBackupOnce,
} from '~/core/managed-resource';

function countMarkers(text: string): number {
  const starts = (text.match(/ditto:managed:start/g) ?? []).length;
  const ends = (text.match(/ditto:managed:end/g) ?? []).length;
  return starts + ends;
}

describe('upsertManagedBlock', () => {
  test('inserts a managed block when none exists, preserving original content', () => {
    const original = 'free text before\n';
    const result = upsertManagedBlock(original, 'managed body');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.content).toContain('free text before');
    expect(MANAGED_START_RE.test(result.content)).toBe(true);
    expect(result.content).toContain(MANAGED_END);
    expect(result.content).toContain('managed body');
  });

  test('replaces an existing block, byte-preserving content before and after', () => {
    const original = 'free text before\n';
    const first = upsertManagedBlock(original, 'old body');
    expect(first.kind).toBe('ok');
    if (first.kind !== 'ok') return;
    const before = `HEADER KEPT\n${first.content}FOOTER KEPT\n`;

    const second = upsertManagedBlock(before, 'new body');
    expect(second.kind).toBe('ok');
    if (second.kind !== 'ok') return;
    expect(second.content.startsWith('HEADER KEPT\n')).toBe(true);
    expect(second.content.endsWith('FOOTER KEPT\n')).toBe(true);
    expect(second.content).toContain('new body');
    expect(second.content).not.toContain('old body');
    // exactly one block remains
    expect((second.content.match(/ditto:managed:start/g) ?? []).length).toBe(1);
  });

  test('collapses a nested double-wrapped ditto block into a single block (heals double-wrap)', () => {
    // Reproduce the global CLAUDE.md double-wrap: an inner ditto block (the
    // legacy GLOBAL_AGENTS.md-sourced block) wrapped again by an outer projection.
    const inner = buildManagedBlock('charter body\n', 'GLOBAL_AGENTS.md');
    const nested = buildManagedBlock(inner, 'AGENTS.md');
    expect((nested.match(/ditto:managed:start/g) ?? []).length).toBe(2);
    expect((nested.match(/ditto:managed:end/g) ?? []).length).toBe(2);

    const result = upsertManagedBlock(`user before\n${nested}\nuser after\n`, 'fresh body');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    // collapsed back to exactly one block
    expect((result.content.match(/ditto:managed:start/g) ?? []).length).toBe(1);
    expect((result.content.match(/ditto:managed:end/g) ?? []).length).toBe(1);
    // content outside the outermost markers is preserved
    expect(result.content).toContain('user before');
    expect(result.content).toContain('user after');
    // the fresh body replaced the old nested content
    expect(result.content).toContain('fresh body');
    expect(result.content).not.toContain('charter body');
  });

  test('re-running with the same body is a no-op outside the block', () => {
    const original = 'A\n';
    const once = upsertManagedBlock(original, 'body');
    if (once.kind !== 'ok') throw new Error('expected ok');
    const twice = upsertManagedBlock(once.content, 'body');
    if (twice.kind !== 'ok') throw new Error('expected ok');
    expect(twice.content).toBe(once.content);
  });

  test('returns corrupted when markers are unbalanced, preserving original', () => {
    const corrupt = `before\n${MANAGED_END}\nafter (end without start)\n`;
    const result = upsertManagedBlock(corrupt, 'body');
    expect(result.kind).toBe('corrupted');
    if (result.kind !== 'corrupted') return;
    expect(result.original).toBe(corrupt);
  });

  test('end marker sits on its own line even when the body lacks a trailing newline', () => {
    const result = upsertManagedBlock('', 'last line with no newline');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    // exactly one newline between the body text and the end marker
    expect(result.content).toContain(`last line with no newline\n${MANAGED_END}`);
    // the end marker must start at a line boundary (not glued to the body char)
    expect(result.content).not.toContain(`newline${MANAGED_END}`);
  });
});

describe('buildManagedBlock sha/body round-trip', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ditto-managed-sha-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // The reader (loadProjection) recomputes actualSha256 over the body it captures
  // BETWEEN the markers (which includes the forced trailing break). The writer must
  // stamp a marker sha over that SAME embedded body, or the block is self-contradictory.
  test('marker sha equals reader-recomputed actualSha256 for a body WITHOUT a trailing newline', async () => {
    const block = buildManagedBlock('body line with no trailing newline', 'AGENTS.md');
    await writeFile(join(dir, 'CLAUDE.md'), `${block}\n`, 'utf8');
    const projection = await loadProjection(dir);
    expect(projection.kind).toBe('ok');
    if (projection.kind !== 'ok') return;
    expect(projection.markerSha256).toBe(projection.actualSha256);
  });

  test('marker sha equals reader-recomputed actualSha256 for a body WITH a trailing newline', async () => {
    const block = buildManagedBlock('body line with a trailing newline\n', 'AGENTS.md');
    await writeFile(join(dir, 'CLAUDE.md'), `${block}\n`, 'utf8');
    const projection = await loadProjection(dir);
    expect(projection.kind).toBe('ok');
    if (projection.kind !== 'ok') return;
    expect(projection.markerSha256).toBe(projection.actualSha256);
  });
});

describe('stripManagedBlock', () => {
  test('removes the block and leaves zero markers, preserving outside content', () => {
    const inserted = upsertManagedBlock('keep me before\n', 'body');
    if (inserted.kind !== 'ok') throw new Error('expected ok');
    const withFooter = `${inserted.content}keep me after\n`;

    const result = stripManagedBlock(withFooter);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(countMarkers(result.content)).toBe(0);
    expect(result.content).toContain('keep me before');
    expect(result.content).toContain('keep me after');
  });

  test('preserves a triple-blank run elsewhere in the user content after strip', () => {
    const userTail = 'section A\n\n\n\nsection B\n';
    const inserted = upsertManagedBlock('intro\n', 'body');
    if (inserted.kind !== 'ok') throw new Error('expected ok');
    const withTail = `${inserted.content}${userTail}`;

    const result = stripManagedBlock(withTail);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(countMarkers(result.content)).toBe(0);
    // the user's own triple-blank run is left untouched
    expect(result.content).toContain('section A\n\n\n\nsection B');
  });

  test('content without a block is returned unchanged', () => {
    const result = stripManagedBlock('plain user content\n');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.content).toBe('plain user content\n');
  });

  test('returns corrupted on unbalanced markers, preserving original', () => {
    const corrupt = `<!-- ditto:managed:start source=AGENTS.md sha256=${'a'.repeat(64)} -->\nno end here\n`;
    const result = stripManagedBlock(corrupt);
    expect(result.kind).toBe('corrupted');
    if (result.kind !== 'corrupted') return;
    expect(result.original).toBe(corrupt);
  });
});

describe('unwrapManagedBlock', () => {
  test('strips ditto marker lines back to raw, keeping inner body and outside content', () => {
    const wrapped = `top\n${buildManagedBlock('charter line 1\ncharter line 2\n', 'GLOBAL_AGENTS.md')}\nbottom\n`;
    const raw = unwrapManagedBlock(wrapped);
    expect(countMarkers(raw)).toBe(0);
    expect(raw).toContain('charter line 1');
    expect(raw).toContain('charter line 2');
    expect(raw).toContain('top');
    expect(raw).toContain('bottom');
  });

  test('content without any markers is returned unchanged', () => {
    const plain = 'just the charter\nno markers\n';
    expect(unwrapManagedBlock(plain)).toBe(plain);
  });
});

describe('writeBackupOnce', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ditto-managed-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('keeps the FIRST original across repeated calls (idempotent)', async () => {
    const target = join(dir, 'CLAUDE.md');
    await writeFile(target, 'first original\n', 'utf8');
    const bak1 = await writeBackupOnce(target);
    expect(bak1).toBe(`${target}.ditto_bak`);

    // user/setup overwrites target, then we back up again
    await writeFile(target, 'second write\n', 'utf8');
    const bak2 = await writeBackupOnce(target);
    expect(bak2).toBeNull();

    const bakContent = await readFile(`${target}.ditto_bak`, 'utf8');
    expect(bakContent).toBe('first original\n');
  });

  test('returns null when the target does not exist', async () => {
    const result = await writeBackupOnce(join(dir, 'missing.md'));
    expect(result).toBeNull();
  });
});

describe('applyManagedFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ditto-managed-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('backs up the original then inserts the block', async () => {
    const target = join(dir, 'CLAUDE.md');
    await writeFile(target, 'user content\n', 'utf8');
    const result = await applyManagedFile(target, 'managed body');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.backupPath).toBe(`${target}.ditto_bak`);

    const written = await readFile(target, 'utf8');
    expect(written).toContain('user content');
    expect(written).toContain('managed body');
    expect(await readFile(`${target}.ditto_bak`, 'utf8')).toBe('user content\n');
  });

  test('creates the file when missing (no backup)', async () => {
    const target = join(dir, 'CLAUDE.md');
    const result = await applyManagedFile(target, 'managed body');
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.backupPath).toBeNull();
    expect(await readFile(target, 'utf8')).toContain('managed body');
  });

  test('refuses to write when the existing file is corrupted, preserving it', async () => {
    const target = join(dir, 'CLAUDE.md');
    const corrupt = `oops\n${MANAGED_END}\n`;
    await writeFile(target, corrupt, 'utf8');
    const result = await applyManagedFile(target, 'managed body');
    expect(result.kind).toBe('corrupted');
    // original file untouched
    expect(await readFile(target, 'utf8')).toBe(corrupt);
  });
});
