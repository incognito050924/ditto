import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HandoffStore, buildHandoff } from '~/core/handoff-store';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import {
  classifyPromptAdvisory,
  duplicateSearch,
  looksCodebaseAnswerable,
  resolveActiveWorkItem,
  userPromptSubmitHandler,
} from '~/hooks/user-prompt-submit';

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

describe('classifyPromptAdvisory', () => {
  test.each(['what does this do?', '이게 맞나요?', '왜 이렇게 했어', '무엇을 해야 하는가'])(
    'question: %s',
    (p) => {
      expect(classifyPromptAdvisory(p)).toBe('question');
    },
  );

  test.each(['build X', '이거 구현해줘', '비밀번호 검증 추가'])('execution: %s', (p) => {
    expect(classifyPromptAdvisory(p)).toBe('execution');
  });
});

describe('looksCodebaseAnswerable Korean code surface (V4)', () => {
  test.each([
    '이 함수 왜 실패해?',
    '테스트 로그 어디에 있어?',
    '이 파일은 왜 깨져?',
    '이 메서드에서 오류가 나는 이유는?',
    '이 모듈 스키마 어디서 정의돼?',
  ])('detects code-surface vocabulary: %s', (p) => {
    expect(looksCodebaseAnswerable(p)).toBe(true);
  });

  test('a Korean prompt with no code surface stays false', () => {
    expect(looksCodebaseAnswerable('오늘 일정이 어떻게 돼?')).toBe(false);
  });
});

