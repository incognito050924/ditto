import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompletionStore } from '~/core/completion-store';
import { WorkItemStore } from '~/core/work-item-store';

// ac-3 (wi_260626wnv) — risk declaration on a work item + the risk-driven gates
// it powers. `declared_risk` mirrors the intent risk axis vocabulary
// (non_local/irreversible/unaudited, gates.ts RiskAxes); it is additive-optional
// (legacy work-item.json omits it, no schema_version bump). Recorded at
// `work start --risk` / `work set-criteria --risk`; consumed by the lightweight
// close override gate (C) and the in-place heavy promotion (D).

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

function startWithRisk(risk: string): string {
  const s = ditto([
    'work',
    'start',
    'the command returns 0',
    '--request',
    'fix the thing',
    '--criteria',
    'the command returns 0',
    '--risk',
    risk,
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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-risk-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ac-3 A: declared_risk recording', () => {
  test('work start --risk records the declared_risk flags', async () => {
    const wid = startWithRisk('non_local,irreversible');
    const item = await new WorkItemStore(dir).get(wid);
    expect(item.declared_risk).toEqual({ non_local: true, irreversible: true });
  });

  test('work set-criteria --risk records the declared_risk flags', async () => {
    const s = ditto(['work', 'start', 'a goal', '--request', 'r', '--output', 'json']);
    expect(s.exitCode).toBe(0);
    const wid = JSON.parse(s.stdout).work_item_id as string;
    const r = ditto([
      'work',
      'set-criteria',
      wid,
      '--criteria',
      'the command returns 0',
      '--risk',
      'unaudited',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    const item = await new WorkItemStore(dir).get(wid);
    expect(item.declared_risk).toEqual({ unaudited: true });
    // criteria still set (ac-1 behavior unchanged)
    expect(
      (item.acceptance_criteria[0] as (typeof item.acceptance_criteria)[number]).statement,
    ).toBe('the command returns 0');
  });

  test('an unknown risk token is a usage error (no silent typo)', () => {
    const s = ditto([
      'work',
      'start',
      'g',
      '--request',
      'r',
      '--risk',
      'nonlocal',
      '--output',
      'json',
    ]);
    expect(s.exitCode).not.toBe(0);
    expect(s.stderr).toMatch(/non_local|irreversible|unaudited|risk/i);
  });

  test('legacy work item without declared_risk parses unchanged (additive-optional)', async () => {
    const created = await new WorkItemStore(dir).create({
      title: 't',
      source_request: 'r',
      goal: 'g',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'the command exits 0', verdict: 'unverified', evidence: [] },
      ],
    });
    const item = await new WorkItemStore(dir).get(created.id);
    expect(item.declared_risk).toBeUndefined();
  });
});

// (C) Logged-override gate at the lightweight close. A risk-flagged WI taking the
// lightweight synthesis path (no intent.json) must NOT close silently: block
// unless `--override-heavy --reason "<why>"`, and persist the override as an
// auditable record (a riskNote on the work item).
describe('ac-3 C: lightweight close override gate', () => {
  test('risk-flagged WI without --override-heavy is rejected (points to deep-interview or override)', async () => {
    const wid = startWithRisk('irreversible');
    await gradeAc1Pass(wid);
    const d = ditto(['work', 'done', wid, '--output', 'json']);
    expect(d.exitCode).not.toBe(0);
    expect(d.stderr).toMatch(/deep-interview|override-heavy/i);
    // not closed, no completion written
    expect(await new CompletionStore(dir).exists(wid)).toBe(false);
    expect((await new WorkItemStore(dir).get(wid)).status).not.toBe('done');
  });

  test('--override-heavy without --reason is a usage error', async () => {
    const wid = startWithRisk('irreversible');
    await gradeAc1Pass(wid);
    const d = ditto(['work', 'done', wid, '--override-heavy', '--output', 'json']);
    expect(d.exitCode).not.toBe(0);
    expect(d.stderr).toMatch(/reason/i);
    expect((await new WorkItemStore(dir).get(wid)).status).not.toBe('done');
  });

  test('--override-heavy --reason closes AND persists an auditable riskNote', async () => {
    const wid = startWithRisk('irreversible');
    await gradeAc1Pass(wid);
    const d = ditto([
      'work',
      'done',
      wid,
      '--override-heavy',
      '--reason',
      'change is reversible in practice; reviewed manually',
      '--output',
      'json',
    ]);
    expect(d.exitCode).toBe(0);
    const item = await new WorkItemStore(dir).get(wid);
    expect(item.status).toBe('done');
    // persisted, not just printed
    expect(
      item.risks.some((rk) => rk.description.includes('change is reversible in practice')),
    ).toBe(true);
  });

  test('no-risk WI closes via the lightweight path exactly as before (ac-2 unchanged)', async () => {
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
    const wid = JSON.parse(s.stdout).work_item_id as string;
    await gradeAc1Pass(wid);
    expect(ditto(['work', 'done', wid, '--output', 'json']).exitCode).toBe(0);
    expect((await new WorkItemStore(dir).get(wid)).status).toBe('done');
  });
});

// (D) In-place promotion to the heavy path without abandon+recreate: preserves
// the existing criteria, verdicts, evidence, and the WI id (no data loss).
describe('ac-3 D: work promote (in-place heavy upgrade)', () => {
  test('promote preserves the existing criteria + id and marks the WI for the heavy path', async () => {
    const s = ditto([
      'work',
      'start',
      'a goal',
      '--request',
      'r',
      '--criteria',
      'the command returns 0; the output contains ok',
      '--output',
      'json',
    ]);
    expect(s.exitCode).toBe(0);
    const wid = JSON.parse(s.stdout).work_item_id as string;
    await gradeAc1Pass(wid);
    const before = await new WorkItemStore(dir).get(wid);

    const p = ditto(['work', 'promote', wid, '--output', 'json']);
    expect(p.exitCode).toBe(0);

    const after = await new WorkItemStore(dir).get(wid);
    expect(after.id).toBe(before.id); // same WI, no recreate
    expect(after.promoted_to_heavy).toBe(true); // marked for the heavy path
    // existing set criteria preserved (NOT reset to placeholder), verdict kept
    expect(after.acceptance_criteria.map((c) => c.statement)).toEqual([
      'the command returns 0',
      'the output contains ok',
    ]);
    expect(
      (after.acceptance_criteria[0] as (typeof after.acceptance_criteria)[number]).verdict,
    ).toBe('pass');
  });
});
