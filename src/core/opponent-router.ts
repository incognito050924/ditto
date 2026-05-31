import type { z } from 'zod';
import type { providerName } from '~/schemas/common';
import type { dialecticInput, opponentFallbackReason } from '~/schemas/dialectic';

/**
 * OpponentModelRouter (메인 설계 §11 core interface, dialectic-contract §3).
 *
 * Deterministic policy resolution + provenance, NOT the call glue. Given a
 * `model_policy`, it produces an ordered candidate list (preferred first, then
 * fallbacks) and — against an availability predicate — selects the first usable
 * one while recording why it fell back. The actual CLI invocation is a separate
 * thin layer the skill drives (§3.4 "run with 재사용 금지"); the result is
 * recorded into `dialecticOpponent.run` (provider/model/fallback_from/reason).
 *
 * Codex being unavailable is the normal path, not a failure (§3.2): the
 * fallback to claude-opus → claude-sonnet keeps the Opponent running with
 * separated context, only with reduced model diversity.
 */

type ProviderName = z.infer<typeof providerName>;
type FallbackReason = z.infer<typeof opponentFallbackReason>;
type ModelPolicy = z.infer<typeof dialecticInput>['model_policy'];

export interface OpponentCandidate {
  /** Policy token as written, e.g. 'codex' / 'claude-opus'. */
  token: string;
  provider: ProviderName;
  model: string;
}

// token → {provider(providerName enum), model}. Unknown tokens default to the
// current host (claude-code) carrying the token as the model name.
const TOKEN_MAP: Record<string, { provider: ProviderName; model: string }> = {
  codex: { provider: 'codex', model: 'codex' },
  'claude-opus': { provider: 'claude-code', model: 'claude-opus' },
  'claude-sonnet': { provider: 'claude-code', model: 'claude-sonnet' },
};

function mapToken(token: string): { provider: ProviderName; model: string } {
  return TOKEN_MAP[token] ?? { provider: 'claude-code', model: token };
}

/**
 * Ordered opponent candidates: `opponent_preferred` first, then each
 * `opponent_fallback` in order. Duplicate tokens are dropped (first wins) so a
 * policy that repeats the preferred in its fallback list does not double-try it.
 */
export function resolveOpponentCandidates(policy: ModelPolicy): OpponentCandidate[] {
  const tokens = [policy.opponent_preferred, ...policy.opponent_fallback];
  const seen = new Set<string>();
  const out: OpponentCandidate[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    out.push({ token, ...mapToken(token) });
  }
  return out;
}

export interface OpponentAvailability {
  available: boolean;
  /** Why the candidate is NOT usable; ignored when available. */
  reason?: Exclude<FallbackReason, 'none'>;
}

export interface OpponentSelection {
  provider: ProviderName;
  model: string;
  /** The preferred provider we fell back FROM, or null when the preferred won. */
  fallback_from: ProviderName | null;
  fallback_reason: FallbackReason;
}

export class NoOpponentAvailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoOpponentAvailableError';
  }
}

/**
 * Walk the candidates in order and pick the first available one. When the
 * preferred (index 0) wins, `fallback_from=null` / `fallback_reason='none'`.
 * When a later candidate wins, record the preferred's provider as
 * `fallback_from` and the preferred's unavailability reason as
 * `fallback_reason`. Throws when nothing is available (so the skill surfaces a
 * blocked deliberation rather than silently producing no Opponent).
 */
export function selectOpponent(
  candidates: OpponentCandidate[],
  isAvailable: (candidate: OpponentCandidate) => OpponentAvailability,
): OpponentSelection {
  if (candidates.length === 0) {
    throw new NoOpponentAvailableError('no opponent candidates resolved from model_policy');
  }
  const preferred = candidates[0];
  let preferredReason: FallbackReason = 'none';
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const availability = isAvailable(candidate);
    if (availability.available) {
      if (i === 0) {
        return {
          provider: candidate.provider,
          model: candidate.model,
          fallback_from: null,
          fallback_reason: 'none',
        };
      }
      return {
        provider: candidate.provider,
        model: candidate.model,
        fallback_from: preferred.provider,
        fallback_reason: preferredReason,
      };
    }
    // Remember why the *preferred* failed; that is the fallback reason recorded
    // when a later candidate is chosen.
    if (i === 0) preferredReason = availability.reason ?? 'runtime';
  }
  throw new NoOpponentAvailableError(
    `no available opponent among ${candidates.length} candidate(s): ${candidates
      .map((c) => c.token)
      .join(', ')}`,
  );
}
