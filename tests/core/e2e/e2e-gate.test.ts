import { describe, expect, test } from 'bun:test';
import { type E2eGateInput, type JourneyEntry, verifyE2eEvidence } from '~/core/e2e/e2e-gate';
import type {
  CheckEvidence,
  EvidenceQueryResult,
  EvidenceSource,
  RepoCoord,
} from '~/core/e2e/evidence-source';
import type { PushedRef } from '~/core/push-gate';
import type { RecipeE2eGate } from '~/schemas/recipe';

// n-gate-engine (wi_2607095fz) — the PURE e2e push-gate decision core. Journeys and a
// fake EvidenceSource are INJECTED (mock-unit, NO real git/network), so every branch —
// config-presence split, protected match, membership (exclude + unparseable), evidence
// classification, per-ref sha, and fail-closed on !ok — is deterministic.

const COORD: RepoCoord = { repo: 'octo/widget' };
const EVIDENCE = { source: 'github-checks' as const, check_name_template: 'e2e/{journey}' };
const GATE: RecipeE2eGate = { protected_branches: ['main'], evidence: EVIDENCE };

/** A pushed branch ref carrying its own localSha. */
function ref(branch: string, sha: string): PushedRef {
  return {
    localRef: `refs/heads/${branch}`,
    localSha: sha,
    remoteRef: `refs/heads/${branch}`,
    remoteSha: 'r',
    branch,
  };
}

/** A journey membership entry (excluded defaults false). */
function jrny(id: string, over: Partial<JourneyEntry> = {}): JourneyEntry {
  return { id, name: id, excluded: false, ...over };
}

/** A CI check-run (completed + success by default). */
function chk(name: string, over: Partial<CheckEvidence> = {}): CheckEvidence {
  return { name, status: 'completed', conclusion: 'success', head_sha: 'x', ...over };
}

/** A fake EvidenceSource returning a fixed result (or a per-sha function), recording shas. */
function fakeSource(reply: EvidenceQueryResult | ((sha: string) => EvidenceQueryResult)): {
  source: EvidenceSource;
  shas: string[];
} {
  const shas: string[] = [];
  const source: EvidenceSource = {
    fetchCommitEvidence(_coord, sha) {
      shas.push(sha);
      return typeof reply === 'function' ? reply(sha) : reply;
    },
  };
  return { source, shas };
}

/** A never-called source: any invocation fails the test loudly (asserts no fetch). */
const NEVER: EvidenceSource = {
  fetchCommitEvidence() {
    throw new Error('evidence source must NOT be called');
  },
};

function input(over: Partial<E2eGateInput>): E2eGateInput {
  return {
    pushedRefs: [ref('main', 'sha0')],
    e2eGate: GATE,
    journeys: [jrny('login')],
    repoCoord: COORD,
    source: fakeSource({ ok: true, sha: 'sha0', checks: [chk('e2e/login')] }).source,
    protectedBranches: ['main'],
    ...over,
  };
}

describe('verifyE2eEvidence — config-presence split (finding 4, ac-4)', () => {
  test('e2e_gate undefined → PASS unconfigured (degrade, never inferred)', () => {
    const r = verifyE2eEvidence(input({ e2eGate: undefined, source: NEVER }));
    expect(r).toEqual({ decision: 'pass', reason: 'unconfigured' });
  });
});

describe('verifyE2eEvidence — protected-branch match', () => {
  test('a non-protected branch push → PASS (gate does not fire)', () => {
    const r = verifyE2eEvidence(input({ pushedRefs: [ref('feature', 'shaF')], source: NEVER }));
    expect(r).toEqual({ decision: 'pass', reason: 'no protected branch' });
  });

  test('"*" protects EVERY pushed branch (sentinel reuse)', () => {
    const r = verifyE2eEvidence(
      input({
        pushedRefs: [ref('anything', 's1')],
        protectedBranches: ['*'],
        source: fakeSource({ ok: true, sha: 's1', checks: [chk('e2e/login')] }).source,
      }),
    );
    expect(r).toEqual({ decision: 'pass' });
  });

  test('a tag push (branch=null) never matches, even under "*" → PASS no protected branch', () => {
    const tag: PushedRef = {
      localRef: 'refs/tags/v1',
      localSha: 't1',
      remoteRef: 'refs/tags/v1',
      remoteSha: 'r',
      branch: null,
    };
    const r = verifyE2eEvidence(
      input({ pushedRefs: [tag], protectedBranches: ['*'], source: NEVER }),
    );
    expect(r).toEqual({ decision: 'pass', reason: 'no protected branch' });
  });
});

