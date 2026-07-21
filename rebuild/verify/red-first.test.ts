import { describe, expect, test } from 'bun:test';

import { checkRedFirst, hashTestContent, type RedFirstInput } from './red-first';

// A round where every red-first condition is satisfied: the completion test was
// authored EXTERNALLY (not by the loop), was observed RED before green, and the
// frozen red test is byte-for-byte the content that was hashed at capture.
const FROZEN_BODY = 'test("ac-3 red-first rejects self-authored", () => { expect(x).toBe(1); });';

function admissibleInput(): RedFirstInput {
  return {
    test: { author: 'external', redRunExitCode: 1, greenRunExitCode: 0 },
    frozen: {
      capturedHash: hashTestContent(FROZEN_BODY),
      currentContent: FROZEN_BODY,
    },
  };
}

describe('checkRedFirst — admissible round (accept path)', () => {
  test('external author + red-before-green + unchanged frozen hash → accepted', () => {
    const d = checkRedFirst(admissibleInput());
    expect(d.accepted).toBe(true);
    expect(d.reasons).toEqual([]);
  });
});

describe('checkRedFirst — (a) a completion test that was never red is rejected', () => {
  test('redRunExitCode null (no red run recorded) → rejected', () => {
    const input = admissibleInput();
    input.test.redRunExitCode = null;
    const d = checkRedFirst(input);
    expect(d.accepted).toBe(false);
    expect(d.reasons.join(' ')).toContain('RED');
  });

  test('redRunExitCode 0 (the claimed red run actually passed) → rejected', () => {
    const input = admissibleInput();
    input.test.redRunExitCode = 0;
    const d = checkRedFirst(input);
    expect(d.accepted).toBe(false);
    expect(d.reasons.join(' ')).toContain('RED');
  });
});

describe('checkRedFirst — (b) a self-authored success test is rejected', () => {
  test('author=loop (the loop wrote its own success test) → rejected', () => {
    const input = admissibleInput();
    input.test.author = 'loop';
    const d = checkRedFirst(input);
    expect(d.accepted).toBe(false);
    expect(d.reasons.join(' ')).toContain('self-authored');
  });
});

describe('checkRedFirst — (c) deleting/weakening a frozen (hashed) test is rejected', () => {
  test('frozen test deleted (currentContent null) → rejected', () => {
    const input = admissibleInput();
    input.frozen.currentContent = null;
    const d = checkRedFirst(input);
    expect(d.accepted).toBe(false);
    expect(d.reasons.join(' ')).toContain('deleted');
  });

  test('frozen test weakened (content changed → hash mismatch) → rejected', () => {
    const input = admissibleInput();
    // Assertion relaxed away: same file, different (weaker) body → different hash.
    input.frozen.currentContent = 'test("ac-3", () => { expect(true).toBe(true); });';
    const d = checkRedFirst(input);
    expect(d.accepted).toBe(false);
    expect(d.reasons.join(' ')).toContain('hash');
  });
});

describe('hashTestContent — pure SHA-256 over content', () => {
  test('deterministic and content-sensitive', () => {
    expect(hashTestContent('a')).toBe(hashTestContent('a'));
    expect(hashTestContent('a')).not.toBe(hashTestContent('b'));
    // sha256 hex is 64 chars.
    expect(hashTestContent('a')).toHaveLength(64);
  });
});
