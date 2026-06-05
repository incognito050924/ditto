import { describe, expect, test } from 'bun:test';
import { filterSourceFiles, semanticScanNudge } from '~/hooks/semantic-nudge';

// S1 (wi_260605aw1) — Stop-time AX nudge decision logic (pure, no git/CodeQL).
// The nudge is the ACG direction-keeping signal: when an in-progress work item
// is allowed to stop but touched source without any semantic artifact, remind
// (non-blocking) to run `ditto semantic scan`. Cheap: no CodeQL in this path.

describe('filterSourceFiles', () => {
  test('keeps ACG-supported source extensions, drops the rest', () => {
    expect(
      filterSourceFiles([
        'src/a.ts',
        'b.tsx',
        'c.js',
        'D.java',
        'e.kt',
        'f.py',
        'README.md',
        'x.json',
      ]),
    ).toEqual(['src/a.ts', 'b.tsx', 'c.js', 'D.java', 'e.kt', 'f.py']);
  });

  test('drops .d.ts declaration files', () => {
    expect(filterSourceFiles(['types.d.ts', 'real.ts'])).toEqual(['real.ts']);
  });
});

describe('semanticScanNudge', () => {
  const base = {
    workItemId: 'wi_abcd1234',
    isNonTerminal: true,
    semanticPresent: false,
    base: 'abc123',
    changedSourceFiles: ['src/user.ts'],
  };

  test('nudges when in-progress, source changed, no semantic artifact', () => {
    const msg = semanticScanNudge(base);
    expect(msg).toContain('ditto semantic scan');
    expect(msg).toContain('wi_abcd1234');
    expect(msg).toContain('abc123');
  });

  test('no nudge when a semantic artifact already exists', () => {
    expect(semanticScanNudge({ ...base, semanticPresent: true })).toBeNull();
  });

  test('no nudge for a terminal work item', () => {
    expect(semanticScanNudge({ ...base, isNonTerminal: false })).toBeNull();
  });

  test('no nudge when no base ref resolves', () => {
    expect(semanticScanNudge({ ...base, base: null })).toBeNull();
  });

  test('no nudge when no source files changed', () => {
    expect(semanticScanNudge({ ...base, changedSourceFiles: [] })).toBeNull();
  });
});
