import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextCoverageNode, recordCoverageRound } from '~/core/coverage-loop';
import { assembleRelevanceVerdicts } from '~/core/coverage-relevance';
import { CoverageStore } from '~/core/coverage-store';
import { CATEGORY_NODE_PREFIX } from '~/core/coverage-taxonomy';
import { WorkItemStore } from '~/core/work-item-store';

/**
 * wi_260622vjo §8-2 — category-complete termination. With seedCategories on, the
 * first call seeds the root + one node per floor category, so termination (the
 * existing `allClosed` predicate) requires every category swept (ac-2). Off by
 * default → the existing root-only tree is unchanged (ac-7).
 */
let repo: string;
let WI: string;
const NOW = new Date('2026-06-01T00:00:00.000Z');

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-cov-seed-'));
  const wi = await new WorkItemStore(repo).create(
    {
      title: 'seeding test',
      source_request: 'far-field 카테고리를 sweep 노드로 시딩',
      goal: '모든 카테고리가 명시 sweep돼야 종료',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'categories seeded', verdict: 'unverified', evidence: [] },
      ],
    },
    NOW,
  );
  WI = wi.id;
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('category seeding (wi_260622vjo §8-2)', () => {
  test('seedCategories:true seeds root + one node per floor category and schedules a category', async () => {
    const first = await nextCoverageNode({ repoRoot: repo, workItemId: WI, seedCategories: true });
    expect(first.action).toBe('interrogate');
    if (first.action !== 'interrogate') return;

    const map = await new CoverageStore(repo).getMap(WI);
    // root + 23 category nodes — still 23 after wi_260706n4w (minimal-increment
    // routed out to the charter self-check, authorization facet-split back in;
    // the removal is ledgered in the report's routed_out, not silently dropped)
    expect(map.nodes.filter((n) => n.id.startsWith(CATEGORY_NODE_PREFIX)).length).toBe(23);
    expect(map.nodes.length).toBe(24);

    // root has open children → it is deferred; the leaf frontier is a category.
    expect(first.node.id.startsWith(CATEGORY_NODE_PREFIX)).toBe(true);
  });

  // AC2 (parallel sweep): the ready frontier is independent sibling leaves, so the
  // step surfaces ALL of them as a `wave` the caller can interrogate in parallel —
  // not just ready[0]. The single `node`/`judgeInput` still mirror wave[0] for
  // backward-compat; record stays a sequential single-writer (unchanged).
  test('interrogate surfaces the full ready frontier as a wave (AC2)', async () => {
    const first = await nextCoverageNode({ repoRoot: repo, workItemId: WI, seedCategories: true });
    expect(first.action).toBe('interrogate');
    if (first.action !== 'interrogate') return;

    expect(first.wave).toBeDefined();
    // root is deferred (open children); all 23 category leaves form the frontier.
    expect(first.wave.length).toBe(23);
    for (const item of first.wave) {
      expect(item.node.id.startsWith(CATEGORY_NODE_PREFIX)).toBe(true);
      // each wave entry carries its own fresh judge input for that node.
      expect(item.judgeInput.node.id).toBe(item.node.id);
    }
    // backward-compat: the single node/judgeInput equal wave[0].
    expect(first.node.id).toBe((first.wave[0] as (typeof first.wave)[number]).node.id);
    expect(first.judgeInput.node.id).toBe((first.wave[0] as (typeof first.wave)[number]).node.id);
  });

  test('default (no seedCategories) keeps the existing root-only tree (ac-7)', async () => {
    const first = await nextCoverageNode({ repoRoot: repo, workItemId: WI });
    expect(first.action).toBe('interrogate');
    if (first.action !== 'interrogate') return;
    expect(first.node.id).toBe('cov-root');

    const map = await new CoverageStore(repo).getMap(WI);
    expect(map.nodes.length).toBe(1);
  });
});

// wi_260706n4w ac-2/ac-3 — disposition routing metadata must survive the seed →
// coverage.json → read round-trip (the schema seam), and a routed category seeds
// OPEN (fail-open: ac-4's deep-interview wiring closes it downstream, never seed).
describe('disposition routing metadata at seed (wi_260706n4w ac-2/ac-3)', () => {
  test('a routed floor category persists its disposition through coverage.json and stays open', async () => {
    await nextCoverageNode({ repoRoot: repo, workItemId: WI, seedCategories: true });
    const map = await new CoverageStore(repo).getMap(WI);
    const model = map.nodes.find((n) => n.id === `${CATEGORY_NODE_PREFIX}authorization-model`);
    expect(model?.disposition).toBe('user-intent');
    expect(model?.state).toBe('open');
    const enforce = map.nodes.find((n) => n.id === `${CATEGORY_NODE_PREFIX}authorization`);
    expect(enforce?.disposition).toBe('code-verify');
    // minimal-increment no longer seeds a node — its removal is ledgered instead
    expect(map.nodes.some((n) => n.id === `${CATEGORY_NODE_PREFIX}minimal-increment`)).toBe(false);
  });
});

