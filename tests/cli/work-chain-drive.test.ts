import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// wi_2606277pt — `ditto work chain drive <wi>` CLI surface. These scenarios all
// HALT (or reject) before the per-member autopilot subprocess, so they exercise the
// entry-point validation, spine resolution, and halt-gates end-to-end without
// requiring a global `ditto` on PATH or a full agent loop.

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

function start(goal: string, extra: string[] = []): string {
  const s = ditto([
    'work',
    'start',
    goal,
    '--request',
    'continue the prior work',
    '--criteria',
    'the command returns 0',
    ...extra,
    '--output',
    'json',
  ]);
  expect(s.exitCode).toBe(0);
  return JSON.parse(s.stdout).work_item_id as string;
}

function makeDone(wid: string): void {
  const wiPath = join(dir, '.ditto', 'local', 'work-items', wid, 'work-item.json');
  expect(ditto(['verify', wid, '--criterion', 'ac-1', '--', 'cat', wiPath]).exitCode).toBe(0);
  expect(ditto(['work', 'done', wid, '--output', 'json']).exitCode).toBe(0);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-chaindrive-cli-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('INPUT: a malformed / traversal id is rejected at the entry', () => {
  test('a `../`-style id never reaches the store', () => {
    const r = ditto(['work', 'chain', 'drive', '../etc/passwd']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/invalid work item id/i);
  });
});

describe('ac-2: a member with no intent.json HALTS (no auto-create)', () => {
  test('driving a lightweight (no-intent) member reports blocked-unlocked-no-intent', () => {
    const a = start('first step');
    start('second step', ['--follows', a]); // b → a
    const r = ditto(['work', 'chain', 'drive', a, '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ledger[0]).toEqual({
      member_id: a,
      disposition: 'blocked-unlocked-no-intent',
      reason: 'needs-intent-lock',
    });
    expect(out.halted_member).toBe(a);
    // no intent.json was created
    const r2 = ditto(['work', 'status', a, '--output', 'json']);
    expect(JSON.parse(r2.stdout).status).toBe('draft');
  });
});

describe('ac-1: resume skips an already-done member', () => {
  test('a done member is skipped, then the next non-terminal member halts on its gate', () => {
    const a = start('first step');
    const b = start('second step', ['--follows', a]); // b → a
    makeDone(a);
    const r = ditto(['work', 'chain', 'drive', b, '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ledger[0]).toEqual({ member_id: a, disposition: 'skipped-already-done' });
    expect(out.ledger[1].disposition).toBe('blocked-unlocked-no-intent');
    expect(out.halted_member).toBe(b);
  });
});

describe('ac-1 spine: a branched stem is rejected, naming the branch point', () => {
  test('two members following the same predecessor → usage error naming it', () => {
    const a = start('first step');
    start('branch one', ['--follows', a]); // b → a
    start('branch two', ['--follows', a]); // c → a (branch at a)
    const r = ditto(['work', 'chain', 'drive', a]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/branch/i);
    expect(r.stderr).toMatch(new RegExp(a));
  });
});

describe('ac-3: an abandoned member halts the chain', () => {
  test('an abandoned member halts rather than being skipped', () => {
    const a = start('first step');
    const b = start('second step', ['--follows', a]); // b → a
    expect(ditto(['work', 'abandon', a, '--output', 'json']).exitCode).toBe(0);
    const r = ditto(['work', 'chain', 'drive', b, '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.halted_member).toBe(a);
    expect(out.ledger[0].disposition).toBe('halted');
    expect(out.ledger[0].reason).toMatch(/abandon/i);
  });
});
