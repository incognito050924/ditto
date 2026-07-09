import type { CheckEvidence, EvidenceSource, RepoCoord } from '~/core/e2e/evidence-source';
import type { PushedRef } from '~/core/push-gate';
import type { RecipeE2eGate } from '~/schemas/recipe';

/**
 * E2E push-gate decision core (wi_2607095fz) — PURE, no I/O. Given the pushed refs,
 * the resolved `e2e_gate`, the repo's journeys (resolved to a membership shape by the
 * caller), and an injected `EvidenceSource`, it decides whether a push to a protected
 * branch may proceed by reading LIVE CI evidence for each ref's EXACT commit sha.
 *
 * Fail-closed by construction (findings 4,5,6,8,13): the ONLY pass paths are an
 * explicit degrade (no gate configured, no protected branch, no mandatory journey) or
 * every mandatory journey's check reading `success` on every protected ref. Any
 * unavailable evidence, missing/failed/pending/stale check, or malformed journey
 * BLOCKS. The disposition is the inverse of the barrier's degrade-proceed.
 */

/**
 * One journey's gate-membership view, resolved by the CALLER from the on-disk journey
 * files (kept INJECTED so this core is mock-unit testable — no journey loading here).
 * `excluded` reflects the journey's `gate.exclude === true` opt-out; `unparseable` marks
 * a journey file that FAILED to load/validate — which must BLOCK when not excluded
 * (malformed ≠ absent), never silently drop from the mandatory set.
 */
export interface JourneyEntry {
  id: string;
  name: string;
  excluded: boolean;
  unparseable?: boolean;
}

/** How a mandatory journey's CI check reads for a given commit. */
export type E2eCheckStatus = 'passed' | 'failed' | 'pending' | 'missing' | 'stale' | 'unparseable';

/** One reason a ref could not pass — enumerated per journey (finding 13). */
export interface BlockedJourney {
  journeyId: string;
  journeyName: string;
  status: E2eCheckStatus;
  checkName: string;
  /** The exact commit sha whose evidence was read (empty for a pre-fetch malformed-journey block). */
  sha: string;
}

/** The gate's verdict. `reason` explains a degrade-PASS or a non-per-journey BLOCK
 *  (unconfigured / no protected branch / no mandatory journey / evidence unavailable);
 *  `blocked` enumerates the failing mandatory journeys when checks were actually read. */
export interface E2eGateOutcome {
  decision: 'pass' | 'block';
  reason?: string;
  blocked?: BlockedJourney[];
}

export interface E2eGateInput {
  pushedRefs: PushedRef[];
  /** The resolved `e2e_gate` (undefined → THE unconfigured signal → degrade-PASS). */
  e2eGate: RecipeE2eGate | undefined;
  journeys: JourneyEntry[];
  repoCoord: RepoCoord;
  source: EvidenceSource;
  /** The protected branch list to match pushed refs against (the caller sets this to
   *  `e2eGate.protected_branches`). A literal `*` protects every pushed branch. */
  protectedBranches: string[];
}

/** Classify one journey's check-run against the gate. Absent → missing (absent ≠ pass);
 *  not-completed → pending; success → passed; a terminal failure conclusion → failed;
 *  anything else on a completed run (neutral/skipped/stale/null) → stale. */
function classifyCheck(ev: CheckEvidence | undefined): E2eCheckStatus {
  if (!ev) return 'missing';
  if (ev.status !== 'completed') return 'pending';
  if (ev.conclusion === 'success') return 'passed';
  if (
    ev.conclusion === 'failure' ||
    ev.conclusion === 'cancelled' ||
    ev.conclusion === 'timed_out' ||
    ev.conclusion === 'action_required'
  ) {
    return 'failed';
  }
  return 'stale';
}

/**
 * Decide the e2e push gate. See the module doc for the fail-closed contract.
 */
export function verifyE2eEvidence(inp: E2eGateInput): E2eGateOutcome {
  const { pushedRefs, e2eGate, journeys, repoCoord, source, protectedBranches } = inp;

  // 1. Config-presence split (finding 4, ac-4): an absent gate is THE unconfigured
  //    signal — degrade to PASS. Never inferred from journey/evidence presence.
  if (e2eGate === undefined) return { decision: 'pass', reason: 'unconfigured' };

  // 2. Protected match (pushGateDecision's `*` sentinel logic). Only branch refs can be
  //    protected — a tag (branch=null) never gates. Empty → the gate does not fire.
  const protectedSet = new Set(protectedBranches);
  const star = protectedSet.has('*');
  const matched = pushedRefs.filter(
    (r) => r.branch !== null && (star || protectedSet.has(r.branch)),
  );
  if (matched.length === 0) return { decision: 'pass', reason: 'no protected branch' };

  // 3. Membership (blocklist): a journey is mandatory unless it opted out (exclude).
  const mandatory = journeys.filter((j) => j.excluded !== true);
  //    3a. A malformed mandatory journey BLOCKS before any fetch (malformed ≠ absent;
  //        findings 6/10) — it must never silently drop from the mandatory set.
  const unparseable = mandatory.filter((j) => j.unparseable === true);
  if (unparseable.length > 0) {
    return {
      decision: 'block',
      reason: `unparseable mandatory journey(s): ${unparseable.map((j) => j.id).join(', ')}`,
      blocked: unparseable.map((j) => ({
        journeyId: j.id,
        journeyName: j.name,
        status: 'unparseable' as const,
        checkName: '',
        sha: '',
      })),
    };
  }
  //    3b. 0 mandatory journeys → degrade-PASS. This is a USER DECISION overriding the
  //        design's original 'suspicious→BLOCK'; the unparseable BLOCK above is separate.
  if (mandatory.length === 0) return { decision: 'pass', reason: 'no mandatory journeys' };

  // 4. For EACH protected ref, read CI evidence for its OWN commit sha (one batched call,
  //    finding 9). Any unavailable read fails closed (finding 5). Otherwise classify each
  //    mandatory journey's check; a ref passes iff ALL its mandatory checks read success.
  const template = e2eGate.evidence.check_name_template;
  const blocked: BlockedJourney[] = [];
  for (const ref of matched) {
    const result = source.fetchCommitEvidence(repoCoord, ref.localSha);
    if (!result.ok) {
      return {
        decision: 'block',
        reason: `evidence unavailable for ${ref.localSha}: ${result.reason}`,
      };
    }
    const byName = new Map(result.checks.map((c) => [c.name, c] as const));
    for (const j of mandatory) {
      const checkName = template.replace('{journey}', j.id);
      const status = classifyCheck(byName.get(checkName));
      if (status !== 'passed') {
        blocked.push({
          journeyId: j.id,
          journeyName: j.name,
          status,
          checkName,
          sha: ref.localSha,
        });
      }
    }
  }

  // 5. Overall: PASS iff every matched ref's mandatory checks all passed.
  if (blocked.length > 0) return { decision: 'block', blocked };
  return { decision: 'pass' };
}
