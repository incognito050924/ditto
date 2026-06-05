import { describe, expect, test } from 'bun:test';
import {
  buildScanObservation,
  computeScanFingerprint,
  workItemBaseCandidates,
} from '~/acg/semantic/scan-observation';
import { acgSemanticScanObservation } from '~/schemas/acg-semantic-scan-observation';

// O2/O8 (wi_260605aw1 S2) — pure observation helpers.

describe('computeScanFingerprint', () => {
  test('deterministic for the same base + diff', () => {
    expect(computeScanFingerprint('abc', 'diff')).toBe(computeScanFingerprint('abc', 'diff'));
  });

  test('differs when the diff differs (content change is detected)', () => {
    expect(computeScanFingerprint('abc', 'diff1')).not.toBe(computeScanFingerprint('abc', 'diff2'));
  });

  test('differs when the base differs', () => {
    expect(computeScanFingerprint('abc', 'd')).not.toBe(computeScanFingerprint('xyz', 'd'));
  });
});

describe('buildScanObservation', () => {
  const base = {
    workItemId: 'wi_obs00001',
    baseUsed: 'HEAD',
    language: 'javascript',
    sourceRoot: 'src',
    fingerprint: 'fp',
    producedAt: '2026-06-05T00:00:00Z',
  };

  test('schema-valid, non-gated observation with a multi-change list (O5)', () => {
    const obs = buildScanObservation({
      ...base,
      changes: [
        { file: 'a.ts', symbol: 'f', before: 'f(): A', after: 'f(): B' },
        { file: 'b.ts', symbol: 'g', before: 'g(x: number): void', after: 'g(x: string): void' },
      ],
    });
    expect(acgSemanticScanObservation.safeParse(obs).success).toBe(true);
    expect(obs.change_count).toBe(2);
    expect(obs.kind).toBe('acg.semantic-scan-observation.v1');
  });

  test('empty changes is valid (change_count 0)', () => {
    const obs = buildScanObservation({ ...base, changes: [] });
    expect(acgSemanticScanObservation.safeParse(obs).success).toBe(true);
    expect(obs.change_count).toBe(0);
  });
});

describe('workItemBaseCandidates (OBJ-4 fallback chain)', () => {
  test('started_at_sha first, then the usual mains', () => {
    expect(workItemBaseCandidates({ started_at_sha: 'abc123' })).toEqual([
      'abc123',
      'origin/main',
      'origin/master',
      'main',
      'master',
    ]);
  });

  test('omits the start sha when absent', () => {
    expect(workItemBaseCandidates({ started_at_sha: undefined })).toEqual([
      'origin/main',
      'origin/master',
      'main',
      'master',
    ]);
  });
});
