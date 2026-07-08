import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OpponentAvailability, OpponentCandidate } from '~/core/opponent-router';
import {
  buildIntentFragments,
  criticalTermination,
  deriveFragmentMappings,
} from '~/core/prism/engine';
import { runOpponentCritiqueRound, runOpponentDissentRound } from '~/core/prism/loop';
import {
  OPPONENT_FANOUT_CAP,
  engageDialecticCritique,
  engageIndependentDissent,
  engageSemanticCritique,
  flaggedCriticalNodeIds,
  semanticCriticTargets,
} from '~/core/prism/opponent';
import { PrismStore } from '~/core/prism/store';
import type { CoverageNode } from '~/schemas/coverage';
import type { PrismIssueMap, PrismNodeEvaluation, PrismSeverityAssignment } from '~/schemas/prism';

/**
 * Model-assist opponent CONSUMPTION seam (wi_260708tzs, node tzs-opponent).
 *
 * The seam resolves the opponent (opponent-router = pure policy resolution),
 * CONSUMES host-delegated structured output (ADR-0001 — never spawns a provider),
 * and records it onto the Run-tier issue-map evaluation. When no opponent host is
 * available it degrades to the deterministic shell and STAMPS opponent_status =
 * host_absent (ADR-0018 / OBJ-3 — self-describing, never silent, never a fake pass).
 */

// ── fixtures ─────────────────────────────────────────────────────────────────

function node(id: string, label: string, state: CoverageNode['state'] = 'resolved'): CoverageNode {
  return { id, parent_id: null, label, origin: 'seed', depth_weight: 0.5, state, children: [] };
}

function prism(
  nodes: CoverageNode[],
  severities: PrismSeverityAssignment[] = [],
  evaluations: PrismNodeEvaluation[] = [],
): PrismIssueMap {
  return {
    schema_version: '0.1.0',
    work_item_id: 'wi_prismtest',
    tree: {
      schema_version: '0.1.0',
      work_item_id: 'wi_prismtest',
      root_id: 'prism_root0001',
      nodes,
    },
    severities,
    evaluations,
  };
}

const critical = (id: string): PrismSeverityAssignment => ({ node_id: id, severity: 'critical' });
const flagged = (id: string): PrismNodeEvaluation => ({ node_id: id, evaluation: 'unevaluated' });

const POLICY = {
  producer: 'current-host',
  opponent_preferred: 'codex',
  opponent_fallback: ['claude-opus'],
  synthesizer: 'claude-opus',
};

const NONE_AVAILABLE = (): OpponentAvailability => ({ available: false, reason: 'runtime' });
// Codex available (it is the preferred token) → selectOpponent picks it, fallback_from null.
const CODEX_AVAILABLE = (c: OpponentCandidate): OpponentAvailability =>
  c.provider === 'codex' ? { available: true } : { available: false, reason: 'runtime' };

// ── ac-5 · ADR-0018 graceful degrade (mandated) ──────────────────────────────

describe('engageDialecticCritique — host_absent degrade is self-describing (ac-5 / OBJ-3)', () => {
  test('no opponent host → stamps opponent_status=host_absent, no delegate call, no fake critique', async () => {
    const p = prism(
      [node('prism_a0000001', '결제 재시도')],
      [critical('prism_a0000001')],
      [flagged('prism_a0000001')],
    );
    let delegated = 0;
    const out = await engageDialecticCritique(p, {
      policy: POLICY,
      currentHost: 'claude-code',
      isAvailable: NONE_AVAILABLE,
      delegate: async () => {
        delegated++;
        return 'MUST NOT be recorded';
      },
      intent: '결제 흐름을 안전하게 만든다',
    });

    expect(delegated).toBe(0); // no host → no host-delegated invocation
    expect(out.host_available).toBe(false);
    const ev = out.prism.evaluations.find((e) => e.node_id === 'prism_a0000001');
    expect(ev?.opponent_status).toBe('host_absent'); // self-describing, NOT silent
    expect(ev?.opponent_critique).toBeUndefined(); // never a fake pass
    expect(out.degraded).toContain('prism_a0000001');
    expect(out.engaged).toHaveLength(0);
  });
});

// ── ac-5 · engaged critique (host present, consume + record) ──────────────────

