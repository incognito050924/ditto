import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import { resolveActiveWorkItem, userPromptSubmitHandler } from '~/hooks/user-prompt-submit';

let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-ups-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const run = (raw: unknown) => userPromptSubmitHandler({ raw, repoRoot: repo, env: {} });

function additionalContext(stdout: string | undefined): string {
  const parsed = JSON.parse(stdout ?? '{}');
  return parsed.hookSpecificOutput?.additionalContext ?? '';
}

describe('resolveActiveWorkItem (single-active invariant)', () => {
  test('empty state creates a draft work item and sets the pointer', async () => {
    const r = await resolveActiveWorkItem(repo, 'sess-1', 'add a feature');
    expect(r.action).toBe('created');
    expect(r.workItem?.status).toBe('draft');
    const pointer = await new SessionPointerStore(repo).get('sess-1');
    expect(pointer).toBe(r.workItem?.id ?? null);
  });

  test('existing pointer loads the same work item', async () => {
    const first = await resolveActiveWorkItem(repo, 'sess-1', 'add a feature');
    const second = await resolveActiveWorkItem(repo, 'sess-1', 'follow-up prompt');
    expect(second.action).toBe('loaded');
    expect(second.workItem?.id).toBe(first.workItem?.id);
  });

  test('pointer present wins even when other open drafts exist (ignores the rest)', async () => {
    const items = new WorkItemStore(repo);
    // establish sess-1's pointer first (clean state)
    const active = await resolveActiveWorkItem(repo, 'sess-1', 'mine');
    expect(active.action).toBe('created');
    // now add unrelated open drafts
    await items.create({
      title: 'other-a',
      source_request: 'a',
      goal: 'a',
      acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
    });
    await items.create({
      title: 'other-b',
      source_request: 'b',
      goal: 'b',
      acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
    });
    const again = await resolveActiveWorkItem(repo, 'sess-1', 'mine again');
    expect(again.action).toBe('loaded');
    expect(again.workItem?.id).toBe(active.workItem?.id);
  });

  test('no pointer + open work items exist => ask, never auto-pick or create', async () => {
    const items = new WorkItemStore(repo);
    await items.create({
      title: 'pre-existing',
      source_request: 'x',
      goal: 'x',
      acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
    });
    const before = (await items.list()).length;
    const r = await resolveActiveWorkItem(repo, 'fresh-session', 'do something new');
    expect(r.action).toBe('ask');
    expect(r.workItem).toBeUndefined();
    expect(r.advisory).toContain('Resume one explicitly');
    expect((await items.list()).length).toBe(before); // nothing created
    expect(await new SessionPointerStore(repo).get('fresh-session')).toBeNull();
  });
});

