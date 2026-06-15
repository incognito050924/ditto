import { describe, expect, test } from 'bun:test';
import { type EffectRecorder, runL2Differential } from '~/acg/tidy/l2-differential';

describe('runL2Differential — L2 old↔new differential, PURE variant (WU-2c ②, ac-6)', () => {
  test('returns a concrete counterexample for an over-fitting refactor that only matches on the seed inputs', () => {
    // old: the true behaviour.
    const old = (x: number) => x * 2;
    // new: an over-fitting refactor — it hard-codes the literal test inputs (1,2,3)
    // and is wrong everywhere else. Literal-input-only checking would MISS this.
    const seeds = [1, 2, 3];
    const overFit = (x: number) => {
      if (x === 1) return 2;
      if (x === 2) return 4;
      if (x === 3) return 6;
      return 0; // diverges on any generated input
    };

    const verdict = runL2Differential({
      kind: 'pure',
      old,
      new: overFit,
      seeds,
      generate: (seed) => [seed, seed + 7, seed * 1000, -seed],
      inputCount: 20,
    });

    expect(verdict.status).toBe('refuted');
    expect(verdict.autoCommit).toBe('none');
    expect(verdict.counterexample).toBeDefined();
    // the counterexample is the reproducing input, not one of the seeds
    expect(seeds).not.toContain(verdict.counterexample?.input);
  });
});

describe('runL2Differential — L2 old↔new differential, TRACE variant (WU-2c ②, ac-6)', () => {
  // The unit-under-test makes external calls through an injected `rec` (the intercept
  // seam). The TRACE differential records old's effect trace, then replays new and
  // compares the recorded external-call args + order.
  const oldUnit = (x: number, rec: EffectRecorder) => {
    rec.call('charge', x);
    rec.call('notify', x);
    return x;
  };
  // wrong-internal-call refactor: calls 'refund' instead of 'charge' (and the return is
  // identical, so a pure return-value check would MISS it — only the effect trace diverges).
  const wrongCallUnit = (x: number, rec: EffectRecorder) => {
    rec.call('refund', x);
    rec.call('notify', x);
    return x;
  };

  test('returns a concrete counterexample when the recorded effect trace diverges', () => {
    const verdict = runL2Differential({
      kind: 'trace',
      old: oldUnit,
      new: wrongCallUnit,
      seeds: [10],
      generate: (seed) => [seed + 1, seed * 2],
      inputCount: 10,
    });

    expect(verdict.status).toBe('refuted');
    expect(verdict.autoCommit).toBe('none');
    expect(verdict.counterexample).toBeDefined();
    expect(verdict.counterexample?.divergence).toContain('charge');
    expect(verdict.counterexample?.divergence).toContain('refund');
  });

  test('returns unrefuted when old and new produce the same effect trace on every input', () => {
    const verdict = runL2Differential({
      kind: 'trace',
      old: oldUnit,
      new: oldUnit,
      seeds: [10],
      generate: (seed) => [seed + 1, seed * 2],
      inputCount: 10,
    });
    expect(verdict.status).toBe('unrefuted');
    expect(verdict.counterexample).toBeUndefined();
  });
});

describe('runL2Differential — no intercept seam → degraded fail-open (WU-2c, ac-7)', () => {
  test('returns unverified + Review-high-risk and does NOT block/throw when no seam exists', () => {
    let verdict: ReturnType<typeof runL2Differential> | undefined;
    expect(() => {
      verdict = runL2Differential({
        kind: 'trace',
        old: (x: number) => x, // side-effecting code with NO recorder seam declared
        new: (x: number) => x,
        seeds: [1, 2],
        // intercept seam is absent → effects are non-recordable
        noSeam: true,
      });
    }).not.toThrow();

    expect(verdict?.status).toBe('unverified');
    expect(verdict?.reviewHighRisk).toBe(true);
    // degraded fail-open is NEVER a hard block
    expect(verdict?.status).not.toBe('refuted');
    // auto-commit cannot be 'full' on an unverified change
    expect(verdict?.autoCommit).not.toBe('full');
  });
});
