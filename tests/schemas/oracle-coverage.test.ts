import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_COVERAGE_DISPOSITION,
  ORACLE_PATTERN_MAX_LENGTH,
  coverageDisposition,
  coverageMap,
  coverageNode,
  coverageTaxonomyConfig,
  isDecidableOraclePattern,
  labelerLabel,
  oracleAdvisoryReason,
  oracleClaim,
  oracleEnforcementTier,
  oracleMode,
  oracleProvenance,
  oracleVerdict,
  oracleVerdictOutcome,
} from '~/schemas/coverage';
import { acOracle, acceptanceCriterion } from '~/schemas/work-item';

// wi_260706n4w (n2-schema-coverage, ac-1/ac-2/ac-4 schema layer) — additive-only:
// far-field disposition routing, 2-mode oracle claim + verdict, oracle/labeler
// provenance sidecar, AcOracle pattern+mode. Every persisted-node field is
// OPTIONAL so pre-change coverage.json keeps parsing (compat).

const WI = 'wi_260706n4w';

const node = (over: Record<string, unknown> = {}) => ({
  id: 'cov-cat-injection',
  parent_id: 'cov-root',
  label: '입력이 명령·쿼리로 흘러드는 경로는?',
  origin: 'seed' as const,
  depth_weight: 1,
  state: 'open' as const,
  children: [] as string[],
  ...over,
});

describe('coverageDisposition (static routing enum)', () => {
  test('accepts all three routes', () => {
    for (const d of ['code-verify', 'user-intent', 'runtime-post-impl']) {
      expect(coverageDisposition.safeParse(d).success).toBe(true);
    }
  });

  test('rejects an unknown route', () => {
    expect(coverageDisposition.safeParse('manual-review').success).toBe(false);
  });

  test('DEFAULT_COVERAGE_DISPOSITION is a member of the enum (unspecified-category default)', () => {
    expect(coverageDisposition.safeParse(DEFAULT_COVERAGE_DISPOSITION).success).toBe(true);
  });
});

describe('coverageNode.disposition (additive-optional)', () => {
  test('node WITHOUT disposition still parses (legacy shape) and the field is undefined', () => {
    const parsed = coverageNode.parse(node());
    expect(parsed.disposition).toBeUndefined();
  });

  test('node WITH a disposition parses', () => {
    expect(coverageNode.safeParse(node({ disposition: 'code-verify' })).success).toBe(true);
  });

  test('node with an invalid disposition is rejected', () => {
    expect(coverageNode.safeParse(node({ disposition: 'oracle' })).success).toBe(false);
  });
});

describe('coverageTaxonomyConfig disposition override (tier-②)', () => {
  test('added category may carry a disposition', () => {
    const cfg = {
      added: [
        { id: 'tenancy', lens: '테넌트 경계를 넘는 데이터 접근은?', disposition: 'user-intent' },
      ],
    };
    expect(coverageTaxonomyConfig.safeParse(cfg).success).toBe(true);
  });

  test('added category without disposition still parses (legacy config)', () => {
    const cfg = { added: [{ id: 'tenancy', lens: '테넌트 경계를 넘는 데이터 접근은?' }] };
    expect(coverageTaxonomyConfig.safeParse(cfg).success).toBe(true);
  });

  test('dispositions map overrides floor categories by id', () => {
    const cfg = { dispositions: { injection: 'code-verify', regulatory: 'user-intent' } };
    expect(coverageTaxonomyConfig.safeParse(cfg).success).toBe(true);
  });

  test('dispositions map rejects an invalid route value', () => {
    const cfg = { dispositions: { injection: 'grep' } };
    expect(coverageTaxonomyConfig.safeParse(cfg).success).toBe(false);
  });

  test('empty config still parses (fail-open floor unchanged)', () => {
    expect(coverageTaxonomyConfig.safeParse({}).success).toBe(true);
  });
});

// ── 2-mode oracle claim (ac-1) ──────────────────────────────────────────────
// A claim is untrusted LLM output: the schema persists it RAW; decidability
// (token shape + containment) is the n4 shape gate's call, not parse-time.