describe('engageDialecticCritique — engaged path (ac-5)', () => {
  test('drives the opponent ONLY on A2-flagged critical nodes and records the critique', async () => {
    const p = prism(
      [
        node('prism_a0000001', '결제 재시도'),
        node('prism_b0000002', '로그 포맷'), // critical but NOT flagged (evaluation justified)
        node('prism_c0000003', '캐시 TTL'), // flagged but NOT critical → not a target
      ],
      [critical('prism_a0000001'), critical('prism_b0000002')],
      [
        flagged('prism_a0000001'),
        { node_id: 'prism_b0000002', evaluation: 'justified' },
        flagged('prism_c0000003'),
      ],
    );
    // The seam fires ONLY on the flagged critical node.
    expect(flaggedCriticalNodeIds(p)).toEqual(['prism_a0000001']);

    const seen: string[] = [];
    const out = await engageDialecticCritique(p, {
      policy: POLICY,
      currentHost: 'claude-code',
      isAvailable: CODEX_AVAILABLE,
      delegate: async (brief) => {
        seen.push(brief.node_id);
        expect(brief.concern).toBe('critique');
        expect(brief.selection.provider).toBe('codex');
        return `DA critique + Popper refutation of ${brief.label}`;
      },
      intent: '결제 흐름을 안전하게 만든다',
    });

    expect(seen).toEqual(['prism_a0000001']); // exactly the flagged critical node
    expect(out.host_available).toBe(true);
    expect(out.engaged).toEqual(['prism_a0000001']);
    const ev = out.prism.evaluations.find((e) => e.node_id === 'prism_a0000001');
    expect(ev?.opponent_status).toBe('engaged');
    expect(ev?.opponent_critique).toContain('Popper refutation');
    // Untouched nodes keep their prior evaluation stamp (additive record-back).
    expect(out.prism.evaluations.find((e) => e.node_id === 'prism_b0000002')?.evaluation).toBe(
      'justified',
    );
  });

  test('host present but delegate yields empty → self-describing host_absent, not a fake pass', async () => {
    const p = prism(
      [node('prism_a0000001', '결제 재시도')],
      [critical('prism_a0000001')],
      [flagged('prism_a0000001')],
    );
    const out = await engageDialecticCritique(p, {
      policy: POLICY,
      currentHost: 'claude-code',
      isAvailable: CODEX_AVAILABLE,
      delegate: async () => '   ', // whitespace-only = produced nothing
      intent: '결제 흐름',
    });
    const ev = out.prism.evaluations.find((e) => e.node_id === 'prism_a0000001');
    expect(ev?.opponent_status).toBe('host_absent');
    expect(ev?.opponent_critique).toBeUndefined();
    expect(out.degraded).toContain('prism_a0000001');
  });
});

// ── Note B · per-run fan-out cap ──────────────────────────────────────────────

describe('engageDialecticCritique — per-run fan-out cap (Note B)', () => {
  test('caps invocations at the ceiling and reports the skipped remainder', async () => {
    const many = Array.from({ length: OPPONENT_FANOUT_CAP + 2 }, (_, i) =>
      node(`prism_n000000${i}`, `flagged ${i}`),
    );
    const p = prism(
      many,
      many.map((n) => critical(n.id)),
      many.map((n) => flagged(n.id)),
    );
    let invoked = 0;
    const out = await engageDialecticCritique(p, {
      policy: POLICY,
      currentHost: 'claude-code',
      isAvailable: CODEX_AVAILABLE,
      delegate: async () => {
        invoked++;
        return 'critique';
      },
      intent: 'x',
    });
    expect(invoked).toBe(OPPONENT_FANOUT_CAP); // never balloons past the ceiling
    expect(out.engaged).toHaveLength(OPPONENT_FANOUT_CAP);
    expect(out.skipped_by_cap).toBe(2);
  });
});

// ── ac-6 · independent 2nd-perspective dissent at anchor re-facing ────────────

describe('engageIndependentDissent — anchor re-facing (ac-6)', () => {
  test('re-derives from the ORIGINAL intent and records dissent on the anchor', async () => {
    const p = prism([node('prism_a0000001', '결제 재시도')]);
    let briefIntent = '';
    const out = await engageIndependentDissent(p, {
      policy: POLICY,
      currentHost: 'claude-code',
      isAvailable: CODEX_AVAILABLE,
      delegate: async (brief) => {
        briefIntent = brief.intent;
        expect(brief.concern).toBe('dissent');
        return '독립 2차 관점: 원의도의 전제 X가 성립하지 않을 수 있다';
      },
      intent: '결제 흐름을 안전하게 만든다',
    });
    expect(briefIntent).toBe('결제 흐름을 안전하게 만든다'); // re-derived from ORIGINAL intent
    // default anchor = tree root (the intent frame)
    const ev = out.prism.evaluations.find((e) => e.node_id === 'prism_root0001');
    expect(ev?.opponent_status).toBe('engaged');
    expect(ev?.opponent_dissent).toContain('독립 2차 관점');
    expect(ev?.opponent_critique).toBeUndefined(); // dissent field, not critique
  });

  test('host absent → dissent degrades self-describing on the anchor', async () => {
    const p = prism([node('prism_a0000001', '결제 재시도')]);
    const out = await engageIndependentDissent(p, {
      policy: POLICY,
      currentHost: 'claude-code',
      isAvailable: NONE_AVAILABLE,
      delegate: async () => 'MUST NOT record',
      intent: '결제 흐름',
    });
    const ev = out.prism.evaluations.find((e) => e.node_id === 'prism_root0001');
    expect(ev?.opponent_status).toBe('host_absent');
    expect(ev?.opponent_dissent).toBeUndefined();
    expect(out.host_available).toBe(false);
  });
});

