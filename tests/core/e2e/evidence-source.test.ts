import { describe, expect, test } from 'bun:test';
import {
  type CheckEvidence,
  type EvidenceQueryResult,
  type RepoCoord,
  githubChecksSource,
} from '~/core/e2e/evidence-source';
import { DEFAULT_GH_TIMEOUT_MS, type GhExec, type GhExecResult } from '~/core/gh-client';

// n-evidence-channel (ac-5, ac-3): the portable, UNFORGEABLE CI-evidence source.
// The authoritative allow-signal is a LIVE server-side read of CI check-run status
// for the EXACT pushed commit sha — no committed artifact grants ALLOW. We inject a
// fake GhExec (mock-unit, NO real network) to drive every success/failure class.
//
// Anti-forgery invariant this file guards: EVERY !ok query → the gate must BLOCK
// (caller's job), and a malformed payload → `unparseable` (NOT "no gate → pass").

/** A GhExec that records every argv+timeout and returns a canned raw result. */
function recordingExec(result: GhExecResult): {
  exec: GhExec;
  calls: { args: string[]; timeoutMs: number }[];
} {
  const calls: { args: string[]; timeoutMs: number }[] = [];
  const exec: GhExec = (args, timeoutMs) => {
    calls.push({ args, timeoutMs });
    return result;
  };
  return { exec, calls };
}

const COORD: RepoCoord = { repo: 'octo/widget' };
const SHA = 'deadbeefcafebabefeedface00112233deadbeef';

/** A well-formed check-runs payload (gh api repos/{repo}/commits/{sha}/check-runs). */
function checkRunsPayload(runs: Partial<CheckEvidence>[]): string {
  return JSON.stringify({
    total_count: runs.length,
    check_runs: runs.map((r) => ({
      name: r.name ?? 'e2e/login',
      status: r.status ?? 'completed',
      conclusion: r.conclusion === undefined ? 'success' : r.conclusion,
      head_sha: r.head_sha ?? SHA,
    })),
  });
}

function okExec(stdout: string): GhExecResult {
  return { exitCode: 0, stdout, stderr: '' };
}

describe('githubChecksSource.fetchCommitEvidence — success (ac-3 live read)', () => {
  test('(a) parses a well-formed check-runs payload → {ok:true, sha, checks}', () => {
    const payload = checkRunsPayload([
      { name: 'e2e/login', status: 'completed', conclusion: 'success', head_sha: SHA },
      { name: 'e2e/checkout', status: 'in_progress', conclusion: null, head_sha: SHA },
    ]);
    const { exec } = recordingExec(okExec(payload));
    const r = githubChecksSource(exec).fetchCommitEvidence(COORD, SHA);
    expect(r).toEqual({
      ok: true,
      sha: SHA,
      checks: [
        { name: 'e2e/login', status: 'completed', conclusion: 'success', head_sha: SHA },
        { name: 'e2e/checkout', status: 'in_progress', conclusion: null, head_sha: SHA },
      ],
    });
  });

  test('an empty check_runs array is a VALID parse → {ok:true, checks:[]} (the 0-checks BLOCK is the caller)', () => {
    const { exec } = recordingExec(okExec(checkRunsPayload([])));
    const r = githubChecksSource(exec).fetchCommitEvidence(COORD, SHA);
    expect(r).toEqual({ ok: true, sha: SHA, checks: [] });
  });

  test('(finding 9) issues exactly ONE batched call per sha, capped at DEFAULT_GH_TIMEOUT_MS (no N+1)', () => {
    const { exec, calls } = recordingExec(okExec(checkRunsPayload([{ name: 'e2e/login' }])));
    githubChecksSource(exec).fetchCommitEvidence(COORD, SHA);
    expect(calls).toHaveLength(1);
    expect(calls[0].timeoutMs).toBe(DEFAULT_GH_TIMEOUT_MS);
    // one batched check-runs endpoint, per_page=100, filter=latest
    const argv = calls[0].args;
    expect(argv[0]).toBe('api');
    expect(argv[1]).toContain(`repos/${COORD.repo}/commits/${SHA}/check-runs`);
    expect(argv[1]).toContain('per_page=100');
    expect(argv[1]).toContain('filter=latest');
  });
});

describe('githubChecksSource.fetchCommitEvidence — every failure class → !ok (gate BLOCKs)', () => {
  test('(b) gh auth failure → {ok:false, reason:"unauthenticated"}', () => {
    const { exec } = recordingExec({
      exitCode: 1,
      stdout: '',
      stderr: 'gh auth login required: not logged in to any GitHub hosts',
    });
    const r = githubChecksSource(exec).fetchCommitEvidence(COORD, SHA);
    expect(r).toEqual({ ok: false, reason: 'unauthenticated' });
  });

  test('(c) rate-limit → {ok:false, reason:"rate_limited"}', () => {
    const { exec } = recordingExec({
      exitCode: 1,
      stdout: '',
      stderr: 'HTTP 403: You have exceeded a secondary rate limit. retry-after: 60',
    });
    const r = githubChecksSource(exec).fetchCommitEvidence(COORD, SHA);
    expect(r).toEqual({ ok: false, reason: 'rate_limited' });
  });

  test('403 permission (not rate-limit) → {ok:false, reason:"insufficient_perm"}', () => {
    const { exec } = recordingExec({
      exitCode: 1,
      stdout: '',
      stderr: 'HTTP 403: Resource not accessible by integration',
    });
    const r = githubChecksSource(exec).fetchCommitEvidence(COORD, SHA);
    expect(r).toEqual({ ok: false, reason: 'insufficient_perm' });
  });

  test('(d) timeout (network hang) → {ok:false, reason:"timeout"}', () => {
    const { exec } = recordingExec({
      exitCode: null,
      stdout: '',
      stderr: '',
      spawnError: 'timeout',
    });
    const r = githubChecksSource(exec).fetchCommitEvidence(COORD, SHA);
    expect(r).toEqual({ ok: false, reason: 'timeout' });
  });

  test('generic non-zero exit → {ok:false, reason:"nonzero"}', () => {
    const { exec } = recordingExec({ exitCode: 1, stdout: '', stderr: 'something broke' });
    const r = githubChecksSource(exec).fetchCommitEvidence(COORD, SHA);
    expect(r).toEqual({ ok: false, reason: 'nonzero' });
  });
});

