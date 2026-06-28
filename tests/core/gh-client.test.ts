import { describe, expect, test } from 'bun:test';
import {
  type GhExec,
  type GhExecResult,
  classifyGhFailure,
  createFakeGhClient,
  createGhClient,
  parseAssigneeLogins,
} from '~/core/gh-client';

// n3-ghclient (ac-1 assignee write, ac-3 read-back, ac-7 unclaim @me-only,
// ac-8 graceful degrade incl. rate-limit classification). We inject a recording
// GhExec to assert exact argv (execFileSync, NO shell — no read-back value is ever
// interpolated into a shell string) and a canned raw result to drive the parse paths.

/** A GhExec that records every argv it is called with and returns a canned result. */
function recordingExec(result: GhExecResult): { exec: GhExec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: GhExec = (args) => {
    calls.push(args);
    return result;
  };
  return { exec, calls };
}

const ok0: GhExecResult = { exitCode: 0, stdout: '', stderr: '' };

describe('issueAddAssignee (ac-1) — claim via gh issue edit --add-assignee', () => {
  test('emits argv `issue edit <n> -R <repo> --add-assignee @me`, no shell', () => {
    const { exec, calls } = recordingExec(ok0);
    const client = createGhClient(exec);
    const r = client.issueAddAssignee('owner/repo', 5, '@me');
    expect(r).toEqual({ ok: true, value: undefined });
    expect(calls).toEqual([['issue', 'edit', '5', '-R', 'owner/repo', '--add-assignee', '@me']]);
  });

  test('degrades (never throws) when the invocation fails', () => {
    const client = createGhClient(() => ({
      exitCode: 1,
      stdout: '',
      stderr: 'HTTP 403: Resource not accessible',
    }));
    let r: unknown;
    expect(() => {
      r = client.issueAddAssignee('owner/repo', 5, '@me');
    }).not.toThrow();
    expect(r).toEqual({ ok: false, reason: 'insufficient_perm', detail: expect.any(String) });
  });
});

describe('issueRemoveAssignee (ac-7) — unclaim removes @me ONLY', () => {
  test('emits `--remove-assignee @me` and nothing that clears other assignees', () => {
    const { exec, calls } = recordingExec(ok0);
    const client = createGhClient(exec);
    const r = client.issueRemoveAssignee('owner/repo', 5, '@me');
    expect(r).toEqual({ ok: true, value: undefined });
    expect(calls).toEqual([['issue', 'edit', '5', '-R', 'owner/repo', '--remove-assignee', '@me']]);
    // Guard the @me-only invariant: no --add-assignee, the removed token is exactly @me.
    const argv = calls[0];
    expect(argv).not.toContain('--add-assignee');
    const removeIdx = argv.indexOf('--remove-assignee');
    expect(argv[removeIdx + 1]).toBe('@me');
  });
});

describe('issueView read-back includes assignees (ac-3)', () => {
  test('requests the assignees field from gh', () => {
    const { exec, calls } = recordingExec({
      exitCode: 0,
      stdout: JSON.stringify({ number: 5, assignees: [] }),
      stderr: '',
    });
    const client = createGhClient(exec);
    client.issueView('owner/repo', 5);
    const jsonFlagIdx = calls[0].indexOf('--json');
    expect(jsonFlagIdx).toBeGreaterThanOrEqual(0);
    expect(calls[0][jsonFlagIdx + 1].split(',')).toContain('assignees');
  });
});

describe('parseAssigneeLogins (ac-3) — narrow, never throw', () => {
  test('extracts logins from a well-formed payload', () => {
    expect(parseAssigneeLogins({ assignees: [{ login: 'me' }, { login: 'you' }] })).toEqual([
      'me',
      'you',
    ]);
  });

  test('empty assignees → []', () => {
    expect(parseAssigneeLogins({ assignees: [] })).toEqual([]);
  });

  test('missing assignees key → []', () => {
    expect(parseAssigneeLogins({ number: 5 })).toEqual([]);
  });

  test('odd (non-array) assignees → [] (no throw)', () => {
    expect(() => parseAssigneeLogins({ assignees: 'oops' })).not.toThrow();
    expect(parseAssigneeLogins({ assignees: 'oops' })).toEqual([]);
  });

  test('per-element narrowing skips malformed entries', () => {
    expect(
      parseAssigneeLogins({ assignees: [{ login: 'me' }, { nope: 1 }, { login: 42 }, null] }),
    ).toEqual(['me']);
  });

  test('non-object input → [] (no throw)', () => {
    expect(() => parseAssigneeLogins(null)).not.toThrow();
    expect(parseAssigneeLogins(null)).toEqual([]);
    expect(parseAssigneeLogins('whatever')).toEqual([]);
  });
});

describe('classifyGhFailure — rate-limit 403 is rate_limited, not insufficient_perm (ac-8)', () => {
  // GitHub returns HTTP 403 for BOTH a true permission denial and a secondary
  // rate limit. The rate-limit test must run BEFORE the 403/perm branch, else a
  // transient limit is mis-reported as a permanent permission error.
  const rateLimitStderrs = [
    'HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.',
    'API rate limit exceeded for user ID 1234567.',
    'HTTP 403: You have exceeded a secondary rate limit and have been temporarily blocked from content creation. Please retry your request again later. (retry-after: 60)',
    'HTTP 429: Too Many Requests',
  ];
  for (const stderr of rateLimitStderrs) {
    test(`→ rate_limited: ${stderr.slice(0, 40)}`, () => {
      expect(classifyGhFailure({ exitCode: 1, stdout: '', stderr })).toBe('rate_limited');
    });
  }

  test('a true permission 403 stays insufficient_perm', () => {
    expect(
      classifyGhFailure({
        exitCode: 1,
        stdout: '',
        stderr: 'HTTP 403: Resource not accessible by integration',
      }),
    ).toBe('insufficient_perm');
  });

  test('createGhClient surfaces rate_limited as a typed degradation (never throws)', () => {
    const client = createGhClient(() => ({
      exitCode: 1,
      stdout: '',
      stderr: 'HTTP 403: You have exceeded a secondary rate limit.',
    }));
    let r: unknown;
    expect(() => {
      r = client.issueAddAssignee('owner/repo', 5, '@me');
    }).not.toThrow();
    expect(r).toEqual({ ok: false, reason: 'rate_limited', detail: expect.any(String) });
  });
});

describe('createFakeGhClient mirrors the new assignee methods (ac-1/ac-7)', () => {
  test('records issueAddAssignee / issueRemoveAssignee calls + args', () => {
    const { client, calls } = createFakeGhClient();
    expect(typeof client.issueAddAssignee).toBe('function');
    expect(typeof client.issueRemoveAssignee).toBe('function');
    client.issueAddAssignee('owner/repo', 5, '@me');
    client.issueRemoveAssignee('owner/repo', 5, '@me');
    expect(calls).toEqual([
      { method: 'issueAddAssignee', args: ['owner/repo', 5, '@me'] },
      { method: 'issueRemoveAssignee', args: ['owner/repo', 5, '@me'] },
    ]);
  });

  test('degrade option makes the new methods return the degradation', () => {
    const degrade = { ok: false, reason: 'rate_limited', detail: 'slow down' } as const;
    const { client } = createFakeGhClient({ degrade });
    expect(client.issueAddAssignee('owner/repo', 5, '@me')).toEqual(degrade);
    expect(client.issueRemoveAssignee('owner/repo', 5, '@me')).toEqual(degrade);
  });
});