describe('verifyE2eEvidence — evidence classification on a protected push (ac-3)', () => {
  test('all mandatory checks success → PASS', () => {
    const r = verifyE2eEvidence(
      input({
        journeys: [jrny('login'), jrny('checkout')],
        source: fakeSource({
          ok: true,
          sha: 'sha0',
          checks: [chk('e2e/login'), chk('e2e/checkout')],
        }).source,
      }),
    );
    expect(r).toEqual({ decision: 'pass' });
  });

  test('a mandatory check MISSING → BLOCK status=missing (absent ≠ pass)', () => {
    const r = verifyE2eEvidence(
      input({
        journeys: [jrny('login'), jrny('checkout')],
        source: fakeSource({ ok: true, sha: 'sha0', checks: [chk('e2e/login')] }).source,
      }),
    );
    expect(r.decision).toBe('block');
    expect(r.blocked).toEqual([
      {
        journeyId: 'checkout',
        journeyName: 'checkout',
        status: 'missing',
        checkName: 'e2e/checkout',
        sha: 'sha0',
      },
    ]);
  });

  test('a FAILED conclusion → BLOCK status=failed', () => {
    const r = verifyE2eEvidence(
      input({
        source: fakeSource({
          ok: true,
          sha: 'sha0',
          checks: [chk('e2e/login', { conclusion: 'failure' })],
        }).source,
      }),
    );
    expect(r.decision).toBe('block');
    expect(r.blocked?.[0]?.status).toBe('failed');
  });

  test('a PENDING run (status!=completed) → BLOCK status=pending', () => {
    const r = verifyE2eEvidence(
      input({
        source: fakeSource({
          ok: true,
          sha: 'sha0',
          checks: [chk('e2e/login', { status: 'in_progress', conclusion: null })],
        }).source,
      }),
    );
    expect(r.decision).toBe('block');
    expect(r.blocked?.[0]?.status).toBe('pending');
  });

  test('a STALE conclusion (skipped/neutral) → BLOCK status=stale', () => {
    const r = verifyE2eEvidence(
      input({
        source: fakeSource({
          ok: true,
          sha: 'sha0',
          checks: [chk('e2e/login', { conclusion: 'skipped' })],
        }).source,
      }),
    );
    expect(r.decision).toBe('block');
    expect(r.blocked?.[0]?.status).toBe('stale');
  });

  test('a custom check_name_template is honored ({journey} → id)', () => {
    const gate: RecipeE2eGate = {
      protected_branches: ['main'],
      evidence: { source: 'github-checks', check_name_template: 'ci/e2e-{journey}-job' },
    };
    const r = verifyE2eEvidence(
      input({
        e2eGate: gate,
        source: fakeSource({ ok: true, sha: 'sha0', checks: [chk('ci/e2e-login-job')] }).source,
      }),
    );
    expect(r).toEqual({ decision: 'pass' });
  });
});

