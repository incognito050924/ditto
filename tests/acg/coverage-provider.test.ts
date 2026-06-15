import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CoverageCollectResult,
  buildCoverageProvider,
  deriveUnitTestPaths,
  parseLcov,
  regionCoverage,
} from '~/acg/tidy/coverage-provider';

describe('parseLcov — bun lcov → per-file line coverage map', () => {
  test('parses SF/LF/LH records into a repo-relative map', () => {
    const lcov = [
      'TN:',
      'SF:src/acg/tidy/behavior-lock.ts',
      'FNF:2',
      'FNH:2',
      'DA:56,15',
      'DA:57,0',
      'LF:30',
      'LH:29',
      'end_of_record',
    ].join('\n');
    const map = parseLcov(lcov);
    expect(map.get('src/acg/tidy/behavior-lock.ts')).toEqual({ linesFound: 30, linesHit: 29 });
  });

  test('parses multiple records and normalizes ./ prefixes', () => {
    const lcov = [
      'SF:./src/a.ts',
      'LF:10',
      'LH:10',
      'end_of_record',
      'SF:src/b.ts',
      'LF:4',
      'LH:0',
      'end_of_record',
    ].join('\n');
    const map = parseLcov(lcov);
    expect(map.size).toBe(2);
    expect(map.get('src/a.ts')).toEqual({ linesFound: 10, linesHit: 10 });
    expect(map.get('src/b.ts')).toEqual({ linesFound: 4, linesHit: 0 });
  });
});

describe('regionCoverage — region covered only above the coveredRatio threshold (item 3)', () => {
  const map = parseLcov(
    [
      'SF:src/a.ts', // 0.8 — at the default threshold
      'LF:10',
      'LH:8',
      'end_of_record',
      'SF:src/b.ts', // 0.0 — never executed
      'LF:4',
      'LH:0',
      'end_of_record',
      'SF:src/c.ts', // 0.5 — executed but BELOW threshold (the over-credit case)
      'LF:10',
      'LH:5',
      'end_of_record',
    ].join('\n'),
  );

  test('a file at/above the default 0.8 threshold → covered, ratio = hit/found', () => {
    const r = regionCoverage(map, { files: ['src/a.ts'] });
    expect(r.status).toBe('covered');
    expect(r.coveredRatio).toBeCloseTo(0.8);
  });

  test('a file executed but BELOW threshold (0.5 < 0.8) → uncovered (over-credit fix)', () => {
    const r = regionCoverage(map, { files: ['src/c.ts'] });
    expect(r.status).toBe('uncovered');
    expect(r.coveredRatio).toBeCloseTo(0.5);
  });

  test('a file present but linesHit==0 (never executed) → uncovered', () => {
    const r = regionCoverage(map, { files: ['src/b.ts'] });
    expect(r.status).toBe('uncovered');
    expect(r.coveredRatio).toBe(0);
  });

  test('a file absent from the lcov (never loaded) → uncovered', () => {
    const r = regionCoverage(map, { files: ['src/never.ts'] });
    expect(r.status).toBe('uncovered');
  });

  test('multi-file region: covered only when EVERY file is at/above threshold', () => {
    expect(regionCoverage(map, { files: ['src/a.ts'] }).status).toBe('covered');
    // a.ts passes but c.ts is below threshold → region not fully witnessed → uncovered
    expect(regionCoverage(map, { files: ['src/a.ts', 'src/c.ts'] }).status).toBe('uncovered');
  });

  test('threshold is configurable — a 0.5 file passes at threshold 0.4', () => {
    expect(regionCoverage(map, { files: ['src/c.ts'] }, 0.4).status).toBe('covered');
    expect(regionCoverage(map, { files: ['src/c.ts'] }, 0.6).status).toBe('uncovered');
  });

  test('empty region → uncovered (nothing witnessed)', () => {
    expect(regionCoverage(map, { files: [] }).status).toBe('uncovered');
  });
});

