/**
 * ① L1 behavior lock (80-plan §4, WU-1) — the floor of the equivalence-evidence
 * ladder. Before a Tidy item may start, its changed region must be witnessed by a
 * characterization that actually executes it.
 *
 * PROVIDER PRECONDITION (dialectic-8 OBJ-02): no coverage runner is wired in this
 * repo yet (`src/` 0건). So L1 is NOT a blanket hard-block — when the provider is
 * absent it FAILS OPEN to a 미검증-강등 (degraded) verdict that restricts the
 * downstream auto-commit to diff-only (full-bar requires a firing provider — D8 /
 * dialectic-9 OBJ-04). It is neither "always block" nor a silent bypass.
 */

/** Result of querying coverage for a changed region. */
export interface CoverageResult {
  status: 'covered' | 'uncovered';
  coveredRatio?: number;
}

/** The toolchain seam an L1 coverage runner implements. Absent today (0건). */
export interface CoverageProvider {
  coverageOf(region: ChangedRegion): Promise<CoverageResult> | CoverageResult;
}

export interface ChangedRegion {
  files: string[];
  functions?: string[];
}

export type L1Status = 'blocked-baseline-red' | 'met' | 'degraded' | 'unmet';

/** Whether the §4.4 full bar may auto-commit this item (D8). */
export type AutoCommitMode = 'full' | 'diff-only' | 'none';

export interface BehaviorLockVerdict {
  status: L1Status;
  autoCommit: AutoCommitMode;
  reason: string;
}

export interface BehaviorLockInput {
  /** Whether the existing suite is green before tidy starts (G-R1 floor). */
  baselineGreen: boolean;
  changedRegion: ChangedRegion;
  /** Absent in this repo today → fail-open to degraded (OBJ-02). */
  coverageProvider?: CoverageProvider;
}

/**
 * Assess the L1 behavior lock for one tidy item.
 *
 * - baseline red → blocked (tidy cannot start; G-R1).
 * - no provider → degraded + diff-only (fail-open, not hard-block; OBJ-02).
 * - provider + covered → met + full (full bar eligible).
 * - provider + uncovered → unmet (generate characterization first, then retry).
 */
export async function assessBehaviorLock(input: BehaviorLockInput): Promise<BehaviorLockVerdict> {
  if (!input.baselineGreen) {
    return {
      status: 'blocked-baseline-red',
      autoCommit: 'none',
      reason: 'baseline suite is red — tidy cannot start on a non-green baseline (G-R1)',
    };
  }

  if (!input.coverageProvider) {
    return {
      status: 'degraded',
      autoCommit: 'diff-only',
      reason:
        'no coverage provider wired (provider 0건) — L1 fails open to 미검증-강등; auto-commit restricted to diff-only',
    };
  }

  const result = await input.coverageProvider.coverageOf(input.changedRegion);
  if (result.status === 'covered') {
    return {
      status: 'met',
      autoCommit: 'full',
      reason: 'changed region is executed by characterization — L1 met (full bar eligible)',
    };
  }
  return {
    status: 'unmet',
    autoCommit: 'none',
    reason:
      'changed region is not covered by characterization — generate a characterization first before tidy',
  };
}
