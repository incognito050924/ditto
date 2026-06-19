import { describe, expect, test } from 'bun:test';
import {
  CURRENT_SELECTION_BAR,
  PERFORMANCE_PRESETS,
  intensityToSubLevers,
  resolveQuestionConfig,
} from '~/core/tech-spec-options';

describe('tech-spec question-config resolver (wi_260619yfw)', () => {
  // ── calibration (ac-6): intensity 60 reproduces today's qualitative bar ──
  test('intensity 60 (default) maps to the current selection bar — behavior-preserving anchor', () => {
    // The gate threshold has no numeric literal today; the qualitative bar
    // ("meaningful, worth the user's attention") is encoded as CURRENT_SELECTION_BAR.
    expect(intensityToSubLevers(60).threshold).toBe(CURRENT_SELECTION_BAR);
    expect(resolveQuestionConfig({}).threshold).toBe(CURRENT_SELECTION_BAR);
  });

  test('intensityToSubLevers is deterministic — same intensity → same levers', () => {
    expect(intensityToSubLevers(42)).toEqual(intensityToSubLevers(42));
    expect(intensityToSubLevers(0).threshold).toBeLessThan(intensityToSubLevers(100).threshold);
    // monotone non-decreasing in intensity
    expect(intensityToSubLevers(30).threshold).toBeLessThanOrEqual(
      intensityToSubLevers(60).threshold,
    );
    expect(intensityToSubLevers(60).threshold).toBeLessThanOrEqual(
      intensityToSubLevers(90).threshold,
    );
  });

  test('intensity drives granularity buckets deterministically', () => {
    expect(intensityToSubLevers(15).granularity).toBe('low');
    expect(intensityToSubLevers(60).granularity).toBe('medium');
    expect(intensityToSubLevers(85).granularity).toBe('high');
  });

  // ── defaults (ac-6): every default reproduces current behavior ──
  test('all defaults reproduce current behavior (generators=2 is the only intentional change)', () => {
    const c = resolveQuestionConfig({});
    expect(c.intensity).toBe(60);
    expect(c.generators).toBe(2);
    expect(c.performance).toBe('standard');
    expect(c.generator_effort).toBe('inherit');
    expect(c.gate_mode).toBe('confirm');
    expect(c.max_questions).toBe(0);
    expect(c.max_rounds).toBe(0);
    expect(c.granularity).toBe('medium');
    expect(c.threshold_override).toBe(false);
    expect(c.granularity_override).toBe(false);
  });

  // ── presets (ac-3): exact (intensity, generators, effort) tuples ──
  test('PERFORMANCE_PRESETS expand to the exact spec tuples', () => {
    expect(PERFORMANCE_PRESETS.glance).toEqual({ intensity: 15, generators: 1, effort: 'low' });
    expect(PERFORMANCE_PRESETS.quick).toEqual({ intensity: 35, generators: 2, effort: 'low' });
    expect(PERFORMANCE_PRESETS.standard).toEqual({
      intensity: 60,
      generators: 2,
      effort: 'inherit',
    });
    expect(PERFORMANCE_PRESETS.deep).toEqual({ intensity: 85, generators: 3, effort: 'high' });
    expect(PERFORMANCE_PRESETS.exhaustive).toEqual({
      intensity: 100,
      generators: 4,
      effort: 'high',
    });
  });

  test('a preset sets intensity/generators/effort and NO hard-cap', () => {
    const c = resolveQuestionConfig({ performance: 'deep' });
    expect(c.intensity).toBe(85);
    expect(c.generators).toBe(3);
    expect(c.generator_effort).toBe('high');
    expect(c.max_questions).toBe(0);
    expect(c.max_rounds).toBe(0);
  });

  // ── precedence (ac-4) ──
  test('explicit intensity overrides the preset intensity (-p deep -i 50 ⇒ 50)', () => {
    const c = resolveQuestionConfig({ performance: 'deep', intensity: 50 });
    expect(c.intensity).toBe(50);
    // generators still from the preset (not overridden)
    expect(c.generators).toBe(3);
  });

  test('explicit generators overrides preset generators', () => {
    const c = resolveQuestionConfig({ performance: 'deep', generators: 6 });
    expect(c.generators).toBe(6);
  });

  test('explicit threshold override beats the intensity-derived threshold', () => {
    const c = resolveQuestionConfig({ intensity: 100, threshold: 0.2 });
    expect(c.threshold).toBe(0.2);
    expect(c.threshold_override).toBe(true);
    // intensity is still recorded
    expect(c.intensity).toBe(100);
  });

  test('explicit granularity override beats the intensity-derived granularity', () => {
    const c = resolveQuestionConfig({ intensity: 15, granularity: 'high' });
    expect(c.granularity).toBe('high');
    expect(c.granularity_override).toBe(true);
  });

  test('without an override, threshold/granularity equal the intensity-derived values', () => {
    const c = resolveQuestionConfig({ intensity: 100 });
    expect(c.threshold).toBe(intensityToSubLevers(100).threshold);
    expect(c.granularity).toBe(intensityToSubLevers(100).granularity);
    expect(c.threshold_override).toBe(false);
    expect(c.granularity_override).toBe(false);
  });

  // ── hard-cap (ac-5): opt-in ceiling, default unlimited ──
  test('positive max-* are persisted as a ceiling; 0 stays unlimited', () => {
    const c = resolveQuestionConfig({ max_questions: 5, max_rounds: 3 });
    expect(c.max_questions).toBe(5);
    expect(c.max_rounds).toBe(3);
  });
});

