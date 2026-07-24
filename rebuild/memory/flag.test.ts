import { afterEach, describe, expect, test } from 'bun:test';

import { isMemoryEnabled } from './flag';

const original = process.env.DITTO_MEMORY;
afterEach(() => {
  if (original === undefined) delete process.env.DITTO_MEMORY;
  else process.env.DITTO_MEMORY = original;
});

describe('isMemoryEnabled — the DITTO_MEMORY master switch (default on, fail-open when off)', () => {
  test('unset is on', () => {
    delete process.env.DITTO_MEMORY;
    expect(isMemoryEnabled()).toBe(true);
  });

  test('"off" and "0" disable it (case- and whitespace-insensitive)', () => {
    for (const v of ['off', 'OFF', ' off ', '0']) {
      process.env.DITTO_MEMORY = v;
      expect(isMemoryEnabled()).toBe(false);
    }
  });

  test('any other value leaves it on', () => {
    for (const v of ['on', '1', 'true', 'yes']) {
      process.env.DITTO_MEMORY = v;
      expect(isMemoryEnabled()).toBe(true);
    }
  });
});
