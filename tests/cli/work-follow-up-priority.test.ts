import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkItemStore } from '~/core/work-item-store';

// ac-2 (wi_260710tjd) — an OPTIONAL, ADVISORY `priority` on a follow-up. It only
// orders the pick-up surfacing (display metadata); it drives NOTHING
// (no-auto-pick preserved, ADR-20260627). This file covers the schema round-trip
// + the `--priority` creation flag; the surfacing sort + the no-auto-pick
// invariant are exercised against the real completion gate in
// tests/cli/autopilot-complete-flip-cli.test.ts.

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

function startWithCriteria(): string {
  const s = ditto([
    'work',
    'start',
    'the command returns 0',
    '--request',
    'fix the thing',
    '--criteria',
    'the command returns 0',
    '--output',
    'json',
  ]);
  expect(s.exitCode).toBe(0);
  return JSON.parse(s.stdout).work_item_id as string;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-followup-prio-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ─── schema: additive-optional `priority` round-trips; legacy parses unchanged ──
describe('ac-2 schema: optional advisory priority', () => {
  test('a follow-up priority round-trips through the store (additive-optional)', async () => {
    const created = await new WorkItemStore(dir).create({
      title: 't',
      source_request: 'r',
      goal: 'g',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'the command exits 0', verdict: 'unverified', evidence: [] },
      ],
    });
    await new WorkItemStore(dir).update(created.id, (cur) => ({
      ...cur,
      follow_ups: [{ kind: 'idea', note: 'ordered candidate', priority: 2 }],
    }));
    const item = await new WorkItemStore(dir).get(created.id);
    expect(item.follow_ups?.[0]?.priority).toBe(2);
  });

  test('a legacy follow-up without priority parses unchanged (priority undefined)', async () => {
    const created = await new WorkItemStore(dir).create({
      title: 't',
      source_request: 'r',
      goal: 'g',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'the command exits 0', verdict: 'unverified', evidence: [] },
      ],
    });
    await new WorkItemStore(dir).update(created.id, (cur) => ({
      ...cur,
      follow_ups: [{ kind: 'idea', note: 'no priority here' }],
    }));
    const item = await new WorkItemStore(dir).get(created.id);
    expect(item.follow_ups?.[0]?.priority).toBeUndefined();
  });
});

// ─── creation: `--priority` flag is parse-validated and stamped on the entry ────
describe('ac-2 creation: --priority flag', () => {
  test('--priority stamps the advisory rank onto the appended follow-up', async () => {
    const wid = startWithCriteria();
    const r = ditto([
      'work',
      'follow-up',
      wid,
      '--kind',
      'idea',
      '--note',
      'ordered candidate',
      '--priority',
      '2',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    const item = await new WorkItemStore(dir).get(wid);
    expect(item.follow_ups?.[0]?.priority).toBe(2);
  });

  test('omitting --priority leaves priority undefined (additive-optional)', async () => {
    const wid = startWithCriteria();
    expect(ditto(['work', 'follow-up', wid, '--kind', 'idea', '--note', 'no rank']).exitCode).toBe(
      0,
    );
    const item = await new WorkItemStore(dir).get(wid);
    expect(item.follow_ups?.[0]?.priority).toBeUndefined();
  });

  test('a non-numeric or out-of-range --priority is a usage error (no write)', async () => {
    const wid = startWithCriteria();
    const nan = ditto([
      'work',
      'follow-up',
      wid,
      '--kind',
      'idea',
      '--note',
      'x',
      '--priority',
      'hi',
    ]);
    expect(nan.exitCode).not.toBe(0);
    expect(nan.stderr).toMatch(/priority|integer|1.*5/i);
    const oor = ditto([
      'work',
      'follow-up',
      wid,
      '--kind',
      'idea',
      '--note',
      'x',
      '--priority',
      '9',
    ]);
    expect(oor.exitCode).not.toBe(0);
    expect(oor.stderr).toMatch(/priority|range|1.*5/i);
    // no write: neither invalid call appended a follow-up
    const item = await new WorkItemStore(dir).get(wid);
    expect(item.follow_ups ?? []).toHaveLength(0);
  });
});
