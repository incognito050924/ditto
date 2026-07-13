import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTidySubgraph } from '~/acg/tidy/subgraph';
import { ActiveNodeLeaseStore } from '~/core/active-node-lease';
import { buildInitialNodes } from '~/core/autopilot-graph';
import { nextNode, recordResult } from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import { preToolUseHandler } from '~/hooks/pre-tool-use';
import type { Autopilot } from '~/schemas/autopilot';

const NOW = new Date('2026-06-01T00:00:00.000Z');
const git = (cwd: string, args: string[]) =>
  Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });

let repo: string;
let aps: AutopilotStore;
let wis: WorkItemStore;
let WI: string;
let baseSha: string;

function graph(nodes: Autopilot['nodes']): Autopilot {
  return {
    schema_version: '0.1.0',
    autopilot_id: 'orch_tidywire',
    work_item_id: WI,
    mode: 'autopilot',
    root_goal: 'goal',
    completion_boundary: 'entire_work_item',
    approval_gate: {
      status: 'not_required',
      source: 'small_reversible_policy',
      approved_at: null,
      approved_by: null,
      evidence_refs: [],
    },
    nodes,
    caps: {
      fix_per_node: 2,
      switch_per_node: 1,
      converge_rounds: 3,
      oracle_failures_to_block: 3,
      loop_rounds: 12,
      no_progress_rounds: 3,
      progress_continuation_cap: 24,
    },
    continue_policy: {
      continue_after_approval: true,
      continue_after_checkpoint: true,
      continue_after_fixable_failure: true,
      ask_user_only_for_user_owned_decisions: true,
    },
    stop_conditions: [],
    user_interrupt_policy: 'ask_only_for_user_owned_decisions',
  };
}

/** Seed graph with N2 (implement) dispatched to running, ready to record a pass. */
function runningImplement(acIds = ['ac-1']): Autopilot['nodes'] {
  return buildInitialNodes(acIds).map((n) =>
    n.id === 'N2' ? { ...n, status: 'running' as const } : n,
  );
}

beforeEach(async () => {
  // A REAL git repo so the runtime classifier can read a diff-stat (numstat).
  repo = await mkdtemp(join(tmpdir(), 'ditto-tidywire-'));
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 't@t.t']);
  git(repo, ['config', 'user.name', 't']);
  await writeFile(join(repo, 'placeholder.txt'), 'x\n');
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '-m', 'base']);
  baseSha = (git(repo, ['rev-parse', 'HEAD']).stdout?.toString() ?? '').trim();

  aps = new AutopilotStore(repo);
  wis = new WorkItemStore(repo);
  const wi = await wis.create(
    {
      title: 'tidy wiring',
      source_request: 'wire tidy',
      goal: 'tidy stage runs on green implement',
      acceptance_criteria: [{ id: 'ac-1', statement: 'a', verdict: 'unverified', evidence: [] }],
    },
    NOW,
  );
  WI = wi.id;
  // started_at_sha is the tidy base (the just-made diff is base...HEAD).
  await wis.update(WI, (w) => ({ ...w, started_at_sha: baseSha }));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('recordResult tidy stage (WU-3 ac-1: green implement → ⓪ ENTER → ④/⑦ subgraph splice)', () => {
  test('ENTER on a sizeable code diff splices a tidy subgraph after the implement node', async () => {
    // Make + commit a sizeable code diff so the classifier ENTERs (>20 lines).
    const body = `${Array.from({ length: 30 }, (_, i) => `export const k${i} = ${i};`).join('\n')}\n`;
    await writeFile(join(repo, 'src.ts'), body);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'impl']);

    await aps.write(WI, graph(runningImplement()));
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N2',
        result_text: 'Implemented the change; all DoD green. Changed src.ts. Suite green, exit 0.',
        outcome: 'pass',
        changed_files: ['src.ts'],
      },
    });
    expect(res.status).toBe('passed');
    expect(res.promoted_node_ids.length).toBeGreaterThan(0);

    const after = await aps.get(WI);
    const tidyRefactor = after.nodes.filter((n) => n.kind === 'refactor');
    const tidyVerify = after.nodes.filter(
      (n) => n.kind === 'verify' && n.depends_on.some((d) => d.startsWith('N2t')),
    );
    expect(tidyRefactor.length).toBe(1);
    expect(tidyVerify.length).toBe(1);
    // cleanup node roots at the implement node and carries a DECLARED file_scope
    expect(tidyRefactor[0]?.depends_on).toContain('N2');
    expect(tidyRefactor[0]?.file_scope).toEqual(['src.ts']);
    // the replay verify carries the implementation acceptance ids (⑦ DoD replay)
    expect(tidyVerify[0]?.acceptance_refs).toEqual(['ac-1']);

    // The ⓪ classifier verdict is left as an artifact (G3).
    const classPath = join(repo, '.ditto', 'local', 'work-items', WI, 'tidy-classification.json');
    expect(await Bun.file(classPath).exists()).toBe(true);
    const verdict = JSON.parse(await Bun.file(classPath).text());
    expect(verdict.decision).toBe('ENTER');
  });

  test('SKIP on a docs-only diff splices NO tidy nodes', async () => {
    await writeFile(join(repo, 'README.md'), `${'doc line\n'.repeat(40)}`);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-q', '-m', 'docs']);

    await aps.write(WI, graph(runningImplement()));
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N2',
        result_text: 'Edited docs only; README updated. No code changed. Suite green, exit 0.',
        outcome: 'pass',
        changed_files: ['README.md'],
      },
    });
    expect(res.status).toBe('passed');
    const after = await aps.get(WI);
    expect(after.nodes.filter((n) => n.kind === 'refactor').length).toBe(0);
    const verdict = JSON.parse(
      await Bun.file(
        join(repo, '.ditto', 'local', 'work-items', WI, 'tidy-classification.json'),
      ).text(),
    );
    expect(verdict.decision).toBe('SKIP');
  });

  test('no started_at_sha (no base) fails open to SKIP — no tidy nodes, no throw', async () => {
    await wis.update(WI, (w) => ({ ...w, started_at_sha: undefined }));
    await aps.write(WI, graph(runningImplement()));
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N2',
        result_text: 'Implemented the change with evidence; suite green, exit 0.',
        outcome: 'pass',
        changed_files: ['src.ts'],
      },
    });
    expect(res.status).toBe('passed');
    const after = await aps.get(WI);
    expect(after.nodes.filter((n) => n.kind === 'refactor').length).toBe(0);
  });
});