describe('oracleMode / oracleClaim (2-mode)', () => {
  test('mode enum accepts presence and absence only', () => {
    expect(oracleMode.safeParse('presence').success).toBe(true);
    expect(oracleMode.safeParse('absence').success).toBe(true);
    expect(oracleMode.safeParse('mutation').success).toBe(false);
  });

  test('presence claim parses (file:line citation, no new grammar)', () => {
    const claim = { mode: 'presence', maps_to: 'src/core/gates.ts:42' };
    expect(oracleClaim.safeParse(claim).success).toBe(true);
  });

  test('absence claim parses (pattern + scope_path)', () => {
    const claim = { mode: 'absence', pattern: 'legacyFnName', scope_path: 'src/core' };
    expect(oracleClaim.safeParse(claim).success).toBe(true);
  });

  test('absence claim without pattern is rejected', () => {
    const claim = { mode: 'absence', scope_path: 'src/core' };
    expect(oracleClaim.safeParse(claim).success).toBe(false);
  });

  test('absence claim without scope_path is rejected', () => {
    const claim = { mode: 'absence', pattern: 'legacyFnName' };
    expect(oracleClaim.safeParse(claim).success).toBe(false);
  });

  test('unknown mode is rejected', () => {
    const claim = { mode: 'grep', pattern: 'x', scope_path: 'src' };
    expect(oracleClaim.safeParse(claim).success).toBe(false);
  });

  test('a PROSE pattern still PARSES (raw persistence — the labeler needs fabricated claims)', () => {
    const claim = { mode: 'absence', pattern: 'no such function anywhere', scope_path: 'src' };
    expect(oracleClaim.safeParse(claim).success).toBe(true);
  });
});

describe('isDecidableOraclePattern (n4 shape-gate SoT)', () => {
  test('single non-whitespace token within the cap is decidable', () => {
    expect(isDecidableOraclePattern('legacyFnName')).toBe(true);
  });

  test('prose (whitespace) is not decidable', () => {
    expect(isDecidableOraclePattern('no such function')).toBe(false);
  });

  test('empty pattern is not decidable', () => {
    expect(isDecidableOraclePattern('')).toBe(false);
  });

  test('pattern over the length cap is not decidable', () => {
    expect(isDecidableOraclePattern('x'.repeat(ORACLE_PATTERN_MAX_LENGTH + 1))).toBe(false);
    expect(isDecidableOraclePattern('x'.repeat(ORACLE_PATTERN_MAX_LENGTH))).toBe(true);
  });
});

// ── 2-mode oracle verdict (ac-2) ────────────────────────────────────────────
// The exit 3-way branch must be representable WITHOUT coercion: confirmed /
// refuted / advisory_unverified are distinct, and an advisory verdict must say
// why (shape_gate | exec_error | tool_absent) — an error is never "absent".

const absenceVerdict = (over: Record<string, unknown> = {}) => ({
  claim_id: 'clm-1',
  category_id: 'injection',
  claim: { mode: 'absence' as const, pattern: 'evalUserInput', scope_path: 'src' },
  outcome: 'confirmed' as const,
  tier: 'hard_reject' as const,
  ...over,
});

describe('oracleVerdict (exit 3-way, tier, advisory degradation)', () => {
  test('outcome enum carries exactly the three branches', () => {
    for (const o of ['confirmed', 'refuted', 'advisory_unverified']) {
      expect(oracleVerdictOutcome.safeParse(o).success).toBe(true);
    }
    expect(oracleVerdictOutcome.safeParse('absent').success).toBe(false);
  });

  test('tier enum: hard_reject | advisory', () => {
    expect(oracleEnforcementTier.safeParse('hard_reject').success).toBe(true);
    expect(oracleEnforcementTier.safeParse('advisory').success).toBe(true);
    expect(oracleEnforcementTier.safeParse('soft').success).toBe(false);
  });

  test('confirmed-absent verdict parses (exit 1)', () => {
    expect(oracleVerdict.safeParse(absenceVerdict({ exit_code: 1 })).success).toBe(true);
  });

  test('refuted verdict parses (exit 0 — the claimed-absent token exists)', () => {
    expect(
      oracleVerdict.safeParse(absenceVerdict({ outcome: 'refuted', exit_code: 0 })).success,
    ).toBe(true);
  });

  test('advisory_unverified WITHOUT advisory_reason is rejected (no silent degradation)', () => {
    expect(
      oracleVerdict.safeParse(absenceVerdict({ outcome: 'advisory_unverified' })).success,
    ).toBe(false);
  });

  test('advisory_unverified with each degradation reason parses (incl. tool_absent, ADR-0018)', () => {
    for (const reason of ['shape_gate', 'exec_error', 'tool_absent']) {
      expect(
        oracleVerdict.safeParse(
          absenceVerdict({
            outcome: 'advisory_unverified',
            tier: 'advisory',
            advisory_reason: reason,
          }),
        ).success,
      ).toBe(true);
    }
    expect(oracleAdvisoryReason.safeParse('gave_up').success).toBe(false);
  });

  test('presence-claim verdict parses', () => {
    const v = absenceVerdict({
      claim: { mode: 'presence', maps_to: 'src/core/gates.ts:42' },
      outcome: 'refuted',
      tier: 'advisory',
    });
    expect(oracleVerdict.safeParse(v).success).toBe(true);
  });

  test('missing claim_id is rejected (correlation key is mandatory)', () => {
    const { claim_id: _drop, ...rest } = absenceVerdict();
    expect(oracleVerdict.safeParse(rest).success).toBe(false);
  });
});

