import { describe, expect, test } from 'bun:test';
import type { GeneratorSeams, RunGeneratorInput, RunGeneratorSeams } from '~/core/e2e/generator';
import { probeGenerator, runGenerator } from '~/core/e2e/generator';
import type { E2eAgentsRecord } from '~/core/e2e/init-agents';
import type { GeneratedHeaderInput } from '~/core/e2e/journey-digest';
import type { PlanStepMap } from '~/core/e2e/plan-adapter';

/**
 * wi_2607026qs ac-3 (Contract 9 · N-generator orchestration). The generator
 * orchestration probes whether the OFFICIAL Playwright test-generator is usable
 * (live browser + Playwright>=1.61 + installed agents + MCP), drives it over the
 * live browser from the plan and post-passes the output when usable, and
 * gracefully DEGRADES to the e2e-scripter fallback otherwise (ADR-0018) — never
 * crashing when Playwright/browser is absent. Every real effect (browser probe,
 * version read, agents record, MCP probe, the live drive) sits behind an
 * injectable seam so these unit tests need no real browser/Playwright.
 */

const REPO = '/tmp/ditto-generator-test-repo-does-not-exist';

const header: GeneratedHeaderInput = {
  sourcePath: 'e2e/journeys/login.journey.md',
  digest: 'a'.repeat(64),
  kind: 'journey',
  id: 'jrn-login',
};

const dslOriginal = `1. [s1] 입력: 이메일 입력
2. [s2] 확인: 대시보드 노출`;

const planMap: PlanStepMap = { 1: { 기본: { 1: 's1', 2: 's2' } } };

const rawGeneratedSpec = `import { test, expect } from '@playwright/test';

test('로그인 기본', async ({ page }) => {
  // 1. 이메일 입력
  await page.getByLabel('email').fill('a@b.c');
  // 2. 대시보드 노출
  await expect(page.getByRole('heading')).toBeVisible();
});
`;

const okRecord: E2eAgentsRecord = {
  installed_at: '2026-07-02T00:00:00.000Z',
  playwright_version: '1.61.0',
  loop: 'claude',
  plan_format_version: 'v1',
  healer: 'constrained',
};

function baseSeams(overrides: Partial<GeneratorSeams> = {}): GeneratorSeams {
  return {
    probeBrowser: async () => ({ available: true, reason: 'browser ok' }),
    readPlaywrightVersion: async () => 'Version 1.61.0',
    readAgentsRecord: async () => okRecord,
    probeMcp: async () => true,
    ...overrides,
  };
}

const runInput: RunGeneratorInput = {
  repoRoot: REPO,
  host: 'claude',
  journeyId: 'jrn-login',
  plan: '# 로그인 Test Plan\n\n## Test Scenarios\n### 1. 로그인\n',
  planMap,
  dslOriginal,
  header,
  specPath: 'e2e/generated/login.spec.ts',
  planPath: 'specs/login.plan.md',
};

describe('probeGenerator — per-check availability', () => {
  test('all four checks pass → usable', async () => {
    const a = await probeGenerator(REPO, 'claude', baseSeams());
    expect(a.usable).toBe(true);
    expect(a.checks).toEqual({
      browser: true,
      playwrightVersionOk: true,
      agentsInstalled: true,
      mcpAvailable: true,
    });
  });

  test('browser absent → usable=false, reason names the browser check', async () => {
    const a = await probeGenerator(
      REPO,
      'claude',
      baseSeams({ probeBrowser: async () => ({ available: false, reason: 'no cached chromium' }) }),
    );
    expect(a.usable).toBe(false);
    expect(a.checks.browser).toBe(false);
    expect(a.reason).toContain('browser');
  });

  test('Playwright < 1.61 → usable=false, reason names the version floor', async () => {
    const a = await probeGenerator(
      REPO,
      'claude',
      baseSeams({ readPlaywrightVersion: async () => 'Version 1.56.0' }),
    );
    expect(a.usable).toBe(false);
    expect(a.checks.playwrightVersionOk).toBe(false);
    expect(a.reason).toContain('1.61');
  });

  test('Playwright absent → usable=false (version check fails, no throw)', async () => {
    const a = await probeGenerator(
      REPO,
      'claude',
      baseSeams({ readPlaywrightVersion: async () => null }),
    );
    expect(a.usable).toBe(false);
    expect(a.checks.playwrightVersionOk).toBe(false);
  });

  test('agents record missing → usable=false, reason names the agents check', async () => {
    const a = await probeGenerator(
      REPO,
      'claude',
      baseSeams({ readAgentsRecord: async () => null }),
    );
    expect(a.usable).toBe(false);
    expect(a.checks.agentsInstalled).toBe(false);
    expect(a.reason).toContain('agents');
  });

  test('plan-format skew → agents check fails (stale installed agents)', async () => {
    const a = await probeGenerator(
      REPO,
      'claude',
      baseSeams({ readAgentsRecord: async () => ({ ...okRecord, plan_format_version: 'v0' }) }),
    );
    expect(a.usable).toBe(false);
    expect(a.checks.agentsInstalled).toBe(false);
  });

  test('MCP unavailable → usable=false, reason names MCP', async () => {
    const a = await probeGenerator(REPO, 'claude', baseSeams({ probeMcp: async () => false }));
    expect(a.usable).toBe(false);
    expect(a.checks.mcpAvailable).toBe(false);
    expect(a.reason).toContain('MCP');
  });

  test('never throws when the probe seams reject (Playwright/browser absent)', async () => {
    const a = await probeGenerator(
      REPO,
      'claude',
      baseSeams({
        probeBrowser: async () => {
          throw new Error('spawn failed');
        },
        readPlaywrightVersion: async () => {
          throw new Error('spawn failed');
        },
        readAgentsRecord: async () => {
          throw new Error('malformed json');
        },
        probeMcp: async () => {
          throw new Error('mcp probe failed');
        },
      }),
    );
    expect(a.usable).toBe(false);
    expect(a.checks.browser).toBe(false);
    expect(a.checks.agentsInstalled).toBe(false);
  });
});