/** A graph with an implement node (passed) + one running tidy refactor node. */
function tidyGraph(): Autopilot['nodes'] {
  return [
    {
      id: 'N1',
      kind: 'design',
      owner: 'planner',
      purpose: 'plan',
      status: 'passed',
      depends_on: [],
      acceptance_refs: ['ac-1'],
      evidence_refs: [],
      ac_verdicts: [],
      attempts: { fix: 0, switch: 0 },
    },
    {
      id: 'N2',
      kind: 'implement',
      owner: 'implementer',
      purpose: 'impl',
      status: 'passed',
      depends_on: ['N1'],
      acceptance_refs: ['ac-1'],
      evidence_refs: [],
      ac_verdicts: [],
      attempts: { fix: 0, switch: 0 },
    },
    {
      id: 'N2tc1',
      kind: 'refactor',
      owner: 'refactorer',
      purpose: 'tidy src.ts',
      status: 'running',
      depends_on: ['N2'],
      acceptance_refs: [],
      evidence_refs: [],
      ac_verdicts: [],
      attempts: { fix: 0, switch: 0 },
      file_scope: ['src.ts'],
    },
    {
      id: 'N2treplay',
      kind: 'verify',
      owner: 'verifier',
      purpose: 'replay DoD',
      status: 'pending',
      depends_on: ['N2tc1'],
      acceptance_refs: ['ac-1'],
      evidence_refs: [],
      ac_verdicts: [],
      attempts: { fix: 0, switch: 0 },
    },
  ];
}

