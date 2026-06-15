import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  analyzeStandingFitness,
  defaultStandingFitnessDeps,
  renderComplexityQuery,
  sarifToFitnessViolationIds,
} from '~/acg/fitness/standing-fitness';

// wi_260615lj6 ac-1 (ADR-0019 D1 — dialectic-10 OBJ-A) — the standing-code fitness
// analyzer. It runs a CUSTOM @kind problem CodeQL query (cyclomatic complexity > N) and
// projects the SARIF alerts to a per-FUNCTION violation-identity set (rule@path#L<line>)
// so the HEAD↔worktree debt count drops when a refactor lowers a function's complexity.
// (Stock @kind treemap metrics queries emit no SARIF results — OBJ-A.)

describe('renderComplexityQuery — a runnable @kind problem query at threshold N', () => {
  test('embeds the threshold and is a problem query (produces SARIF results)', () => {
    const q = renderComplexityQuery(10);
    expect(q).toContain('@kind problem');
    expect(q).toContain('getCyclomaticComplexity()');
    expect(q).toContain('> 10');
    expect(q).not.toContain('@kind treemap'); // OBJ-A: treemap emits no results
  });
});

describe('sarifToFitnessViolationIds — per-function identity rule@path#L<line>', () => {
  const sarif = (results: Array<{ rule: string; uri: string; line: number }>) =>
    JSON.stringify({
      runs: [
        {
          results: results.map((r) => ({
            ruleId: r.rule,
            message: { text: 'x' },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: r.uri },
                  region: { startLine: r.line },
                },
              },
            ],
          })),
        },
      ],
    });

  test('two high-complexity functions in ONE file → TWO distinct identities (not collapsed)', () => {
    const ids = sarifToFitnessViolationIds(
      sarif([
        { rule: 'ditto/high-cyclomatic-complexity', uri: 'src/a.ts', line: 10 },
        { rule: 'ditto/high-cyclomatic-complexity', uri: 'src/a.ts', line: 40 },
      ]),
    );
    expect(ids.sort()).toEqual([
      'ditto/high-cyclomatic-complexity@src/a.ts#L10',
      'ditto/high-cyclomatic-complexity@src/a.ts#L40',
    ]);
  });

  test('filters to the unit files when given', () => {
    const ids = sarifToFitnessViolationIds(
      sarif([
        { rule: 'r', uri: 'src/a.ts', line: 1 },
        { rule: 'r', uri: 'src/other.ts', line: 1 },
      ]),
      { unitFiles: ['src/a.ts'] },
    );
    expect(ids).toEqual(['r@src/a.ts#L1']);
  });

  test('dedupes identical identities', () => {
    const ids = sarifToFitnessViolationIds(
      sarif([
        { rule: 'r', uri: 'src/a.ts', line: 5 },
        { rule: 'r', uri: 'src/a.ts', line: 5 },
      ]),
    );
    expect(ids).toEqual(['r@src/a.ts#L5']);
  });
});

describe('analyzeStandingFitness — orchestrate query write + codeql run, fail-open', () => {
  const okSarif = JSON.stringify({
    runs: [
      {
        results: [
          {
            ruleId: 'ditto/high-cyclomatic-complexity',
            message: { text: 'x' },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: 'src/acg/tidy/coverage-provider.ts' },
                  region: { startLine: 80 },
                },
              },
            ],
          },
        ],
      },
    ],
  });

  const baseInput = {
    repoRoot: '/repo',
    sourceRoot: '/repo',
    unitFiles: ['src/acg/tidy/coverage-provider.ts'],
    threshold: 10,
    dbPath: '/repo/.ditto/local/tmp/db',
    sarifPath: '/repo/.ditto/local/tmp/out.sarif',
    queryDir: '/repo/.ditto/local/tmp/ql',
  };

  test('writes the query pack and returns per-function violation ids filtered to the unit', async () => {
    const writes: string[] = [];
    const r = await analyzeStandingFitness(baseInput, {
      writeText: async (p) => {
        writes.push(p);
      },
      runAnalysis: async () => okSarif,
    });
    expect(writes.some((p) => p.endsWith('qlpack.yml'))).toBe(true);
    expect(writes.some((p) => p.endsWith('.ql'))).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.violationIds).toEqual([
      'ditto/high-cyclomatic-complexity@src/acg/tidy/coverage-provider.ts#L80',
    ]);
  });

  test('fail-open: codeql run throws → ok:false, empty ids, degraded reason (no throw)', async () => {
    const r = await analyzeStandingFitness(baseInput, {
      writeText: async () => {},
      runAnalysis: async () => {
        throw new Error('codeql database create failed (exit 1)');
      },
    });
    expect(r.ok).toBe(false);
    expect(r.violationIds).toEqual([]);
    expect(r.degradedReason).toContain('codeql');
  });
});

// OBJ-A evidence baked in (opt-in — needs codeql installed, ~20s). Run with CODEQL_E2E=1.
// Proves a custom @kind problem query produces REAL per-function SARIF alerts on ditto
// source (where stock @kind treemap metrics queries produce none).
describe.if(process.env.CODEQL_E2E === '1')('analyzeStandingFitness — real codeql (e2e)', () => {
  test('custom complexity problem query yields per-function violations on src/acg/tidy', async () => {
    const repoRoot = process.cwd();
    const tmp = mkdtempSync(join(repoRoot, '.ditto', 'local', 'tmp', 'fit-e2e-'));
    try {
      const r = await analyzeStandingFitness(
        {
          repoRoot,
          sourceRoot: join(repoRoot, 'src', 'acg', 'tidy'),
          unitFiles: ['coverage-provider.ts'], // relative to sourceRoot
          threshold: 8,
          dbPath: join(tmp, 'db'),
          sarifPath: join(tmp, 'out.sarif'),
          queryDir: join(tmp, 'ql'),
        },
        defaultStandingFitnessDeps,
      );
      expect(r.ok).toBe(true);
      // coverage-provider.ts has multiple complex functions → multiple per-function ids.
      expect(r.violationIds.length).toBeGreaterThan(1);
      expect(r.violationIds.every((id) => id.includes('coverage-provider.ts#L'))).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 120_000);
});