describe('config-default layer — per-user .ditto/local/config.json (wi_260619jmu)', () => {
  test('config value is used when the CLI flag is absent', () => {
    const c = resolveQuestionConfig({}, { generators: 5 });
    expect(c.generators).toBe(5);
  });

  test('explicit CLI overrides the config value', () => {
    const c = resolveQuestionConfig({ generators: 6 }, { generators: 5 });
    expect(c.generators).toBe(6);
  });

  test('config overrides the built-in default', () => {
    // built-in intensity default is 60; config moves it
    const c = resolveQuestionConfig({}, { intensity: 90 });
    expect(c.intensity).toBe(90);
  });

  test('config performance: exhaustive ⇒ intensity 100 / generators 4 / effort high (no CLI)', () => {
    const c = resolveQuestionConfig({}, { performance: 'exhaustive' });
    expect(c.performance).toBe('exhaustive');
    expect(c.intensity).toBe(100);
    expect(c.generators).toBe(4);
    expect(c.generator_effort).toBe('high');
  });

  test('CLI performance overrides config performance', () => {
    const c = resolveQuestionConfig({ performance: 'glance' }, { performance: 'exhaustive' });
    expect(c.performance).toBe('glance');
    expect(c.intensity).toBe(15);
  });

  test('override flags are true when EITHER cliRaw or configRaw set them', () => {
    expect(resolveQuestionConfig({ threshold: 0.3 }, {}).threshold_override).toBe(true);
    expect(resolveQuestionConfig({}, { threshold: 0.3 }).threshold_override).toBe(true);
    expect(resolveQuestionConfig({}, { granularity: 'high' }).granularity_override).toBe(true);
    expect(resolveQuestionConfig({}, {}).threshold_override).toBe(false);
    // CLI threshold wins over config threshold
    expect(resolveQuestionConfig({ threshold: 0.2 }, { threshold: 0.9 }).threshold).toBe(0.2);
  });

  test('omitting configRaw is equivalent to passing {} (back-compat, single-arg callers)', () => {
    expect(resolveQuestionConfig({ intensity: 70 })).toEqual(
      resolveQuestionConfig({ intensity: 70 }, {}),
    );
  });
});