// ── A1 semantic critic · achieve-vs-characterize (advisory, non-blocking) ─────

describe('semanticCriticTargets — localized to covered (fragment,node) pairs (A1 ac-1)', () => {
  test('returns exactly the covered pairs deriveFragmentMappings yields', () => {
    const p = prism([
      node('prism_a0000001', '결제 재시도 흐름'),
      node('prism_b0000002', '로그 포맷'),
    ]);
    const fragments = buildIntentFragments({ goal: '결제 재시도', in_scope: ['로그 포맷 정리'] });
    const targets = semanticCriticTargets(p, fragments);
    // identical to the deterministic covered mapping — no blanket sweep, no extra pairs
    expect(targets).toEqual(deriveFragmentMappings(fragments, p));
    expect(targets).toContainEqual({ fragment_id: 'goal', node_id: 'prism_a0000001' });
    expect(targets).toContainEqual({ fragment_id: 'in_scope[0]', node_id: 'prism_b0000002' });
  });

  test('zero covered mapping → empty list (localized, never a blanket sweep)', () => {
    const p = prism([node('prism_a0000001', '완전히 무관한 라벨')]);
    const fragments = buildIntentFragments({ goal: '결제 재시도' });
    expect(semanticCriticTargets(p, fragments)).toEqual([]);
  });
});

describe('engageSemanticCritique — record advisory + self-describing degrade (A1 ac-2)', () => {
  const fragments = buildIntentFragments({ goal: '결제 재시도' });

  test('delegate present → records semantic_critique + semantic_status=engaged (SEPARATE field)', async () => {
    const p = prism([node('prism_a0000001', '결제 재시도 흐름')]);
    const out = await engageSemanticCritique(p, fragments, {
      policy: POLICY,
      currentHost: 'claude-code',
      isAvailable: CODEX_AVAILABLE,
      delegate: async (brief) => {
        expect(brief.concern).toBe('semantic');
        expect(brief.fragment?.id).toBe('goal');
        expect(brief.fragment?.text).toBe('결제 재시도');
        return 'achieve: 노드가 fragment를 실제 달성함';
      },
      intent: '결제 흐름을 안전하게 만든다',
    });
    const ev = out.prism.evaluations.find((e) => e.node_id === 'prism_a0000001');
    expect(ev?.semantic_status).toBe('engaged');
    expect(ev?.semantic_critique).toContain('achieve');
    // seam-separate: the shared opponent_* fields are NOT touched (observability finding)
    expect(ev?.opponent_status).toBeUndefined();
    expect(ev?.opponent_critique).toBeUndefined();
    expect(out.engaged).toContain('prism_a0000001');
  });

  test('delegate null/empty → host_absent, never a fake record', async () => {
    const p = prism([node('prism_a0000001', '결제 재시도 흐름')]);
    const out = await engageSemanticCritique(p, fragments, {
      policy: POLICY,
      currentHost: 'claude-code',
      isAvailable: CODEX_AVAILABLE,
      delegate: async () => '   ', // whitespace-only = produced nothing
      intent: 'x',
    });
    const ev = out.prism.evaluations.find((e) => e.node_id === 'prism_a0000001');
    expect(ev?.semantic_status).toBe('host_absent');
    expect(ev?.semantic_critique).toBeUndefined();
    expect(out.degraded).toContain('prism_a0000001');
  });

  test('no opponent host → host_absent, NO delegate invocation', async () => {
    const p = prism([node('prism_a0000001', '결제 재시도 흐름')]);
    let called = 0;
    const out = await engageSemanticCritique(p, fragments, {
      policy: POLICY,
      currentHost: 'claude-code',
      isAvailable: NONE_AVAILABLE,
      delegate: async () => {
        called++;
        return 'MUST NOT record';
      },
      intent: 'x',
    });
    expect(called).toBe(0);
    expect(out.host_available).toBe(false);
    const ev = out.prism.evaluations.find((e) => e.node_id === 'prism_a0000001');
    expect(ev?.semantic_status).toBe('host_absent');
    expect(ev?.semantic_critique).toBeUndefined();
  });

  test('delegate throw → host_absent (no exception propagation, symmetric to null)', async () => {
    const p = prism([node('prism_a0000001', '결제 재시도 흐름')]);
    const out = await engageSemanticCritique(p, fragments, {
      policy: POLICY,
      currentHost: 'claude-code',
      isAvailable: CODEX_AVAILABLE,
      delegate: async () => {
        throw new Error('host boom');
      },
      intent: 'x',
    });
    const ev = out.prism.evaluations.find((e) => e.node_id === 'prism_a0000001');
    expect(ev?.semantic_status).toBe('host_absent');
    expect(ev?.semantic_critique).toBeUndefined();
    expect(out.degraded).toContain('prism_a0000001');
  });

  test('per-run cap bounds delegate calls and reports skipped_by_cap', async () => {
    const nodes = Array.from({ length: OPPONENT_FANOUT_CAP + 2 }, (_, i) =>
      node(`prism_n000000${i}`, `결제 재시도 ${i}`),
    );
    const p = prism(nodes); // goal keyword matches EVERY node → cap+2 covered pairs
    let invoked = 0;
    const out = await engageSemanticCritique(p, fragments, {
      policy: POLICY,
      currentHost: 'claude-code',
      isAvailable: CODEX_AVAILABLE,
      delegate: async () => {
        invoked++;
        return 'achieve';
      },
      intent: 'x',
    });
    expect(invoked).toBe(OPPONENT_FANOUT_CAP); // never balloons past the ceiling
    expect(out.skipped_by_cap).toBe(2);
  });
});

