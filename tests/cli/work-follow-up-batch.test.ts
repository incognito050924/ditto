import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IntentStore } from '~/core/intent-store';
import { WorkItemStore } from '~/core/work-item-store';
import { intentContract } from '~/schemas/intent';

// ac-4 (T1, wi_2606266az) — BATCH materialization of OUT-of-scope follow-ups.
// The single `work follow-up <wi> --kind bug` path materializes ONE bug per CLI
// call. This batch path takes the WHOLE captured candidate set (the intent
// sidecar's `follow_up_candidates` ∪ the WI's own unmaterialized idea follow_ups)
// and materializes it on ONE approval — N candidates → N back-linked WIs with
// zero per-item drip. materialize != drive (R9): the created WIs are tracked
// records (status 'draft'), never auto-started.

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

async function seedIntent(wid: string, candidates: string[]): Promise<void> {
  const intent = intentContract.parse({
    schema_version: '0.1.0',
    work_item_id: wid,
    source_request: 'fix the thing',
    goal: 'the command returns 0',
    acceptance_criteria: [{ id: 'ac-1', statement: 'the command returns 0' }],
    follow_up_candidates: candidates,
  });
  await new IntentStore(dir).write(intent);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-followup-batch-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ac-4 T1: batch materialization', () => {
  test('--batch materializes the WHOLE captured set on ONE approval (N candidates → N WIs, 0 per-item drip, none driven)', async () => {
    const wid = startWithCriteria();

    // one candidate captured on the WI itself (idea follow_up = candidate-only)
    expect(
      ditto(['work', 'follow-up', wid, '--kind', 'idea', '--note', 'cache the parser output'])
        .exitCode,
    ).toBe(0);
    // two more out-of-scope candidates recorded in the intent sidecar
    await seedIntent(wid, ['extract a shared validator', 'add a retry on the flaky fetch']);

    const store = new WorkItemStore(dir);
    const before = (await store.list()).length;

    // ONE invocation = ONE batch approval covering the WHOLE set (no per-item prompt)
    const r = ditto(['work', 'follow-up', wid, '--batch', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.batch_approved).toBe(true);
    expect(out.materialized_wis).toHaveLength(3); // 2 intent candidates + 1 idea follow_up

    // N candidates → N WIs created from the single approval
    const after = (await store.list()).length;
    expect(after - before).toBe(3);

    // R9 materialize != drive: each created WI is a tracked record only — never started/driven
    for (const newWid of out.materialized_wis as string[]) {
      const child = await store.get(newWid);
      expect(child.discovered_by).toBe(wid); // child side of provenance
      expect(child.status).toBe('draft'); // NOT in_progress — not auto-started
      expect(child.parent_id).toBeUndefined(); // discovered_by, not a parent/child drive edge
    }

    // parent side of provenance: every captured follow-up now back-links its WI
    const parent = await store.get(wid);
    const entries = parent.follow_ups ?? [];
    expect(entries).toHaveLength(3); // original idea (stamped) + 2 appended from intent candidates
    for (const e of entries) {
      expect(typeof e.materialized_wi).toBe('string');
      expect((out.materialized_wis as string[]).includes(e.materialized_wi as string)).toBe(true);
    }

    // the one-time approval is recorded in the intent sidecar (not re-prompted per item)
    const savedIntent = await new IntentStore(dir).get(wid);
    expect(savedIntent.follow_up_materialization?.batch_approved).toBe(true);
    expect(savedIntent.follow_up_materialization?.materialized_wis).toHaveLength(3);
  });

  test('--batch is one-time: a second invocation creates no duplicate WIs (back-link makes it idempotent)', async () => {
    const wid = startWithCriteria();
    await seedIntent(wid, ['one improvement', 'two improvement']);

    expect(ditto(['work', 'follow-up', wid, '--batch', '--output', 'json']).exitCode).toBe(0);
    const afterFirst = (await new WorkItemStore(dir).list()).length;

    // second invocation: already approved → no-op, no new WIs
    const r2 = ditto(['work', 'follow-up', wid, '--batch', '--output', 'json']);
    expect(r2.exitCode).toBe(0);
    const afterSecond = (await new WorkItemStore(dir).list()).length;
    expect(afterSecond).toBe(afterFirst);
  });

  test('--batch cannot be combined with --kind/--note/--resolve (one mode per invocation)', () => {
    const wid = startWithCriteria();
    const r = ditto(['work', 'follow-up', wid, '--batch', '--kind', 'bug', '--note', 'x']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/one mode|--batch|--kind/i);
  });

  test('--batch on a lightweight WI with no intent.json is a clear error (nowhere to record the one-time approval)', () => {
    const wid = startWithCriteria(); // lightweight: no intent.json
    const r = ditto(['work', 'follow-up', wid, '--batch']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/intent\.json/i);
  });

  // Regression: the single per-bug path must keep working unchanged.
  test('regression: the single --kind bug path still materializes exactly one back-linked WI', async () => {
    const wid = startWithCriteria();
    const store = new WorkItemStore(dir);
    const before = (await store.list()).length;
    const r = ditto([
      'work',
      'follow-up',
      wid,
      '--kind',
      'bug',
      '--note',
      'race in the writer',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    const newWid = JSON.parse(r.stdout).materialized_wi as string;
    expect(typeof newWid).toBe('string');
    expect((await store.list()).length - before).toBe(1);
    const child = await store.get(newWid);
    expect(child.discovered_by).toBe(wid);
  });
});
