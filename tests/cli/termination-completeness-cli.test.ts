import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompletionStore, buildCompletion } from '~/core/completion-store';
import { WorkItemStore } from '~/core/work-item-store';

// ac-1 (wi_260710tjd) TERMINATION-COMPLETENESS gate — WIRED-path evidence. Both
// terminal-flip close paths (`work done`, `autopilot complete`) flip the WI to
// `done` BEFORE the Stop hook can enforce the residual gates (the flip trips the
// Stop NON_TERMINAL guard, so a Stop-hook-only wire is bypassed — the "완료-판정
// 채널 갭"). These tests exercise the REAL CLI paths and assert the gate actually
// fires there (blocks the silent pass-close of an in-scope agent-owned residual),
// and — the no-deadlock clause — that a disposed/out-of-scope/legacy/lightweight
// close still terminates.

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

function git(args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
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
  dir = await mkdtemp(join(tmpdir(), 'ditto-termcomplete-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ── (a) work done: in-scope agent-owned undisposed residual blocks the pass-close ─
describe('ditto work done — termination-completeness gate (ac-1)', () => {
  test('a PASS completion parking an agent_resolvable residual is BLOCKED at work done (status stays open)', async () => {
    const wi = await workItemWithRealAC();
    // A pass completion (ac-1 pass + command evidence) that SILENTLY drops an
    // agent-resolvable residual into unverified[] (out_of_scope so the pass derives,
    // but agent_resolvable so parking it is the anti-pattern the gate must catch).
    const completion = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 'pass with a parked agent-resolvable residual',
      verdicts: [{ criterion_id: 'ac-1', verdict: 'pass', evidence: [cmdEv()] }],
      unverified: [
        {
          item: 'refactor the duplicated helper the fix left behind',
          reason: 'agent could resolve this but parked it',
          out_of_scope: true,
          resolvability: 'agent_resolvable',
        },
      ],
    });
    expect(completion.final_verdict).toBe('pass'); // out_of_scope residual → still a pass
    await new CompletionStore(dir).write(completion);

    const d = ditto(['work', 'done', wi.id, '--output', 'json']);
    expect(d.exitCode).not.toBe(0);
    expect(`${d.stderr}${d.stdout}`).toMatch(/residual|resolve|non_pass_status/i);
    // The done-flip was blocked — status is NOT done.
    expect((await new WorkItemStore(dir).get(wi.id)).status).not.toBe('done');
  });

  // (b) no-deadlock: a properly-DISPOSED / out-of-scope-only residual still closes.
  test('a PASS completion whose only residual is an out-of-scope note (no resolvability label) closes fine (no deadlock)', async () => {
    const wi = await workItemWithRealAC();
    const completion = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 'pass with a benign out-of-scope note',
      verdicts: [{ criterion_id: 'ac-1', verdict: 'pass', evidence: [cmdEv()] }],
      unverified: [
        {
          item: 'a nice-to-have idea for later',
          reason: 'captured, not this work',
          out_of_scope: true,
          // no resolvability label → a legacy/unlabeled out-of-scope capture, not a park
        },
      ],
    });
    expect(completion.final_verdict).toBe('pass');
    await new CompletionStore(dir).write(completion);

    const d = ditto(['work', 'done', wi.id, '--output', 'json']);
    expect(d.exitCode).toBe(0);
    expect((await new WorkItemStore(dir).get(wi.id)).status).toBe('done');
  });

  // (d) legacy in-flight fixture: a pre-disposition pass completion (NO resolvability
  // labels, NO non_pass_status, NO remaining_risk_records) still closes — the gate is
  // PRESENCE-keyed (blocks on a present blocking residual), never on ABSENCE of new
  // metadata, so 30+ legacy in-flight completions do not newly deadlock.
  test('a legacy in-flight pass completion (no new metadata) still closes', async () => {
    const wi = await workItemWithRealAC();
    const completion = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 'legacy pass completion (pre-disposition shape)',
      verdicts: [{ criterion_id: 'ac-1', verdict: 'pass', evidence: [cmdEv()] }],
    });
    expect(completion.non_pass_status).toBeUndefined();
    expect(completion.remaining_risk_records).toBeUndefined();
    expect(completion.unverified).toEqual([]);
    await new CompletionStore(dir).write(completion);

    const d = ditto(['work', 'done', wi.id, '--output', 'json']);
    expect(d.exitCode).toBe(0);
    expect((await new WorkItemStore(dir).get(wi.id)).status).toBe('done');
  });

  // (e) lightweight path (no intent.json) — start --criteria → verify → done closes;
  // the gate must not deadlock a lightweight WI (no materialized+tracked clause).
  test('lightweight path (no intent.json): start → verify → done closes (no deadlock)', async () => {
    const s = ditto([
      'work',
      'start',
      'the command returns 0',
      '--request',
      'fix it',
      '--criteria',
      'the command returns 0',
      '--output',
      'json',
    ]);
    expect(s.exitCode).toBe(0);
    const wid = JSON.parse(s.stdout).work_item_id as string;
    const intentPath = join(dir, '.ditto', 'local', 'work-items', wid, 'intent.json');
    expect(await Bun.file(intentPath).exists()).toBe(false);

    const wiPath = join(dir, '.ditto', 'local', 'work-items', wid, 'work-item.json');
    expect(ditto(['verify', wid, '--criterion', 'ac-1', '--', 'cat', wiPath]).exitCode).toBe(0);

    const d = ditto(['work', 'done', wid, '--output', 'json']);
    expect(d.exitCode).toBe(0);
    expect((await new WorkItemStore(dir).get(wid)).status).toBe('done');
    expect(await Bun.file(intentPath).exists()).toBe(false);
  });
});

