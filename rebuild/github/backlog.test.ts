import { describe, expect, test } from 'bun:test';

import { readBacklog } from './backlog';
import type { BacklogIssue, BacklogReader, GhResult } from './gh';

function reader(result: GhResult<BacklogIssue[]>): BacklogReader {
  return { listIssues: () => result };
}

describe('backlog read — layer 1 (GitHub is SoT, ditto reads)', () => {
  test('reads issues and attaches the owner/repo#n coordinate', () => {
    const out = readBacklog(
      reader({
        ok: true,
        value: [
          { repo: 'octo/app', number: 42, title: 'ship it', state: 'open' },
          { repo: 'octo/lib', number: 7, title: 'fix bug', state: 'closed' },
        ],
      }),
    );
    expect(out.items).toEqual([
      { coord: { repo: 'octo/app', number: 42 }, coordString: 'octo/app#42', title: 'ship it', state: 'open' },
      { coord: { repo: 'octo/lib', number: 7 }, coordString: 'octo/lib#7', title: 'fix bug', state: 'closed' },
    ]);
    expect(out.notices).toEqual([]);
  });

  test('degrades to an empty backlog + notice when the reader fails (never throws, ADR-0018)', () => {
    const out = readBacklog(reader({ ok: false, reason: 'gh not installed' }));
    expect(out.items).toEqual([]);
    expect(out.notices[0]).toMatch(/degraded|gh not installed/i);
  });

  test('skips an issue whose repo/number cannot form a valid coordinate (notice, no throw)', () => {
    const out = readBacklog(
      reader({
        ok: true,
        value: [
          { repo: 'no-slash', number: 1, title: 'bad', state: 'open' },
          { repo: 'octo/app', number: 5, title: 'good', state: 'open' },
        ],
      }),
    );
    expect(out.items).toHaveLength(1);
    expect(out.items[0]?.coordString).toBe('octo/app#5');
    expect(out.notices).toHaveLength(1);
  });
});
