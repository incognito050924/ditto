import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompletionStore, buildCompletion } from '~/core/completion-store';
import { WorkItemStore } from '~/core/work-item-store';

// wi_2606200ec — lightweight completion path. A work item fixed directly (no
// autopilot) must still be closable: `ditto work done` synthesizes a completion
// contract from the work item's OWN acceptance verdicts/evidence (set by
// `ditto verify`), gated by the SAME completionGate + completionEvidenceGate.
// No autopilot graph, no intent.json required — but the evidence gate still holds.

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

async function workItemWithRealAC() {
  return new WorkItemStore(dir).create({
    title: 'direct fix',
    source_request: 'fix the thing',
    goal: 'the thing is fixed',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'the command exits 0', verdict: 'unverified', evidence: [] },
    ],
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-workdone-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto work done — lightweight completion path', () => {
  test('verified AC (pass+evidence) → done synthesizes completion.json and closes', async () => {
    const wi = await workItemWithRealAC();
    // verify records a real (command) evidence ref and flips ac-1 to pass.
    // A real command (cat an existing file) — `ditto verify` now rejects no-op
    // commands (true / : / bare echo) so they cannot grade a criterion (ac-1 D).
    const wiPath = join(dir, '.ditto', 'local', 'work-items', wi.id, 'work-item.json');
    const v = ditto(['verify', wi.id, '--criterion', 'ac-1', '--', 'cat', wiPath]);
    expect(v.exitCode).toBe(0);

    expect(await new CompletionStore(dir).exists(wi.id)).toBe(false); // none yet
    const d = ditto(['work', 'done', wi.id, '--output', 'json']);
    expect(d.exitCode).toBe(0);

    // completion.json synthesized with final_verdict=pass
    const completion = await new CompletionStore(dir).get(wi.id);
    expect(completion.final_verdict).toBe('pass');
    expect(completion.acceptance.find((a) => a.criterion_id === 'ac-1')?.verdict).toBe('pass');
    // status closed
    const item = await new WorkItemStore(dir).get(wi.id);
    expect(item.status).toBe('done');
  });

  test('unverified AC → done refuses, writes no completion.json, leaves status open', async () => {
    const wi = await workItemWithRealAC(); // ac-1 stays unverified, no evidence
    const d = ditto(['work', 'done', wi.id, '--output', 'json']);
    expect(d.exitCode).not.toBe(0);
    expect(await new CompletionStore(dir).exists(wi.id)).toBe(false);
    const item = await new WorkItemStore(dir).get(wi.id);
    expect(item.status).not.toBe('done');
  });

  test('placeholder AC (work start default) → done refuses even if verdict flipped', async () => {
    const s = ditto(['work', 'start', 'a goal', '--request', 'r', '--output', 'json']);
    expect(s.exitCode).toBe(0);
    const wid = JSON.parse(s.stdout).work_item_id as string;
    // flip the placeholder AC to pass with evidence, but the statement is still TBD
    const wiPath = join(dir, '.ditto', 'local', 'work-items', wid, 'work-item.json');
    ditto(['verify', wid, '--criterion', 'ac-1', '--', 'cat', wiPath]);
    const d = ditto(['work', 'done', wid, '--output', 'json']);
    expect(d.exitCode).not.toBe(0);
    expect(await new CompletionStore(dir).exists(wid)).toBe(false);
  });
});

// ac-2 (wi_260626wnv) Part A — prove the WHOLE lightweight close runs through the
// user-typed surfaces end-to-end: `work start --criteria` (ac-1 real criteria) →
// `verify` (grade pass) → `work done` (synthesize completion + close), with NO
// intent.json and NO deep-interview ever present. Guards the no-graph path against
// regression.
describe('ditto work done — end-to-end lightweight close (ac-2 A)', () => {
  test('work start --criteria → verify pass → work done closes with synthesized pass completion, no intent.json', async () => {
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

    // No intent.json is created on this path — closing must not depend on one.
    const intentPath = join(dir, '.ditto', 'local', 'work-items', wid, 'intent.json');
    expect(await Bun.file(intentPath).exists()).toBe(false);

    // Grade ac-1 pass with a real command (cat an existing file).
    const wiPath = join(dir, '.ditto', 'local', 'work-items', wid, 'work-item.json');
    expect(ditto(['verify', wid, '--criterion', 'ac-1', '--', 'cat', wiPath]).exitCode).toBe(0);

    const d = ditto(['work', 'done', wid, '--output', 'json']);
    expect(d.exitCode).toBe(0);

    // Completion synthesized from the work item's OWN AC verdicts, final_verdict=pass.
    const completion = await new CompletionStore(dir).get(wid);
    expect(completion.final_verdict).toBe('pass');
    expect(completion.acceptance.find((a) => a.criterion_id === 'ac-1')?.verdict).toBe('pass');

    const item = await new WorkItemStore(dir).get(wid);
    expect(item.status).toBe('done');
    // Closed without ever writing an intent.json / running a deep-interview.
    expect(await Bun.file(intentPath).exists()).toBe(false);
  });
});