// ── oracle-verdict + labeler provenance sidecar (ac-4/ac-5) ─────────────────
// Mirrors relevanceProvenance: raw oracle_verdicts[] (ENFORCE) + raw
// labeler_labels[] (JUDGE, verdict-blind) as SEPARATE arrays + a deterministic
// tally slot (CORRELATE — computed by ditto code, never by either agent).

const provenance = (over: Record<string, unknown> = {}) => ({
  schema_version: '0.1.0' as const,
  work_item_id: WI,
  oracle_verdicts: [absenceVerdict({ exit_code: 1 })],
  labeler_labels: [{ claim_id: 'clm-1', label: 'real' as const }],
  tally: {
    claims: 1,
    oracle: { confirmed: 1, refuted: 0, advisory_unverified: 0 },
    labeler: { real: 1, fabricated: 0 },
  },
  ...over,
});

describe('labelerLabel (verdict-blind JUDGE set)', () => {
  test('valid label parses, both label values accepted', () => {
    expect(labelerLabel.safeParse({ claim_id: 'clm-1', label: 'real' }).success).toBe(true);
    expect(
      labelerLabel.safeParse({ claim_id: 'clm-1', label: 'fabricated', reason: '토큰 실재' })
        .success,
    ).toBe(true);
  });

  test('unknown label value is rejected', () => {
    expect(labelerLabel.safeParse({ claim_id: 'clm-1', label: 'maybe' }).success).toBe(false);
  });
});

describe('oracleProvenance sidecar (oracle-provenance.json)', () => {
  test('valid sidecar parses and round-trips', () => {
    const original = oracleProvenance.parse(provenance());
    const round = oracleProvenance.parse(JSON.parse(JSON.stringify(original)));
    expect(round).toEqual(original);
  });

  test('empty arrays + zero tally parse (pre-run state)', () => {
    const empty = provenance({
      oracle_verdicts: [],
      labeler_labels: [],
      tally: {
        claims: 0,
        oracle: { confirmed: 0, refuted: 0, advisory_unverified: 0 },
        labeler: { real: 0, fabricated: 0 },
      },
    });
    expect(oracleProvenance.safeParse(empty).success).toBe(true);
  });

  test('rejects bad work_item_id', () => {
    expect(oracleProvenance.safeParse(provenance({ work_item_id: 'nope' })).success).toBe(false);
  });

  test('rejects negative tally counts', () => {
    const bad = provenance({
      tally: {
        claims: -1,
        oracle: { confirmed: 0, refuted: 0, advisory_unverified: 0 },
        labeler: { real: 0, fabricated: 0 },
      },
    });
    expect(oracleProvenance.safeParse(bad).success).toBe(false);
  });

  test('rejects a missing tally (the CORRELATE slot is mandatory)', () => {
    const { tally: _drop, ...rest } = provenance();
    expect(oracleProvenance.safeParse(rest).success).toBe(false);
  });
});

// ── AcOracle pattern + mode (ac-1, additive-optional) ───────────────────────
// EXACTLY two new fields on the existing triple; the absence claim maps to
// verification_method=static_scan, direction=backward, maps_to=scope_path.

