import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PLACEHOLDER_AC_STATEMENT } from '~/core/charter';
import { WorkItemStore } from '~/core/work-item-store';

// ac-1 (wi_260626wnv) — lightweight real-criteria setter. `ditto work set-criteria`
// replaces the placeholder acceptance criterion with real, observable criteria
// (semicolon-separated → ac-1, ac-2, …), gated by acceptanceTestable, and locks
// already-graded criteria against silent goalpost-moving (charter §4-6).

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
let dir: string;

function ditto(args: string[]) {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], { cwd: dir, env: { ...process.env } });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

async function startWorkItem(): Promise<string> {
  const s = ditto(['work', 'start', 'a goal', '--request', 'r', '--output', 'json']);
  expect(s.exitCode).toBe(0);
  return JSON.parse(s.stdout).work_item_id as string;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-setcrit-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto work set-criteria', () => {
  test('A: semicolon-separated criteria replace the placeholder as ac-1, ac-2', async () => {
    const wid = await startWorkItem();
    const r = ditto([
      'work',
      'set-criteria',
      wid,
      '--criteria',
      'the command returns 0; the output contains ok',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    const item = await new WorkItemStore(dir).get(wid);
    expect(item.acceptance_criteria).toHaveLength(2);
    expect(item.acceptance_criteria[0].id).toBe('ac-1');
    expect(item.acceptance_criteria[0].statement).toBe('the command returns 0');
    expect(item.acceptance_criteria[0].verdict).toBe('unverified');
    expect(item.acceptance_criteria[1].id).toBe('ac-2');
    expect(item.acceptance_criteria[1].statement).toBe('the output contains ok');
  });

  test('C: a non-observable statement in the batch rejects the whole set; no partial write', async () => {
    const wid = await startWorkItem();
    const r = ditto([
      'work',
      'set-criteria',
      wid,
      '--criteria',
      'the command returns 0; make the thing robust',
    ]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/robust|vague|observable/i);
    // No partial write: the placeholder is untouched (single original ac-1).
    const item = await new WorkItemStore(dir).get(wid);
    expect(item.acceptance_criteria).toHaveLength(1);
    expect(item.acceptance_criteria[0].statement).toBe(PLACEHOLDER_AC_STATEMENT);
  });

  // Grade ac-1 to `pass` via a real verify command, returning the work item id.
  async function startAndGrade(): Promise<string> {
    const wid = await startWorkItem();
    expect(
      ditto(['work', 'set-criteria', wid, '--criteria', 'the command returns 0']).exitCode,
    ).toBe(0);
    const wiPath = join(dir, '.ditto', 'local', 'work-items', wid, 'work-item.json');
    expect(ditto(['verify', wid, '--criterion', 'ac-1', '--', 'cat', wiPath]).exitCode).toBe(0);
    return wid;
  }

  test('E: an already-graded criterion blocks silent overwrite (no --supersede)', async () => {
    const wid = await startAndGrade();
    const r = ditto(['work', 'set-criteria', wid, '--criteria', 'the output contains ok']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/supersede|graded|verdict/i);
    // Unchanged: the graded ac-1 survives.
    const item = await new WorkItemStore(dir).get(wid);
    expect(item.acceptance_criteria).toHaveLength(1);
    expect(item.acceptance_criteria[0].statement).toBe('the command returns 0');
    expect(item.acceptance_criteria[0].verdict).toBe('pass');
  });

  test('E: --supersede --reason overwrites and preserves prior statement + reason', async () => {
    const wid = await startAndGrade();
    const r = ditto([
      'work',
      'set-criteria',
      wid,
      '--criteria',
      'the output contains ok',
      '--supersede',
      '--reason',
      'scope changed by user',
    ]);
    expect(r.exitCode).toBe(0);
    const item = await new WorkItemStore(dir).get(wid);
    expect(item.acceptance_criteria[0].statement).toBe('the output contains ok');
    expect(item.acceptance_criteria[0].verdict).toBe('unverified'); // fresh, re-verify required
    expect(item.acceptance_criteria[0].superseded).toEqual([
      { statement: 'the command returns 0', reason: 'scope changed by user' },
    ]);
  });

  test('E: --supersede without --reason is a usage error (no write)', async () => {
    const wid = await startAndGrade();
    const r = ditto([
      'work',
      'set-criteria',
      wid,
      '--criteria',
      'the output contains ok',
      '--supersede',
    ]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/reason/i);
    const item = await new WorkItemStore(dir).get(wid);
    expect(item.acceptance_criteria[0].statement).toBe('the command returns 0'); // unchanged
  });

  test('E: leftover graded criteria beyond the new count are preserved on supersede', async () => {
    const wid = await startWorkItem();
    // two real criteria, both graded pass
    expect(
      ditto([
        'work',
        'set-criteria',
        wid,
        '--criteria',
        'the command returns 0; the output contains ok',
      ]).exitCode,
    ).toBe(0);
    const wiPath = join(dir, '.ditto', 'local', 'work-items', wid, 'work-item.json');
    expect(ditto(['verify', wid, '--criterion', 'ac-1', '--', 'cat', wiPath]).exitCode).toBe(0);
    expect(ditto(['verify', wid, '--criterion', 'ac-2', '--', 'cat', wiPath]).exitCode).toBe(0);
    // supersede with a SINGLE new criterion — ac-2's graded statement must not be lost
    const r = ditto([
      'work',
      'set-criteria',
      wid,
      '--criteria',
      'the response status equals 204',
      '--supersede',
      '--reason',
      'merged into one',
    ]);
    expect(r.exitCode).toBe(0);
    const item = await new WorkItemStore(dir).get(wid);
    expect(item.acceptance_criteria).toHaveLength(1);
    const preserved = item.acceptance_criteria[0].superseded ?? [];
    expect(preserved.map((p: { statement: string }) => p.statement)).toEqual([
      'the command returns 0',
      'the output contains ok',
    ]);
  });
});
