import type { DittoConfigGithub } from '~/schemas/ditto-config';
import { readGithubConfig } from './ditto-config';

/**
 * github-config doctor (wi_2606289h9 ac-6) — a LOCAL-ONLY, READ-ONLY check that a
 * github config carrying the integration is not a 구버전 shape missing the
 * non-terminal `claim_status_map.in_progress` mapping.
 *
 * Why it matters: on claim (`ditto` work start) the board move to the "In progress"
 * column is GUARDED by `claim_status_map.in_progress` (src/core/github-claim.ts) —
 * when that key is absent the move is silently skipped. A user whose config predates
 * that field never sees the board advance and has no signal why. This surfaces the
 * gap and names the remediation (`ditto github setup`).
 *
 * LOCAL-ONLY by contract (approved DoD): it inspects only the local
 * `.ditto/local/config.json` github block — NO `gh`/network probe of the actual
 * board — so it can never hang or false-fail offline. READ-ONLY: no auto-fix.
 */

/** claim_status_map key for the non-terminal "claimed / in progress" board column. */
export const IN_PROGRESS_KEY = 'in_progress';

export interface GithubConfigFinding {
  kind: 'claim_status_map_missing';
  message: string;
  /** The command the user runs to repair it (advisory text only; never executed). */
  remediation: string;
}

export interface GithubConfigReport {
  /** A github block is present in the local config (integration set up). */
  github_configured: boolean;
  /** `claim_status_map.in_progress` is mapped to a board option. */
  claim_in_progress_mapped: boolean;
  findings: GithubConfigFinding[];
  finding_count: number;
}

/**
 * Pure evaluation over the (already fail-open-parsed) github block. A finding is
 * raised ONLY when the integration is configured but `claim_status_map.in_progress`
 * is unset — an absent github block means the user is not using the integration, so
 * there is nothing to warn about (no finding).
 */
export function evaluateGithubConfig(github: DittoConfigGithub | undefined): GithubConfigReport {
  const configured = github !== undefined;
  const mapped = Boolean(github?.claim_status_map?.[IN_PROGRESS_KEY]);
  const findings: GithubConfigFinding[] =
    configured && !mapped
      ? [
          {
            kind: 'claim_status_map_missing',
            message: 'claim_status_map.in_progress 미설정 → 착수 시 보드가 In progress로 안 옮겨짐',
            remediation: 'ditto github setup',
          },
        ]
      : [];
  return {
    github_configured: configured,
    claim_in_progress_mapped: mapped,
    findings,
    finding_count: findings.length,
  };
}

export interface GithubConfigDoctorDeps {
  /** Read the local github config block (fail-open: undefined = absent OR malformed). */
  readGithub: () => Promise<DittoConfigGithub | undefined>;
}

export function defaultGithubConfigDoctorDeps(repoRoot: string): GithubConfigDoctorDeps {
  return { readGithub: () => readGithubConfig(repoRoot) };
}

export async function collectGithubConfigReport(
  deps: GithubConfigDoctorDeps,
): Promise<GithubConfigReport> {
  return evaluateGithubConfig(await deps.readGithub());
}
