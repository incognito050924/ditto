import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLACEHOLDER_AC_STATEMENT } from '~/core/charter';

// V1/V3 (wi_260607vgi): `work start` must emit the SAME placeholder AC statement
// the user-prompt-submit detector matches (so the deep-interview directive fires
// for CLI-created work items), and its "next steps" must point at finalize —
// `autopilot bootstrap` needs intent.json, which only deep-interview finalize writes.

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
let dir: string;

function ditto(args: string[]): { stdout: string; stderr: string; exitCode: number | null } {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], { cwd: dir, env: { ...process.env } });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-workstart-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto work start', () => {
  test('V1: the initial AC statement equals PLACEHOLDER_AC_STATEMENT (detector matches)', async () => {
    const r = ditto([
      'work',
      'start',
      'observable goal',
      '--request',
      'do the thing',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    const item = JSON.parse(await readFile(join(dir, out.path), 'utf8'));
    expect(item.acceptance_criteria).toHaveLength(1);
    expect(item.acceptance_criteria[0].statement).toBe(PLACEHOLDER_AC_STATEMENT);
  });

  test('V3: next-steps point at finalize and note bootstrap needs intent.json', () => {
    const r = ditto(['work', 'start', 'observable goal', '--request', 'do the thing']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('finalize');
    expect(r.stdout).toContain('intent.json');
  });

  // ac-1 (B) — `--criteria` sets real observable criteria at creation instead of
  // the placeholder (semicolon-separated → ac-1, ac-2, …).
  test('B: --criteria sets real observable criteria instead of the placeholder', async () => {
    const r = ditto([
      'work',
      'start',
      'observable goal',
      '--request',
      'do the thing',
      '--criteria',
      'the command returns 0; the output contains ok',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    const item = JSON.parse(await readFile(join(dir, out.path), 'utf8'));
    expect(item.acceptance_criteria).toHaveLength(2);
    expect(item.acceptance_criteria[0].id).toBe('ac-1');
    expect(item.acceptance_criteria[0].statement).toBe('the command returns 0');
    expect(item.acceptance_criteria[1].id).toBe('ac-2');
    expect(item.acceptance_criteria[1].statement).toBe('the output contains ok');
    expect(
      item.acceptance_criteria.some(
        (c: { statement: string }) => c.statement === PLACEHOLDER_AC_STATEMENT,
      ),
    ).toBe(false);
  });

  // ac-1 (C) — observability gate: a vague/non-observable --criteria statement is
  // rejected (non-zero exit) and no work item is created (no partial write).
  test('C: --criteria with a vague statement rejects; no work item created', () => {
    const r = ditto([
      'work',
      'start',
      'observable goal',
      '--request',
      'do the thing',
      '--criteria',
      'make it robust',
    ]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/robust|vague|observable/i);
    const s = ditto(['work', 'status', '--output', 'json']);
    expect(s.exitCode).toBe(0);
    expect(JSON.parse(s.stdout).items).toHaveLength(0);
  });
});
