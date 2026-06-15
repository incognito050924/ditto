import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CoverageCollectResult,
  buildCoverageProvider,
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

describe('regionCoverage — is a changed region executed by the suite?', () => {
  const map = parseLcov(
    [
      'SF:src/a.ts',
      'LF:10',
      'LH:8',
      'end_of_record',
      'SF:src/b.ts',
      'LF:4',
      'LH:0',
      'end_of_record',
    ].join('\n'),
  );

  test('a file present with linesHit>0 → covered, ratio = hit/found', () => {
    const r = regionCoverage(map, { files: ['src/a.ts'] });
    expect(r.status).toBe('covered');
    expect(r.coveredRatio).toBeCloseTo(0.8);
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

  test('multi-file region: covered only when EVERY file is executed', () => {
    expect(regionCoverage(map, { files: ['src/a.ts'] }).status).toBe('covered');
    // one executed + one not → the region is not fully witnessed → uncovered
    expect(regionCoverage(map, { files: ['src/a.ts', 'src/b.ts'] }).status).toBe('uncovered');
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
