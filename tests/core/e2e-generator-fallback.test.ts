import { describe, expect, test } from 'bun:test';
import {
  FALLBACK_UNVERIFIED_MARKER,
  generateFallbackSpec,
  isFallbackUnverified,
} from '~/core/e2e/generator-fallback';
import { renderGeneratedHeader } from '~/core/e2e/journey-digest';

/**
 * Contract 9 (ADR-0018 graceful degrade) — the e2e generator fallback branch.
 *
 * When the official Playwright generator is unusable (no live browser), the
 * fallback routes the SAME plan.md to an e2e-scripter-style conversion, stamps a
 * DURABLE `@ditto-unverified` marker so a guessed spec can never be mistaken for
 * a live-verified one, and reports which browser-evidence ACs (ac-3, ac-5) stay
 * unverified. It NEVER crashes, auto-installs, or fabricates a pass.
 */

const header = {
  sourcePath: 'e2e/journeys/login.journey.md',
  digest: 'a'.repeat(64),
  kind: 'journey' as const,
  id: 'jrn-login',
};

const plan = `# 로그인 Test Plan
<!-- @ditto-plan v1 · source: e2e/journeys/login.journey.md · digest: sha256:abc -->

## Test Scenarios
### 1. 로그인
`;

function runFallback(available: boolean) {
  return generateFallbackSpec({
    probe: { available, reason: available ? 'ok' : 'Playwright/Chromium not available' },
    plan,
    header,
    specPath: 'e2e/generated/login.spec.ts',
    planPath: 'specs/login.plan.md',
  });
}

describe('generateFallbackSpec — browser absent (degrade)', () => {
  test('routes to fallback: used_fallback + unverified ACs + loud warning + specPath', () => {
    const r = runFallback(false);
    expect(r.used_fallback).toBe(true);
    expect(r.unverified_acs).toContain('ac-3');
    expect(r.unverified_acs).toContain('ac-5');
    expect(Boolean(r.warn && r.warn.length > 0)).toBe(true);
    expect(r.specPath).toBe('e2e/generated/login.spec.ts');
    // the verdict carries the probe reason so the degrade is auditable
    expect(r.reason).toContain('Playwright/Chromium not available');
  });

  test('the fallback spec header carries the durable @ditto-unverified marker', () => {
    const r = runFallback(false);
    expect(r.spec).toBeDefined();
    expect(r.spec).toContain('@ditto-unverified');
    expect(r.spec).toContain(FALLBACK_UNVERIFIED_MARKER);
    // still a normal generated header (provenance preserved), not a replacement
    expect(r.spec).toContain('@ditto-generated');
    expect(r.spec).toContain('@ditto-source e2e/journeys/login.journey.md');
  });

  test('the SAME plan is the conversion authority (embedded), not the raw DSL', () => {
    const r = runFallback(false);
    expect(r.spec).toContain('로그인 Test Plan');
    expect(r.spec).toContain('specs/login.plan.md');
  });

  test('never throws when the probe reports unavailable (graceful degrade)', () => {
    expect(() => runFallback(false)).not.toThrow();
  });
});

describe('generateFallbackSpec — browser available (use primary)', () => {
  test('signals use-primary: no fallback, no spec, no unverified ACs', () => {
    const r = runFallback(true);
    expect(r.used_fallback).toBe(false);
    expect(r.spec).toBeUndefined();
    expect(r.unverified_acs).toEqual([]);
  });
});

describe('isFallbackUnverified — durable marker detector', () => {
  test('true for a fallback header, false for a normal @ditto-generated header', () => {
    const fallbackSpec = runFallback(false).spec ?? '';
    expect(isFallbackUnverified(fallbackSpec)).toBe(true);

    const normal = renderGeneratedHeader(header);
    expect(normal).toContain('@ditto-generated'); // it IS generated…
    expect(isFallbackUnverified(normal)).toBe(false); // …just not a fallback
  });
});
