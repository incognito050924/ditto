import { describe, expect, test } from 'bun:test';
import { generateId } from '~/core/id';
import { reviewId, runId, workItemId } from '~/schemas/common';

describe('generateId', () => {
  test('produces a wi_ id matching schema regex', async () => {
    const id = await generateId('wi', async () => false);
    expect(() => workItemId.parse(id)).not.toThrow();
  });

  test('produces a run_ id matching schema regex', async () => {
    const id = await generateId('run', async () => false);
    expect(() => runId.parse(id)).not.toThrow();
  });

  test('produces a rv_ id matching schema regex', async () => {
    const id = await generateId('rv', async () => false);
    expect(() => reviewId.parse(id)).not.toThrow();
  });

  test('encodes the UTC date in YYMMDD', async () => {
    const id = await generateId('wi', async () => false, {
      now: new Date(Date.UTC(2027, 6, 9, 0, 0, 0)), // 2027-07-09 UTC
    });
    expect(id.startsWith('wi_270709')).toBe(true);
  });

  test('retries on collision and eventually succeeds', async () => {
    let calls = 0;
    const id = await generateId('wi', async () => {
      calls += 1;
      return calls <= 2;
    });
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(() => workItemId.parse(id)).not.toThrow();
  });

  test('throws after exhausting maxAttempts when always colliding', async () => {
    let thrown: unknown;
    try {
      await generateId('wi', async () => true, { maxAttempts: 3 });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
  });

  test('two ids generated back-to-back differ', async () => {
    const a = await generateId('wi', async () => false);
    const b = await generateId('wi', async () => false);
    expect(a).not.toBe(b);
  });
});