describe('githubChecksSource.fetchCommitEvidence — malformed → unparseable (finding 6 inversion)', () => {
  test('(e) non-JSON stdout on exit 0 → {ok:false, reason:"unparseable"} (never reads as "no gate → pass")', () => {
    const { exec } = recordingExec(okExec('this is not json <<<'));
    const r = githubChecksSource(exec).fetchCommitEvidence(COORD, SHA);
    expect(r).toEqual({ ok: false, reason: 'unparseable' });
  });

  test('JSON object but check_runs is not an array → unparseable (fail-closed)', () => {
    const { exec } = recordingExec(okExec(JSON.stringify({ total_count: 1, check_runs: 'oops' })));
    const r = githubChecksSource(exec).fetchCommitEvidence(COORD, SHA);
    expect(r).toEqual({ ok: false, reason: 'unparseable' });
  });

  test('a check_runs element missing required fields → unparseable (never silently dropped)', () => {
    const { exec } = recordingExec(
      okExec(JSON.stringify({ total_count: 1, check_runs: [{ name: 'e2e/login' }] })),
    );
    const r = githubChecksSource(exec).fetchCommitEvidence(COORD, SHA);
    expect(r).toEqual({ ok: false, reason: 'unparseable' });
  });
});

describe('githubChecksSource.fetchCommitEvidence — source absent (finding 5 polarity)', () => {
  test('(f) gh binary absent (ENOENT / classify→absent) → {ok:false, reason:"source_absent"}', () => {
    const { exec } = recordingExec({
      exitCode: null,
      stdout: '',
      stderr: '',
      spawnError: 'absent',
    });
    const r = githubChecksSource(exec).fetchCommitEvidence(COORD, SHA);
    // Inversion of gh-client fail-OPEN: absence blocks the GATE (caller), never passes.
    expect(r).toEqual({ ok: false, reason: 'source_absent' });
  });
});

describe('githubChecksSource — portability (ADR-0016): coord is injected, no host/repo hardcode', () => {
  test('(g) the repo/sha in the argv come from the injected coord, not a constant', () => {
    const coordA: RepoCoord = { repo: 'alice/one' };
    const coordB: RepoCoord = { repo: 'bob/two' };
    const shaA = 'a'.repeat(40);
    const shaB = 'b'.repeat(40);
    const { exec: execA, calls: callsA } = recordingExec(okExec(checkRunsPayload([])));
    const { exec: execB, calls: callsB } = recordingExec(okExec(checkRunsPayload([])));
    githubChecksSource(execA).fetchCommitEvidence(coordA, shaA);
    githubChecksSource(execB).fetchCommitEvidence(coordB, shaB);
    expect(callsA[0].args[1]).toContain(`repos/alice/one/commits/${shaA}/check-runs`);
    expect(callsB[0].args[1]).toContain(`repos/bob/two/commits/${shaB}/check-runs`);
    // no cross-contamination / no hardcoded host or repo
    expect(callsA[0].args.join(' ')).not.toContain('bob/two');
    expect(callsB[0].args.join(' ')).not.toContain('alice/one');
  });

  test('a resolved token (envRef upstream) is passed as an auth header, never a committed literal', () => {
    const { exec, calls } = recordingExec(okExec(checkRunsPayload([])));
    githubChecksSource(exec).fetchCommitEvidence(
      { repo: 'octo/widget', token: 'ghp_runtime' },
      SHA,
    );
    const argv = calls[0].args;
    // token is a runtime-resolved value used as an Authorization header (credential-free source)
    const hIdx = argv.indexOf('-H');
    expect(hIdx).toBeGreaterThanOrEqual(0);
    expect(argv[hIdx + 1]).toContain('ghp_runtime');
  });

  test('an undefined token falls back to gh ambient auth (no -H emitted)', () => {
    const { exec, calls } = recordingExec(okExec(checkRunsPayload([])));
    githubChecksSource(exec).fetchCommitEvidence({ repo: 'octo/widget' }, SHA);
    expect(calls[0].args).not.toContain('-H');
  });
});

// Type-level guard: an !ok result never carries checks (the union discriminates).
test('EvidenceQueryResult discriminates ok from !ok', () => {
  const bad: EvidenceQueryResult = { ok: false, reason: 'source_absent' };
  if (!bad.ok) expect(bad.reason).toBe('source_absent');
});
