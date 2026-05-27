import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompletionStore, buildCompletion } from '~/core/completion-store';
import { completionGate } from '~/core/gates';
import { WorkItemStore } from '~/core/work-item-store';

let repo: string;
async function workItem() {
  return new WorkItemStore(repo).create({
    title: 'pw',
    source_request: 's',
    goal: 'g',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'returns 200', verdict: 'unverified', evidence: [] },
      { id: 'ac-2', statement: 'rejects empty', verdict: 'unverified', evidence: [] },
    ],
  });
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-comp-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('buildCompletion', () => {
  test('all pass + no in-scope unverified => final pass, and completionGate passes', async () => {
    const wi = await workItem();
    const completion = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 'all verified',
      verdicts: [
        { criterion_id: 'ac-1', verdict: 'pass' },
        { criterion_id: 'ac-2', verdict: 'pass' },
      ],
    });
    expect(completion.final_verdict).toBe('pass');
    expect(completionGate(wi, completion).pass).toBe(true);
  });

  test('emits one entry per work-item criterion (missing verdict defaults to unverified)', async () => {
    const wi = await workItem();
    const completion = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 'partial',
      verdicts: [{ criterion_id: 'ac-1', verdict: 'pass' }],
    });
    expect(completion.acceptance.map((a) => a.criterion_id).sort()).toEqual(['ac-1', 'ac-2']);
    expect(completion.acceptance.find((a) => a.criterion_id === 'ac-2')?.verdict).toBe(
      'unverified',
    );
    expect(completion.final_verdict).toBe('unverified');
    // non-pass requires handoff path (schema refine satisfied by builder default)
    expect(completion.next_handoff_path).toBeDefined();
  });

  test('a failing criterion aggregates to fail', async () => {
    const wi = await workItem();
    const completion = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 'one failed',
      verdicts: [
        { criterion_id: 'ac-1', verdict: 'pass' },
        { criterion_id: 'ac-2', verdict: 'fail' },
      ],
    });
    expect(completion.final_verdict).toBe('fail');
  });

  test('in-scope unverified blocks pass', async () => {
    const wi = await workItem();
    const completion = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 'unverified remains',
      verdicts: [
        { criterion_id: 'ac-1', verdict: 'pass' },
        { criterion_id: 'ac-2', verdict: 'pass' },
      ],
      unverified: [{ item: 'regression', reason: 'no time', out_of_scope: false }],
    });
    expect(completion.final_verdict).not.toBe('pass');
  });
});

describe('CompletionStore', () => {
  test('write then get round-trips', async () => {
    const wi = await workItem();
    const completion = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 'ok',
      verdicts: [
        { criterion_id: 'ac-1', verdict: 'pass' },
        { criterion_id: 'ac-2', verdict: 'pass' },
      ],
    });
    const store = new CompletionStore(repo);
    await store.write(completion);
    expect(await store.exists(wi.id)).toBe(true);
    expect((await store.get(wi.id)).final_verdict).toBe('pass');
  });
});
