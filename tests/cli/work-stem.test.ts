import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkItemStore } from '~/core/work-item-store';

// ac-5 (wi_260626wnv) — chain lineage. Related work items often form a sequential
// CHAIN (each WI continues the prior), which the parent_id tree + dead child_ids
// could not model. `follows` is an additive-optional edge ("this WI continues from
// the named predecessor"); the stem is a DERIVED view computed from those edges
// (no stored stem object). `work stem` queries the chain in both directions and can
// bulk-close it as one unit.

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

async function gradeAc1Pass(wid: string): Promise<void> {
  const wiPath = join(dir, '.ditto', 'local', 'work-items', wid, 'work-item.json');
  expect(ditto(['verify', wid, '--criterion', 'ac-1', '--', 'cat', wiPath]).exitCode).toBe(0);
}

async function makeDone(wid: string): Promise<void> {
  await gradeAc1Pass(wid);
  expect(ditto(['work', 'done', wid, '--output', 'json']).exitCode).toBe(0);
}

function abandon(wid: string): void {
  expect(ditto(['work', 'abandon', wid, '--output', 'json']).exitCode).toBe(0);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-stem-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ─── Part A: chain lineage edge (`follows`) ───────────────────────────────────
describe('ac-5 A: follows edge', () => {
  test('legacy work item without follows parses unchanged (additive-optional)', async () => {
    const created = await new WorkItemStore(dir).create({
      title: 't',
      source_request: 'r',
      goal: 'g',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'the command exits 0', verdict: 'unverified', evidence: [] },
      ],
    });
    const item = await new WorkItemStore(dir).get(created.id);
    expect(item.follows).toBeUndefined();
  });

  test('work start --follows <prev> records the lineage edge at creation', async () => {
    const a = start('first step');
    const b = start('second step', ['--follows', a]);
    const item = await new WorkItemStore(dir).get(b);
    expect(item.follows).toBe(a);
  });

  test('work stem <wi> --follows <prev> wires the edge on an already-existing WI', async () => {
    const a = start('first step');
    const b = start('second step'); // created WITHOUT a follows edge
    const r = ditto(['work', 'stem', b, '--follows', a, '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const item = await new WorkItemStore(dir).get(b);
    expect(item.follows).toBe(a);
  });

  test('--follows a nonexistent predecessor is a usage error (no write)', async () => {
    const b = start('second step');
    const r = ditto(['work', 'stem', b, '--follows', 'wi_doesnotexist01']);
    expect(r.exitCode).not.toBe(0);
    const item = await new WorkItemStore(dir).get(b);
    expect(item.follows).toBeUndefined();
  });

  test('CYCLE: a --follows that would close a cycle is rejected (no write)', async () => {
    const a = start('first step');
    const b = start('second step', ['--follows', a]); // b → a
    // now try a → b, which would create a cycle a → b → a
    const r = ditto(['work', 'stem', a, '--follows', b]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/cycle|loop/i);
    // no write: a still has no follows edge
    expect((await new WorkItemStore(dir).get(a)).follows).toBeUndefined();
    // a self-follow is also a cycle
    const self = ditto(['work', 'stem', a, '--follows', a]);
    expect(self.exitCode).not.toBe(0);
    expect((await new WorkItemStore(dir).get(a)).follows).toBeUndefined();
  });
});

// ─── Part B: derived stem view (computed, no stored stem object) ──────────────
describe('ac-5 B: derived stem view', () => {
  test('walks the chain TRANSITIVELY in BOTH directions from a middle WI, in lineage order', async () => {
    const a = start('first step');
    const b = start('second step', ['--follows', a]); // b → a
    const c = start('third step', ['--follows', b]); // c → b
    // query from the MIDDLE (b): must reach the predecessor (a) upward AND the
    // successor (c) downward, ordered root → tip.
    const r = ditto(['work', 'stem', b, '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.members.map((m: { id: string }) => m.id)).toEqual([a, b, c]);
    // every member carries its status; all draft → chain is still open
    expect(out.members.every((m: { status: string }) => typeof m.status === 'string')).toBe(true);
    expect(out.rolled_up).toBe('open');
  });

  test('a lone WI with no follows edge is a one-member stem', async () => {
    const a = start('only step');
    const r = ditto(['work', 'stem', a, '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.members.map((m: { id: string }) => m.id)).toEqual([a]);
    expect(out.rolled_up).toBe('open');
  });
});

// ─── Part C: bulk close with a rolled-up verdict ──────────────────────────────
describe('ac-5 C: bulk close', () => {
  test('all members done → --close emits rolled_up verdict done', async () => {
    const a = start('first step');
    const b = start('second step', ['--follows', a]); // b → a
    await makeDone(a);
    await makeDone(b);
    const r = ditto(['work', 'stem', a, '--close', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).rolled_up).toBe('done');
  });

  test('partial-abandon IS allowed: one abandoned, rest done → rolled_up partial', async () => {
    const a = start('first step');
    const b = start('second step', ['--follows', a]); // b → a
    await makeDone(a);
    abandon(b);
    const r = ditto(['work', 'stem', a, '--close', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).rolled_up).toBe('partial');
  });

  test('REJECT: a non-terminal member blocks --close, names it, and does not mutate', async () => {
    const a = start('first step');
    const b = start('second step', ['--follows', a]); // b → a, left draft (non-terminal)
    await makeDone(a);
    const r = ditto(['work', 'stem', a, '--close']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(new RegExp(b)); // lists the non-terminal member
    // no mutation: a stays done, b stays draft
    expect((await new WorkItemStore(dir).get(a)).status).toBe('done');
    expect((await new WorkItemStore(dir).get(b)).status).toBe('draft');
  });
});
