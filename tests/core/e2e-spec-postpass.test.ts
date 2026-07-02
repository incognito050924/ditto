import { describe, expect, test } from 'bun:test';
import { checkStepConformance } from '~/core/e2e/conformance';
import { computeSourceDigest, parseGeneratedHeader } from '~/core/e2e/journey-digest';
import { extractStepMarkers } from '~/core/e2e/journey-dsl';
import { type PlanStepMap, injectDittoMarkers } from '~/core/e2e/spec-postpass';

/**
 * ac-4: the post-pass turns a raw generator spec (plain `// N.` step comments)
 * into a DITTO-generated, traceable spec — it prepends the provenance header and
 * injects one `// @step <journeyId>/sN` marker per DSL step, reading the N→sN
 * join from the plan sidecar (never re-derived from the comment text). The
 * output must clear checkStepConformance; a DSL step the generator dropped must
 * surface in `unmatched` so the CLI can exit non-zero.
 */

const JOURNEY = `---
ditto_journey: v2
id: jrn-login-basic
name: 기본 로그인
description: 등록 사용자가 로그인할 수 있다.
surfaces:
  - page:/login
implementation_intent: 등록 사용자가 로그인하면 대시보드로 이동한다.
---

1. [s1] 방문: /login
2. [s2] 입력: 이메일과 비밀번호
3. [s3] 확인: url contains /dashboard
`;

// Sidecar plan map: scenario "1" → case "기본" → plan-step-N → DSL step id.
const PLAN_MAP: PlanStepMap = {
  '1': {
    기본: { '1': 's1', '2': 's2', '3': 's3' },
  },
};

// Raw output of the official playwright-test-generator: plain `// N.` comments,
// NO provenance header, NO @step markers yet.
const RAW_GENERATED = `import { test, expect } from '@playwright/test';

test('jrn-login-basic', async ({ page }) => {
  // 1. visit the login page
  await page.goto('/login');
  // 2. fill in the credentials
  await page.getByLabel('Email').fill('user@example.com');
  // 3. land on the dashboard
  await expect(page).toHaveURL(/\\/dashboard/);
});
`;

const header = {
  sourcePath: 'e2e/journeys/login-basic.journey.md',
  digest: computeSourceDigest(JOURNEY),
  kind: 'journey' as const,
  id: 'jrn-login-basic',
};

describe('injectDittoMarkers (ac-4)', () => {
  test('prepends the provenance header and injects one @step marker per DSL step', () => {
    const result = injectDittoMarkers({
      generated: RAW_GENERATED,
      journeyId: 'jrn-login-basic',
      header,
      planMap: PLAN_MAP,
      dslOriginal: JOURNEY,
    });

    // Provenance header present, with the source digest (freshness → not stale).
    expect(result.spec).toContain('@ditto-generated');
    const parsed = parseGeneratedHeader(result.spec);
    expect(parsed?.digest).toBe(computeSourceDigest(JOURNEY));
    expect(parsed?.journey).toBe('jrn-login-basic');

    // One @step marker per DSL step, in body order, carrying the DSL 원문.
    expect(result.injected).toBe(3);
    expect(result.unmatched).toEqual([]);
    expect(extractStepMarkers(result.spec)).toEqual([
      'jrn-login-basic/s1',
      'jrn-login-basic/s2',
      'jrn-login-basic/s3',
    ]);
    expect(result.spec).toContain('// @step jrn-login-basic/s1 방문: /login');

    // The post-passed spec clears the conformance gate: required == found.
    const report = checkStepConformance({
      journeyText: JOURNEY,
      blockTexts: {},
      generatedText: result.spec,
      supportTexts: [],
    });
    expect(report.ok).toBe(true);
    expect([...report.found].sort()).toEqual([...report.required].sort());
  });

  test('확인: steps get @step markers from the assertion channel (expect lines) — conformance ok (ac-4)', () => {
    // Real pipeline shape: plan-adapter routes 확인: steps to Expected Results, so
    // the numbered map holds ONLY the action step (s1). The 확인: step id (s2) is
    // carried in the parallel assertion channel and must be marked above the
    // matching expect(...) line — which the generator emits with NO `// N.` comment.
    const journeyAssert = `---
ditto_journey: v2
id: jrn-assert
name: 확인 여정
description: 확인 스텝이 마커를 얻는다.
surfaces:
  - page:/login
implementation_intent: 방문 후 대시보드 URL을 확인한다.
---

1. [s1] 방문: /login
2. [s2] 확인: url contains /dashboard
`;
    // Numbered map: action steps only (no s2). Assertion channel: 확인: ids only.
    const planMapActionsOnly: PlanStepMap = { '1': { 기본: { '1': 's1' } } };
    const assertionChannel = { '1': { 기본: ['s2'] } };
    const rawGenerated = `import { test, expect } from '@playwright/test';

test('jrn-assert', async ({ page }) => {
  // 1. visit the login page
  await page.goto('/login');
  await expect(page).toHaveURL(/\\/dashboard/);
});
`;
    const result = injectDittoMarkers({
      generated: rawGenerated,
      journeyId: 'jrn-assert',
      header: {
        sourcePath: 'e2e/journeys/assert.journey.md',
        digest: computeSourceDigest(journeyAssert),
        kind: 'journey' as const,
        id: 'jrn-assert',
      },
      planMap: planMapActionsOnly,
      assertions: assertionChannel,
      dslOriginal: journeyAssert,
    });

    // BOTH the action (s1, via numbered map) and the 확인: step (s2, via the
    // assertion channel above the expect line) are marked, in body order.
    expect(result.injected).toBe(2);
    expect(result.unmatched).toEqual([]);
    expect(extractStepMarkers(result.spec)).toEqual(['jrn-assert/s1', 'jrn-assert/s2']);
    // The 확인: marker carries the DSL 원문 and sits above the expect line.
    expect(result.spec).toContain('// @step jrn-assert/s2 확인: url contains /dashboard');
    expect(result.spec).toMatch(
      /\/\/ @step jrn-assert\/s2 확인: url contains \/dashboard\n\s*await expect\(page\)/,
    );

    // The whole DSL step set (incl. the 확인: id) is now traceable → gate passes.
    const report = checkStepConformance({
      journeyText: journeyAssert,
      blockTexts: {},
      generatedText: result.spec,
      supportTexts: [],
    });
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
  });

  test('a DSL step with no generated marker surfaces in unmatched (CLI exits non-zero)', () => {
    // Generator dropped step 3 → no `// 3.` comment to resolve to s3.
    const generatedMissingStep3 = RAW_GENERATED.replace(
      '  // 3. land on the dashboard\n  await expect(page).toHaveURL(/\\/dashboard/);\n',
      '',
    );
    const result = injectDittoMarkers({
      generated: generatedMissingStep3,
      journeyId: 'jrn-login-basic',
      header,
      planMap: PLAN_MAP,
      dslOriginal: JOURNEY,
    });

    expect(result.injected).toBe(2);
    expect(result.unmatched).toEqual(['jrn-login-basic/s3']);

    // And the dropped step is a genuine conformance failure downstream.
    const report = checkStepConformance({
      journeyText: JOURNEY,
      blockTexts: {},
      generatedText: result.spec,
      supportTexts: [],
    });
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(['jrn-login-basic/s3']);
  });
});
