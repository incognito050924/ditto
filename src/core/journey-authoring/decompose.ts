/**
 * Intent → step DRAFT decomposition (ac-5).
 *
 * Takes a one-line user intent and proposes journey-DSL verb steps. This is a
 * PROPOSAL ONLY — it writes nothing and never auto-confirms. The user owns WHAT
 * the journey is (e2e-author "No agent-invented journeys"); confirmation is a
 * separate, explicit step. When the screen is unbuilt there is no code to infer
 * from, so we emit a skeleton rather than guessing structure.
 */

export interface StepDraft {
  step_id: string;
  intent: string;
}

export interface DecomposeDraft {
  /** Always true — a structural reminder that this output is a proposal, not a commitment. */
  proposed: true;
  steps: StepDraft[];
  /** Human note carried alongside the draft so callers cannot mistake it for a finalized set. */
  note: string;
}

/** Connectives that separate sub-actions in a one-line Korean/English intent. */
const SEPARATORS = /\s*(?:그리고|그다음|그 다음|->|→|,|\bthen\b|\band\b)\s*/g;

/**
 * Split `intent` into ordered step drafts (`s1`, `s2`, …). A single phrase with
 * no connective yields one skeleton step. Deterministic: same input → same draft.
 */
export function decomposeIntent(intent: string): DecomposeDraft {
  const phrases = intent
    .split(SEPARATORS)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const effective = phrases.length > 0 ? phrases : [intent.trim()];
  const steps = effective.map((phrase, i) => ({ step_id: `s${i + 1}`, intent: phrase }));
  return {
    proposed: true,
    steps,
    note: '제안된 단계 초안 — 사용자가 WHAT을 확정해야 한다 (자동 물질화·자동 확정 금지)',
  };
}
