/**
 * Statistics for the stop-gate measurement harness (standalone, NOT part of the
 * bun test suite). Index rules are fixed here so every reported number is
 * reproducible from the raw samples:
 *
 * - median: sort ascending; odd N -> s[(N-1)/2]; even N -> arithmetic mean of the
 *   two middle values s[N/2-1] and s[N/2] (midpoint interpolation, FIXED).
 * - p95: nearest-rank on the sorted samples, index = ceil(0.95 * N) - 1 (FIXED:
 *   ceil, never floor; N=30 -> ceil(28.5)-1 = index 28, the 29th value).
 * - one sample = the MEAN of K inner executions (batching amortizes the clock
 *   read); K is recorded next to every stat block.
 */

export interface StatSummary {
  n: number;
  inner_reps_per_sample: number;
  unit: 'ns';
  min: number;
  max: number;
  mean: number;
  median: number;
  p95: number;
  /** First sample taken BEFORE warmup (cold estimate: includes JIT/first-touch). */
  cold_first_sample: number;
  /** Warmup samples discarded from the stats above (recorded for transparency). */
  warmup_samples: number[];
  rules: {
    median: 'sorted asc; odd N -> s[(N-1)/2]; even N -> mean(s[N/2-1], s[N/2])';
    p95: 'nearest-rank: sorted asc, index = ceil(0.95*N)-1';
    sample: 'one sample = mean of K inner executions (K = inner_reps_per_sample)';
    clock: 'Bun.nanoseconds() monotonic (Date.now forbidden: 1ms resolution)';
  };
}

export function median(samples: readonly number[]): number {
  if (samples.length === 0) throw new Error('median of empty sample set');
  const s = [...samples].sort((a, b) => a - b);
  const n = s.length;
  if (n % 2 === 1) return s[(n - 1) / 2] as number;
  return (((s[n / 2 - 1] as number) + (s[n / 2] as number)) / 2) as number;
}

export function p95(samples: readonly number[]): number {
  if (samples.length === 0) throw new Error('p95 of empty sample set');
  const s = [...samples].sort((a, b) => a - b);
  const idx = Math.ceil(0.95 * s.length) - 1;
  return s[idx] as number;
}

export function mean(samples: readonly number[]): number {
  if (samples.length === 0) throw new Error('mean of empty sample set');
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

export function summarize(
  warmSamples: readonly number[],
  opts: { innerReps: number; coldFirstSample: number; warmupSamples: readonly number[] },
): StatSummary {
  return {
    n: warmSamples.length,
    inner_reps_per_sample: opts.innerReps,
    unit: 'ns',
    min: Math.min(...warmSamples),
    max: Math.max(...warmSamples),
    mean: mean(warmSamples),
    median: median(warmSamples),
    p95: p95(warmSamples),
    cold_first_sample: opts.coldFirstSample,
    warmup_samples: [...opts.warmupSamples],
    rules: {
      median: 'sorted asc; odd N -> s[(N-1)/2]; even N -> mean(s[N/2-1], s[N/2])',
      p95: 'nearest-rank: sorted asc, index = ceil(0.95*N)-1',
      sample: 'one sample = mean of K inner executions (K = inner_reps_per_sample)',
      clock: 'Bun.nanoseconds() monotonic (Date.now forbidden: 1ms resolution)',
    },
  };
}

/** Tiny self-check assertions for this module (invoked by run.ts --self-check path). */
export function statsSelfCheck(): string[] {
  const violations: string[] = [];
  // median: odd
  if (median([3, 1, 2]) !== 2) violations.push('median odd-N rule broken');
  // median: even -> midpoint interpolation
  if (median([1, 2, 3, 4]) !== 2.5) violations.push('median even-N interpolation rule broken');
  // p95 nearest-rank ceil: N=30 -> index 28 (29th smallest). 1..30 -> 29.
  const thirty = Array.from({ length: 30 }, (_, i) => i + 1);
  if (p95(thirty) !== 29)
    violations.push('p95 nearest-rank ceil rule broken (expected 29 for 1..30)');
  // p95: N=20 -> ceil(19)-1 = 18 -> 19th smallest. 1..20 -> 19.
  const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
  if (p95(twenty) !== 19) violations.push('p95 rule broken for N=20');
  return violations;
}
