import { describe, expect, test } from 'bun:test';
import { posix, win32 } from 'node:path';
import { leaseScopeRelPath } from '~/hooks/pre-tool-use';

// wi_2607084du: the scope gates compare against `/`-separated scope refs, but
// `relative()` yields `\` on Windows — so without POSIX normalization every scope
// UNDER-MATCHES on Windows (whitelist false-block, blacklist under-enforce). The
// `pathImpl` injection lets us exercise the Windows path semantics on a POSIX host.
describe('leaseScopeRelPath — POSIX-normalized scope path across OS separators (wi_2607084du)', () => {
  test('Windows (\\) separators are normalized to POSIX / (non-worktree edit)', () => {
    const rel = leaseScopeRelPath('C:\\ws', 'C:\\ws\\src\\core\\foo.ts', win32);
    // Without normalization this would be `src\core\foo.ts` and would not match a
    // `src/core/` scope ref — the Windows under-match bug.
    expect(rel).toBe('src/core/foo.ts');
    expect(rel).not.toContain('\\');
  });

  test('POSIX paths are unchanged (no regression on the running host)', () => {
    expect(leaseScopeRelPath('/ws', '/ws/src/core/foo.ts', posix)).toBe('src/core/foo.ts');
  });
});