describe('userPromptSubmitHandler', () => {
  test('always exits 0 (advisory) and injects the charter projection', async () => {
    const out = await run({ session_id: 'sess-1', prompt: 'build X' });
    expect(out.exitCode).toBe(0);
    const ctx = additionalContext(out.stdout);
    expect(ctx).toContain('prime directive');
    expect(ctx).toContain('Active work item: wi_');
  });

  test('Stop and UserPromptSubmit read the same pointer (one work item)', async () => {
    await run({ session_id: 'sess-1', prompt: 'build X' });
    const fromHook = await new SessionPointerStore(repo).get('sess-1');
    expect(fromHook).toMatch(/^wi_/);
    // a second prompt resolves to the same id
    const r = await resolveActiveWorkItem(repo, 'sess-1', 'next');
    expect(r.workItem?.id ?? null).toBe(fromHook);
  });

  test('classification + action are logged, never block', async () => {
    await run({ session_id: 'sess-1', prompt: 'what does this do?' });
    const log = await readFile(join(repo, '.ditto', 'logs', 'user-prompt.jsonl'), 'utf8');
    const entry = JSON.parse(log.trim().split('\n')[0] ?? '{}');
    expect(entry.classification).toBe('question');
    expect(entry.action).toBe('created');
  });

  test('missing session_id still injects charter (degrade gracefully)', async () => {
    const out = await run({ prompt: 'no session' });
    expect(out.exitCode).toBe(0);
    expect(additionalContext(out.stdout)).toContain('prime directive');
  });

  test('auto-created work item (all-placeholder AC) emits placeholder advisory', async () => {
    const out = await run({ session_id: 'sess-ph', prompt: 'do the thing' });
    expect(out.exitCode).toBe(0);
    const ctx = additionalContext(out.stdout);
    expect(ctx).toContain('acceptance criteria are placeholders');
    expect(ctx).toContain('/ditto:deep-interview');
  });

  test('work item with at least one real AC does NOT emit placeholder advisory', async () => {
    const items = new WorkItemStore(repo);
    const created = await items.create({
      title: 'real',
      source_request: 'r',
      goal: 'r',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'returns 200 on /health', verdict: 'unverified', evidence: [] },
      ],
    });
    await new SessionPointerStore(repo).set('sess-real', created.id);
    const out = await run({ session_id: 'sess-real', prompt: 'continue' });
    expect(out.exitCode).toBe(0);
    expect(additionalContext(out.stdout)).not.toContain('acceptance criteria are placeholders');
  });

  test('mixed AC (one placeholder + one real) does NOT emit placeholder advisory', async () => {
    const items = new WorkItemStore(repo);
    const created = await items.create({
      title: 'mixed',
      source_request: 'm',
      goal: 'm',
      acceptance_criteria: [
        {
          id: 'ac-1',
          statement: 'TBD — derive observable criteria during interview/planning',
          verdict: 'unverified',
          evidence: [],
        },
        { id: 'ac-2', statement: 'logs request id', verdict: 'unverified', evidence: [] },
      ],
    });
    await new SessionPointerStore(repo).set('sess-mix', created.id);
    const out = await run({ session_id: 'sess-mix', prompt: 'continue' });
    expect(out.exitCode).toBe(0);
    expect(additionalContext(out.stdout)).not.toContain('acceptance criteria are placeholders');
  });

  // §AC-1 deep-interview directive matrix (4 cases) — only the conjunction
  // (placeholder-only + execution) triggers; the other three are silent.
  describe('§AC-1 deep-interview directive', () => {
    test('placeholder-only + execution prompt → directive inject (the conjunction)', async () => {
      // Fresh session, fresh work item: auto-create yields placeholder-only.
      const out = await run({ session_id: 'sess-dir-1', prompt: 'build a password endpoint' });
      const ctx = additionalContext(out.stdout);
      expect(ctx).toContain('Run /ditto:deep-interview now');
    });

    test('placeholder-only + question prompt → directive NOT injected', async () => {
      const out = await run({
        session_id: 'sess-dir-2',
        prompt: 'what does the bridge command do?',
      });
      const ctx = additionalContext(out.stdout);
      expect(ctx).not.toContain('Run /ditto:deep-interview now');
    });

    test('real AC + execution prompt → directive NOT injected', async () => {
      const items = new WorkItemStore(repo);
      const created = await items.create({
        title: 'real-ex',
        source_request: 'r',
        goal: 'r',
        acceptance_criteria: [
          { id: 'ac-1', statement: 'returns 200', verdict: 'unverified', evidence: [] },
        ],
      });
      await new SessionPointerStore(repo).set('sess-dir-3', created.id);
      const out = await run({ session_id: 'sess-dir-3', prompt: 'implement the endpoint' });
      expect(additionalContext(out.stdout)).not.toContain('Run /ditto:deep-interview now');
    });

    test('real AC + question prompt → directive NOT injected', async () => {
      const items = new WorkItemStore(repo);
      const created = await items.create({
        title: 'real-q',
        source_request: 'r',
        goal: 'r',
        acceptance_criteria: [
          { id: 'ac-1', statement: 'returns 200', verdict: 'unverified', evidence: [] },
        ],
      });
      await new SessionPointerStore(repo).set('sess-dir-4', created.id);
      const out = await run({ session_id: 'sess-dir-4', prompt: 'what is the goal?' });
      expect(additionalContext(out.stdout)).not.toContain('Run /ditto:deep-interview now');
    });
  });

  // §AC-5 QuestionGate self-answer hint (advisory, no enforcement).
  describe('§AC-5 QuestionGate self-answer hint', () => {
    test('question prompt mentioning code surface → self-answer hint', async () => {
      const out = await run({
        session_id: 'sess-qg-1',
        prompt: 'what does the function handleRequest in src/api.ts do?',
      });
      expect(additionalContext(out.stdout)).toContain('self-answer from code/docs/web first');
    });

    test('question prompt with no code surface → no self-answer hint', async () => {
      const out = await run({ session_id: 'sess-qg-2', prompt: 'what should we name it?' });
      expect(additionalContext(out.stdout)).not.toContain('self-answer from code/docs/web first');
    });

    test('execution prompt mentioning code surface → no self-answer hint (only question-shaped)', async () => {
      const out = await run({
        session_id: 'sess-qg-3',
        prompt: 'fix the error in src/api.ts',
      });
      expect(additionalContext(out.stdout)).not.toContain('self-answer from code/docs/web first');
    });
  });
});
