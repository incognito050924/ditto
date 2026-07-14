import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `ditto prism` CLI (wi_260707oi1, node oi1-issuemap-engine). Drives the prism
 * issue-map engine end-to-end: seed (cap-enforced growth), close (MODEL-1 gate),
 * summary (ac-3 label-only), and status (ac-2 termination + ac-4 one-shot launch
 * notification). Spawns the source CLI with cwd=<temp repo> so all writes land in
 * an isolated tree (never the real .ditto).
 */
const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const WI = 'wi_prismcli01';
/** Mirror of src/cli/util.ts USAGE_ERROR_EXIT (sysexits EX_USAGE). */
const USAGE_ERROR_EXIT = 65;

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

function seed(label: string, extra: string[] = []): { node_id: string } {
  const res = spawnDitto([
    'prism',
    'seed',
    '--wi',
    WI,
    '--label',
    label,
    '--output',
    'json',
    ...extra,
  ]);
  expect(res.exitCode).toBe(0);
  return JSON.parse(res.stdout);
}

/** Read the durable Record-tier decision KINDS actually persisted for WI. */
async function decisionKinds(): Promise<string[]> {
  // Run tier (wi_260708cdl): prism decisions live under .ditto/local/.../prism/,
  // never the committed base (which is record.json + events/ only).
  const path = join(dir, '.ditto', 'local', 'work-items', WI, 'prism', 'prism-decisions.jsonl');
  try {
    const text = await readFile(path, 'utf8');
    return text
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l).kind as string);
  } catch {
    return [];
  }
}

