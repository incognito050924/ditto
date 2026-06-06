import { describe, expect, test } from 'bun:test';
import {
  type ApplicabilityDeps,
  type WebUiSignals,
  detectWebUiSignals,
  evaluateAxis3Applicability,
  evaluateAxis3FromRepo,
} from '~/core/e2e/applicability';

describe('evaluateAxis3Applicability (web-UI signals → applicable | N/A)', () => {
  const NO_WEB: WebUiSignals = { web_framework: null, ui_file_count: 0 };

  test('no framework and no UI files → N/A, names the covering axes', () => {
    const r = evaluateAxis3Applicability(NO_WEB);
    expect(r.applicable).toBe(false);
    expect(r.covered_by.length).toBeGreaterThan(0);
    expect(r.covered_by.join(' ')).toContain('axis-2');
  });

  test('a browser framework dependency → applicable', () => {
    const r = evaluateAxis3Applicability({ web_framework: 'react', ui_file_count: 0 });
    expect(r.applicable).toBe(true);
    expect(r.covered_by).toEqual([]);
    expect(r.reason).toContain('react');
  });

  test('UI files present even without a framework dep → applicable', () => {
    const r = evaluateAxis3Applicability({ web_framework: null, ui_file_count: 4 });
    expect(r.applicable).toBe(true);
    expect(r.reason).toContain('4');
  });
});

describe('detectWebUiSignals (injected package.json + file scan)', () => {
  const deps = (over: Partial<ApplicabilityDeps>): ApplicabilityDeps => ({
    repoRoot: '/repo',
    readPackageJson: () => ({ dependencies: {}, devDependencies: {} }),
    countUiFiles: () => 0,
    ...over,
  });

  test('a CLI/library (no web dep, no UI files) → N/A end to end', () => {
    const r = evaluateAxis3FromRepo(deps({}));
    expect(r.applicable).toBe(false);
    expect(r.signals).toEqual({ web_framework: null, ui_file_count: 0 });
  });

  test('detects a framework across dependencies / devDependencies / peerDependencies', () => {
    expect(
      detectWebUiSignals(deps({ readPackageJson: () => ({ dependencies: { vue: '^3' } }) }))
        .web_framework,
    ).toBe('vue');
    expect(
      detectWebUiSignals(deps({ readPackageJson: () => ({ devDependencies: { svelte: '^4' } }) }))
        .web_framework,
    ).toBe('svelte');
  });

  test('a stack-agnostic dependency is not mistaken for a web framework', () => {
    const r = detectWebUiSignals(
      deps({ readPackageJson: () => ({ dependencies: { zod: '^3' } }) }),
    );
    expect(r.web_framework).toBe(null);
  });

  test('UI files in src with no framework dep still flips applicability', () => {
    const r = evaluateAxis3FromRepo(deps({ countUiFiles: () => 3 }));
    expect(r.applicable).toBe(true);
    expect(r.signals.ui_file_count).toBe(3);
  });
});
