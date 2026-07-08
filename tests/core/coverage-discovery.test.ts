import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admitDiscoveredCategories, citesCode } from '~/core/coverage-discovery';
import { attributeCoverageEscape } from '~/core/coverage-feedback';
import { CoverageStore } from '~/core/coverage-store';
import { FAR_FIELD_ROUTED_OUT, type FarFieldCategory } from '~/core/coverage-taxonomy';

// wi_260707phi ac-5/ac-6 — the deterministic gap-only, evidence-bound discovery
// CORE. Per ADR-0001 ditto never calls a provider directly: a host-delegated agent
// scans the codebase and PROPOSES candidate categories; this module is the
// deterministic gate their proposals flow through — mirroring how
// coverage-relevance.ts consumes structured relevance-judge output. The safety
// rules live HERE so a candidate can never surface without grounding (ac-5) and a
// candidate that merely re-confirms an existing floor lens can never add noise
// (ac-6). The gate is PROJECT-SCOPED (candidates + effective taxonomy) — it never
// touches a per-work-item coverage.json, so it does NOT blanket-reject the way the
// WI-scoped attributeCoverageEscape would.

const TAXONOMY: FarFieldCategory[] = [
  { id: 'authentication', lens: '인증 경로·방식은 이 변경에서 일관·정확한가?' },
  { id: 'data-integrity', lens: '데이터 손실·손상·부분쓰기·멱등 영향이 있나?' },
];

describe('admitDiscoveredCategories — gap-only + evidence-bound (ac-5/ac-6)', () => {
  test('ac-6 gap-only: a candidate with NO covering floor lens + a code citation is ADMITTED', () => {
    const verdicts = admitDiscoveredCategories(
      [
        {
          id: 'supply-chain-provenance',
          lens: '의존성 공급망 서명·출처 검증이 이 변경에 필요한가?',
          evidence: 'src/deps/loader.ts:42',
        },
      ],
      TAXONOMY,
    );
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.admitted).toBe(true);
    expect(verdicts[0]?.id).toBe('supply-chain-provenance');
    expect(verdicts[0]?.lens).toBe('의존성 공급망 서명·출처 검증이 이 변경에 필요한가?');
    expect(verdicts[0]?.evidence).toBe('src/deps/loader.ts:42');
  });

  test('ac-6 gap-only: a candidate re-confirming an existing floor category is DROPPED (no floor re-confirmation noise)', () => {
    const verdicts = admitDiscoveredCategories(
      [
        {
          id: 'authentication',
          lens: '인증을 다시 확인하자',
          evidence: 'src/auth/login.ts:10',
        },
      ],
      TAXONOMY,
    );
    expect(verdicts[0]?.admitted).toBe(false);
    expect(verdicts[0]?.reason).toBe('reconfirms_covered');
  });

  test('ac-6 gap-only: a cov-cat-prefixed candidate id also matches the bare floor id (dropped)', () => {
    const verdicts = admitDiscoveredCategories(
      [{ id: 'cov-cat-data-integrity', lens: '무결성 재확인', evidence: 'src/db/write.ts:5' }],
      TAXONOMY,
    );
    expect(verdicts[0]?.admitted).toBe(false);
    expect(verdicts[0]?.reason).toBe('reconfirms_covered');
  });

  test('ac-6 gap-only: a candidate re-proposing a ROUTED-OUT category is DROPPED (its domain is covered by the receiving gate)', () => {
    const routed = FAR_FIELD_ROUTED_OUT[0];
    if (!routed) throw new Error('routed-out ledger unexpectedly empty');
    const verdicts = admitDiscoveredCategories(
      [{ id: routed.id, lens: '이 렌즈를 floor에 다시 넣자', evidence: 'src/core/charter.ts:1' }],
      TAXONOMY,
    );
    expect(verdicts[0]?.admitted).toBe(false);
    expect(verdicts[0]?.reason).toBe('reconfirms_covered');
  });

  test('ac-5 evidence-bound: a candidate with NO evidence is REJECTED (no-evidence-no-candidate)', () => {
    const verdicts = admitDiscoveredCategories(
      [{ id: 'supply-chain-provenance', lens: '공급망 검증?', evidence: '' }],
      TAXONOMY,
    );
    expect(verdicts[0]?.admitted).toBe(false);
    expect(verdicts[0]?.reason).toBe('no_evidence');
  });

  test('ac-5 evidence-bound: prose with NO verifiable citation token is REJECTED', () => {
    const verdicts = admitDiscoveredCategories(
      [{ id: 'supply-chain-provenance', lens: '공급망 검증?', evidence: '이건 위험해 보인다' }],
      TAXONOMY,
    );
    expect(verdicts[0]?.admitted).toBe(false);
    expect(verdicts[0]?.reason).toBe('no_evidence');
  });

  test('ac-5 evidence-bound: a dependency reference (scoped package + manifest citation) counts as grounding', () => {
    const verdicts = admitDiscoveredCategories(
      [
        {
          id: 'sdk-webhook-verification',
          lens: '결제 SDK 웹훅 서명 검증이 있나?',
          evidence: '@aws-sdk/client-s3',
        },
        {
          id: 'unpinned-dependency-risk',
          lens: '고정되지 않은 의존성 위험이 있나?',
          evidence: 'package.json:some-unpinned-dep',
        },
      ],
      TAXONOMY,
    );
    expect(verdicts[0]?.admitted).toBe(true);
    expect(verdicts[1]?.admitted).toBe(true);
  });

  test('ac-5 is the outer safety core: a candidate that BOTH lacks evidence AND re-confirms a floor lens is rejected as no_evidence', () => {
    const verdicts = admitDiscoveredCategories(
      [{ id: 'authentication', lens: '재확인', evidence: 'prose only' }],
      TAXONOMY,
    );
    expect(verdicts[0]?.admitted).toBe(false);
    expect(verdicts[0]?.reason).toBe('no_evidence');
  });

  test('every candidate gets a verdict — rejections are auditable, never silently dropped', () => {
    const verdicts = admitDiscoveredCategories(
      [
        { id: 'genuine-gap', lens: '새 도메인?', evidence: 'src/x.ts:1' },
        { id: 'authentication', lens: '재확인', evidence: 'src/y.ts:2' },
        { id: 'no-grounding', lens: '근거없음?', evidence: '' },
      ],
      TAXONOMY,
    );
    expect(verdicts.map((v) => v.admitted)).toEqual([true, false, false]);
  });
});

