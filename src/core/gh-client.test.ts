import { describe, expect, test } from 'bun:test';
import {
  type GhDegradeReason,
  type GhExec,
  type GhExecResult,
  classifyGhFailure,
  createGhClient,
} from './gh-client';

// ac-7 (ADR-0018): every gh failure class degrades gracefully — a typed GhDegradation
// (ok:false) the caller can manual-fallback / skip on, NEVER an unhandled throw. We
// inject a fake GhExec simulating each class; no spawning of the real `gh` binary.

/** A GhExec that always returns the same canned raw result. */
const fakeExec =
  (result: GhExecResult): GhExec =>
  () =>
    result;

/** Failure fixtures keyed by the reason each should classify to. */
const failures: Record<Exclude<GhDegradeReason, never>, GhExecResult> = {
  absent: { exitCode: null, stdout: '', stderr: '', spawnError: 'absent' },
  timeout: { exitCode: null, stdout: '', stderr: '', spawnError: 'timeout' },
  unauthenticated: {
    exitCode: 1,
    stdout: '',
    stderr: 'gh auth login: you are not logged in to any GitHub hosts',
  },
  insufficient_perm: {
    exitCode: 1,
    stdout: '',
    stderr: 'HTTP 403: Resource not accessible by integration',
  },
  unknown_command: {
    exitCode: 1,
    stdout: '',
    stderr: 'unknown command "sub-issue" for "gh issue"',
  },
  nonzero: { exitCode: 1, stdout: '', stderr: 'fatal: an unexpected error occurred' },
  // exit 0 but stdout is not the JSON the runJson path expects.
  unparseable: { exitCode: 0, stdout: 'this is not json <<<', stderr: '' },
};

describe('classifyGhFailure', () => {
  for (const [reason, result] of Object.entries(failures)) {
    if (reason === 'unparseable') continue; // unparseable is a post-exec-0 parse failure, not a classify case
    test(`classifies → ${reason}`, () => {
      expect(classifyGhFailure(result)).toBe(reason as GhDegradeReason);
    });
  }
});

describe('createGhClient — every failure class degrades, never throws (ac-7)', () => {
  // A runJson-backed method (issueView) and a void method (issueComment) cover both
  // helper paths through the degradation contract.
  for (const [reason, result] of Object.entries(failures)) {
    test(`issueView: ${reason} → GhDegradation(ok:false)`, () => {
      const client = createGhClient(fakeExec(result));
      let r: unknown;
      expect(() => {
        r = client.issueView('owner/repo', 42);
      }).not.toThrow();
      expect(r).toEqual({ ok: false, reason, detail: expect.any(String) });
    });

    test(`issueComment: ${reason} → GhDegradation(ok:false)`, () => {
      // 'unparseable' only applies to JSON-parsing methods; a void method treats exit-0
      // as success, so skip it for the void path.
      if (reason === 'unparseable') return;
      const client = createGhClient(fakeExec(result));
      let r: unknown;
      expect(() => {
        r = client.issueComment('owner/repo', 42, 'hi');
      }).not.toThrow();
      expect(r).toEqual({ ok: false, reason, detail: expect.any(String) });
    });
  }
});

describe('createGhClient — happy paths', () => {
  test('issueView: valid JSON → ok:true with parsed value', () => {
    const payload = { number: 42, title: 't', state: 'OPEN', body: 'b', url: 'u' };
    const client = createGhClient(
      fakeExec({ exitCode: 0, stdout: JSON.stringify(payload), stderr: '' }),
    );
    const r = client.issueView('owner/repo', 42);
    expect(r).toEqual({ ok: true, value: payload });
  });

  test('issueComment: exit 0 → ok:true void', () => {
    const client = createGhClient(fakeExec({ exitCode: 0, stdout: '', stderr: '' }));
    const r = client.issueComment('owner/repo', 42, 'hi');
    expect(r).toEqual({ ok: true, value: undefined });
  });

  test('apiGraphql: valid JSON → ok:true with parsed value', () => {
    const payload = { data: { repository: { issue: { number: 1 } } } };
    const client = createGhClient(
      fakeExec({ exitCode: 0, stdout: JSON.stringify(payload), stderr: '' }),
    );
    const r = client.apiGraphql('query{}', { owner: 'o' });
    expect(r).toEqual({ ok: true, value: payload });
  });
});