describe('acOracle.pattern / acOracle.mode (additive)', () => {
  test('legacy oracle (triple only) still parses; new fields undefined', () => {
    const parsed = acOracle.parse({
      verification_method: 'static_scan',
      maps_to: 'src/core/gates.ts:42',
      direction: 'backward',
    });
    expect(parsed.pattern).toBeUndefined();
    expect(parsed.mode).toBeUndefined();
  });

  test('absence oracle parses (static_scan + backward + maps_to=scope_path + pattern + mode)', () => {
    const oracle = {
      verification_method: 'static_scan',
      maps_to: 'src/core',
      direction: 'backward',
      pattern: 'legacyFnName',
      mode: 'absence',
    };
    expect(acOracle.safeParse(oracle).success).toBe(true);
  });

  test('presence oracle parses (file:line maps_to reused, no new grammar)', () => {
    const oracle = {
      verification_method: 'static_scan',
      maps_to: 'src/core/gates.ts:42',
      direction: 'backward',
      mode: 'presence',
    };
    expect(acOracle.safeParse(oracle).success).toBe(true);
  });

  test('invalid mode value is rejected', () => {
    const oracle = {
      verification_method: 'static_scan',
      maps_to: 'src/core',
      direction: 'backward',
      mode: 'mutation',
    };
    expect(acOracle.safeParse(oracle).success).toBe(false);
  });

  test('acceptanceCriterion with an absence oracle parses end-to-end', () => {
    const ac = {
      id: 'ac-1',
      statement: 'legacyFnName is gone from src/core',
      verdict: 'unverified',
      evidence: [],
      oracle: {
        verification_method: 'static_scan',
        maps_to: 'src/core',
        direction: 'backward',
        pattern: 'legacyFnName',
        mode: 'absence',
      },
    };
    expect(acceptanceCriterion.safeParse(ac).success).toBe(true);
  });

  test('existing forward/code-pointer superRefine is untouched by the new fields', () => {
    const oracle = {
      verification_method: 'static_scan',
      maps_to: 'src/core/gates.ts:42',
      direction: 'forward',
      mode: 'presence',
    };
    expect(acOracle.safeParse(oracle).success).toBe(false);
  });
});

// ── legacy compat (plan_brief) ──────────────────────────────────────────────
// A coverage.json written BEFORE this increment (no disposition anywhere) must
// keep parsing under the new schema. The literal mirrors the on-disk shape of
// `.ditto/local/runs/<wi>/coverage.json` (close_reason / residual_risk on
// non-resolved closes, resolved root, no new fields) — inline so the test stays
// deterministic and does not read the gitignored personal tier.

describe('pre-change coverage.json keeps parsing (additive-only compat)', () => {
  const legacyCoverageLiteral = {
    schema_version: '0.1.0',
    work_item_id: WI,
    root_id: 'cov-root',
    nodes: [
      {
        id: 'cov-root',
        parent_id: null,
        label: 'far-field pre-mortem 라우팅 + 2모드 oracle 신뢰성',
        origin: 'seed',
        depth_weight: 1,
        state: 'resolved',
        children: ['cov-cat-authentication', 'cov-cat-injection'],
      },
      {
        id: 'cov-cat-authentication',
        parent_id: 'cov-root',
        label: '이 기능에 도달하는 인증 경로·방식은?',
        origin: 'seed',
        depth_weight: 1,
        state: 'out_of_scope',
        children: [],
        close_reason: 'in-process TS 엔진+로컬 CLI, 인증 표면 없음',
        residual_risk: '없음 — 네트워크 경계 부재',
      },
      {
        id: 'cov-cat-injection',
        parent_id: 'cov-root',
        label: '입력이 명령·쿼리로 흘러드는 경로는?',
        origin: 'seed',
        depth_weight: 1,
        state: 'resolved',
        children: [],
      },
    ],
  };

  test('legacy map parses; disposition is absent on every node', () => {
    const parsed = coverageMap.parse(legacyCoverageLiteral);
    expect(parsed.nodes.length).toBe(3);
    for (const n of parsed.nodes) {
      expect(n.disposition).toBeUndefined();
    }
  });

  test('legacy map round-trips byte-equivalently through the new schema', () => {
    const parsed = coverageMap.parse(legacyCoverageLiteral);
    const round = coverageMap.parse(JSON.parse(JSON.stringify(parsed)));
    expect(round).toEqual(parsed);
  });
});