describe('citesCode — verifiable-citation shape gate (ac-5)', () => {
  test('accepts a file:line code pointer (codePointerMapsTo grammar, reused)', () => {
    expect(citesCode('src/core/foo.ts:42')).toBe(true);
  });
  test('accepts a scoped-package dependency reference', () => {
    expect(citesCode('@scope/pkg')).toBe(true);
  });
  test('accepts a manifest dependency citation', () => {
    expect(citesCode('go.mod:github.com/foo/bar')).toBe(true);
  });
  test('accepts evidence prose that CONTAINS a citation token', () => {
    expect(citesCode('웹훅 미검증 src/pay/webhook.ts:88 참고')).toBe(true);
  });
  test('rejects empty and prose-only evidence', () => {
    expect(citesCode('')).toBe(false);
    expect(citesCode('this looks risky to me')).toBe(false);
  });
});

// The task's non-blanket-reject requirement: the PROJECT-SCOPED gap path admits a
// genuine gap using ONLY {candidates, taxonomy} — no CoverageStore, no
// work_item_id, no per-WI coverage.json. Contrast with the WI-scoped
// attributeCoverageEscape, which requires a seeded coverage.json and blanket-rejects
// a floor candidate as "not seeded in this work item's coverage map". Reusing that
// path for project-wide discovery would reject genuine gaps.
describe('project-scoped gap path does NOT blanket-reject like the WI-scoped path', () => {
  test('project-scoped: a genuine gap is admitted with NO store / WI / coverage.json', () => {
    const verdicts = admitDiscoveredCategories(
      [
        {
          id: 'multi-tenant-isolation',
          lens: '테넌트 경계가 이 변경에서 새지 않나?',
          evidence: 'src/tenant/scope.ts:120',
        },
      ],
      TAXONOMY,
    );
    expect(verdicts[0]?.admitted).toBe(true);
  });

  test('WI-scoped attributeCoverageEscape blanket-rejects a floor candidate when the WI has no seeded coverage.json (the path discovery must NOT reuse)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cov-discovery-'));
    await Bun.write(join(root, '.ditto', '.keep'), '');
    try {
      const store = new CoverageStore(root); // no writeMap → store.exists() is false
      const verdict = await attributeCoverageEscape(store, {
        work_item_id: 'wi_00000000',
        category_id: 'authentication',
        evidence: 'x',
      });
      expect(verdict.accepted).toBe(false);
      expect(verdict.reason).toContain('not seeded');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