describe('recordResult tidy failure policy (WU-3 ac-4: bug found → implement node back to pending)', () => {
  test('a tidy node reporting a found bug returns the implement node to pending and does NOT retry the tidy node in place', async () => {
    await aps.write(WI, graph(tidyGraph()));
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N2tc1',
        result_text:
          'While tidying src.ts I found a real bug: the off-by-one in the loop bound means the last element is dropped. This is a defect in the implementation, not a cleanup concern.',
        outcome: 'fail',
        failure_class: 'fixable',
        tidy_bug_found: true,
      },
    });
    const after = await aps.get(WI);
    // The implement node is returned to pending so it (and a fresh tidy stage) re-runs.
    expect(after.nodes.find((n) => n.id === 'N2')?.status).toBe('pending');
    // The tidy node is NOT retried in place: its attempts.fix is unchanged (0) and
    // it is not put back to pending for re-dispatch.
    const tidyNode = after.nodes.find((n) => n.id === 'N2tc1');
    expect(tidyNode?.attempts.fix).toBe(0);
    expect(tidyNode?.status).not.toBe('pending');
    expect(tidyNode?.status).not.toBe('running');
    // The result reports the returned implement node.
    expect(res.outcome).toBe('fail');
    expect(res.reason.toLowerCase()).toContain('implement');
  });

  test('a tidy node that fails 3 times stops and reports without a 4th attempt (ac-5)', async () => {
    // 3-strike: with fix_per_node = 2, two retries are spent then the 3rd fail
    // caps out (the policy retries while attempts.fix < cap and escalates at ==).
    // Three dispatched failures, no 4th attempt.
    const g = graph(tidyGraph());
    g.caps = {
      fix_per_node: 2,
      switch_per_node: 1,
      converge_rounds: 3,
      oracle_failures_to_block: 3,
      loop_rounds: 12,
      no_progress_rounds: 3,
      progress_continuation_cap: 24,
    };
    await aps.write(WI, g);

    const failTidy = async () => {
      // re-dispatch the tidy node to running (a retry re-arms it to pending).
      await aps.updateNode(WI, 'N2tc1', (n) => ({ ...n, status: 'running' }));
      return recordResult(repo, {
        workItemId: WI,
        now: NOW,
        payload: {
          node_id: 'N2tc1',
          result_text:
            'The tidy extract still does not typecheck after another attempt — same local failure.',
          outcome: 'fail',
          failure_class: 'fixable',
        },
      });
    };

    const r1 = await failTidy();
    expect(r1.decision).toBe('retry');
    expect(r1.cap_exceeded).toBe(false);
    const r2 = await failTidy();
    expect(r2.decision).toBe('retry');
    expect(r2.cap_exceeded).toBe(false);
    // 3rd strike: cap reached → escalate (stop + report), node terminal, no 4th.
    const r3 = await failTidy();
    expect(r3.decision).toBe('escalate');
    expect(r3.cap_exceeded).toBe(true);
    expect(r3.status).toBe('failed');

    const after = await aps.get(WI);
    const tidy = after.nodes.find((n) => n.id === 'N2tc1');
    // Terminal: it is not pending (would invite a 4th dispatch); 2 retries spent.
    expect(tidy?.status).toBe('failed');
    expect(tidy?.attempts.fix).toBe(2);
  });

  test('a tidy node that fails WITHOUT a found-bug signal uses the normal retry policy (in place)', async () => {
    await aps.write(WI, graph(tidyGraph()));
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N2tc1',
        result_text:
          'The tidy edit failed to typecheck after the extract; retrying with a narrower move.',
        outcome: 'fail',
        failure_class: 'fixable',
      },
    });
    const after = await aps.get(WI);
    // No bug signal → the implement node is untouched (still passed).
    expect(after.nodes.find((n) => n.id === 'N2')?.status).toBe('passed');
    // Normal retry: the tidy node goes back to pending and consumed one fix attempt.
    expect(res.decision).toBe('retry');
    expect(after.nodes.find((n) => n.id === 'N2tc1')?.attempts.fix).toBe(1);
    expect(after.nodes.find((n) => n.id === 'N2tc1')?.status).toBe('pending');
  });
});