const lcovOf = (...recs: Array<[string, number, number]>) =>
  recs.map(([f, lf, lh]) => `SF:${f}\nLF:${lf}\nLH:${lh}\nend_of_record`).join('\n');

describe('buildCoverageProvider — collect once, fail-open on failure', () => {
  test('collect ok → a provider whose coverageOf answers from the parsed map', async () => {
    const provider = buildCoverageProvider('/repo', {
      collect: () => ({ ok: true, lcov: lcovOf(['src/a.ts', 10, 10]) }),
    });
    expect(provider).toBeDefined();
    const r = await provider?.coverageOf({ files: ['src/a.ts'] });
    expect(r?.status).toBe('covered');
  });

  test('collect runs ONCE even when coverageOf is called for many regions (cached map)', async () => {
    let collects = 0;
    const provider = buildCoverageProvider('/repo', {
      collect: () => {
        collects++;
        return { ok: true, lcov: lcovOf(['src/a.ts', 4, 4]) };
      },
    });
    await provider?.coverageOf({ files: ['src/a.ts'] });
    await provider?.coverageOf({ files: ['src/a.ts'] });
    expect(collects).toBe(1);
  });

  test('collect failure → undefined (fail-open: provider treated as absent)', () => {
    const provider = buildCoverageProvider('/repo', {
      collect: () => ({ ok: false, reason: 'no test files / bun not found' }),
    });
    expect(provider).toBeUndefined();
  });

  test('collect ok but no coverage data (empty lcov) → undefined (fail-open)', () => {
    const provider = buildCoverageProvider('/repo', {
      collect: () => ({ ok: true, lcov: '' }),
    });
    expect(provider).toBeUndefined();
  });
});

describe('deriveUnitTestPaths — map unit source files to mirrored test files (item 2)', () => {
  const tests = [
    'tests/acg/tidy-behavior-lock.test.ts',
    'tests/acg/coverage-provider.test.ts',
    'tests/cli/refactor-cli.test.ts',
    'tests/core/autopilot-tidy.test.ts',
  ];

  test('matches a source basename as a substring of the test path', () => {
    expect(deriveUnitTestPaths(['src/acg/tidy/behavior-lock.ts'], tests)).toEqual([
      'tests/acg/tidy-behavior-lock.test.ts',
    ]);
  });

  test('unions matches across multiple unit files, deduped', () => {
    const r = deriveUnitTestPaths(
      ['src/acg/tidy/behavior-lock.ts', 'src/acg/tidy/coverage-provider.ts'],
      tests,
    );
    expect(r.sort()).toEqual(
      ['tests/acg/coverage-provider.test.ts', 'tests/acg/tidy-behavior-lock.test.ts'].sort(),
    );
  });

  test('no mirrored test → empty (caller falls back to the full suite)', () => {
    expect(deriveUnitTestPaths(['src/acg/tidy/nonexistent-xyz.ts'], tests)).toEqual([]);
  });
});

