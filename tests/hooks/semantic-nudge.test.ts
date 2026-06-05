import { describe, expect, test } from 'bun:test';
import { filterSourceFiles, semanticScanNudge } from '~/hooks/semantic-nudge';

// S1+S3 (wi_260605aw1) — Stop-time AX nudge decision logic (pure, no git/CodeQL).
// The nudge reflects the observe flow: no fresh observation → run observe; a
// fresh observation with changes (not yet promoted to a blocking verdict) →
// promote the breaking ones; a fresh observation with zero changes → silent.

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
    observationChangeCount: null as number | null,
  };

  test('no fresh observation → nudge to run `ditto semantic observe`', () => {
    const msg = semanticScanNudge(base);
    expect(msg).toContain('ditto semantic observe');
    expect(msg).toContain('wi_abcd1234');
    expect(msg).toContain('abc123');
  });

  test('fresh observation with changes → nudge to promote (detect/verdict)', () => {
    const msg = semanticScanNudge({ ...base, observationChangeCount: 2 });
    expect(msg).toContain('2');
    expect(msg).toMatch(/detect|verdict|promote/i);
    expect(msg).not.toContain('semantic observe');
  });

  test('fresh observation with zero changes → silent', () => {
    expect(semanticScanNudge({ ...base, observationChangeCount: 0 })).toBeNull();
  });

  test('no nudge when a blocking semantic-compatibility.json already exists', () => {
    expect(semanticScanNudge({ ...base, semanticPresent: true })).toBeNull();
    expect(
      semanticScanNudge({ ...base, semanticPresent: true, observationChangeCount: 3 }),
    ).toBeNull();
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