/** Read the Run-tier issue-map.json (the draft the CLI persists), or null if absent. */
// biome-ignore lint/suspicious/noExplicitAny: test reads the persisted JSON shape ad hoc.
async function readIssueMap(): Promise<any | null> {
  const path = join(dir, '.ditto', 'local', 'work-items', WI, 'prism', 'issue-map.json');
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Write a minimal valid intent.json so the launch re-anchor (ac-3) has an original intent. */
async function writeIntent(sourceRequest: string, inScope: string[] = []): Promise<void> {
  const wiDir = join(dir, '.ditto', 'local', 'work-items', WI);
  await mkdir(wiDir, { recursive: true });
  const intent = {
    schema_version: '0.1.0',
    work_item_id: WI,
    source_request: sourceRequest,
    goal: '재시도 정책 확정',
    in_scope: inScope,
    acceptance_criteria: [{ id: 'ac-1', statement: '재시도 정책이 정의된다' }],
  };
  await writeFile(join(wiDir, 'intent.json'), JSON.stringify(intent, null, 2));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-prism-'));
  git(['init']);
  git(['config', 'user.email', 't@t.test']);
  git(['config', 'user.name', 't']);
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto prism summary — label-only (ac-3)', () => {
  test('renders labels only; no node id / severity / axis leaks', () => {
    const critical = seed('결제 실패 시 재시도 정책', ['--critical']);
    seed('로그 포맷 통일');
    const res = spawnDitto(['prism', 'summary', '--wi', WI]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('결제 실패 시 재시도 정책');
    expect(res.stdout).toContain('로그 포맷 통일');
    // no leaks of the internal node id, severity enum, or coverage axis name.
    expect(res.stdout).not.toContain(critical.node_id);
    expect(res.stdout).not.toContain('critical');
    expect(res.stdout).not.toContain('completeness');
  });
});

describe('ditto prism close — MODEL-1 unknown-close gate (ac-2)', () => {
  test('a no-residual unknown-close of a critical node is rejected', () => {
    const c = seed('인증 경계', ['--critical']);
    const res = spawnDitto([
      'prism',
      'close',
      '--wi',
      WI,
      '--node',
      c.node_id,
      '--state',
      'out_of_scope',
    ]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('residual_risk');
  });

  test('an unknown-close WITH residual is accepted and records a durable decision', () => {
    const c = seed('인증 경계', ['--critical']);
    const res = spawnDitto([
      'prism',
      'close',
      '--wi',
      WI,
      '--node',
      c.node_id,
      '--state',
      'user_owned',
      '--reason',
      '사용자 결정',
      '--residual',
      '인증 미검증 잔여',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout).ok).toBe(true);
  });
});

describe('ditto prism status — termination + one-shot launch notification (ac-2/ac-4)', () => {
  test('0-critical map does NOT report terminated (B1 guard) and does not notify', () => {
    seed('로그 포맷 통일'); // non-critical only
    const res = spawnDitto(['prism', 'status', '--wi', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.terminated).toBe(false);
    expect(payload.notified).toBe(false);
  });

  test('critical scope settled → notify ONCE with re-anchor surface, then silent (one-shot, ac-3/ac-4)', async () => {
    const intentText = '결제 재시도 정책을 설계한다 — 원문 의도 텍스트';
    await writeIntent(intentText);
    const c = seed('인증 경계', ['--critical']);
    seed('로그 포맷 통일'); // a surviving non-critical item
    // A critical node whose surviving risk is recorded counts as resolved-for-termination
    // (MODEL-1 산입) — reaches criticalTermination without needing A2 grounding.
    const closed = spawnDitto([
      'prism',
      'close',
      '--wi',
      WI,
      '--node',
      c.node_id,
      '--state',
      'user_owned',
      '--reason',
      '사용자 결정',
      '--residual',
      '인증 미검증 잔여',
    ]);
    expect(closed.exitCode).toBe(0);

    const first = spawnDitto(['prism', 'status', '--wi', WI]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('최소한으로 착수할 수 있어요');
    // ac-3: the launch fires WITH the achieve-vs-characterize re-anchor + intent verbatim.
    expect(first.stdout).toContain('원래 의도를 다시 봅니다');
    expect(first.stdout).toContain(intentText);

    const second = spawnDitto(['prism', 'status', '--wi', WI]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).not.toContain('최소한으로 착수할 수 있어요');
    // The re-anchor is bound to the one-shot launch line — silent on the second read too.
    expect(second.stdout).not.toContain('원래 의도를 다시 봅니다');
  });

  test('re-anchor is absent (json) when the WI has no intent.json', async () => {
    const c = seed('인증 경계', ['--critical']);
    spawnDitto([
      'prism',
      'close',
      '--wi',
      WI,
      '--node',
      c.node_id,
      '--state',
      'user_owned',
      '--reason',
      '사용자 결정',
      '--residual',
      '인증 미검증 잔여',
    ]);
    const res = spawnDitto(['prism', 'status', '--wi', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.notified).toBe(true);
    // No intent.json written → no original intent → no re_anchor surface (non-blocking).
    expect(payload.re_anchor).toBeUndefined();
  });
});

describe('ditto prism status — ac-2 completeness seed is wired into a production path', () => {
  test('an uncovered original-intent fragment surfaces as a noncritical seed node after status', async () => {
    // intent.json carries an in_scope fragment that NO seeded node addresses.
    await writeIntent('결제 흐름 설계', ['결제 재시도 정책', '배송 추적 알림']);
    // this node addresses the goal (재시도/정책) + in_scope[0] (결제/재시도/정책) — NOT '배송 추적 알림'.
    seed('결제 재시도 정책 로직', ['--critical']);
    // status evaluates termination → the completeness seed fires for the unaddressed fragment.
    const status = spawnDitto(['prism', 'status', '--wi', WI, '--output', 'json']);
    expect(status.exitCode).toBe(0);
    // the gap is now a real, pure-read-visible node in the tree.
    const tree = spawnDitto(['prism', 'tree', '--wi', WI, '--output', 'json']);
    expect(tree.exitCode).toBe(0);
    const nodes = JSON.parse(tree.stdout).nodes as { label: string; severity: string }[];
    const labels = nodes.map((n) => n.label);
    // the uncovered fragment surfaced as a seed node...
    expect(labels).toContain('배송 추적 알림');
    // ...NONCRITICAL, so it surfaces the gap yet can never hard-block termination.
    const seedNode = nodes.find((n) => n.label === '배송 추적 알림');
    expect(seedNode?.severity).toBe('noncritical');
    // the covered fragment is NOT re-seeded — only real gaps surface.
    expect(labels.filter((l) => l === '결제 재시도 정책')).toHaveLength(0);
  });

  test('a fully-covered intent seeds nothing after status (no over-seeding)', async () => {
    await writeIntent('결제 흐름 설계', ['결제 재시도 정책']);
    // this single node addresses BOTH goal (재시도/정책/확정) and in_scope[0] (결제/재시도/정책).
    seed('결제 재시도 정책 확정 로직', ['--critical']);
    const before = JSON.parse(spawnDitto(['prism', 'tree', '--wi', WI, '--output', 'json']).stdout)
      .nodes.length;
    expect(spawnDitto(['prism', 'status', '--wi', WI, '--output', 'json']).exitCode).toBe(0);
    const after = JSON.parse(spawnDitto(['prism', 'tree', '--wi', WI, '--output', 'json']).stdout)
      .nodes.length;
    expect(after).toBe(before); // no completeness seed node added
  });
});

describe('ditto prism diverge — divergence emit is reachable from a shipped command (ac-10)', () => {
  test('a re-challenge WITH new evidence persists a durable challenge_admit decision', async () => {
    const c = seed('인증 경계', ['--critical']);
    const res = spawnDitto([
      'prism',
      'diverge',
      '--wi',
      WI,
      '--challenge-of',
      c.node_id,
      '--signature',
      '인증 경계 다시',
      '--new-evidence',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.verdict.action).toBe('challenge-node');
    expect(payload.decision.kind).toBe('challenge_admit');
    // The whole point: it landed in the durable Record tier, not just in memory.
    expect(await decisionKinds()).toContain('challenge_admit');
  });

  test('a meaningless divergence (repeat question) persists a durable early_exit decision', async () => {
    const res = spawnDitto([
      'prism',
      'diverge',
      '--wi',
      WI,
      '--question',
      '재시도 횟수?',
      '--seen',
      '재시도 횟수?',
      '--output',
      'json',
    ]);
    // A flagged meaningless divergence is a STOP (not a green continue).
    expect(res.exitCode).not.toBe(0);
    expect(await decisionKinds()).toContain('early_exit');
  });

  test('no divergence → no decision recorded (never a spurious Record entry)', async () => {
    const res = spawnDitto([
      'prism',
      'diverge',
      '--wi',
      WI,
      '--question',
      '완전히 새로운 질문?',
      '--seen',
      '이전 질문',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout).verdict.action).toBe('continue');
    expect(await decisionKinds()).toHaveLength(0);
  });

  // wi_2607075vc: the trivial_streak shape was CLI-unreachable — every --seen history
  // entry was hardcoded trivial:false, so a streak could never reach TRIVIAL_STREAK_CAP.
  // --seen-trivial carries prior trivial questions so the shape is reachable (ac-1).
  test('a trivial-streak divergence is reachable via --seen-trivial (ac-1)', async () => {
    const res = spawnDitto([
      'prism',
      'diverge',
      '--wi',
      WI,
      '--question',
      '이것도 사소한 질문?',
      '--trivial',
      '--seen-trivial',
      '사소한 질문 1',
      '--seen-trivial',
      '사소한 질문 2',
      '--output',
      'json',
    ]);
    // trivial (current) + 2 prior trivial = streak 3 = TRIVIAL_STREAK_CAP → cap-stop.
    expect(res.exitCode).not.toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.verdict.diverged).toBe(true);
    expect(payload.verdict.kind).toBe('trivial_streak');
  });

  test('a trivial current question with only non-trivial --seen history does NOT falsely trigger the streak (ac-2)', async () => {
    const res = spawnDitto([
      'prism',
      'diverge',
      '--wi',
      WI,
      '--question',
      '사소한 현재 질문?',
      '--trivial',
      '--seen',
      '진지한 질문 1',
      '--seen',
      '진지한 질문 2',
      '--output',
      'json',
    ]);
    // streak = 1 (only the current trivial; non-trivial history breaks it) → continue.
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout).verdict.diverged).toBe(false);
  });
});

describe('ditto prism seed — cap really stops growth (ac-10)', () => {
  test('the tree-node cap halts the seed with an escalation (cap ≠ success)', () => {
    // --max-nodes 2: root(1) + one seed = 2 nodes; the next seed hits the cap.
    const ok = spawnDitto(['prism', 'seed', '--wi', WI, '--label', '첫 항목', '--max-nodes', '2']);
    expect(ok.exitCode).toBe(0);
    const halted = spawnDitto([
      'prism',
      'seed',
      '--wi',
      WI,
      '--label',
      '둘째 항목',
      '--max-nodes',
      '2',
    ]);
    expect(halted.exitCode).not.toBe(0);
    expect(halted.stderr).toContain('cap');
  });
});

describe('ditto prism close — A2 critical resolved-close gate wiring (ac-1)', () => {
  test('a critical resolved-close WITHOUT the gate inputs is rejected and stamps a durable Run-tier unevaluated trace (OBJ-4)', async () => {
    const c = seed('인증 경계', ['--critical']);
    const res = spawnDitto([
      'prism',
      'close',
      '--wi',
      WI,
      '--node',
      c.node_id,
      '--state',
      'resolved',
      '--reason',
      '해결',
    ]);
    // The rejection surfaces the reason (never a silent exit).
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('justifying_reason');
    expect(res.stderr).toContain('unevaluated');
    // OBJ-4: the under-think catch is a DURABLE Run-tier trace (the node stamped
    // `unevaluated` in issue-map.json), not a rejection that exits with no record.
    const map = await readIssueMap();
    const evalRec = map?.evaluations?.find((e: { node_id: string }) => e.node_id === c.node_id);
    expect(evalRec?.evaluation).toBe('unevaluated');
    // Run tier only — the rejection must NOT write the committed-base decisions tier.
    expect(await decisionKinds()).toHaveLength(0);
  });

  test('the justifying_reason + refutation_attempted flags are actually passed through to the gate', async () => {
    const c = seed('인증 경계', ['--critical']);
    const res = spawnDitto([
      'prism',
      'close',
      '--wi',
      WI,
      '--node',
      c.node_id,
      '--state',
      'resolved',
      '--reason',
      '해결',
      '--justifying-reason',
      '재시도는 3회 지수백오프로 확정',
      '--refutation-attempted',
    ]);
    // Still rejected (structural grounding is separately required), but because the
    // flags WERE consumed the reason no longer lists them — only the grounding miss
    // remains. This is the proof the CLI wires the inputs into the gate.
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('grounding');
    expect(res.stderr).not.toContain('justifying_reason');
    expect(res.stderr).not.toContain('refutation_attempted');
    // The inputs are persisted onto the node's evaluation annotation.
    const map = await readIssueMap();
    const evalRec = map?.evaluations?.find((e: { node_id: string }) => e.node_id === c.node_id);
    expect(evalRec?.justifying_reason).toBe('재시도는 3회 지수백오프로 확정');
    expect(evalRec?.refutation_attempted).toBe(true);
  });
});

describe('ditto prism tree — pure-query tree view (ac-4)', () => {
  test('a not-yet-seeded map is a clean message, not a crash', () => {
    const res = spawnDitto(['prism', 'tree', '--wi', WI]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('아직 정리한 항목이 없어요');
  });

  test('renders the tree structure + label·severity·state + question-round timestamps', () => {
    seed('결제 재시도 정책', ['--critical']);
    seed('로그 포맷 통일');
    const res = spawnDitto(['prism', 'tree', '--wi', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    const labels = payload.nodes.map((n: { label: string }) => n.label);
    expect(labels).toContain('결제 재시도 정책');
    expect(labels).toContain('로그 포맷 통일');
    const critical = payload.nodes.find((n: { label: string }) => n.label === '결제 재시도 정책');
    expect(critical.severity).toBe('critical');
    expect(critical.state).toBe('open');
    // Each seed appends one VALUE round → the tree view surfaces the round timestamps.
    expect(payload.question_round_timestamps.length).toBe(2);
  });

  test('the query does NOT mutate state (pure read)', async () => {
    seed('결제 재시도 정책', ['--critical']);
    const before = JSON.stringify(await readIssueMap());
    const res = spawnDitto(['prism', 'tree', '--wi', WI]);
    expect(res.exitCode).toBe(0);
    const after = JSON.stringify(await readIssueMap());
    expect(after).toBe(before);
  });
});

describe('ditto prism opponent — model-assist seam is genuinely invoked (ac-5/ac-6)', () => {
  test('critique over an A2-flagged critical node degrades to host_absent in the bare CLI (ac-5)', async () => {
    // Flag a critical node: a rejected critical resolved-close stamps it `unevaluated`.
    const c = seed('인증 경계', ['--critical']);
    spawnDitto([
      'prism',
      'close',
      '--wi',
      WI,
      '--node',
      c.node_id,
      '--state',
      'resolved',
      '--reason',
      'x',
    ]);

    const res = spawnDitto([
      'prism',
      'opponent',
      '--wi',
      WI,
      '--concern',
      'critique',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    // The seam actually ran (no host delegate → graceful degrade), no crash / fake pass.
    expect(payload.host_available).toBe(false);
    expect(payload.degraded).toContain(c.node_id);
    // The degrade is a DURABLE self-describing stamp on the node (host_absent).
    const map = await readIssueMap();
    const evalRec = map?.evaluations?.find((e: { node_id: string }) => e.node_id === c.node_id);
    expect(evalRec?.opponent_status).toBe('host_absent');
  });

  test('dissent at the anchor degrades to host_absent and surfaces the message (ac-6)', async () => {
    seed('인증 경계', ['--critical']);
    const res = spawnDitto(['prism', 'opponent', '--wi', WI, '--concern', 'dissent']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('반대 검토 모델');
    // The anchor (tree root) carries the self-describing degrade stamp.
    const map = await readIssueMap();
    const anchor = map.tree.root_id;
    const evalRec = map?.evaluations?.find((e: { node_id: string }) => e.node_id === anchor);
    expect(evalRec?.opponent_status).toBe('host_absent');
  });
});

// ── opponent-briefs / opponent-record — the host-delegated pass-in-JSON seam ──
// A prism fixture with (a) a critique target (A2-flagged critical node), (b) the
// dissent anchor (tree root), (c) a semantic target (a node whose label token-maps an
// intent fragment). `intentText` is the ORIGINAL intent every brief target carries.
const intentText = '결제 재시도 정책을 설계한다 — 원문 의도 텍스트';

/** Seed the shared fixture; returns the flagged/semantic node id + the tree root id. */
async function seedOpponentFixture(): Promise<{ nodeId: string; rootId: string }> {
  // goal='재시도 정책 확정' + in_scope shares tokens with the node label below → the
  // node is a semantic (fragment,node) target via deriveFragmentMappings.
  await writeIntent(intentText, ['결제 재시도 정책 로직']);
  const node = seed('결제 재시도 정책', ['--critical']);
  // A critical resolved-close WITHOUT the A2 gate inputs stamps the node `unevaluated`
  // → it becomes a flaggedCriticalNodeIds critique target.
  spawnDitto([
    'prism',
    'close',
    '--wi',
    WI,
    '--node',
    node.node_id,
    '--state',
    'resolved',
    '--reason',
    'x',
  ]);
  const map = await readIssueMap();
  return { nodeId: node.node_id, rootId: map.tree.root_id };
}

describe('ditto prism opponent-briefs — structured briefs, no model call (ac-1)', () => {
  test('emits critique/dissent/semantic groups each carrying node id + label + intent', async () => {
    const { nodeId, rootId } = await seedOpponentFixture();
    const res = spawnDitto(['prism', 'opponent-briefs', '--wi', WI]);
    expect(res.exitCode).toBe(0);
    const briefs = JSON.parse(res.stdout);
    // critique_targets includes the A2-flagged critical node, with its label + intent.
    const critiqueIds = briefs.critique_targets.map((t: { node_id: string }) => t.node_id);
    expect(critiqueIds).toContain(nodeId);
    const critique = briefs.critique_targets.find((t: { node_id: string }) => t.node_id === nodeId);
    expect(critique.label).toBe('결제 재시도 정책');
    expect(critique.intent).toBe(intentText);
    // dissent_anchor is the tree root, carrying the intent.
    expect(briefs.dissent_anchor.node_id).toBe(rootId);
    expect(briefs.dissent_anchor.intent).toBe(intentText);
    // semantic_targets includes the token-mapped node.
    const semanticIds = briefs.semantic_targets.map((t: { node_id: string }) => t.node_id);
    expect(semanticIds).toContain(nodeId);
  });
});

describe('ditto prism opponent-record — consume verdict JSON, round-trip (ac-2)', () => {
  test('a well-formed 3-concern verdict lands critique/dissent/semantic + status=engaged', async () => {
    const { nodeId, rootId } = await seedOpponentFixture();
    const verdicts = JSON.stringify({
      verdicts: [
        { concern: 'critique', node_id: nodeId, text: '이 노드의 정당화가 약합니다 (반증 시도)' },
        { concern: 'dissent', node_id: rootId, text: '원문 의도로부터 독립적 재판단' },
        { concern: 'semantic', node_id: nodeId, text: '특성화에 그침 — 달성 아님' },
      ],
    });
    const res = spawnDitto([
      'prism',
      'opponent-record',
      '--wi',
      WI,
      '--json',
      verdicts,
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.engaged).toContain(nodeId);
    expect(payload.engaged).toContain(rootId);
    // Re-read round-trips all three fields with status=engaged.
    const map = await readIssueMap();
    const nodeRec = map.evaluations.find((e: { node_id: string }) => e.node_id === nodeId);
    expect(nodeRec.opponent_critique).toBe('이 노드의 정당화가 약합니다 (반증 시도)');
    expect(nodeRec.opponent_status).toBe('engaged');
    expect(nodeRec.semantic_critique).toBe('특성화에 그침 — 달성 아님');
    expect(nodeRec.semantic_status).toBe('engaged');
    const rootRec = map.evaluations.find((e: { node_id: string }) => e.node_id === rootId);
    expect(rootRec.opponent_dissent).toBe('원문 의도로부터 독립적 재판단');
    expect(rootRec.opponent_status).toBe('engaged');
  });

  test('M1: malformed --json (bad shape) → USAGE_ERROR, map unchanged', async () => {
    const { nodeId } = await seedOpponentFixture();
    const before = await readIssueMap();
    // Bad concern enum + missing text → schema rejects.
    const res = spawnDitto([
      'prism',
      'opponent-record',
      '--wi',
      WI,
      '--json',
      JSON.stringify({ verdicts: [{ concern: 'bogus', node_id: nodeId }] }),
    ]);
    expect(res.exitCode).toBe(USAGE_ERROR_EXIT);
    const after = await readIssueMap();
    // No mutation — the map is byte-identical to before the rejected record.
    expect(after).toEqual(before);
  });

  test('M1: non-JSON --json → USAGE_ERROR', async () => {
    await seedOpponentFixture();
    const res = spawnDitto(['prism', 'opponent-record', '--wi', WI, '--json', 'not json at all']);
    expect(res.exitCode).toBe(USAGE_ERROR_EXIT);
  });

  test('M2: a verdict node_id absent from tree.nodes → fail-closed, NO orphan persisted', async () => {
    await seedOpponentFixture();
    const before = await readIssueMap();
    const foreign = 'prism_foreignnode_deadbeef';
    const res = spawnDitto([
      'prism',
      'opponent-record',
      '--wi',
      WI,
      '--json',
      JSON.stringify({ verdicts: [{ concern: 'critique', node_id: foreign, text: '유령 평가' }] }),
    ]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain(foreign);
    const after = await readIssueMap();
    // Fail-closed: map untouched, no orphan evaluation for the foreign id.
    expect(after).toEqual(before);
    const orphan = after.evaluations.find((e: { node_id: string }) => e.node_id === foreign);
    expect(orphan).toBeUndefined();
  });

  test('M2: a concern with empty text is NOT stamped engaged (degrades host_absent)', async () => {
    const { nodeId } = await seedOpponentFixture();
    const res = spawnDitto([
      'prism',
      'opponent-record',
      '--wi',
      WI,
      '--json',
      // Whitespace passes the min(1) schema but is empty → must degrade, not engage.
      JSON.stringify({ verdicts: [{ concern: 'critique', node_id: nodeId, text: '   ' }] }),
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.engaged).not.toContain(nodeId);
    expect(payload.degraded).toContain(nodeId);
    const map = await readIssueMap();
    const rec = map.evaluations.find((e: { node_id: string }) => e.node_id === nodeId);
    expect(rec.opponent_status).toBe('host_absent');
    expect(rec.opponent_critique).toBeUndefined();
  });

  test('M3: --briefed surfaces briefed-but-unanswered concerns', async () => {
    const { nodeId, rootId } = await seedOpponentFixture();
    // Brief two targets but answer only the critique one.
    const res = spawnDitto([
      'prism',
      'opponent-record',
      '--wi',
      WI,
      '--json',
      JSON.stringify({ verdicts: [{ concern: 'critique', node_id: nodeId, text: '답변' }] }),
      '--briefed',
      `${nodeId},${rootId}`,
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.unanswered).toContain(rootId);
    expect(payload.unanswered).not.toContain(nodeId);
  });
});