// wi_260625l0v §3·§5 — the relevance gate pre-closes a not-relevant category AT SEED
// (out_of_scope + reason + residual_risk) so it is never swept (cost saved) yet stays
// in the audit ledger. Conservative default: absent verdicts → every category open.
describe('relevance gate pre-close at seed (wi_260625l0v §3·§5)', () => {
  const AUTH = `${CATEGORY_NODE_PREFIX}authentication`;

  test('a not-relevant verdict pre-closes that category at seed — never scheduled, audited', async () => {
    const first = await nextCoverageNode({
      repoRoot: repo,
      workItemId: WI,
      seedCategories: true,
      relevanceVerdicts: [
        {
          id: 'authentication',
          relevant: false,
          reason: '이 변경은 인증 경로를 건드리지 않음',
          residual_risk: '오판 시 인증 실패가 사전점검에서 누락',
        },
      ],
    });
    expect(first.action).toBe('interrogate');
    if (first.action !== 'interrogate') return;

    const map = await new CoverageStore(repo).getMap(WI);
    const auth = map.nodes.find((n) => n.id === AUTH);
    expect(auth?.state).toBe('out_of_scope');
    expect(auth?.close_reason).toBe('이 변경은 인증 경로를 건드리지 않음');
    expect(auth?.residual_risk).toBe('오판 시 인증 실패가 사전점검에서 누락');
    // ledger still complete: all 23 categories present (no silent drop)
    expect(map.nodes.filter((n) => n.id.startsWith(CATEGORY_NODE_PREFIX)).length).toBe(23);
    // the pre-closed category is never scheduled as the leaf frontier
    expect(first.node.id).not.toBe(AUTH);
  });

  test('absent verdicts → every category open (unchanged, ac-7)', async () => {
    await nextCoverageNode({ repoRoot: repo, workItemId: WI, seedCategories: true });
    const map = await new CoverageStore(repo).getMap(WI);
    expect(
      map.nodes
        .filter((n) => n.id.startsWith(CATEGORY_NODE_PREFIX))
        .every((n) => n.state === 'open'),
    ).toBe(true);
  });
});

// wi_26062227h — relevance provenance + structural cost tally persisted at seed.
// The relevance gate consumes raw judgments/refutes, but coverage.json keeps only the
// ASSEMBLED node state — a kept-relevant category loses its judge proposal + refute
// outcome, so the skip-cause (b: conservative-correct vs c: proposed-skip-then-refuted)
// is undiagnosable post-hoc. Persisting the RAW input at seed makes it diagnosable and
// records the structural cost tally the run-cost metric needs. Token/wall-time stays out
// (ADR-0001 — subagent cost is host-delegated, not engine-visible).
describe('relevance provenance persisted at seed (wi_26062227h)', () => {
  const judgments = [
    { id: 'authentication', relevant: false, reason: '읽기 전용', residual_risk: '우회 시 누락' },
    { id: 'boundary-edge', relevant: true },
    // proposed skip but refuted back to relevant → the (c) weak-signal case that
    // coverage.json alone cannot distinguish from a plain kept-relevant category.
    { id: 'observability', relevant: false, reason: '로깅 없음', residual_risk: '무성 실패' },
  ];
  const refutes = [
    { id: 'authentication', refuted: false }, // skip survives → out_of_scope
    { id: 'observability', refuted: true }, // skip overturned → stays relevant
  ];

  test('rawRelevance at seed writes relevance-provenance.json with raw judgments/refutes + tally', async () => {
    await nextCoverageNode({
      repoRoot: repo,
      workItemId: WI,
      seedCategories: true,
      relevanceVerdicts: assembleRelevanceVerdicts(judgments, refutes),
      rawRelevance: { judgments, refutes },
    });

    const store = new CoverageStore(repo);
    const prov = await store.getRelevanceProvenance(WI);
    // raw preserved verbatim → b/c diagnosable (observability shows the refuted-skip path)
    expect(prov.judgments).toEqual(judgments);
    expect(prov.refutes).toEqual(refutes);
    // tally reflects the ASSEMBLED result: 23 seeded, only authentication skipped
    // (observability's proposed skip was refuted back to relevant), 22 relevant.
    expect(prov.tally.seeded).toBe(23);
    expect(prov.tally.skipped).toBe(1);
    expect(prov.tally.relevant).toBe(22);
  });

  test('no rawRelevance → no provenance file (no gate = no record, ac-3)', async () => {
    await nextCoverageNode({ repoRoot: repo, workItemId: WI, seedCategories: true });
    expect(await new CoverageStore(repo).hasRelevanceProvenance(WI)).toBe(false);
  });
});