describe('verifyE2eEvidence — membership (exclude + degrade + unparseable)', () => {
  test('an EXCLUDED journey is not mandatory → its missing check is ignored → PASS', () => {
    const r = verifyE2eEvidence(
      input({
        journeys: [jrny('login'), jrny('legacy', { excluded: true })],
        source: fakeSource({ ok: true, sha: 'sha0', checks: [chk('e2e/login')] }).source,
      }),
    );
    expect(r).toEqual({ decision: 'pass' });
  });

  test('0 mandatory journeys (all excluded) → PASS degrade (USER override of finding 8)', () => {
    const r = verifyE2eEvidence(
      input({ journeys: [jrny('a', { excluded: true })], source: NEVER }),
    );
    expect(r).toEqual({ decision: 'pass', reason: 'no mandatory journeys' });
  });

  test('0 mandatory journeys (journeys empty) → PASS degrade', () => {
    const r = verifyE2eEvidence(input({ journeys: [], source: NEVER }));
    expect(r).toEqual({ decision: 'pass', reason: 'no mandatory journeys' });
  });

  test('an UNPARSEABLE non-excluded journey → BLOCK (malformed ≠ absent, findings 6/10)', () => {
    // Even when evidence WOULD pass, a malformed journey must never silently drop.
    const r = verifyE2eEvidence(
      input({
        journeys: [jrny('login'), jrny('broken', { unparseable: true })],
        source: fakeSource({ ok: true, sha: 'sha0', checks: [chk('e2e/login')] }).source,
      }),
    );
    expect(r.decision).toBe('block');
    expect(r.blocked?.some((b) => b.journeyId === 'broken')).toBe(true);
  });

  test('an unparseable journey blocks BEFORE any evidence fetch (fail-closed)', () => {
    const r = verifyE2eEvidence(
      input({ journeys: [jrny('broken', { unparseable: true })], source: NEVER }),
    );
    expect(r.decision).toBe('block');
  });

  test('an unparseable but EXCLUDED journey does not block (excluded wins membership)', () => {
    const r = verifyE2eEvidence(
      input({
        journeys: [jrny('login'), jrny('broken', { unparseable: true, excluded: true })],
        source: fakeSource({ ok: true, sha: 'sha0', checks: [chk('e2e/login')] }).source,
      }),
    );
    expect(r).toEqual({ decision: 'pass' });
  });
});

describe('verifyE2eEvidence — fail-closed on unavailable evidence (finding 5, ac-5)', () => {
  const reasons = [
    'source_absent',
    'unauthenticated',
    'insufficient_perm',
    'rate_limited',
    'timeout',
    'unparseable',
    'nonzero',
  ] as const;
  for (const reason of reasons) {
    test(`source {ok:false, reason:'${reason}'} → BLOCK`, () => {
      const r = verifyE2eEvidence(input({ source: fakeSource({ ok: false, reason }).source }));
      expect(r.decision).toBe('block');
      expect(r.reason).toContain(reason);
    });
  }

  test('an EMPTY checks:[] on {ok:true} is valid, but a mandatory journey → BLOCK missing (not "no gate")', () => {
    const r = verifyE2eEvidence(
      input({ source: fakeSource({ ok: true, sha: 'sha0', checks: [] }).source }),
    );
    expect(r.decision).toBe('block');
    expect(r.blocked?.[0]?.status).toBe('missing');
  });
});

describe('verifyE2eEvidence — multi-ref evaluates EACH ref by its OWN sha (finding 1)', () => {
  test('two protected refs → the source is read once per ref sha; a fail on one blocks', () => {
    const { source, shas } = fakeSource((sha) =>
      sha === 'shaA'
        ? { ok: true, sha, checks: [chk('e2e/login')] }
        : { ok: true, sha, checks: [chk('e2e/login', { conclusion: 'failure' })] },
    );
    const r = verifyE2eEvidence(
      input({
        pushedRefs: [ref('main', 'shaA'), ref('release', 'shaB')],
        protectedBranches: ['main', 'release'],
        source,
      }),
    );
    expect(r.decision).toBe('block');
    // Each ref's OWN sha was read.
    expect(shas).toEqual(['shaA', 'shaB']);
    // The block is attributed to shaB (the failing ref's commit).
    expect(r.blocked?.map((b) => b.sha)).toEqual(['shaB']);
  });

  test('two protected refs both green → PASS', () => {
    const { source } = fakeSource((sha) => ({ ok: true, sha, checks: [chk('e2e/login')] }));
    const r = verifyE2eEvidence(
      input({
        pushedRefs: [ref('main', 'shaA'), ref('release', 'shaB')],
        protectedBranches: ['main', 'release'],
        source,
      }),
    );
    expect(r).toEqual({ decision: 'pass' });
  });
});