describe('resolveActiveWorkItem (single-active invariant)', () => {
  test('empty state guides (no auto-create, pointer unset)', async () => {
    const items = new WorkItemStore(repo);
    const r = await resolveActiveWorkItem(repo, 'sess-1', 'add a feature');
    expect(r.action).toBe('guide');
    expect(r.workItem).toBeUndefined();
    expect((await items.list()).length).toBe(0); // nothing created
    expect(await new SessionPointerStore(repo).get('sess-1')).toBeNull();
  });

  test('existing pointer loads the work item it points at', async () => {
    const items = new WorkItemStore(repo);
    const created = await items.create({
      title: 'mine',
      source_request: 'r',
      goal: 'r',
      acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
    });
    await new SessionPointerStore(repo).set('sess-1', created.id);
    const r = await resolveActiveWorkItem(repo, 'sess-1', 'follow-up prompt');
    expect(r.action).toBe('loaded');
    expect(r.workItem?.id).toBe(created.id);
  });

  test('pointer present wins even when other open drafts exist (ignores the rest)', async () => {
    const items = new WorkItemStore(repo);
    const mine = await items.create({
      title: 'mine',
      source_request: 'm',
      goal: 'm',
      acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
    });
    await new SessionPointerStore(repo).set('sess-1', mine.id);
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
    expect(again.workItem?.id).toBe(mine.id);
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

  // ac-6 (wi_260625k0w): an explicit work-item id in the prompt binds the session
  // pointer via the runtime SessionPointerStore.set() call, so evidence/leases
  // attribute to that work item. This is the only runtime caller of set().
  test('explicit wi reference binds the session pointer (runtime set) and loads it', async () => {
    const items = new WorkItemStore(repo);
    const created = await items.create({
      title: 'bindable',
      source_request: 'b',
      goal: 'b',
      acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
    });
    // pointer starts unset for this session
    expect(await new SessionPointerStore(repo).get('sess-bind')).toBeNull();
    const r = await resolveActiveWorkItem(repo, 'sess-bind', `resume ${created.id} please`);
    expect(r.action).toBe('loaded');
    expect(r.workItem?.id).toBe(created.id);
    // the runtime set() ran: the pointer file now binds the session to this WI
    expect(await new SessionPointerStore(repo).get('sess-bind')).toBe(created.id);
  });

  test('explicit reference to a non-existent wi does not bind; falls through', async () => {
    const r = await resolveActiveWorkItem(repo, 'sess-noexist', 'resume wi_doesnotexist1 now');
    expect(r.action).toBe('guide'); // empty store → guide, pointer untouched
    expect(await new SessionPointerStore(repo).get('sess-noexist')).toBeNull();
  });

  // ac-1 (wi_260625x74): an already-bound session must NOT be silently rebound by a
  // mere wi_ mention of a different work item — that would re-route evidence/leases
  // away from the active work item. The active binding is preserved.
  test('active pointer is NOT rebound by a bare mention of another work item', async () => {
    const items = new WorkItemStore(repo);
    const active = await items.create({
      title: 'active',
      source_request: 'a',
      goal: 'a',
      acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
    });
    const other = await items.create({
      title: 'other',
      source_request: 'o',
      goal: 'o',
      acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
    });
    await new SessionPointerStore(repo).set('sess-active', active.id);
    // prompt merely references the OTHER work item id — not an explicit rebind
    const r = await resolveActiveWorkItem(repo, 'sess-active', `compare with ${other.id} behavior`);
    expect(r.action).toBe('loaded');
    expect(r.workItem?.id).toBe(active.id); // active binding preserved
    expect(await new SessionPointerStore(repo).get('sess-active')).toBe(active.id); // not rebound
  });

  // ac-4 (wi_26060678y): no active work item + execution-intent prompt → surface a
  // duplicate-search over open WIs and nudge WI creation, while staying advisory.
  test('execution-intent + no pointer surfaces duplicate matches and nudges WI creation', async () => {
    const items = new WorkItemStore(repo);
    await items.create({
      title: 'autopilot path enforcement lease',
      source_request: 'x',
      goal: 'x',
      acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
    });
    const r = await resolveActiveWorkItem(repo, 'fresh', 'autopilot lease 구현해줘');
    expect(r.action).toBe('ask');
    expect(r.advisory).toContain('Possible duplicates by title overlap');
    expect(r.advisory).toContain('autopilot path enforcement lease');
    expect(r.advisory).toContain('create a NEW work item');
  });
});

describe('duplicateSearch (ac-4 token overlap)', () => {
  test('ranks title-overlapping open items best-first; none → empty', () => {
    const open = [
      { id: 'wi_aaaaaaaa', title: 'autopilot lease enforcement' },
      { id: 'wi_bbbbbbbb', title: 'unrelated docs cleanup' },
    ];
    const hits = duplicateSearch('add autopilot lease path', open);
    expect(hits[0]?.id).toBe('wi_aaaaaaaa');
    expect(duplicateSearch('completely orthogonal request', open)).toEqual([]);
  });
});

describe('userPromptSubmitHandler', () => {
  test('always exits 0 (advisory) and injects the charter projection', async () => {
    const out = await run({ session_id: 'sess-1', prompt: 'build X' });
    expect(out.exitCode).toBe(0);
    const ctx = additionalContext(out.stdout);
    expect(ctx).toContain('prime directive');
    // empty state: no active work item, but the work-item guide is surfaced
    expect(ctx).not.toContain('Active work item: wi_');
    expect(ctx).toContain('ditto work start');
  });

  test('empty-state prompt does not auto-create a work item or set a pointer', async () => {
    const items = new WorkItemStore(repo);
    const out = await run({ session_id: 'sess-1', prompt: 'build X' });
    expect(out.exitCode).toBe(0);
    expect((await items.list()).length).toBe(0);
    expect(await new SessionPointerStore(repo).get('sess-1')).toBeNull();
  });

  test('Stop and UserPromptSubmit read the same pointer (one work item)', async () => {
    const items = new WorkItemStore(repo);
    const created = await items.create({
      title: 'mine',
      source_request: 'build X',
      goal: 'build X',
      acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
    });
    await new SessionPointerStore(repo).set('sess-1', created.id);
    const fromPointer = await new SessionPointerStore(repo).get('sess-1');
    expect(fromPointer).toMatch(/^wi_/);
    // the hook (and a direct resolve) load the same pointed work item
    const out = await run({ session_id: 'sess-1', prompt: 'next' });
    expect(additionalContext(out.stdout)).toContain(`Active work item: ${created.id}`);
    const r = await resolveActiveWorkItem(repo, 'sess-1', 'next');
    expect(r.workItem?.id ?? null).toBe(fromPointer);
  });

  test('classification + action are logged, never block', async () => {
    await run({ session_id: 'sess-1', prompt: 'what does this do?' });
    const log = await readFile(join(repo, '.ditto', 'local', 'logs', 'user-prompt.jsonl'), 'utf8');
    const entry = JSON.parse(log.trim().split('\n')[0] ?? '{}');
    expect(entry.classification).toBe('question');
    expect(entry.action).toBe('guide');
  });

  test('missing session_id still injects charter (degrade gracefully)', async () => {
    const out = await run({ prompt: 'no session' });
    expect(out.exitCode).toBe(0);
    expect(additionalContext(out.stdout)).toContain('prime directive');
  });

  test('loaded placeholder-only work item emits placeholder advisory', async () => {
    const items = new WorkItemStore(repo);
    const created = await items.create({
      title: 'ph',
      source_request: 'do the thing',
      goal: 'do the thing',
      acceptance_criteria: [
        {
          id: 'ac-1',
          statement: 'TBD — derive observable criteria during interview/planning',
          verdict: 'unverified',
          evidence: [],
        },
      ],
    });
    await new SessionPointerStore(repo).set('sess-ph', created.id);
    const out = await run({ session_id: 'sess-ph', prompt: 'do the thing' });
    expect(out.exitCode).toBe(0);
    const ctx = additionalContext(out.stdout);
    expect(ctx).toContain('acceptance criteria are placeholders');
    expect(ctx).toContain('/ditto:deep-interview');
  });

  test('empty-state guide does NOT auto-create, so no placeholder advisory', async () => {
    const out = await run({ session_id: 'sess-noph', prompt: 'do the thing' });
    expect(out.exitCode).toBe(0);
    expect(additionalContext(out.stdout)).not.toContain('acceptance criteria are placeholders');
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
    async function seedPlaceholderOnly(sessionId: string): Promise<void> {
      const items = new WorkItemStore(repo);
      const created = await items.create({
        title: 'ph',
        source_request: 'r',
        goal: 'r',
        acceptance_criteria: [
          {
            id: 'ac-1',
            statement: 'TBD — derive observable criteria during interview/planning',
            verdict: 'unverified',
            evidence: [],
          },
        ],
      });
      await new SessionPointerStore(repo).set(sessionId, created.id);
    }

    test('placeholder-only + execution prompt → directive inject (the conjunction)', async () => {
      // A loaded placeholder-only work item (e.g. from `work start`) + execution intent.
      await seedPlaceholderOnly('sess-dir-1');
      const out = await run({ session_id: 'sess-dir-1', prompt: 'build a password endpoint' });
      const ctx = additionalContext(out.stdout);
      expect(ctx).toContain('Run /ditto:deep-interview now');
    });

    test('placeholder-only + question prompt → directive NOT injected', async () => {
      await seedPlaceholderOnly('sess-dir-2');
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

  // wi_260605wf3 — active handoff 를 파일명 명시 없이 자동으로 읽어 컨텍스트에
  // 주입하고, 주입 직후 archive 로 옮겨 정확히 1회만 픽업한다(누적 0).
  describe('active handoff auto-load', () => {
    async function seedActiveHandoff(currentState: string): Promise<void> {
      const items = new WorkItemStore(repo);
      const wi = await items.create({
        title: 'prev',
        source_request: 'do the prior thing',
        goal: 'g',
        acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
      });
      await new HandoffStore(repo).write(
        buildHandoff({
          workItem: wi,
          fromContext: 'prev session',
          currentState,
          nextFirstCheck: 'run bun test',
        }),
      );
    }

    test('injects the active handoff body without the user naming a file', async () => {
      await seedActiveHandoff('N2 implement midway, ac-1 pending');
      const ctx = additionalContext(
        (await run({ session_id: 'sess-ho', prompt: '계속 해줘' })).stdout,
      );
      expect(ctx).toContain('Pending handoff (auto-loaded');
      expect(ctx).toContain('N2 implement midway, ac-1 pending'); // 본문이 주입됨
    });

    test('archives on pickup — a second prompt no longer sees it (no accumulation)', async () => {
      await seedActiveHandoff('one-shot body marker');
      await run({ session_id: 'sess-ho2', prompt: '계속' });
      expect(await new HandoffStore(repo).listActive()).toHaveLength(0);
      const ctx2 = additionalContext((await run({ session_id: 'sess-ho2', prompt: '또' })).stdout);
      expect(ctx2).not.toContain('one-shot body marker');
    });
  });
});
