/**
 * tech-spec question-elicitation option resolver (wi_260619yfw).
 *
 * The §6-6 question workflow is a SOFT driver procedure in
 * `skills/tech-spec/SKILL.md`; the deterministic part is parse + resolve +
 * persist. This module is the pure resolver: given the raw CLI inputs it
 * assembles the effective `QuestionConfig` the driver obeys.
 *
 * Precedence: explicit sub-lever (threshold / granularity / max-questions /
 *   max-rounds / generators) > explicit intensity > performance preset > default.
 *
 * INVARIANT: every default reproduces current behavior; the ONLY intentional
 * behavior change is the generator fan-out count (3 → 2).
 */

export type GeneratorEffort = 'low' | 'medium' | 'high' | 'inherit';
export type Granularity = 'low' | 'medium' | 'high';
export type GateMode = 'confirm' | 'auto';
export type PerformancePreset = 'glance' | 'quick' | 'standard' | 'deep' | 'exhaustive';

/**
 * Today the tech-spec selection gate has NO numeric threshold — the bar is
 * qualitative ("the fixed score bar a candidate must clear to be meaningful",
 * `agents/question-gate.md`). The gate scores four dimensions each in [0..1];
 * "meaningful / worth the user's attention" is a candidate clearly above the
 * midpoint. We encode that qualitative bar as 0.6 — the value the default
 * intensity (60) maps to under the linear `intensity/100` curve, which makes
 * intensity 60 the behavior-preserving anchor (ac-6). Not an invented number:
 * it traces to "intensity default 60 == today's meaningful bar".
 */
export const CURRENT_SELECTION_BAR = 0.6;

/** Exact preset expansions (intensity, generators, effort) — ac-3 (authoritative). */
export const PERFORMANCE_PRESETS: Record<
  PerformancePreset,
  { intensity: number; generators: number; effort: GeneratorEffort }
> = {
  glance: { intensity: 15, generators: 1, effort: 'low' },
  quick: { intensity: 35, generators: 2, effort: 'low' },
  standard: { intensity: 60, generators: 2, effort: 'inherit' },
  deep: { intensity: 85, generators: 3, effort: 'high' },
  exhaustive: { intensity: 100, generators: 4, effort: 'high' },
};

export interface SubLevers {
  /** Selection-gate score bar [0..1] a candidate must clear. */
  threshold: number;
  /** Question/section granularity bucket. */
  granularity: Granularity;
  /** Soft hint for how many questions to surface per round (advisory, not a cap). */
  count_hint: number;
}

/**
 * Deterministic intensity → sub-levers. Same intensity always yields the same
 * levers (ac-2). Linear `intensity/100` threshold curve, monotone, anchored so
 * intensity 60 === CURRENT_SELECTION_BAR (ac-6). Granularity buckets at the
 * natural thirds; count_hint scales roughly 1..3 over the dial.
 */
export function intensityToSubLevers(intensity: number): SubLevers {
  const threshold = Math.round((intensity / 100) * 100) / 100; // 2-dp, 60 → 0.6
  const granularity: Granularity = intensity < 34 ? 'low' : intensity < 67 ? 'medium' : 'high';
  const count_hint = Math.max(1, Math.round(intensity / 33));
  return { threshold, granularity, count_hint };
}

export interface QuestionConfig {
  intensity: number;
  generators: number;
  performance: PerformancePreset;
  generator_effort: GeneratorEffort;
  gate_mode: GateMode;
  max_questions: number;
  max_rounds: number;
  threshold: number;
  granularity: Granularity;
  count_hint: number;
  threshold_override: boolean;
  granularity_override: boolean;
}

/** Raw resolver input — only what was explicitly provided is present. */
export interface RawQuestionConfig {
  intensity?: number;
  generators?: number;
  performance?: PerformancePreset;
  generator_effort?: GeneratorEffort;
  gate_mode?: GateMode;
  max_questions?: number;
  max_rounds?: number;
  threshold?: number;
  granularity?: Granularity;
}

/**
 * Assemble the effective config by precedence. Pure: same input → same output.
 *
 * Precedence per field: explicit `cliRaw` > `configRaw` (per-user
 * .ditto/local/config.json defaults, wi_260619jmu) > preset/built-in. `configRaw`
 * is passed in (NOT read inside) so this stays a pure, unit-testable function;
 * the CLI is responsible for loading the config file.
 */
export function resolveQuestionConfig(
  cliRaw: RawQuestionConfig,
  configRaw: RawQuestionConfig = {},
): QuestionConfig {
  const performance: PerformancePreset = cliRaw.performance ?? configRaw.performance ?? 'standard';
  const preset = PERFORMANCE_PRESETS[performance];

  // intensity: explicit cli > config > preset > default(60). The preset's
  // intensity is the default carrier (standard.intensity === 60), so this also
  // fixes the default.
  const intensity = cliRaw.intensity ?? configRaw.intensity ?? preset.intensity;
  const generators = cliRaw.generators ?? configRaw.generators ?? preset.generators;
  const generator_effort = cliRaw.generator_effort ?? configRaw.generator_effort ?? preset.effort;
  const gate_mode: GateMode = cliRaw.gate_mode ?? configRaw.gate_mode ?? 'confirm';
  const max_questions = cliRaw.max_questions ?? configRaw.max_questions ?? 0;
  const max_rounds = cliRaw.max_rounds ?? configRaw.max_rounds ?? 0;

  const derived = intensityToSubLevers(intensity);
  const rawThreshold = cliRaw.threshold ?? configRaw.threshold;
  const rawGranularity = cliRaw.granularity ?? configRaw.granularity;
  const threshold_override = rawThreshold !== undefined;
  const granularity_override = rawGranularity !== undefined;
  const threshold = threshold_override ? (rawThreshold as number) : derived.threshold;
  const granularity = granularity_override ? (rawGranularity as Granularity) : derived.granularity;

  return {
    intensity,
    generators,
    performance,
    generator_effort,
    gate_mode,
    max_questions,
    max_rounds,
    threshold,
    granularity,
    count_hint: derived.count_hint,
    threshold_override,
    granularity_override,
  };
}