// ── (a') autopilot complete: the gate fires on the OTHER close path too ──────────
describe('ditto autopilot complete — termination-completeness gate (ac-1)', () => {
  const WI = 'wi_termcomp01';

  async function write(name: string, obj: unknown): Promise<void> {
    await writeFile(
      join(dir, '.ditto', 'local', 'work-items', WI, name),
      `${JSON.stringify(obj, null, 2)}\n`,
      'utf8',
    );
  }

  async function seedWorkItem(): Promise<void> {
    await write('work-item.json', {
      schema_version: '0.1.0',
      id: WI,
      title: 'complete cli',
      source_request: 'add a thing',
      goal: 'the thing works',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'ac-1 holds', verdict: 'unverified', evidence: [] },
      ],
      status: 'in_progress',
      owner_profile: 'workspace-write',
      child_ids: [],
      changed_files: ['src/x.ts'],
      risks: [],
      runs: [],
      created_at: '2026-07-10T00:00:00.000Z',
      updated_at: '2026-07-10T00:00:00.000Z',
    });
  }

  // A verify node passed WITH command evidence → ac-1 pass → final_verdict pass.
  async function seedGraph(): Promise<void> {
    await write('autopilot.json', {
      schema_version: '0.1.0',
      autopilot_id: 'orch_termcomp1',
      work_item_id: WI,
      mode: 'autopilot',
      root_goal: 'the thing works',
      completion_boundary: 'entire_work_item',
      approval_gate: { status: 'not_required', source: 'small_reversible_policy' },
      nodes: [
        {
          id: 'N3',
          kind: 'verify',
          owner: 'verifier',
          purpose: 'verify ac-1',
          status: 'passed',
          depends_on: [],
          acceptance_refs: ['ac-1'],
          evidence_refs: [{ kind: 'command', path: 'bun test', summary: 'ac-1 passes' }],
          attempts: { fix: 0, switch: 0 },
        },
      ],
      caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: 3 },
      continue_policy: {},
      stop_conditions: [],
      user_interrupt_policy: 'ask_only_for_user_owned_decisions',
    });
  }

  async function readStatus(): Promise<string> {
    const raw = await readFile(
      join(dir, '.ditto', 'local', 'work-items', WI, 'work-item.json'),
      'utf8',
    );
    return JSON.parse(raw).status as string;
  }

  beforeEach(async () => {
    git(['init']);
    git(['config', 'user.email', 'tc@example.com']);
    git(['config', 'user.name', 'tc']);
    await mkdir(join(dir, '.ditto', 'local', 'work-items', WI), { recursive: true });
    await writeFile(join(dir, '.gitignore'), '.ditto/\n', 'utf8');
    git(['add', '.gitignore']);
    git(['commit', '-m', 'baseline']);
  });

  test('a PASS run carrying an UNRESOLVED agent_resolvable risk is BLOCKED before the done-flip', async () => {
    await seedWorkItem();
    await seedGraph();
    // Stage the declared changed file so that — WITHOUT the gate — the land step
    // succeeds and the run flips to done (a real RED on the gate assertion, not a
    // land failure). WITH the gate, the block fires BEFORE land, so nothing commits.
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'x.ts'), 'export const x = 1;\n', 'utf8');
    git(['add', 'src/x.ts']);
    // An auto_fix / agent_resolvable decision with NO re-verify recheck node → the
    // completion producer projects it into remaining_risk_records (undisposed) → the
    // gate must block the done-flip (silent shrink on an otherwise-pass run).
    await writeFile(
      join(dir, '.ditto', 'local', 'work-items', WI, 'autopilot-decisions.jsonl'),
      `${JSON.stringify({
        ts: '2026-07-10T00:00:01.000Z',
        node_id: 'N3',
        decision: 'auto_fix',
        resolvability: 'agent_resolvable',
        reason: 'auto-fix residual risk: leftover TODO the fix could resolve',
      })}\n`,
      'utf8',
    );

    const res = ditto(['autopilot', 'complete', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).not.toBe(0);
    expect(`${res.stderr}${res.stdout}`).toMatch(/residual|resolve/i);
    // NOT flipped to done — the residual must be resolved first.
    expect(await readStatus()).not.toBe('done');
  });

  test('a clean PASS run with no undisposed residual still flips to done (no over-block)', async () => {
    await seedWorkItem();
    await seedGraph();
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'src', 'x.ts'), 'export const x = 1;\n', 'utf8');
    git(['add', 'src/x.ts']);

    const res = ditto(['autopilot', 'complete', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout.slice(res.stdout.indexOf('{')));
    expect(out.final_verdict).toBe('pass');
    expect(out.auto_close?.outcome).toBe('flipped');
    expect(await readStatus()).toBe('done');
  });
});