describe('tidy DoD replay (WU-3 ac-3: replay node carries the DoD + reports fitness-delta/replay green)', () => {
  /** Graph: implement+cleanup passed, tidy replay verify running, ready to record. */
  function replayReadyGraph(): Autopilot['nodes'] {
    const sub = buildTidySubgraph({
      implementNodeId: 'N2',
      fileBatches: [['src.ts']],
      acceptanceIds: ['ac-1'],
      idPrefix: 'N2t',
    }).map((n) => {
      if (n.kind === 'refactor') return { ...n, status: 'passed' as const };
      if (n.kind === 'verify') return { ...n, status: 'running' as const };
      return n;
    });
    const implement = buildInitialNodes(['ac-1']).find((n) => n.id === 'N2');
    if (!implement) throw new Error('expected N2');
    return [{ ...implement, depends_on: [], status: 'passed' as const }, ...sub];
  }

  test('a green DoD-replay pass on the tidy verify node closes it and persists the per-AC verdict', async () => {
    await aps.write(WI, graph(replayReadyGraph()));
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N2treplay',
        result_text:
          'Replayed the implementation DoD after tidy: all acceptance criteria green. Fitness delta = 0 new violations (dup/complexity unchanged vs pre-tidy snapshot). exit 0.',
        outcome: 'pass',
        ac_verdicts: [
          { criterion_id: 'ac-1', verdict: 'pass', notes: 'DoD replay green after tidy' },
        ],
        // ac-closing evidence guard (wi_260619zqa): a pass-verdict criterion must
        // carry evidence — the replay's exit-0 run is the proof, recorded as a
        // command evidenceRef (was [] under the old false-green-tolerant behavior).
        evidence_refs: [{ kind: 'command', command: 'bun test (DoD replay)', summary: 'exit 0' }],
      },
    });
    expect(res.status).toBe('passed');
    const after = await aps.get(WI);
    const replay = after.nodes.find((n) => n.id === 'N2treplay');
    expect(replay?.status).toBe('passed');
    // The DoD replay verdict is recorded per-AC (so completion cannot over-close it).
    expect(replay?.ac_verdicts).toEqual([
      { criterion_id: 'ac-1', verdict: 'pass', notes: 'DoD replay green after tidy' },
    ]);
  });

  test('a fitness-delta regression (new violations) is reported as a verify FAIL, not silently passed', async () => {
    await aps.write(WI, graph(replayReadyGraph()));
    const res = await recordResult(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        node_id: 'N2treplay',
        result_text:
          'Tidy introduced 2 new duplication violations vs the pre-tidy snapshot (fitness delta > 0). The DoD replay would pass but the delta gate fails — reporting fail so the tidy is not auto-accepted.',
        outcome: 'fail',
        failure_class: 'fixable',
      },
    });
    expect(res.outcome).toBe('fail');
    const after = await aps.get(WI);
    // The verify node did not silently pass; it is non-passed (retry/blocked/failed).
    expect(after.nodes.find((n) => n.id === 'N2treplay')?.status).not.toBe('passed');
  });
});

describe('tidy lease isolation (WU-3 ac-2: a declared-scope tidy node blocks out-of-scope edits, incl. parallel)', () => {
  const SESS = 'sess-tidy';

  /** Graph: implement passed + two parallel tidy refactor nodes (from buildTidySubgraph). */
  function parallelTidyGraph(): Autopilot['nodes'] {
    const sub = buildTidySubgraph({
      implementNodeId: 'N2',
      fileBatches: [['src/a.ts'], ['src/b.ts']],
      acceptanceIds: ['ac-1'],
      idPrefix: 'N2t',
    });
    // Implement node passed (the tidy stage roots on it); no competing pending seed
    // node — this test isolates the tidy parallel wave's lease enforcement.
    const implement = buildInitialNodes(['ac-1']).find((n) => n.id === 'N2');
    if (!implement) throw new Error('expected N2');
    return [{ ...implement, depends_on: [], status: 'passed' as const }, ...sub];
  }

  const edit = (rel: string, tool_name = 'Edit') =>
    preToolUseHandler({
      raw: { tool_name, tool_input: { file_path: join(repo, rel) }, session_id: SESS },
      repoRoot: repo,
      env: {},
    });

  test('nextNode dispatches the parallel tidy wave with DECLARED-scope leases (enforceable)', async () => {
    await new SessionPointerStore(repo).set(SESS, WI);
    await aps.write(WI, graph(parallelTidyGraph()));
    const res = await nextNode(repo, WI);
    // Two parallel tidy refactor nodes are wave-eligible (each declares its scope).
    expect(res.action).toBe('spawn_wave');
    if (res.action !== 'spawn_wave') throw new Error('expected spawn_wave');
    expect(res.spawns.map((s) => s.node_id).sort()).toEqual(['N2tc1', 'N2tc2']);

    // Both leases are DECLARED (the lease only enforces when EVERY lease is declared).
    const leases = await new ActiveNodeLeaseStore(repo).listActive(WI);
    expect(leases.map((l) => l.node_id).sort()).toEqual(['N2tc1', 'N2tc2']);
    expect(leases.every((l) => l.scope_source === 'declared')).toBe(true);

    // PreToolUse: an edit OUTSIDE every active tidy lease scope blocks (exit 2)…
    const blocked = await edit('src/c.ts');
    expect(blocked.exitCode).toBe(2);
    expect(blocked.stderr).toContain('autopilot-path');
    // …while an edit inside one tidy node's declared scope is allowed (exit 0).
    expect((await edit('src/a.ts')).exitCode).toBe(0);
    expect((await edit('src/b.ts')).exitCode).toBe(0);
    // Write/MultiEdit go through the same lease branch.
    expect((await edit('src/c.ts', 'Write')).exitCode).toBe(2);
  });
});