// ac-2 (wi_260626wnv) Part B — a partially-done-but-unverifiable WI must not be
// forced into a false `done` or false `abandon`. `work done --status partial|blocked`
// parks it in the resumable status (schema already has these + re_entry), populating
// re_entry from --re-entry-command / --needs. re_entry is mandatory for these statuses
// (schema superRefine) — the close is rejected when it is missing.
describe('ditto work done --status partial|blocked — lightweight resumable close (ac-2 B)', () => {
  async function startWithCriteria(): Promise<string> {
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

  test('--status partial with --re-entry-command parks the WI and records re_entry.command', async () => {
    const wid = await startWithCriteria();
    const r = ditto([
      'work',
      'done',
      wid,
      '--status',
      'partial',
      '--re-entry-command',
      'bun test tests/cli/work-done.test.ts',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    const item = await new WorkItemStore(dir).get(wid);
    expect(item.status).toBe('partial');
    expect(item.re_entry?.command).toBe('bun test tests/cli/work-done.test.ts');
  });

  test('--status blocked with --needs parks the WI and records re_entry.fresh_evidence_needed', async () => {
    const wid = await startWithCriteria();
    const r = ditto([
      'work',
      'done',
      wid,
      '--status',
      'blocked',
      '--needs',
      'upstream API key; staging deploy',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    const item = await new WorkItemStore(dir).get(wid);
    expect(item.status).toBe('blocked');
    expect(item.re_entry?.fresh_evidence_needed).toEqual(['upstream API key', 'staging deploy']);
  });

  test('--status partial without re_entry (no command, no needs) is rejected; status unchanged', async () => {
    const wid = await startWithCriteria();
    const r = ditto(['work', 'done', wid, '--status', 'partial', '--output', 'json']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/re.?entry|re-entry-command|needs/i);
    const item = await new WorkItemStore(dir).get(wid);
    expect(item.status).not.toBe('partial');
  });

  test('--status done-path unaffected: existing pass close still works without --status', async () => {
    const wid = await startWithCriteria();
    const wiPath = join(dir, '.ditto', 'local', 'work-items', wid, 'work-item.json');
    expect(ditto(['verify', wid, '--criterion', 'ac-1', '--', 'cat', wiPath]).exitCode).toBe(0);
    expect(ditto(['work', 'done', wid, '--output', 'json']).exitCode).toBe(0);
    expect((await new WorkItemStore(dir).get(wid)).status).toBe('done');
  });
});

// wi_260719ka9: a prior partial handoff leaves a stale completion.json on disk
// (final_verdict=partial). The lightweight close later grades every AC to pass via
// `ditto verify`, but the synthesis was gated on `!completion.exists`, so `work
// done` read the stale partial and blocked ("final_verdict=partial — cannot mark
// done") instead of re-synthesizing from the work item's now-all-pass SoT verdicts.
// The fix re-synthesizes when the on-disk completion is a non-pass, still through
// the SAME completionGate + completionEvidenceGate (a stale partial cannot masquerade
// as pass — the work item's own verdicts must actually be pass+evidence).
describe('ditto work done — stale non-pass completion re-synthesis (wi_260719ka9)', () => {
  test('ac-1: stale partial completion + all-pass AC verdicts → done closes, completion re-written to pass', async () => {
    const wi = await workItemWithRealAC();
    // Grade ac-1 pass with real command evidence (the SoT is now all-pass).
    const wiPath = join(dir, '.ditto', 'local', 'work-items', wi.id, 'work-item.json');
    expect(ditto(['verify', wi.id, '--criterion', 'ac-1', '--', 'cat', wiPath]).exitCode).toBe(0);

    // Simulate a prior partial handoff: a stale completion.json=partial on disk.
    const stale = buildCompletion({
      workItem: wi,
      declaredBy: 'main',
      summary: 'stale partial handoff',
      verdicts: [{ criterion_id: 'ac-1', verdict: 'partial', evidence: [] }],
    });
    expect(stale.final_verdict).toBe('partial');
    await new CompletionStore(dir).write(stale);

    const d = ditto(['work', 'done', wi.id, '--output', 'json']);
    expect(d.exitCode).toBe(0);

    const completion = await new CompletionStore(dir).get(wi.id);
    expect(completion.final_verdict).toBe('pass');
    expect(completion.acceptance.find((a) => a.criterion_id === 'ac-1')?.verdict).toBe('pass');
    expect((await new WorkItemStore(dir).get(wi.id)).status).toBe('done');
  });

  test('ac-2: stale partial completion + unverified AC (no evidence) → done still refused, no pass', async () => {
    const wi = await workItemWithRealAC(); // ac-1 stays unverified, no evidence
    const stale = buildCompletion({
      workItem: wi,
      declaredBy: 'main',
      summary: 'stale partial handoff',
      verdicts: [{ criterion_id: 'ac-1', verdict: 'partial', evidence: [] }],
    });
    await new CompletionStore(dir).write(stale);

    const d = ditto(['work', 'done', wi.id, '--output', 'json']);
    expect(d.exitCode).not.toBe(0);
    // Re-synthesis must not bless it: the on-disk completion is never flipped to pass.
    expect((await new CompletionStore(dir).get(wi.id)).final_verdict).not.toBe('pass');
    expect((await new WorkItemStore(dir).get(wi.id)).status).not.toBe('done');
  });

  test('ac-3: pre-existing pass completion is NOT re-synthesized (summary preserved)', async () => {
    const wi = await workItemWithRealAC();
    const passCompletion = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 'autopilot run — do not overwrite',
      verdicts: [
        { criterion_id: 'ac-1', verdict: 'pass', evidence: [{ kind: 'command', summary: 'x → 0' }] },
      ],
    });
    expect(passCompletion.final_verdict).toBe('pass');
    await new CompletionStore(dir).write(passCompletion);

    expect(ditto(['work', 'done', wi.id, '--output', 'json']).exitCode).toBe(0);

    const completion = await new CompletionStore(dir).get(wi.id);
    expect(completion.final_verdict).toBe('pass');
    // The pass path skips re-synthesis, so the original summary survives verbatim.
    expect(completion.summary).toBe('autopilot run — do not overwrite');
    expect((await new WorkItemStore(dir).get(wi.id)).status).toBe('done');
  });
});

// wi_260627273: the autopilot path writes completion.json with derived pass
// verdicts but leaves work-item.json acceptance_criteria at `unverified`. `work
// done` reading that pre-existing completion must mirror the verdicts (+ evidence)
// back so `work status`/`push-ready` are not stale.
describe('ditto work done — mirrors completion verdicts onto work-item acceptance (wi_260627273)', () => {
  test('pre-existing completion (pass) → done flips acceptance verdicts + evidence, 0 stale unverified', async () => {
    const wi = await new WorkItemStore(dir).create({
      title: 'autopilot-shaped',
      source_request: 's',
      goal: 'g',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'the command exits 0', verdict: 'unverified', evidence: [] },
        { id: 'ac-2', statement: 'the output is non-empty', verdict: 'unverified', evidence: [] },
      ],
    });
    // Simulate the autopilot path: a completion.json already exists (final_verdict
    // =pass, per-AC command evidence) while the work item's acceptance is still
    // unverified — exactly the wi_260627jhh shape.
    const completion = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 'autopilot run',
      verdicts: [
        {
          criterion_id: 'ac-1',
          verdict: 'pass',
          evidence: [{ kind: 'command', summary: 'x → 0' }],
        },
        {
          criterion_id: 'ac-2',
          verdict: 'pass',
          evidence: [{ kind: 'command', summary: 'y → 0' }],
        },
      ],
    });
    await new CompletionStore(dir).write(completion);

    expect(ditto(['work', 'done', wi.id, '--output', 'json']).exitCode).toBe(0);

    const item = await new WorkItemStore(dir).get(wi.id);
    expect(item.status).toBe('done');
    expect(item.acceptance_criteria.map((c) => c.verdict)).toEqual(['pass', 'pass']);
    expect(item.acceptance_criteria.filter((c) => c.verdict === 'unverified')).toHaveLength(0);
    for (const c of item.acceptance_criteria) {
      expect(c.evidence.some((e) => e.kind === 'command')).toBe(true);
    }
  });
});
