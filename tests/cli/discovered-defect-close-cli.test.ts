import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompletionStore, buildCompletion } from '~/core/completion-store';
import { WorkItemStore } from '~/core/work-item-store';

// ac-10 (wi_2607148yg): the lightweight `work done` close path must BLOCK when a
// discovered real-behavior defect was left UNMATERIALIZED (mentioned but not
// persisted into a work item = worthless, source intent), and RELEASE once the
// defect is materialized (grounding = the work-item pointer). GATE ONLY — the
// lightweight path never DRIVES the fix and never hard-blocks-until-user: a
// materialized defect releases the close. These exercise the REAL CLI wiring
// (discoveredDefectCloseBlockers) alongside the existing pass-close gates.

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
let dir: string;

function ditto(args: string[]) {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], {
    cwd: dir,
    env: { ...process.env, DITTO_AUTOPILOT_BYPASS: '1' },
  });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

async function workItemWithRealAC() {
  return new WorkItemStore(dir).create({
    title: 'in-scope work',
    source_request: 'do the thing',
    goal: 'the thing is done',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'the command exits 0', verdict: 'unverified', evidence: [] },
    ],
  });
}

const cmdEv = () => ({ kind: 'command' as const, command: 'bun test', summary: 'exit 0' });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-defectclose-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto work done — discovered-defect close gate (ac-10)', () => {
  // (a) an UNMATERIALIZED discovered defect blocks the close.
  test('a PASS completion carrying an UNMATERIALIZED discovered_defect is BLOCKED at work done', async () => {
    const wi = await workItemWithRealAC();
    // out_of_scope so the pass derives (a discovered defect is captured, not an
    // in-scope AC), but resolvability=discovered_defect with NO grounding = it was
    // never materialized into a work item → the close gate must fire.
    const completion = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 'pass with an unmaterialized discovered defect',
      verdicts: [{ criterion_id: 'ac-1', verdict: 'pass', evidence: [cmdEv()] }],
      unverified: [
        {
          item: 'null-deref in parseConfig when the file is empty',
          reason: 'reproduced mid-work; a real-behavior bug',
          out_of_scope: true,
          resolvability: 'discovered_defect',
        },
      ],
    });
    expect(completion.final_verdict).toBe('pass');
    await new CompletionStore(dir).write(completion);

    const d = ditto(['work', 'done', wi.id, '--output', 'json']);
    expect(d.exitCode).not.toBe(0);
    expect(`${d.stderr}${d.stdout}`).toMatch(/discovered defect|materialize/i);
    expect((await new WorkItemStore(dir).get(wi.id)).status).not.toBe('done');
  });

  // (b) a FABRICATED grounding pointer (a wi_ id that was never created) does NOT release —
  // the close stays BLOCKED. This is the ac-10 claim-not-proof fix: a non-empty grounding
  // string is not enough; it must resolve to a REAL materialized work item.
  test('a FABRICATED discovered_defect grounding (nonexistent work item) is BLOCKED at work done', async () => {
    const wi = await workItemWithRealAC();
    const completion = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 'pass with a fabricated discovered-defect pointer',
      verdicts: [{ criterion_id: 'ac-1', verdict: 'pass', evidence: [cmdEv()] }],
      unverified: [
        {
          item: 'null-deref in parseConfig when the file is empty',
          reason: 'reproduced mid-work; claims materialization but the WI never existed',
          out_of_scope: true,
          resolvability: 'discovered_defect',
          grounding: 'wi_defect0001', // never created — a fabricated pointer
        },
      ],
    });
    expect(completion.final_verdict).toBe('pass');
    await new CompletionStore(dir).write(completion);

    const d = ditto(['work', 'done', wi.id, '--output', 'json']);
    expect(d.exitCode).not.toBe(0);
    expect(`${d.stderr}${d.stdout}`).toMatch(/does not exist|materialize/i);
    expect((await new WorkItemStore(dir).get(wi.id)).status).not.toBe('done');
  });

  // (c) once MATERIALIZED into a REAL work item (grounding carries that WI's id), the close
  // is RELEASED — the gate never hard-blocks; materialize → release (no drive on this path).
  test('a discovered_defect grounded on a REAL materialized work item RELEASES the close', async () => {
    const wi = await workItemWithRealAC();
    // materialize the discovered defect into an ACTUAL back-linked work item first.
    const defectWi = await new WorkItemStore(dir).create({
      title: 'defect: null-deref in parseConfig',
      source_request: `Discovered while working on ${wi.id}`,
      goal: 'fix the null-deref',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'no crash on empty config', verdict: 'unverified', evidence: [] },
      ],
      discovered_by: wi.id,
    });
    const completion = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 'pass with a materialized discovered defect',
      verdicts: [{ criterion_id: 'ac-1', verdict: 'pass', evidence: [cmdEv()] }],
      unverified: [
        {
          item: 'null-deref in parseConfig when the file is empty',
          reason: 'reproduced mid-work; materialized to backlog',
          out_of_scope: true,
          resolvability: 'discovered_defect',
          grounding: `materialized as ${defectWi.id} (backlog)`,
        },
      ],
    });
    expect(completion.final_verdict).toBe('pass');
    await new CompletionStore(dir).write(completion);

    const d = ditto(['work', 'done', wi.id, '--output', 'json']);
    expect(d.exitCode).toBe(0);
    expect((await new WorkItemStore(dir).get(wi.id)).status).toBe('done');
  });
});
