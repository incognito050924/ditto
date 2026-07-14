import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncClaudeCodeProjection } from '~/core/bridge-sync';
import { checkInstructionsForHosts, loadProjection } from '~/core/instruction-bridge';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-bridge-'));
  await writeFile(join(dir, 'AGENTS.md'), '# AGENTS\nshared instruction\n', 'utf8');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('bridge sync', () => {
  test('appends a managed block and preserves free text', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), 'free area\n', 'utf8');
    const result = await syncClaudeCodeProjection(dir);
    expect(result.action).toBe('updated');
    const text = await readFile(join(dir, 'CLAUDE.md'), 'utf8');
    expect(text).toContain('free area');
    expect(text).toContain('ditto:managed:start');
    expect((await checkInstructionsForHosts(['claude-code'], dir)).findings).toEqual([]);
  });

  test('check mode does not write', async () => {
    const result = await syncClaudeCodeProjection(dir, { check: true });
    expect(result.action).toBe('would-create');
    expect(await Bun.file(join(dir, 'CLAUDE.md')).exists()).toBe(false);
  });

  // Aligning the bridge-sync builder to the forced-break discipline must NOT
  // re-introduce a marker!=body divergence: whatever break the builder forces into
  // the embedded body, the stamped marker sha must be computed over that same body.
  test('written block marker sha matches the reader-recomputed body sha for a source WITHOUT a trailing newline', async () => {
    await writeFile(join(dir, 'AGENTS.md'), '# AGENTS\nno trailing newline source', 'utf8');
    await syncClaudeCodeProjection(dir);
    const projection = await loadProjection(dir);
    expect(projection.kind).toBe('ok');
    if (projection.kind !== 'ok') return;
    expect(projection.markerSha256).toBe(projection.actualSha256);
  });

  // Common (trailing-newline) source must stay fully clean under the doctor.
  test('written block for a source WITH a trailing newline stays clean under the doctor', async () => {
    await syncClaudeCodeProjection(dir);
    const projection = await loadProjection(dir);
    expect(projection.kind).toBe('ok');
    if (projection.kind !== 'ok') return;
    expect(projection.markerSha256).toBe(projection.actualSha256);
    expect((await checkInstructionsForHosts(['claude-code'], dir)).findings).toEqual([]);
  });
});
