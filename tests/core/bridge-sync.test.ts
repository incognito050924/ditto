import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { syncClaudeCodeProjection } from '~/core/bridge-sync';
import { checkInstructionsForHosts } from '~/core/instruction-bridge';

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
});
