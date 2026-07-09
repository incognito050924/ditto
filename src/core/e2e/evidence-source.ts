import {
  DEFAULT_GH_TIMEOUT_MS,
  type GhDegradeReason,
  type GhExec,
  type GhExecResult,
  classifyGhFailure,
  defaultGhExec,
} from '~/core/gh-client';

/**
 * The portable, UNFORGEABLE CI-evidence source (wi_2607095fz, ac-5/ac-3).
 *
 * KEYSTONE (anti-forgery): there is NO committed evidence artifact that grants
 * ALLOW — any local file is developer-writable, hence forgeable. The authoritative
 * allow-signal is a LIVE server-side read of CI check-run status for the EXACT
 * pushed commit sha (`gh api repos/{repo}/commits/{sha}/check-runs`), which lives on
 * GitHub, not on the developer's disk. Provenance is disjoint from `.ditto/local/runs`
 * by construction — this module never reads run artifacts.
 *
 * INVERTED POLARITY vs gh-client (finding 5): src/core/gh-client.ts is fail-OPEN —
 * every failure returns a `GhDegradation` and never blocks its callers. We REUSE that
 * module's `GhExec` seam and `classifyGhFailure` to CLASSIFY a failure, but here every
 * failure maps to `{ok:false, reason}` so the caller (the gate engine) BLOCKs. We do
 * NOT modify gh-client — its callers still need it fail-open. Each `GhDegradeReason`
 * (gh-client.ts:26-34) maps to the corresponding `EvidenceUnavailableReason`.
 *
 * MALFORMED → BLOCK (finding 6, an inversion worth stating): a corrupt/unparseable
 * payload yields `{ok:false, reason:'unparseable'}`. This is the OPPOSITE of
 * `readGreenCache` (push-gate.ts:250-261), where a corrupt cache reads as EMPTY. For a
 * green-cache, "empty" fails safe (re-run the gate). For evidence, "empty/no gate"
 * would fail OPEN (read as pass) — so malformed evidence must never read as "no gate →
 * pass"; it blocks. A partially-shaped check-run element is likewise `unparseable`
 * rather than silently dropped, so a `failure` check can never become invisible.
 *
 * N+1 + ceiling (finding 9): exactly ONE batched call per sha (`per_page=100`,
 * `filter=latest`), capped at `DEFAULT_GH_TIMEOUT_MS`. The journey→check-name mapping
 * and the 0-mandatory-checks decision (finding 8) are the CALLER's local lookup — this
 * module only returns the check-runs faithfully.
 *
 * CREDENTIAL-FREE (finding 11): `RepoCoord.token` is already a resolved value (the
 * recipe holds an envRef, resolved upstream). This module never sees a literal
 * committed token. When present it is used as an Authorization header; when absent, gh
 * ambient auth (GH_TOKEN / keyring) is used.
 *
 * PORTABILITY (ADR-0016): host/repo/sha come from the injected `RepoCoord` + the
 * `EvidenceSource` seam — nothing is hardcoded. A non-GitHub CI can implement
 * `EvidenceSource` without touching this built-in.
 */

/** A repository coordinate. `repo` is `owner/name`. `token` is a runtime-resolved
 *  value (may be undefined → gh ambient auth), NEVER a committed literal. */
export interface RepoCoord {
  repo: string;
  token?: string;
}

/** One CI check-run, as returned by the check-runs endpoint. `conclusion` is null
 *  while a run is queued/in_progress. */
export interface CheckEvidence {
  name: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
}

/** Why a live evidence read could not be obtained. EVERY value → the gate BLOCKs. */
export type EvidenceUnavailableReason =
  | 'source_absent'
  | 'unauthenticated'
  | 'insufficient_perm'
  | 'rate_limited'
  | 'timeout'
  | 'unparseable'
  | 'nonzero';

/** Result of one commit-scoped evidence read. `ok:false` (for ANY reason) means the
 *  caller has no authoritative pass-signal and must BLOCK. */
export type EvidenceQueryResult =
  | { ok: true; sha: string; checks: CheckEvidence[] }
  | { ok: false; reason: EvidenceUnavailableReason };

/** The portable seam: one batched, live read of CI evidence for an exact commit sha. */
export interface EvidenceSource {
  fetchCommitEvidence(coord: RepoCoord, sha: string): EvidenceQueryResult;
}

/** Map a gh-client failure class → the evidence reason. Total over `GhDegradeReason`.
 *  `unknown_command` (an old gh lacking the `api`/check-runs capability) is folded into
 *  `source_absent`: functionally, no usable evidence source is present. */
const REASON_MAP: Record<GhDegradeReason, EvidenceUnavailableReason> = {
  absent: 'source_absent',
  unauthenticated: 'unauthenticated',
  rate_limited: 'rate_limited',
  insufficient_perm: 'insufficient_perm',
  unknown_command: 'source_absent',
  timeout: 'timeout',
  unparseable: 'unparseable',
  nonzero: 'nonzero',
};

/** True iff the invocation ran and exited cleanly (mirror of gh-client's internal
 *  `invocationOk`, which is not exported). Any other shape is a degradable failure. */
function invocationOk(result: GhExecResult): boolean {
  return result.spawnError == null && result.exitCode === 0;
}

/** Build the ONE batched check-runs argv for a commit sha. A resolved token (if any)
 *  is passed as an Authorization header; `gh api` reads argv, never a shell string. */
function checkRunsArgs(coord: RepoCoord, sha: string): string[] {
  const path = `repos/${coord.repo}/commits/${sha}/check-runs?filter=latest&per_page=100`;
  const args = ['api', path];
  if (coord.token) args.push('-H', `Authorization: token ${coord.token}`);
  return args;
}

/** Narrow-don't-cast a raw check-runs payload into `CheckEvidence[]`, or null if the
 *  payload is unparseable/mis-shaped. Fail-closed: a partially-shaped element → null
 *  (never a silent drop), so a `failure` check cannot vanish into a false pass. */
function parseCheckRuns(raw: string): CheckEvidence[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const runs = (parsed as { check_runs?: unknown }).check_runs;
  if (!Array.isArray(runs)) return null;
  const checks: CheckEvidence[] = [];
  for (const run of runs) {
    if (!run || typeof run !== 'object') return null;
    const o = run as Record<string, unknown>;
    const { name, status, conclusion, head_sha } = o;
    if (typeof name !== 'string' || typeof status !== 'string') return null;
    if (!(conclusion === null || typeof conclusion === 'string')) return null;
    if (typeof head_sha !== 'string') return null;
    checks.push({ name, status, conclusion, head_sha });
  }
  return checks;
}

/**
 * The built-in GitHub-checks evidence source. Injects `GhExec` (defaults to the live
 * `defaultGhExec`; tests inject a fake). One batched `gh api …/check-runs` per sha;
 * any failure → a classified `{ok:false, reason}` (fail-closed); a malformed success
 * payload → `unparseable` (fail-closed).
 */
export function githubChecksSource(exec: GhExec = defaultGhExec): EvidenceSource {
  return {
    fetchCommitEvidence(coord, sha) {
      const result = exec(checkRunsArgs(coord, sha), DEFAULT_GH_TIMEOUT_MS);
      if (!invocationOk(result)) {
        return { ok: false, reason: REASON_MAP[classifyGhFailure(result)] };
      }
      const checks = parseCheckRuns(result.stdout);
      if (checks === null) return { ok: false, reason: 'unparseable' };
      return { ok: true, sha, checks };
    },
  };
}
