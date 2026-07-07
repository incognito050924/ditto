import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const WI = 'wi_loopcli01';

let dir: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
}

function spawnDitto(args: string[]): { stdout: string; stderr: string; exitCode: number | null } {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], { cwd: dir, env: { ...process.env } });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

function node(id: string, kind: string, owner: string, depends_on: string[]) {
  return {
    id,
    kind,
    owner,
    purpose: `${kind} step`,
    status: 'pending',
    depends_on,
    acceptance_refs: ['ac-1'],
    evidence_refs: [],
    attempts: { fix: 0, switch: 0 },
  };
}

async function seed(): Promise<void> {
  const wiDir = join(dir, '.ditto', 'local', 'work-items', WI);
  await mkdir(wiDir, { recursive: true });
  await writeFile(
    join(wiDir, 'work-item.json'),
    `${JSON.stringify(
      {
        schema_version: '0.1.0',
        id: WI,
        title: 'loop cli test',
        source_request: 'drive the loop via CLI',
        goal: 'next-node and record-result work end to end',
        acceptance_criteria: [
          { id: 'ac-1', statement: 'loop steps work', verdict: 'unverified', evidence: [] },
        ],
        status: 'in_progress',
        owner_profile: 'workspace-write',
        child_ids: [],
        changed_files: ['src/x.ts'],
        risks: [],
        runs: [],
        created_at: '2026-06-01T00:00:00.000Z',
        updated_at: '2026-06-01T00:00:00.000Z',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(
    join(wiDir, 'autopilot.json'),
    `${JSON.stringify(
      {
        schema_version: '0.1.0',
        autopilot_id: 'orch_loopcli01',
        work_item_id: WI,
        mode: 'autopilot',
        root_goal: 'drive the loop',
        completion_boundary: 'entire_work_item',
        approval_gate: {
          status: 'not_required',
          source: 'small_reversible_policy',
          approved_at: null,
          approved_by: null,
          evidence_refs: [],
        },
        nodes: [
          node('N1', 'design', 'planner', []),
          node('N2', 'implement', 'implementer', ['N1']),
          node('N3', 'verify', 'verifier', ['N2']),
        ],
        caps: { fix_per_node: 2, switch_per_node: 1 },
        continue_policy: {
          continue_after_approval: true,
          continue_after_checkpoint: true,
          continue_after_fixable_failure: true,
          ask_user_only_for_user_owned_decisions: true,
        },
        stop_conditions: [],
        user_interrupt_policy: 'ask_only_for_user_owned_decisions',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-loopcli-'));
  git(['init']);
  git(['config', 'user.email', 't@t.test']);
  git(['config', 'user.name', 't']);
  await mkdir(join(dir, '.ditto'), { recursive: true });
  await seed();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto autopilot next-node / record-result (G9 loop step CLI)', () => {
  test('next-node dispatches the first ready node and returns a packet', async () => {
    const res = spawnDitto(['autopilot', 'next-node', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.action).toBe('spawn');
    expect(payload.node_id).toBe('N1');
    expect(payload.owner).toBe('planner');
    expect(payload.packet.context.file_scope).toEqual(['src/x.ts']);
    // persisted: N1 now running
    const graph = JSON.parse(
      await Bun.file(join(dir, '.ditto', 'local', 'work-items', WI, 'autopilot.json')).text(),
    );
    expect(graph.nodes.find((n: { id: string }) => n.id === 'N1').status).toBe('running');
  });

  test('record-result: G7 overrides an ack-only result claimed as pass to fixable', async () => {
    spawnDitto(['autopilot', 'next-node', '--workItem', WI, '--output', 'json']); // dispatch N1
    const res = spawnDitto([
      'autopilot',
      'record-result',
      '--workItem',
      WI,
      '--output',
      'json',
      '--json',
      JSON.stringify({ node_id: 'N1', result_text: 'done', outcome: 'pass' }),
    ]);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.guard_contentful).toBe(false);
    expect(payload.outcome).toBe('fail');
    expect(payload.status).toBe('pending');
    const graph = JSON.parse(
      await Bun.file(join(dir, '.ditto', 'local', 'work-items', WI, 'autopilot.json')).text(),
    );
    expect(graph.nodes.find((n: { id: string }) => n.id === 'N1').status).toBe('pending');
  });

  test('record-result rejects a fail payload missing failure_class (usage error)', async () => {
    spawnDitto(['autopilot', 'next-node', '--workItem', WI, '--output', 'json']);
    const res = spawnDitto([
      'autopilot',
      'record-result',
      '--workItem',
      WI,
      '--json',
      JSON.stringify({ node_id: 'N1', result_text: 'real failure detail here', outcome: 'fail' }),
    ]);
    expect(res.exitCode).toBe(65); // USAGE_ERROR_EXIT
    expect(res.stderr).toContain('failure_class');
  });

  test('next-node on an unknown work item errors with a clear message', async () => {
    const res = spawnDitto([
      'autopilot',
      'next-node',
      '--workItem',
      'wi_nope0000',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain('autopilot.json missing');
  });
});

describe('ditto autopilot complete — e2e 완료 게이트 (O-4/O-18)', () => {
  test('웹 표면 changed_files + 제안 결정 부재 → complete가 거부한다', async () => {
    // changed_files에 웹 표면(.tsx)을 넣되, 제안 결정 레코드는 만들지 않는다.
    const wiPath = join(dir, '.ditto', 'local', 'work-items', WI, 'work-item.json');
    const wi = JSON.parse(await Bun.file(wiPath).text());
    wi.changed_files = ['src/pages/Home.tsx'];
    await writeFile(wiPath, `${JSON.stringify(wi, null, 2)}\n`, 'utf8');

    const res = spawnDitto(['autopilot', 'complete', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).not.toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.e2e_gate.map((v: { code: string }) => v.code)).toContain('proposal_missing');
    // completion.json이 조립되지 않았다 — 의무 미이행 상태로는 닫히지 않는다.
    expect(
      await Bun.file(join(dir, '.ditto', 'local', 'work-items', WI, 'completion.json')).exists(),
    ).toBe(false);
  });

  test('웹 표면이 아니면 게이트는 침묵하고 complete가 정상 진행된다', async () => {
    const res = spawnDitto(['autopilot', 'complete', '--workItem', WI, '--output', 'json']);
    // changed_files=['src/x.ts'] — 웹 표면 아님, journeys 디렉토리 없음.
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.final_verdict).toBeDefined();
  });
});

describe('ditto autopilot complete — intent-drift conservation 게이트 (false-green 차단, wi_260624xb8 ac-2/ac-3)', () => {
  async function writeIntent(acIds: string[]): Promise<void> {
    const wiDir = join(dir, '.ditto', 'local', 'work-items', WI);
    await writeFile(
      join(wiDir, 'intent.json'),
      `${JSON.stringify(
        {
          schema_version: '0.1.0',
          work_item_id: WI,
          source_request: 'drive the loop via CLI',
          goal: 'next-node and record-result work end to end',
          acceptance_criteria: acIds.map((id) => ({
            id,
            statement: `criterion ${id} is met`,
            evidence_required: ['test'],
          })),
          question_policy: 'ask_only_if_user_only_can_answer',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
  }

  // ac-1을 evidence와 함께 닫는다 → work-item이 ac-1만 보면 final_verdict=pass(=false-green
  // 재현 조건). conservation 게이트가 없으면 complete가 pass를 방출한다.
  async function closeAc1(): Promise<void> {
    const graphPath = join(dir, '.ditto', 'local', 'work-items', WI, 'autopilot.json');
    const graph = JSON.parse(await Bun.file(graphPath).text());
    for (const n of graph.nodes) {
      n.status = 'passed';
      n.evidence_refs = [{ kind: 'note', summary: `ac-1 closed by ${n.id}` }];
    }
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
  }

  test('work item AC가 intent보다 적으면(scope shrink) complete가 final_verdict=pass를 산출하지 않는다', async () => {
    // intent엔 ac-1..ac-5, work-item.json엔 seed의 ac-1만. bootstrap 동기화가
    // 안 된 상태에서 complete가 ac-2..ac-5를 못 보고 false-green을 내던 경로.
    await writeIntent(['ac-1', 'ac-2', 'ac-3', 'ac-4', 'ac-5']);
    await closeAc1();
    const res = spawnDitto(['autopilot', 'complete', '--workItem', WI, '--output', 'json']);
    // 차단(non-zero) 또는 비-pass — 둘 다 false-green 방지로 허용. pass 방출만 금지.
    if (res.exitCode === 0) {
      const out = JSON.parse(res.stdout);
      expect(out.final_verdict).not.toBe('pass');
    } else {
      // 차단 시 false-green completion.json이 디스크에 남지 않는다.
      const written = await Bun.file(
        join(dir, '.ditto', 'local', 'work-items', WI, 'completion.json'),
      ).exists();
      if (written) {
        const comp = JSON.parse(
          await Bun.file(join(dir, '.ditto', 'local', 'work-items', WI, 'completion.json')).text(),
        );
        expect(comp.final_verdict).not.toBe('pass');
      }
    }
  });

  test('work item AC = intent AC(정상 경로)면 complete가 종전대로 진행된다', async () => {
    // seed work-item.json은 ac-1만 — intent도 ac-1만이면 conservation 통과.
    await writeIntent(['ac-1']);
    const res = spawnDitto(['autopilot', 'complete', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.final_verdict).toBeDefined();
  });
});

describe('ditto autopilot complete — ac-4 표식 단독 성공판정 금지 (cite cross-check 배선)', () => {
  test('완료 경로가 cite_cross_check를 advisory로 방출한다 (push 없음 → not-applicable)', async () => {
    // 워밍스타트 usage 로그 없음 ⇒ cite verdict=skip ⇒ cross-check=not-applicable.
    const res = spawnDitto(['autopilot', 'complete', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.cite_cross_check).toBeDefined();
    expect(out.cite_cross_check.combined).toBe('not-applicable');
    expect(out.cite_cross_check.advisory).toBe(true);
    // advisory: cross-check가 final_verdict나 exit code를 바꾸지 않는다.
    expect(out.cite_cross_check).not.toHaveProperty('block');
  });

  test('lineage-pushed 노드가 결정을 인용하면 cite=pass → cross-check는 실제 cite 결과를 검증한다 (baseline 없음 → cannot-confirm)', async () => {
    // 인용한 노드 출력 + actionable usage 레코드 ⇒ cite verdict=pass.
    const wiDir = join(dir, '.ditto', 'local', 'work-items', WI);
    const graphPath = join(wiDir, 'autopilot.json');
    const graph = JSON.parse(await Bun.file(graphPath).text());
    graph.nodes[0].evidence_refs = [
      { kind: 'note', summary: 'followed decision:d1 (ADR-0007) on internal_packages' },
    ];
    await writeFile(graphPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8');
    const usageDir = join(wiDir, 'memory');
    await mkdir(usageDir, { recursive: true });
    await writeFile(
      join(usageDir, 'warmstart-usage.jsonl'),
      `${JSON.stringify({
        ts: '2026-06-17T00:00:00.000Z',
        work_item_id: WI,
        node_id: 'N1',
        owner: 'planner',
        opportunity: true,
        attempt: true,
        hit: true,
        actionable: true,
      })}\n`,
      'utf8',
    );

    const res = spawnDitto(['autopilot', 'complete', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.cite_gate.verdict).toBe('pass');
    // 인용은 했으나(re-proposal) baseline 비교가 없으므로 표식 단독으로 성공 판정 안 함.
    expect(out.cite_cross_check.combined).toBe('cannot-confirm');
    expect(out.cite_cross_check.cite_verdict).toBe('pass');
  });
});

describe('ditto autopilot complete — ac-6 attestation + auto-handling ledger (T1 출력 배선)', () => {
  test('per-AC 양성 attestation을 방출한다 (verified/reasoned/blocked)', async () => {
    // seed 노드는 pending → ac-1 unverified → reasoned-honest-partial.
    const res = spawnDitto(['autopilot', 'complete', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.attestation).toEqual([
      {
        criterion_id: 'ac-1',
        state: 'reasoned-honest-partial',
        basis: 'addressing node not terminal',
      },
    ]);
  });

  test('결정 로그의 auto_fix/surface/batch_escalate를 auto_handling 원장으로 투영한다', async () => {
    const wiDir = join(dir, '.ditto', 'local', 'work-items', WI);
    const decisions = [
      {
        ts: '2026-06-02T00:00:00.000Z',
        node_id: 'N3',
        decision: 'auto_fix',
        resolvability: 'agent_resolvable',
        reason: 'auto-fix residual risk: missing null guard',
      },
      {
        ts: '2026-06-02T00:00:01.000Z',
        node_id: 'N3',
        decision: 'surface',
        resolvability: 'blocked_external',
        reason: 'surface residual risk in-flow (blocked_external): codeql absent',
      },
      {
        ts: '2026-06-02T00:00:02.000Z',
        node_id: 'N3',
        decision: 'batch_escalate',
        resolvability: 'out_of_scope',
        reason: 'batch-escalate 1 out-of-scope follow-up(s)',
      },
      {
        ts: '2026-06-02T00:00:03.000Z',
        node_id: 'N3',
        decision: 'loop_terminated',
        disposition: 'blocked',
        reason: 'partial run',
      },
    ];
    await writeFile(
      join(wiDir, 'autopilot-decisions.jsonl'),
      `${decisions.map((d) => JSON.stringify(d)).join('\n')}\n`,
      'utf8',
    );
    const res = spawnDitto(['autopilot', 'complete', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.auto_handling.auto_fixed).toEqual([
      {
        node_id: 'N3',
        decision: 'auto_fix',
        resolvability: 'agent_resolvable',
        reason: 'auto-fix residual risk: missing null guard',
      },
    ]);
    expect(out.auto_handling.surfaced).toEqual([
      {
        node_id: 'N3',
        decision: 'surface',
        resolvability: 'blocked_external',
        reason: 'surface residual risk in-flow (blocked_external): codeql absent',
      },
    ]);
    expect(out.auto_handling.materialized).toEqual([
      {
        node_id: 'N3',
        decision: 'batch_escalate',
        resolvability: 'out_of_scope',
        reason: 'batch-escalate 1 out-of-scope follow-up(s)',
      },
    ]);
  });

  test('아무것도 자동처리 안 했으면 빈 원장 (human 출력에 none)', async () => {
    const res = spawnDitto(['autopilot', 'complete', '--workItem', WI]); // human
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('attestation (per-AC, ac-6):');
    expect(res.stdout).toContain('auto-handling ledger (ac-6): none');
  });
});

describe('ditto autopilot complete — ac-4 방향 결정 섹션 (dedicated direction ledger)', () => {
  async function seedDirection(): Promise<void> {
    const wiDir = join(dir, '.ditto', 'local', 'work-items', WI);
    const decision = {
      ts: '2026-06-02T00:00:00.000Z',
      node_id: 'N2',
      decision: 'direction',
      reason: 'autonomous direction fork on the frozen purpose',
      direction_record: {
        fork_node_id: 'N1',
        trigger: 'seed 접근이 AC를 만족 못 함',
        options: ['A: 어댑터 확장', 'B: 스키마 우회'],
        choice: 'A: 어댑터 확장',
        intent_basis: 'frozen purpose는 스키마 SoT 보존을 요구',
        blast_radius: 'src/core/x.ts + 2 callers',
        reverse_cost: 'single revert commit',
      },
    };
    await writeFile(
      join(wiDir, 'autopilot-decisions.jsonl'),
      `${JSON.stringify(decision)}\n`,
      'utf8',
    );
  }

  test('JSON 출력이 direction_decisions를 4개 공개 필드와 함께 방출한다', async () => {
    await seedDirection();
    const res = spawnDitto(['autopilot', 'complete', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.direction_decisions).toHaveLength(1);
    const d = out.direction_decisions[0];
    expect(d.node_id).toBe('N2');
    expect(d.fork_node_id).toBe('N1');
    expect(typeof d.decision_id).toBe('string');
    expect(d.trigger).toBe('seed 접근이 AC를 만족 못 함');
    expect(d.options).toEqual(['A: 어댑터 확장', 'B: 스키마 우회']);
    expect(d.choice).toBe('A: 어댑터 확장');
    expect(d.intent_basis).toBe('frozen purpose는 스키마 SoT 보존을 요구');
    expect(d.blast_radius).toBe('src/core/x.ts + 2 callers');
    expect(d.reverse_cost).toBe('single revert commit');
  });

  test('human 출력이 전용 방향 결정 섹션에 4개 필드를 렌더한다', async () => {
    await seedDirection();
    const res = spawnDitto(['autopilot', 'complete', '--workItem', WI]); // human
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('방향 결정 (direction forks, ac-4): 1건');
    expect(res.stdout).toContain('무엇때문에: seed 접근이 AC를 만족 못 함');
    expect(res.stdout).toContain('선택지: A: 어댑터 확장; B: 스키마 우회');
    expect(res.stdout).toContain(
      '선택+의도근거: A: 어댑터 확장 — frozen purpose는 스키마 SoT 보존을 요구',
    );
    expect(res.stdout).toContain(
      '파급/되돌리기비용: src/core/x.ts + 2 callers / single revert commit',
    );
  });

  test('방향 결정이 없으면 none 을 렌더한다', async () => {
    const res = spawnDitto(['autopilot', 'complete', '--workItem', WI]); // human
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('방향 결정 (direction forks, ac-4): none');
  });
});

describe('ditto autopilot revise — ac-5 방향 fork 하류 재구동 (fresh ids, K-block 회피)', () => {
  const decisionsPath = () =>
    join(dir, '.ditto', 'local', 'work-items', WI, 'autopilot-decisions.jsonl');
  const graphPath = () => join(dir, '.ditto', 'local', 'work-items', WI, 'autopilot.json');

  async function readGraph(): Promise<{
    nodes: Array<{ id: string; status: string; depends_on: string[] }>;
  }> {
    return JSON.parse(await Bun.file(graphPath()).text());
  }
  async function readDecisions(): Promise<
    Array<{ node_id: string; reason: string; decision: string }>
  > {
    const text = await Bun.file(decisionsPath()).text();
    return text
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l));
  }

  // Seed: N3 (a downstream node of fork N1) already accumulated K stale
  // `oracle-unsatisfied` failures, then a `direction` fork was taken at N1.
  async function seedForkAndStaleFailures(): Promise<void> {
    const staleFailures = [0, 1, 2].map((k) => ({
      ts: `2026-06-02T00:00:0${k}.000Z`,
      node_id: 'N3',
      decision: 'retry',
      reason: `oracle-unsatisfied: ac-1 recheck ${k}`,
      criterion_ids: ['ac-1'],
    }));
    const direction = {
      ts: '2026-06-02T00:00:09.000Z',
      node_id: 'N2',
      decision: 'direction',
      reason: 'autonomous direction fork on the frozen purpose',
      direction_record: {
        fork_node_id: 'N1',
        trigger: 'seed 접근이 AC를 만족 못 함',
        options: ['A', 'B'],
        choice: 'A',
        intent_basis: 'frozen purpose 보존',
        blast_radius: 'src/core/x.ts',
        reverse_cost: 'single revert',
      },
    };
    await writeFile(
      decisionsPath(),
      `${[...staleFailures, direction].map((d) => JSON.stringify(d)).join('\n')}\n`,
      'utf8',
    );
  }

  test('fork(N1) 하류 노드를 fresh id로 재생성하고 fork를 pending으로 되돌린다', async () => {
    await seedForkAndStaleFailures();
    const res = spawnDitto([
      'autopilot',
      'revise',
      '--workItem',
      WI,
      '--decision',
      'N1', // target by fork node id
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.fork_node_id).toBe('N1');
    expect(out.removed_node_ids.sort()).toEqual(['N2', 'N3']);
    expect(out.regenerated.map((r: { from: string; to: string }) => [r.from, r.to])).toEqual([
      ['N2', 'N2~r1'],
      ['N3', 'N3~r1'],
    ]);
    expect(out.fork_reset_to).toBe('pending');

    const graph = await readGraph();
    const ids = graph.nodes.map((n) => n.id).sort();
    // fresh ids present, old downstream ids gone (no collision)
    expect(ids).toEqual(['N1', 'N2~r1', 'N3~r1']);
    // fork reset to pending
    expect(graph.nodes.find((n) => n.id === 'N1')?.status).toBe('pending');
    // regenerated edges: fresh root depends on the (kept) fork; chain remapped to fresh ids
    expect(graph.nodes.find((n) => n.id === 'N2~r1')?.depends_on).toEqual(['N1']);
    expect(graph.nodes.find((n) => n.id === 'N3~r1')?.depends_on).toEqual(['N2~r1']);
    expect(graph.nodes.find((n) => n.id === 'N2~r1')?.status).toBe('pending');
  });

  // The load-bearing property (sweep HIGH-2): sameOracleFailureCount keys the
  // stale-K-block on node_id and the decision log is never truncated. A REUSED id
  // would inherit N3's prior failures and K-block immediately; a FRESH id counts 0.
  test('재구동 노드는 stale oracle-unsatisfied 실패를 물려받지 않는다 (pre-K-block 아님)', async () => {
    await seedForkAndStaleFailures();
    spawnDitto(['autopilot', 'revise', '--workItem', WI, '--decision', 'N1', '--output', 'json']);
    const decisions = await readDecisions();
    const oracleFailCount = (nodeId: string) =>
      decisions.filter((d) => d.node_id === nodeId && d.reason.startsWith('oracle-unsatisfied'))
        .length;
    // the OLD downstream id carried K=3 stale failures — a reused id would be blocked
    expect(oracleFailCount('N3')).toBe(3);
    // the FRESH regenerated id inherits ZERO — the count that gates the K-block is 0
    expect(oracleFailCount('N3~r1')).toBe(0);
    // and the log was NOT truncated (the stale entries still exist)
    expect(decisions.length).toBeGreaterThanOrEqual(4);
  });

  test('decision_id로도 대상 direction 결정을 지정할 수 있다', async () => {
    await seedForkAndStaleFailures();
    // discover the decision_id the complete report surfaces, then revise by it.
    const complete = spawnDitto(['autopilot', 'complete', '--workItem', WI, '--output', 'json']);
    const decisionId = JSON.parse(complete.stdout).direction_decisions[0].decision_id;
    const res = spawnDitto([
      'autopilot',
      'revise',
      '--workItem',
      WI,
      '--decision',
      decisionId,
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout).fork_node_id).toBe('N1');
  });

  test('일치하는 direction 결정이 없으면 오류로 종료한다', async () => {
    await seedForkAndStaleFailures();
    const res = spawnDitto([
      'autopilot',
      'revise',
      '--workItem',
      WI,
      '--decision',
      'no-such-fork',
      '--output',
      'json',
    ]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('no direction decision');
  });
});
