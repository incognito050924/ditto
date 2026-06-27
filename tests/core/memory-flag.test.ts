import { describe, expect, test } from 'bun:test';
import { isMemoryEnabled } from '~/core/memory-flag';

// The master switch must be robust to surrounding whitespace in the env var
// (e.g. a value pasted/quoted as " off " ⇒ off, not on). Trim before comparing.
describe('isMemoryEnabled() whitespace tolerance', () => {
  test('off/0 with surrounding whitespace disable the subsystem; unset/other stay on', () => {
    const saved = process.env.DITTO_MEMORY;
    try {
      // biome-ignore lint/performance/noDelete: default-on means truly unset, not the "undefined" string
      delete process.env.DITTO_MEMORY;
      expect(isMemoryEnabled()).toBe(true);

      process.env.DITTO_MEMORY = ' off ';
      expect(isMemoryEnabled()).toBe(false);

      process.env.DITTO_MEMORY = ' 0 ';
      expect(isMemoryEnabled()).toBe(false);

      process.env.DITTO_MEMORY = '1';
      expect(isMemoryEnabled()).toBe(true);
    } finally {
      if (saved === undefined) {
        // biome-ignore lint/performance/noDelete: restore the env var to truly unset
        delete process.env.DITTO_MEMORY;
      } else {
        process.env.DITTO_MEMORY = saved;
      }
    }
  });
});
