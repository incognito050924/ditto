import {
  type OpponentBrief,
  type OpponentSeamConfig,
  resolveOpponentSelection,
} from '~/core/prism/opponent';
import type { InterviewDimension, InterviewDissent } from '~/schemas/interview-state';

// prism/opponent.ts declares OpponentSelection locally but does not export it; derive the
// non-null resolved-selection type from resolveOpponentSelection's return instead of
// reaching into a private symbol.
type OpponentSelection = NonNullable<ReturnType<typeof resolveOpponentSelection>>;

/**
 * Intent-layer dissent opponent seam (wi_260709mqt).
 *
 * Ports prism's `engageIndependentDissent` pattern (src/core/prism/opponent.ts) from the
 * RISK layer to the INTENT layer: at a CRITICAL interview dimension, drive a host-delegated
 * opponent that re-derives an independent judgment from the ORIGINAL intent and records a
 * dissent. deep-interview previously had ZERO adversarial pressure — its only critic was the
 * comprehensibility reviewer (question-context.ts) which judges whether a question is
 * understandable, never whether the stated intent is wrong or has a stronger version.
 *
 * Reuse, not fork: `resolveOpponentSelection` / `OpponentBrief` / `OpponentDelegate` /
 * `OpponentSeamConfig` are imported verbatim from prism/opponent.ts (already exported pure
 * policy + types). ONLY the record-back (onto interviewDimension.dissent) is new here.
 *
 * ADR-0001 — this module NEVER spawns a provider. `resolveOpponentSelection` only RESOLVES
 * which opponent to use (pure policy); the actual invocation is the host-delegated
 * {@link OpponentSeamConfig.delegate} callback the CLI/skill wires.
 *
 * ADR-0018 — no host (selection null) OR an empty/null delegate return OR a delegate THROW
 * all degrade to a SELF-DESCRIBING `host_absent` stamp, never a crash and never a fake
 * accept. (prism/opponent.ts's dissent path lacks the throw-guard; that defect is NOT
 * copied — a subprocess/network failure must not block intent realization.)
 *
 * Anti-inflation (ac-4) — the brief constrains the opponent to return only a MORE ACCURATE
 * version of the SAME intent, never a bigger one. This keeps dissent aligned with the
 * question-generator's anti-inflation training ("goal 안 부풀림") instead of fighting it.
 */

// The opponent must sharpen the intent, not grow it. Carried in the brief so the dissent
// stays "same intent, more accurate" — never a scope-grow / goal-inflation (ac-4).
export const INTENT_DISSENT_CONSTRAINT =
  'Do NOT grow the scope or inflate the goal. Return only a MORE ACCURATE version of the ' +
  'SAME intent — the strongest CORRECT reading of what the user already asked for, never a ' +
  'larger ambition. If the stated intent is already the most accurate reading, dissent is ' +
  'unnecessary.';

/**
 * Build the opponent brief for one critical dimension. Minimal-field by design (egress
 * reduction): it carries ONLY the dimension id + the ORIGINAL intent + the anti-inflation
 * constraint. Raw `notes` / full answers / self_answer_attempts are deliberately NOT
 * forwarded — the opponent judges the intent, not the interview transcript.
 */
export function buildIntentDissentBrief(
  dimension: InterviewDimension,
  config: OpponentSeamConfig,
  selection: OpponentSelection,
): OpponentBrief {
  return {
    concern: 'dissent',
    node_id: `cov-dim-${dimension.id}`,
    // id only — never raw notes/answers (minimal-field scope).
    label: dimension.id,
    intent: `${config.intent}\n\n[constraint] ${INTENT_DISSENT_CONSTRAINT}`,
    selection,
  };
}

/**
 * Drive the intent-layer opponent for ONE dimension and return the dissent record-back.
 * The CALLER localizes this to critical dimensions only (cost-localization) — this
 * function does not decide which dimensions face the opponent.
 *
 *   selection null (no host)          → host_absent (delegate NOT called)
 *   delegate returns null/empty       → host_absent (never a fake accept)
 *   delegate throws                   → host_absent (degrade, not crash — ADR-0018)
 *   delegate returns non-empty text   → engaged (verdict 'revise'; impact high iff critical)
 *
 * verdict is fixed to 'revise' on engagement (the opponent only speaks to sharpen the
 * intent); the finalize BLOCK keys off `status`/`impact`/`acknowledged`, not verdict, and
 * the neutrality axis clamps to 'accept' at the projection so a dissent never leaks
 * 'blocked' into the shared coverage axis.
 */
export async function engageIntentDissent(
  dimension: InterviewDimension,
  config: OpponentSeamConfig,
): Promise<InterviewDissent> {
  const selection = resolveOpponentSelection(config);
  if (selection === null) {
    return { status: 'host_absent', acknowledged: false };
  }
  let text: string | null = null;
  try {
    text = await config.delegate(buildIntentDissentBrief(dimension, config, selection));
  } catch {
    // A subprocess/network failure degrades exactly like a missing host — no retry, no
    // propagation (ADR-0018 D2: failure, not only absence, must not block realization).
    text = null;
  }
  if (text && text.trim().length > 0) {
    return {
      status: 'engaged',
      verdict: 'revise',
      impact: dimension.critical ? 'high' : 'low',
      text: text.trim(),
      acknowledged: false,
    };
  }
  return { status: 'host_absent', acknowledged: false };
}

/**
 * Fail-closed carry-forward merge for the record-back. A prior ENGAGED high-impact
 * unacknowledged block is STICKY: a later `host_absent` run (opponent host went away) must
 * NOT erase it, or ADR-0018's degrade would become a bypass — dropping the host to unblock
 * a real dissent. Otherwise the newer outcome wins.
 */
export function mergeDissent(
  existing: InterviewDissent | undefined,
  next: InterviewDissent,
): InterviewDissent {
  if (
    next.status === 'host_absent' &&
    existing?.status === 'engaged' &&
    existing.impact === 'high' &&
    existing.acknowledged !== true
  ) {
    return existing;
  }
  return next;
}
