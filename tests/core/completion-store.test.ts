import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CompletionStore,
  assembleCompletionFromWorkItem,
  buildCompletion,
  mirrorAcceptanceVerdicts,
} from '~/core/completion-store';
import { completionEvidenceGate, completionGate } from '~/core/gates';
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

describe('assembleCompletionFromWorkItem (lightweight path, wi_2606200ec)', () => {
  test('all ACs pass with real evidence → final_verdict=pass and gates clear', async () => {
    const base = await workItem();
    const verified = await new WorkItemStore(repo).update(base.id, (cur) => ({
      ...cur,
      acceptance_criteria: cur.acceptance_criteria.map((c) => ({
        ...c,
        verdict: 'pass' as const,
        evidence: [{ kind: 'command' as const, command: 'echo ok', summary: 'exit 0' }],
      })),
    }));
    const completion = assembleCompletionFromWorkItem(verified, {
      declaredBy: 'main',
      summary: 's',
    });
    expect(completion.final_verdict).toBe('pass');
    expect(completionGate(verified, completion).pass).toBe(true);
    expect(completionEvidenceGate(completion).pass).toBe(true);
  });

  test('an unverified AC → final_verdict not pass', async () => {
    const base = await workItem(); // ac-1/ac-2 unverified
    const completion = assembleCompletionFromWorkItem(base, { declaredBy: 'main', summary: 's' });
    expect(completion.final_verdict).not.toBe('pass');
  });

  test('pass verdict but evidence is only a note → evidence gate rejects (no false-green)', async () => {
    const base = await workItem();
    const acked = await new WorkItemStore(repo).update(base.id, (cur) => ({
      ...cur,
      acceptance_criteria: cur.acceptance_criteria.map((c) => ({
        ...c,
        verdict: 'pass' as const,
        evidence: [{ kind: 'note' as const, summary: 'looks good' }],
      })),
    }));
    const completion = assembleCompletionFromWorkItem(acked, { declaredBy: 'main', summary: 's' });
    // buildCompletion derives pass from verdicts...
    expect(completion.final_verdict).toBe('pass');
    // ...but the ack-only evidence is caught by the evidence gate.
    expect(completionEvidenceGate(completion).pass).toBe(false);
  });
});

describe('mirrorAcceptanceVerdicts (wi_260627273)', () => {
  // The bug: `autopilot complete`/`work done` write completion.json with per-AC
  // pass verdicts and flip status=done, but leave work-item.json
  // acceptance_criteria verdicts at the stale `unverified` they were created with.
  // The mirror projects the completion's per-AC verdict + evidence back onto the
  // work item so `work status`/`push-ready` reflect the verified state.
  const cmdEvidence = [{ kind: 'command' as const, summary: 'bun test → exit 0' }];

  test('ac-1: mirrors each completion verdict onto the matching work-item criterion (0 stale unverified)', async () => {
    const wi = await workItem(); // ac-1, ac-2 both unverified
    const completion = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 's',
      verdicts: [
        { criterion_id: 'ac-1', verdict: 'pass', evidence: cmdEvidence },
        { criterion_id: 'ac-2', verdict: 'pass', evidence: cmdEvidence },
      ],
    });
    const mirrored = mirrorAcceptanceVerdicts(wi, completion);
    expect(mirrored.acceptance_criteria.map((c) => c.verdict)).toEqual(['pass', 'pass']);
    expect(mirrored.acceptance_criteria.filter((c) => c.verdict === 'unverified')).toHaveLength(0);
  });

  test('ac-2: mirrors evidence so push-ready evidence gate is satisfiable', async () => {
    const wi = await workItem();
    const completion = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 's',
      verdicts: [
        { criterion_id: 'ac-1', verdict: 'pass', evidence: cmdEvidence },
        { criterion_id: 'ac-2', verdict: 'pass', evidence: cmdEvidence },
      ],
    });
    const mirrored = mirrorAcceptanceVerdicts(wi, completion);
    // every criterion now carries ≥1 command-kind evidence (the push-ready bar)
    for (const c of mirrored.acceptance_criteria) {
      expect(c.evidence.some((e) => e.kind === 'command')).toBe(true);
    }
  });

  test('ac-3: a non-pass verdict mirrors as-is (partial stays partial, not forced pass)', async () => {
    const wi = await workItem();
    const completion = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 's',
      verdicts: [
        { criterion_id: 'ac-1', verdict: 'pass', evidence: cmdEvidence },
        { criterion_id: 'ac-2', verdict: 'partial', evidence: cmdEvidence },
      ],
    });
    const mirrored = mirrorAcceptanceVerdicts(wi, completion);
    expect(mirrored.acceptance_criteria.find((c) => c.id === 'ac-2')?.verdict).toBe('partial');
  });

  test('ac-3: idempotent — mirroring twice yields byte-identical acceptance_criteria', async () => {
    const wi = await workItem();
    const completion = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 's',
      verdicts: [
        { criterion_id: 'ac-1', verdict: 'pass', evidence: cmdEvidence },
        { criterion_id: 'ac-2', verdict: 'partial', evidence: cmdEvidence },
      ],
    });
    const once = mirrorAcceptanceVerdicts(wi, completion);
    const twice = mirrorAcceptanceVerdicts(once, completion);
    expect(JSON.stringify(twice.acceptance_criteria)).toBe(
      JSON.stringify(once.acceptance_criteria),
    );
  });

  test('a work-item criterion absent from the completion is left untouched', async () => {
    const wi = await workItem();
    const completion = buildCompletion({
      workItem: wi,
      declaredBy: 'verifier',
      summary: 's',
      verdicts: [{ criterion_id: 'ac-1', verdict: 'pass', evidence: cmdEvidence }],
    });
    const mirrored = mirrorAcceptanceVerdicts(wi, completion);
    // ac-2 had no completion entry → stays as it was
    expect(mirrored.acceptance_criteria.find((c) => c.id === 'ac-2')?.verdict).toBe('unverified');
  });
});