// ac-2 — a category may be skipped only as a recorded, justified decision: closing
// a category in a non-resolved state (out_of_scope / user_owned) without a reason
// is rejected (no silent skip); the reason is recorded on the node (auditable).
describe('justified category skip (wi_260622vjo §8-2 / ac-2)', () => {
  const AUTH = `${CATEGORY_NODE_PREFIX}authentication`;

  test('skipping a category out_of_scope without a reason is rejected — no silent skip', async () => {
    await nextCoverageNode({ repoRoot: repo, workItemId: WI, seedCategories: true });
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: AUTH,
        admissibleBranchesAdded: 0,
        close_as: 'out_of_scope',
        derived_nodes: [],
        discovered_nodes: [],
      },
    });
    expect(r.terminated).toBe(false);
    if (r.terminated) return;
    expect(r.closed).toBe(false);
    expect(r.reasons.join(' ')).toContain('reason');

    // the category stays OPEN — it cannot be silently passed.
    const node = (await new CoverageStore(repo).getMap(WI)).nodes.find((n) => n.id === AUTH);
    expect(node?.state).toBe('open');
  });

  test('a skipped category records its justification on the node (auditable)', async () => {
    await nextCoverageNode({ repoRoot: repo, workItemId: WI, seedCategories: true });
    const reason = '이 변경은 인증 경로를 건드리지 않음 — 읽기 전용 내부 계산';
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: AUTH,
        admissibleBranchesAdded: 0,
        close_as: 'out_of_scope',
        close_reason: reason,
        // A non-resolved close now also requires the surviving risk (residual_risk
        // gate); supply one so this close_reason-recording assertion still reaches a
        // closed node. The residual_risk record itself is asserted separately below.
        residual_risk: '잔여: 인증 가정이 외부 우회 경로에서 깨질 수 있음',
        derived_nodes: [],
        discovered_nodes: [],
      },
    });
    expect(r.terminated).toBe(false);
    if (r.terminated) return;
    expect(r.closed).toBe(true);

    const node = (await new CoverageStore(repo).getMap(WI)).nodes.find((n) => n.id === AUTH);
    expect(node?.state).toBe('out_of_scope');
    expect(node?.close_reason).toBe(reason);
  });

  test('resolving a category (swept, not skipped) does not require a skip reason', async () => {
    await nextCoverageNode({ repoRoot: repo, workItemId: WI, seedCategories: true });
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: AUTH,
        admissibleBranchesAdded: 0,
        close_as: 'resolved',
        axis_signals: { neutrality: { opponent_ran: true, verdict: 'accept' } },
        derived_nodes: [],
        discovered_nodes: [],
      },
    });
    expect(r.terminated).toBe(false);
    if (r.terminated) return;
    expect(r.closed).toBe(true);
  });
});

// surviving-risk self-description gap: a non-resolved category close records WHY it
// was skipped (close_reason) but not WHAT RISK survives that skip. residual_risk is a
// separate REQUIRED field for non-resolved closes (out_of_scope / user_owned),
// mirroring close_reason's fail-closed gate; a resolved (swept) close does not require
// it (the sweep settled the risk).
describe('surviving-risk on a skipped category (residual_risk)', () => {
  const AUTH = `${CATEGORY_NODE_PREFIX}authentication`;
  const REASON = '이 변경은 인증 경로를 건드리지 않음 — 읽기 전용 내부 계산';
  const RISK = '잔여: 외부 호출자가 우회 경로로 들어오면 인증 가정이 깨질 수 있음';

  test('skipping a category with a close_reason but NO residual_risk is rejected — surviving risk must be named', async () => {
    await nextCoverageNode({ repoRoot: repo, workItemId: WI, seedCategories: true });
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: AUTH,
        admissibleBranchesAdded: 0,
        close_as: 'out_of_scope',
        close_reason: REASON,
        derived_nodes: [],
        discovered_nodes: [],
      },
    });
    expect(r.terminated).toBe(false);
    if (r.terminated) return;
    expect(r.closed).toBe(false);
    expect(r.reasons.join(' ')).toContain('residual_risk');

    // the category stays OPEN — it cannot be closed without naming the surviving risk.
    const node = (await new CoverageStore(repo).getMap(WI)).nodes.find((n) => n.id === AUTH);
    expect(node?.state).toBe('open');
  });

  test('a skipped category with both close_reason AND residual_risk closes and records both (auditable)', async () => {
    await nextCoverageNode({ repoRoot: repo, workItemId: WI, seedCategories: true });
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: AUTH,
        admissibleBranchesAdded: 0,
        close_as: 'out_of_scope',
        close_reason: REASON,
        residual_risk: RISK,
        derived_nodes: [],
        discovered_nodes: [],
      },
    });
    expect(r.terminated).toBe(false);
    if (r.terminated) return;
    expect(r.closed).toBe(true);

    const node = (await new CoverageStore(repo).getMap(WI)).nodes.find((n) => n.id === AUTH);
    expect(node?.state).toBe('out_of_scope');
    expect(node?.close_reason).toBe(REASON);
    expect(node?.residual_risk).toBe(RISK);
  });

  test('resolving a category (swept, not skipped) does not require a residual_risk', async () => {
    await nextCoverageNode({ repoRoot: repo, workItemId: WI, seedCategories: true });
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: AUTH,
        admissibleBranchesAdded: 0,
        close_as: 'resolved',
        axis_signals: { neutrality: { opponent_ran: true, verdict: 'accept' } },
        derived_nodes: [],
        discovered_nodes: [],
      },
    });
    expect(r.terminated).toBe(false);
    if (r.terminated) return;
    expect(r.closed).toBe(true);
  });
});
