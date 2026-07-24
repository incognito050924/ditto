import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createWorkItem, loadWorkItem } from '../record/store';
import type { CompletionContract } from '../schemas/completion-contract';
import type { RepoCoord } from './coord';
import type { GhResult, MirrorWriter } from './gh';
import { linkIssue } from './linkage';
import { buildResultSummary, mirrorCompletion } from './mirror';

const COORD: RepoCoord = { repo: 'octo/app', number: 42 };

const passingCompletion: CompletionContract = {
  work_item_id: 'wi_secret_internal_id',
  criteria: [
    {
      criterion_id: 'ac-1',
      verdict: 'pass',
      evidence: [{ kind: 'test', path: '/abs/secret/path.test.ts', summary: 'ok' }],
    },
  ],
  final_verdict: 'pass',
};

/** A spy writer that records every method invoked (to prove the mirror uses only one direction). */
function spyWriter(result: GhResult<void> = { ok: true, value: undefined }): {
  writer: MirrorWriter;
  calls: { method: string; coord: RepoCoord; body: string }[];
} {
  const calls: { method: string; coord: RepoCoord; body: string }[] = [];
  return {
    calls,
    writer: {
      postCompletionComment(coord, body) {
        calls.push({ method: 'postCompletionComment', coord, body });
        return result;
      },
    },
  };
}

describe('completion mirror — layer 3 (ditto → GitHub, one-way)', () => {
  test('posts a summary built from the ditto completion to the linked issue', () => {
    const spy = spyWriter();
    const out = mirrorCompletion({ writer: spy.writer }, { coord: COORD, completion: passingCompletion });
    expect(out.commentPosted).toBe(true);
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.method).toBe('postCompletionComment');
    expect(spy.calls[0]?.coord).toEqual(COORD);
    expect(spy.calls[0]?.body).toContain('pass');
  });

  test('skips + notices when the work item is not linked (coord null)', () => {
    const spy = spyWriter();
    const out = mirrorCompletion({ writer: spy.writer }, { coord: null, completion: passingCompletion });
    expect(out.commentPosted).toBe(false);
    expect(spy.calls).toHaveLength(0);
    expect(out.notices[0]).toMatch(/no linked|not linked/i);
  });

  test('degrades to a notice (no throw) when the write fails (ADR-0018)', () => {
    const spy = spyWriter({ ok: false, reason: 'gh 403' });
    const out = mirrorCompletion({ writer: spy.writer }, { coord: COORD, completion: passingCompletion });
    expect(out.commentPosted).toBe(false);
    expect(out.notices[0]).toMatch(/degraded|403/i);
  });

  // --- One-way invariant: a mirror never mutates backlog-authoritative state ---

  test('INVARIANT: the mirror writer exposes ONLY the completion-comment direction (no backlog/board write)', () => {
    const spy = spyWriter();
    const methods = Object.keys(spy.writer);
    expect(methods).toEqual(['postCompletionComment']);
  });

  test('INVARIANT: the only GitHub call the mirror makes is postCompletionComment (never a board/status/priority write)', () => {
    const spy = spyWriter();
    mirrorCompletion({ writer: spy.writer }, { coord: COORD, completion: passingCompletion });
    expect(spy.calls.map((c) => c.method)).toEqual(['postCompletionComment']);
  });

  test('INVARIANT: GitHub state cannot flow back — the posted body is derived purely from the ditto completion (write success/failure does not change it)', () => {
    const succeed = spyWriter({ ok: true, value: undefined });
    const fail = spyWriter({ ok: false, reason: 'gh down' });
    mirrorCompletion({ writer: succeed.writer }, { coord: COORD, completion: passingCompletion });
    mirrorCompletion({ writer: fail.writer }, { coord: COORD, completion: passingCompletion });
    // Same ditto input → identical mirror payload, regardless of the GitHub side.
    expect(fail.calls[0]?.body).toBe(succeed.calls[0]?.body);
    expect(fail.calls[0]?.body).toBe(buildResultSummary(passingCompletion));
  });

  test('INVARIANT: the mirror does not mutate the local work-item Record (no store write)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ditto-gh-mirror-'));
    await createWorkItem(root, { id: 'wi_m', title: 't' });
    await linkIssue(root, 'wi_m', COORD);
    const before = await loadWorkItem(root, 'wi_m');

    mirrorCompletion({ writer: spyWriter().writer }, { coord: COORD, completion: passingCompletion });

    const after = await loadWorkItem(root, 'wi_m');
    expect(after.record).toEqual(before.record);
    expect(after.events).toEqual(before.events);
  });

  test('public-safe summary: never leaks the internal work_item_id or absolute evidence paths', () => {
    const body = buildResultSummary(passingCompletion);
    expect(body).not.toContain('wi_secret_internal_id');
    expect(body).not.toContain('/abs/secret/path.test.ts');
    expect(body).toContain('ac-1');
    expect(body).toContain('pass');
  });
});
