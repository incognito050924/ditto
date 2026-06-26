import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkItemStore } from '~/core/work-item-store';

// ac-4 (wi_260626wnv) — follow-up capture slot on a lightweight work item. A
// lightweight WI has no intent.json, so there was no structured slot for
// discovered follow-ups/bugs (agents prose-dumped them on the user). `follow_ups`
// is an additive-optional array (legacy work-item.json omits it, no
// schema_version bump). `work follow-up <wi> --kind bug|idea --note "..."` appends
// one entry; a bug ALSO materializes a tracked, back-linked WI (Part B); a
// self-caused high/critical bug blocks the source WI's `done` (Part C).

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

async function gradeAc1Pass(wid: string): Promise<void> {
  const wiPath = join(dir, '.ditto', 'local', 'work-items', wid, 'work-item.json');
  expect(ditto(['verify', wid, '--criterion', 'ac-1', '--', 'cat', wiPath]).exitCode).toBe(0);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-followup-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ─── Part A: the capture slot + append subcommand ──────────────────────────────
describe('ac-4 A: follow-up capture slot', () => {
  test('legacy work item without follow_ups parses unchanged (additive-optional)', async () => {
    const created = await new WorkItemStore(dir).create({
      title: 't',
      source_request: 'r',
      goal: 'g',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'the command exits 0', verdict: 'unverified', evidence: [] },
      ],
    });
    const item = await new WorkItemStore(dir).get(created.id);
    expect(item.follow_ups).toBeUndefined();
  });

  test('--kind idea --note appends a candidate-only entry (no severity/self_caused)', async () => {
    const wid = startWithCriteria();
    const r = ditto([
      'work',
      'follow-up',
      wid,
      '--kind',
      'idea',
      '--note',
      'extract a shared parser later',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    const item = await new WorkItemStore(dir).get(wid);
    expect(item.follow_ups).toHaveLength(1);
    expect(item.follow_ups?.[0].kind).toBe('idea');
    expect(item.follow_ups?.[0].note).toBe('extract a shared parser later');
  });

  test('--kind bug --severity high --self-caused records the full entry shape', async () => {
    const wid = startWithCriteria();
    const r = ditto([
      'work',
      'follow-up',
      wid,
      '--kind',
      'bug',
      '--note',
      'introduced a null deref in the parser',
      '--severity',
      'high',
      '--self-caused',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    const item = await new WorkItemStore(dir).get(wid);
    const fu = item.follow_ups?.[0];
    expect(fu?.kind).toBe('bug');
    expect(fu?.note).toBe('introduced a null deref in the parser');
    expect(fu?.severity).toBe('high');
    expect(fu?.self_caused).toBe(true);
  });

  test('an unknown --kind is a usage error (no silent miscapture)', () => {
    const wid = startWithCriteria();
    const r = ditto(['work', 'follow-up', wid, '--kind', 'feature', '--note', 'x']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/bug|idea|kind/i);
  });

  test('appends accumulate (a second follow-up does not clobber the first)', async () => {
    const wid = startWithCriteria();
    expect(ditto(['work', 'follow-up', wid, '--kind', 'idea', '--note', 'first']).exitCode).toBe(0);
    expect(ditto(['work', 'follow-up', wid, '--kind', 'idea', '--note', 'second']).exitCode).toBe(
      0,
    );
    const item = await new WorkItemStore(dir).get(wid);
    expect((item.follow_ups ?? []).map((f) => f.note)).toEqual(['first', 'second']);
  });
});

// ─── Part B: bug materialization into a tracked, back-linked WI ────────────────
describe('ac-4 B: bug materialization', () => {
  test('--kind bug creates a back-linked WI (discovered_by = source) and stamps materialized_wi', async () => {
    const wid = startWithCriteria();
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
    const out = JSON.parse(r.stdout);
    const newWid = out.materialized_wi as string;
    expect(typeof newWid).toBe('string');
    expect(newWid).not.toBe(wid);

    // the source follow-up entry records the materialized WI id
    const source = await new WorkItemStore(dir).get(wid);
    expect(source.follow_ups?.[0].materialized_wi).toBe(newWid);

    // the new WI carries the provenance link (distinct from parent_id)
    const created = await new WorkItemStore(dir).get(newWid);
    expect(created.discovered_by).toBe(wid);
    expect(created.parent_id).toBeUndefined();
  });

  test('--kind idea creates NO work item (candidate only)', async () => {
    const wid = startWithCriteria();
    const before = (await new WorkItemStore(dir).list()).length;
    const r = ditto([
      'work',
      'follow-up',
      wid,
      '--kind',
      'idea',
      '--note',
      'maybe cache this',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).materialized_wi).toBeUndefined();
    const after = (await new WorkItemStore(dir).list()).length;
    expect(after).toBe(before); // no new WI
    const item = await new WorkItemStore(dir).get(wid);
    expect(item.follow_ups?.[0].materialized_wi).toBeUndefined();
  });
});

// ─── Part C: self-caused high-severity regression blocks `done` ───────────────
describe('ac-4 C: self-caused high-severity bug blocks done', () => {
  test('BLOCK: an unresolved self-caused high-severity bug blocks done (names the follow-up)', async () => {
    const wid = startWithCriteria();
    await gradeAc1Pass(wid);
    expect(
      ditto([
        'work',
        'follow-up',
        wid,
        '--kind',
        'bug',
        '--note',
        'broke the close gate',
        '--severity',
        'high',
        '--self-caused',
      ]).exitCode,
    ).toBe(0);
    const d = ditto(['work', 'done', wid, '--output', 'json']);
    expect(d.exitCode).not.toBe(0);
    expect(d.stderr).toMatch(/broke the close gate/);
    expect(d.stderr).toMatch(/resolve|fix/i);
    expect((await new WorkItemStore(dir).get(wid)).status).not.toBe('done');
  });

  test('NON-block: a low-severity self-caused bug does NOT block done', async () => {
    const wid = startWithCriteria();
    await gradeAc1Pass(wid);
    expect(
      ditto([
        'work',
        'follow-up',
        wid,
        '--kind',
        'bug',
        '--note',
        'minor log typo',
        '--severity',
        'low',
        '--self-caused',
      ]).exitCode,
    ).toBe(0);
    expect(ditto(['work', 'done', wid, '--output', 'json']).exitCode).toBe(0);
    expect((await new WorkItemStore(dir).get(wid)).status).toBe('done');
  });

  test('NON-block: a self-caused high IDEA does NOT block done (only kind=bug blocks)', async () => {
    const wid = startWithCriteria();
    await gradeAc1Pass(wid);
    expect(
      ditto([
        'work',
        'follow-up',
        wid,
        '--kind',
        'idea',
        '--note',
        'big refactor idea',
        '--severity',
        'high',
        '--self-caused',
      ]).exitCode,
    ).toBe(0);
    expect(ditto(['work', 'done', wid, '--output', 'json']).exitCode).toBe(0);
    expect((await new WorkItemStore(dir).get(wid)).status).toBe('done');
  });

  test('NON-block: a resolved self-caused high-severity bug does NOT block done', async () => {
    const wid = startWithCriteria();
    await gradeAc1Pass(wid);
    expect(
      ditto([
        'work',
        'follow-up',
        wid,
        '--kind',
        'bug',
        '--note',
        'was a regression, now fixed',
        '--severity',
        'critical',
        '--self-caused',
      ]).exitCode,
    ).toBe(0);
    // mark the follow-up resolved at the store level (gate input state; the CLI
    // `--resolve` path is exercised separately in Part D)
    await new WorkItemStore(dir).update(wid, (cur) => ({
      ...cur,
      follow_ups: (cur.follow_ups ?? []).map((f) => ({ ...f, resolved: true })),
    }));
    expect(ditto(['work', 'done', wid, '--output', 'json']).exitCode).toBe(0);
    expect((await new WorkItemStore(dir).get(wid)).status).toBe('done');
  });
});

// ─── Part D: `--resolve <n>` clears the block (1-based index) ──────────────────
// The done-block (Part C) needs a CLI way to clear it, else a self-caused
// high-severity bug makes the WI permanently un-closeable. `work follow-up <wi>
// --resolve <n>` flips follow_ups[n-1].resolved = true (1-based, human-facing).
describe('ac-4 D: --resolve clears the done block', () => {
  test('--resolve <n> (1-based) marks the follow-up resolved and unblocks done', async () => {
    const wid = startWithCriteria();
    await gradeAc1Pass(wid);
    expect(
      ditto([
        'work',
        'follow-up',
        wid,
        '--kind',
        'bug',
        '--note',
        'self-caused regression',
        '--severity',
        'high',
        '--self-caused',
      ]).exitCode,
    ).toBe(0);
    // blocked before resolving
    expect(ditto(['work', 'done', wid, '--output', 'json']).exitCode).not.toBe(0);
    // resolve the 1st follow-up (1-based)
    const res = ditto(['work', 'follow-up', wid, '--resolve', '1', '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const item = await new WorkItemStore(dir).get(wid);
    expect(item.follow_ups?.[0].resolved).toBe(true);
    // now done is no longer blocked
    expect(ditto(['work', 'done', wid, '--output', 'json']).exitCode).toBe(0);
    expect((await new WorkItemStore(dir).get(wid)).status).toBe('done');
  });

  test('--resolve with an out-of-range or non-numeric index is a usage error (no write)', async () => {
    const wid = startWithCriteria();
    expect(
      ditto([
        'work',
        'follow-up',
        wid,
        '--kind',
        'bug',
        '--note',
        'x',
        '--severity',
        'high',
        '--self-caused',
      ]).exitCode,
    ).toBe(0);
    const oor = ditto(['work', 'follow-up', wid, '--resolve', '5']);
    expect(oor.exitCode).not.toBe(0);
    expect(oor.stderr).toMatch(/range|1-based|index/i);
    const nan = ditto(['work', 'follow-up', wid, '--resolve', 'abc']);
    expect(nan.exitCode).not.toBe(0);
    expect(nan.stderr).toMatch(/integer|index|1-based/i);
    // no write: the follow-up is still unresolved
    const item = await new WorkItemStore(dir).get(wid);
    expect(item.follow_ups?.[0].resolved).not.toBe(true);
  });

  test('--resolve combined with --kind/--note is a usage error (one mode per invocation)', async () => {
    const wid = startWithCriteria();
    expect(ditto(['work', 'follow-up', wid, '--kind', 'idea', '--note', 'x']).exitCode).toBe(0);
    const r = ditto(['work', 'follow-up', wid, '--resolve', '1', '--kind', 'bug', '--note', 'y']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/one mode|--kind|--resolve|combine/i);
    // no new follow-up appended (still just the idea), and it was not resolved
    const item = await new WorkItemStore(dir).get(wid);
    expect(item.follow_ups).toHaveLength(1);
    expect(item.follow_ups?.[0].resolved).not.toBe(true);
  });
});