describe('engageSemanticCritique — non-blocking (A1 ac-3)', () => {
  test('A1 record does NOT change the criticalTermination verdict', async () => {
    const p = prism(
      [node('prism_a0000001', '결제 재시도 흐름')],
      [critical('prism_a0000001')],
      [{ node_id: 'prism_a0000001', evaluation: 'justified' }],
    );
    const before = criticalTermination(p);
    const out = await engageSemanticCritique(p, buildIntentFragments({ goal: '결제 재시도' }), {
      policy: POLICY,
      currentHost: 'claude-code',
      isAvailable: CODEX_AVAILABLE,
      delegate: async () => 'characterize only — 실제 달성 아님',
      intent: 'x',
    });
    const after = criticalTermination(out.prism);
    expect(after).toEqual(before); // gate verdict unchanged before/after A1 record
    // and the advisory WAS recorded (so it's the record, not a no-op, that left the gate still)
    expect(out.prism.evaluations.find((e) => e.node_id === 'prism_a0000001')?.semantic_status).toBe(
      'engaged',
    );
  });
});

// ── loop.ts drivers · single-writer store round-trip (OBJ-2) ──────────────────

describe('runOpponent*Round — store-driven wire, single-writer record-back (OBJ-2)', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-prism-opp-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test('runOpponentCritiqueRound persists the critique through EXACTLY one writeMap', async () => {
    const store = new PrismStore(repo);
    const seed = prism(
      [node('prism_a0000001', '결제 재시도')],
      [critical('prism_a0000001')],
      [flagged('prism_a0000001')],
    );
    await store.writeMap(seed);

    // Count writeMap calls DURING the driver run (OBJ-2: full-replace must not fan out).
    const original = store.writeMap.bind(store);
    let writes = 0;
    store.writeMap = (async (m: PrismIssueMap) => {
      writes++;
      return original(m);
    }) as typeof store.writeMap;

    const out = await runOpponentCritiqueRound(store, 'wi_prismtest', {
      policy: POLICY,
      currentHost: 'claude-code',
      isAvailable: CODEX_AVAILABLE,
      delegate: async () => 'DA critique + Popper refutation',
      intent: '결제 흐름을 안전하게 만든다',
    });

    expect(writes).toBe(1); // single-writer: one full-replace, never a racing fan-out
    expect(out.engaged).toEqual(['prism_a0000001']);
    // Durable trace (OBJ-4): the Run-tier issue-map annotation is persisted.
    const reloaded = await store.getMap('wi_prismtest');
    const ev = reloaded.evaluations.find((e) => e.node_id === 'prism_a0000001');
    expect(ev?.opponent_status).toBe('engaged');
    expect(ev?.opponent_critique).toContain('Popper refutation');
  });

  test('runOpponentDissentRound persists host_absent degrade through one writeMap', async () => {
    const store = new PrismStore(repo);
    await store.writeMap(prism([node('prism_a0000001', '결제 재시도')]));

    const out = await runOpponentDissentRound(store, 'wi_prismtest', {
      policy: POLICY,
      currentHost: 'claude-code',
      isAvailable: NONE_AVAILABLE,
      delegate: async () => 'MUST NOT record',
      intent: '결제 흐름',
    });

    expect(out.host_available).toBe(false);
    const reloaded = await store.getMap('wi_prismtest');
    const ev = reloaded.evaluations.find((e) => e.node_id === 'prism_root0001');
    expect(ev?.opponent_status).toBe('host_absent'); // self-describing, persisted
    expect(ev?.opponent_dissent).toBeUndefined();
  });
});