describe('runGenerator — usable path drives the official generator then post-passes', () => {
  test('calls driveOfficialGenerator, injects @step markers, returns a @ditto-generated spec', async () => {
    let driveCalls = 0;
    let seenPlan: string | undefined;
    const seams: RunGeneratorSeams = {
      ...baseSeams(),
      driveOfficialGenerator: async (arg) => {
        driveCalls++;
        seenPlan = arg.plan;
        return rawGeneratedSpec;
      },
    };
    const r = await runGenerator(runInput, seams);
    expect(driveCalls).toBe(1);
    expect(seenPlan).toBe(runInput.plan);
    expect(r.used_fallback).toBe(false);
    expect(r.availability.usable).toBe(true);
    expect(r.spec).toContain('@ditto-generated');
    expect(r.spec).not.toContain('@ditto-unverified');
    expect(r.spec).toContain('@step jrn-login/s1');
    expect(r.spec).toContain('@step jrn-login/s2');
    expect(r.unverified_acs).toEqual([]);
    expect(r.unmatched).toEqual([]);
  });
});

describe('runGenerator — usable path threads the plan assertion channel (ac-3/ac-4)', () => {
  test('marks the bare expect() assertion line with its 확인 step id: action + assertion both traceable', async () => {
    // Realistic pipeline shape: 확인: steps live in the assertions channel (Expected
    // Results), NOT planMap; the generator emits them as a bare expect() with no
    // `// N.` comment. Only if runGenerator forwards planAssertions does s2 get a marker.
    const rawWithBareAssertion = `import { test, expect } from '@playwright/test';

test('로그인 기본', async ({ page }) => {
  // 1. 이메일 입력
  await page.getByLabel('email').fill('a@b.c');
  await expect(page.getByRole('heading')).toBeVisible();
});
`;
    const seams: RunGeneratorSeams = {
      ...baseSeams(),
      driveOfficialGenerator: async () => rawWithBareAssertion,
    };
    const input: RunGeneratorInput = {
      ...runInput,
      planMap: { 1: { 기본: { 1: 's1' } } },
      planAssertions: { 1: { 기본: ['s2'] } },
    };
    const r = await runGenerator(input, seams);
    expect(r.used_fallback).toBe(false);
    expect(r.spec).toContain('@step jrn-login/s1'); // action, resolved via planMap `// 1.`
    expect(r.spec).toContain('@step jrn-login/s2'); // assertion, via forwarded channel
    expect(r.unmatched).toEqual([]);
  });
});

describe('runGenerator — unusable path degrades to the fallback (ADR-0018)', () => {
  test('routes to the fallback: @ditto-unverified spec, ac-3/ac-5 unverified, drive NOT called', async () => {
    let driveCalls = 0;
    const seams: RunGeneratorSeams = {
      ...baseSeams({ probeBrowser: async () => ({ available: false, reason: 'no browser' }) }),
      driveOfficialGenerator: async () => {
        driveCalls++;
        return rawGeneratedSpec;
      },
    };
    const r = await runGenerator(runInput, seams);
    expect(driveCalls).toBe(0);
    expect(r.used_fallback).toBe(true);
    expect(r.availability.usable).toBe(false);
    expect(r.spec).toContain('@ditto-unverified');
    expect(r.spec).not.toContain('@ditto-generated\n */'); // still degraded, not a clean generated pass
    expect(r.unverified_acs).toEqual(['ac-3', 'ac-5']);
    expect(r.specPath).toBe('e2e/generated/login.spec.ts');
  });

  test('agents-missing (but browser present) still degrades — not falsely routed to primary', async () => {
    let driveCalls = 0;
    const seams: RunGeneratorSeams = {
      ...baseSeams({ readAgentsRecord: async () => null }),
      driveOfficialGenerator: async () => {
        driveCalls++;
        return rawGeneratedSpec;
      },
    };
    const r = await runGenerator(runInput, seams);
    expect(driveCalls).toBe(0);
    expect(r.used_fallback).toBe(true);
    expect(r.spec).toContain('@ditto-unverified');
    expect(r.unverified_acs).toEqual(['ac-3', 'ac-5']);
  });

  test('never throws even if the drive seam would throw (the fallback never calls it)', async () => {
    const seams: RunGeneratorSeams = {
      ...baseSeams({ probeBrowser: async () => ({ available: false, reason: 'no browser' }) }),
      driveOfficialGenerator: async () => {
        throw new Error('drive must not be called on the fallback path');
      },
    };
    const r = await runGenerator(runInput, seams);
    expect(r.used_fallback).toBe(true);
  });
});