describe('buildCoverageProvider scope reduction + escalation (item 2)', () => {
  const fullLcov = lcovOf(['src/acg/tidy/behavior-lock.ts', 10, 10]);
  // a scoped run that ran the wrong tests and never exercised the unit file
  const scopedMissLcov = lcovOf(['src/other.ts', 10, 10]);
  const scope = {
    scopeFiles: ['src/acg/tidy/behavior-lock.ts'],
    testFiles: ['tests/acg/tidy-behavior-lock.test.ts'],
  };

  test('scopes the collect to derived test paths when scopeFiles is given', () => {
    const calls: Array<string[] | undefined> = [];
    buildCoverageProvider(
      '/repo',
      {
        collect: (_root, testPaths) => {
          calls.push(testPaths);
          return { ok: true, lcov: fullLcov };
        },
      },
      scope,
    );
    expect(calls).toEqual([['tests/acg/tidy-behavior-lock.test.ts']]);
  });

  test('covered under the scoped run → no escalation (collect once)', async () => {
    let collects = 0;
    const provider = buildCoverageProvider(
      '/repo',
      {
        collect: () => {
          collects++;
          return { ok: true, lcov: fullLcov };
        },
      },
      scope,
    );
    const r = await provider?.coverageOf({ files: ['src/acg/tidy/behavior-lock.ts'] });
    expect(r?.status).toBe('covered');
    expect(collects).toBe(1);
  });

  test('uncovered under the scoped run → escalates to a full collect before concluding', async () => {
    const seq: Array<string[] | undefined> = [];
    const provider = buildCoverageProvider(
      '/repo',
      {
        collect: (_root, testPaths) => {
          seq.push(testPaths);
          // scoped run misses the unit; full run (testPaths undefined) exercises it
          return testPaths ? { ok: true, lcov: scopedMissLcov } : { ok: true, lcov: fullLcov };
        },
      },
      scope,
    );
    const r = await provider?.coverageOf({ files: ['src/acg/tidy/behavior-lock.ts'] });
    expect(r?.status).toBe('covered'); // escalation confirmed it
    expect(seq).toEqual([['tests/acg/tidy-behavior-lock.test.ts'], undefined]);
  });

  test('empty derived set → collect the full suite (testPaths undefined)', () => {
    const calls: Array<string[] | undefined> = [];
    buildCoverageProvider(
      '/repo',
      {
        collect: (_root, testPaths) => {
          calls.push(testPaths);
          return { ok: true, lcov: fullLcov };
        },
      },
      { scopeFiles: ['src/acg/tidy/no-mirror-xyz.ts'], testFiles: scope.testFiles },
    );
    expect(calls).toEqual([undefined]);
  });

  test('scoped collect failure → falls back to a full-suite collect (not fail-open)', () => {
    const seq: Array<string[] | undefined> = [];
    const provider = buildCoverageProvider(
      '/repo',
      {
        collect: (_root, testPaths) => {
          seq.push(testPaths);
          return testPaths
            ? { ok: false, reason: 'scoped run errored' }
            : { ok: true, lcov: fullLcov };
        },
      },
      scope,
    );
    expect(provider).toBeDefined();
    expect(seq).toEqual([['tests/acg/tidy-behavior-lock.test.ts'], undefined]);
  });
});

describe('ac-a: a REAL `bun test --coverage` run feeds the provider', () => {
  // Run a real coverage pass scoped to ONE characterization test that imports
  // behavior-lock.ts, then decide regions off the REAL lcov it produced.
  const realCollect = (root: string): CoverageCollectResult => {
    const covDir = mkdtempSync(join(tmpdir(), 'ditto-cov-real-'));
    try {
      Bun.spawnSync(
        [
          'bun',
          'test',
          '--coverage',
          '--coverage-reporter=lcov',
          `--coverage-dir=${covDir}`,
          'tests/acg/tidy-behavior-lock.test.ts',
        ],
        { cwd: root, stdout: 'ignore', stderr: 'ignore' },
      );
      return { ok: true, lcov: readFileSync(join(covDir, 'lcov.info'), 'utf8') };
    } catch (err) {
      return { ok: false, reason: String(err) };
    } finally {
      rmSync(covDir, { recursive: true, force: true });
    }
  };

  test('an executed file → covered; a non-executed file → uncovered (real lcov)', async () => {
    const provider = buildCoverageProvider(process.cwd(), { collect: realCollect });
    if (!provider) throw new Error('expected a provider from a real coverage run');
    const covered = await provider.coverageOf({ files: ['src/acg/tidy/behavior-lock.ts'] });
    expect(covered.status).toBe('covered');
    expect(covered.coveredRatio ?? 0).toBeGreaterThan(0);
    // coverage-provider.ts is NOT imported by tidy-behavior-lock.test.ts → absent → uncovered
    const uncovered = await provider.coverageOf({ files: ['src/acg/tidy/coverage-provider.ts'] });
    expect(uncovered.status).toBe('uncovered');
  }, 60_000);
});
