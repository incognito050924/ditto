import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { utimesSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HandoffStore, buildHandoff } from '~/core/handoff-store';
import { IntentStore } from '~/core/intent-store';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import {
  classifyPromptAdvisory,
  duplicateSearch,
  explicitWorkItemRef,
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

// gotcha wi_260627jor: a bare wi_ token anywhere in the prompt (incidental prose
// mention, a quoted id, or an injected tool-result) used to count as an explicit
// resume signal and bind the session pointer — tripping an unrelated Stop gate.
// A resume signal must be the id LEADING the prompt or a resume-intent keyword.
describe('explicitWorkItemRef (resume signal, not incidental mention)', () => {
  test('incidental prose mention does NOT count as a resume signal', () => {
    expect(explicitWorkItemRef('이 버그는 wi_260627273 과 비슷하다 보고서 읽어줘')).toBeUndefined();
    expect(explicitWorkItemRef('compare with wi_260627273 behavior')).toBeUndefined();
  });

  test('id leading the prompt counts as a resume signal', () => {
    expect(explicitWorkItemRef('wi_260627273 이어서 해줘')).toBe('wi_260627273');
    expect(explicitWorkItemRef('wi_260627273')).toBe('wi_260627273');
  });

  test('a resume-intent keyword with the id counts as a resume signal', () => {
    expect(explicitWorkItemRef('resume wi_260627273')).toBe('wi_260627273');
    expect(explicitWorkItemRef('wi_260627273 재개하자')).toBe('wi_260627273');
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

  // wi_2607083ch: a pointer left bound to a TERMINAL work item (done/abandoned)
  // is stale — the work is closed. It must not load as the active work item, so a
  // new/explicit-resume item can bind and the hook stops injecting a closed WI as
  // "Active work item". A non-terminal pointer still loads (no regression).
  test('pointer to a TERMINAL work item is inactive; a non-terminal pointer still loads', async () => {
    const items = new WorkItemStore(repo);
    const closed = await items.create({
      title: 'closed',
      source_request: 'r',
      goal: 'r',
      acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
    });
    await items.update(closed.id, (c) => ({ ...c, status: 'abandoned' }));
    await new SessionPointerStore(repo).set('sess-term', closed.id);
    const r = await resolveActiveWorkItem(repo, 'sess-term', 'do something new');
    expect(r.workItem).toBeUndefined(); // terminal pointer does not load as active

    const live = await items.create({
      title: 'live',
      source_request: 'r',
      goal: 'r',
      acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
    });
    await new SessionPointerStore(repo).set('sess-live', live.id);
    const r2 = await resolveActiveWorkItem(repo, 'sess-live', 'x');
    expect(r2.action).toBe('loaded');
    expect(r2.workItem?.id).toBe(live.id);
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

  // gotcha wi_260627jor: no active pointer + an INCIDENTAL prose mention of an
  // existing wi must NOT auto-bind. It falls through to the non-blocking "ask"
  // advisory, leaving the pointer unset so no unrelated Stop gate fires.
  test('no pointer + incidental mention of an existing wi does NOT bind', async () => {
    const items = new WorkItemStore(repo);
    const existing = await items.create({
      title: 'mentioned',
      source_request: 'm',
      goal: 'm',
      acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
    });
    expect(await new SessionPointerStore(repo).get('sess-incidental')).toBeNull();
    const r = await resolveActiveWorkItem(
      repo,
      'sess-incidental',
      `이 버그는 ${existing.id} 과 구조가 비슷하다. 그냥 보고서나 읽어줘.`,
    );
    expect(r.action).toBe('ask'); // not 'loaded' — no false adoption
    expect(await new SessionPointerStore(repo).get('sess-incidental')).toBeNull();
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
    expect(ctx).toContain('acceptance criteria가 아직 자리표시자다');
    expect(ctx).toContain('/ditto:deep-interview');
  });

  test('empty-state guide does NOT auto-create, so no placeholder advisory', async () => {
    const out = await run({ session_id: 'sess-noph', prompt: 'do the thing' });
    expect(out.exitCode).toBe(0);
    expect(additionalContext(out.stdout)).not.toContain('acceptance criteria가 아직 자리표시자다');
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
    expect(additionalContext(out.stdout)).not.toContain('acceptance criteria가 아직 자리표시자다');
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
    expect(additionalContext(out.stdout)).not.toContain('acceptance criteria가 아직 자리표시자다');
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
      expect(ctx).toContain('지금 /ditto:deep-interview를 실행하라');
    });

    test('placeholder-only + question prompt → directive NOT injected', async () => {
      await seedPlaceholderOnly('sess-dir-2');
      const out = await run({
        session_id: 'sess-dir-2',
        prompt: 'what does the bridge command do?',
      });
      const ctx = additionalContext(out.stdout);
      expect(ctx).not.toContain('지금 /ditto:deep-interview를 실행하라');
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
      expect(additionalContext(out.stdout)).not.toContain('지금 /ditto:deep-interview를 실행하라');
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
      expect(additionalContext(out.stdout)).not.toContain('지금 /ditto:deep-interview를 실행하라');
    });
  });

  // ac-3 B (wi_260626wnv) — the heavy nudge is RISK-driven, not placeholder-string
  // driven. Replacing the placeholder with real criteria must NOT silently lose the
  // heavy-path nudge for high-risk work: a declared_risk flag (or a `work promote`
  // marker, or non-empty intent unknowns) keeps it firing under execution intent.
  describe('ac-3 B risk-driven deep-interview directive', () => {
    async function seedRealCriteria(
      sessionId: string,
      extra: Partial<Parameters<WorkItemStore['create']>[0]> = {},
    ): Promise<string> {
      const items = new WorkItemStore(repo);
      const created = await items.create({
        title: 'real-risk',
        source_request: 'r',
        goal: 'r',
        acceptance_criteria: [
          { id: 'ac-1', statement: 'the command returns 0', verdict: 'unverified', evidence: [] },
        ],
        ...extra,
      });
      await new SessionPointerStore(repo).set(sessionId, created.id);
      return created.id;
    }

    test('real criteria (placeholder replaced) + declared risk + execution → STILL nudges heavy', async () => {
      // The KEY invariant: set-criteria replaced the placeholder (placeholderOnly=false),
      // but a declared_risk flag keeps the heavy nudge alive.
      await seedRealCriteria('sess-risk-1', { declared_risk: { irreversible: true } });
      const out = await run({ session_id: 'sess-risk-1', prompt: 'implement the migration' });
      expect(additionalContext(out.stdout)).toContain('지금 /ditto:deep-interview를 실행하라');
    });

    test('real criteria + declared risk + QUESTION prompt → directive NOT injected (conjunction preserved)', async () => {
      await seedRealCriteria('sess-risk-2', { declared_risk: { irreversible: true } });
      const out = await run({ session_id: 'sess-risk-2', prompt: 'what does the migration do?' });
      expect(additionalContext(out.stdout)).not.toContain('지금 /ditto:deep-interview를 실행하라');
    });

    test('real criteria, NO risk + execution → directive NOT injected (no false heavy)', async () => {
      await seedRealCriteria('sess-risk-3');
      const out = await run({ session_id: 'sess-risk-3', prompt: 'implement the endpoint' });
      expect(additionalContext(out.stdout)).not.toContain('지금 /ditto:deep-interview를 실행하라');
    });

    test('promoted_to_heavy marker + real criteria + execution → nudges heavy', async () => {
      const id = await seedRealCriteria('sess-risk-4');
      await new WorkItemStore(repo).update(id, (cur) => ({ ...cur, promoted_to_heavy: true }));
      const out = await run({ session_id: 'sess-risk-4', prompt: 'continue the work' });
      expect(additionalContext(out.stdout)).toContain('지금 /ditto:deep-interview를 실행하라');
    });

    test('intent.json with non-empty unknowns + real criteria + execution → nudges heavy', async () => {
      const id = await seedRealCriteria('sess-risk-5');
      await new IntentStore(repo).write({
        schema_version: '0.1.0',
        work_item_id: id,
        source_request: 'r',
        goal: 'g',
        in_scope: [],
        out_of_scope: [],
        acceptance_criteria: [
          {
            id: 'ac-1',
            statement: 'the command returns 0',
            verdict: 'unverified',
            evidence: [],
            evidence_required: [],
          },
        ],
        unknowns: ['which migration order is safe?'],
        follow_up_candidates: [],
        question_policy: 'ask_only_if_user_only_can_answer',
      });
      const out = await run({ session_id: 'sess-risk-5', prompt: 'continue the work' });
      expect(additionalContext(out.stdout)).toContain('지금 /ditto:deep-interview를 실행하라');
    });
  });

  // §AC-5 QuestionGate self-answer hint (advisory, no enforcement).
  describe('§AC-5 QuestionGate self-answer hint', () => {
    test('question prompt mentioning code surface → self-answer hint', async () => {
      const out = await run({
        session_id: 'sess-qg-1',
        prompt: 'what does the function handleRequest in src/api.ts do?',
      });
      expect(additionalContext(out.stdout)).toContain(
        '묻기 전에 코드·문서·웹에서 먼저 스스로 답하라',
      );
    });

    test('question prompt with no code surface → no self-answer hint', async () => {
      const out = await run({ session_id: 'sess-qg-2', prompt: 'what should we name it?' });
      expect(additionalContext(out.stdout)).not.toContain(
        '묻기 전에 코드·문서·웹에서 먼저 스스로 답하라',
      );
    });

    test('execution prompt mentioning code surface → no self-answer hint (only question-shaped)', async () => {
      const out = await run({
        session_id: 'sess-qg-3',
        prompt: 'fix the error in src/api.ts',
      });
      expect(additionalContext(out.stdout)).not.toContain(
        '묻기 전에 코드·문서·웹에서 먼저 스스로 답하라',
      );
    });
  });

  // wi_260708700 — handoff auto-load REMOVED. Auto-load (wi_260605wf3) had no
  // efficacy and dumped the verbatim body into context on every resume turn. A
  // handoff is now neither injected nor consumed on prompt; it stays active for
  // MANUAL load (a follow-up read mechanism). Only the stale sweep (below) GCs it.
  describe('handoff is NOT auto-loaded (manual load only)', () => {
    async function seedActiveHandoff(currentState: string): Promise<{ id: string }> {
      const wi = await new WorkItemStore(repo).create({
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
      return wi;
    }

    test('an active handoff is neither injected into context nor consumed', async () => {
      const wi = await seedActiveHandoff('body-marker-N2');
      await new SessionPointerStore(repo).set('sess-ho', wi.id); // bound to its OWN handoff
      const ctx = additionalContext(
        (await run({ session_id: 'sess-ho', prompt: '계속 해줘' })).stdout,
      );
      expect(ctx).not.toContain('Pending handoff (auto-loaded');
      expect(ctx).not.toContain('body-marker-N2'); // body NOT injected
      // NOT consumed — stays active so a manual mechanism can still load it.
      const hs = new HandoffStore(repo);
      expect(await hs.exists(wi.id)).toBe(true);
      expect(await hs.listActive()).toHaveLength(1);
    });
  });

  // wi_2606289nt: the consume path also sweeps STALE active handoffs into archive
  // (move-not-delete) so an un-picked-up handoff can never re-inject forever.
  describe('stale active sweep on prompt', () => {
    const DAY = 24 * 60 * 60 * 1000;
    async function makeWI(title: string): Promise<{ id: string }> {
      return new WorkItemStore(repo).create({
        title,
        source_request: 'r',
        goal: 'g',
        acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
      });
    }
    async function seedStaleHandoffFor(wi: { id: string }, currentState: string): Promise<void> {
      const item = await new WorkItemStore(repo).get(wi.id);
      await new HandoffStore(repo).write(
        buildHandoff({
          workItem: item,
          fromContext: 'prev',
          currentState,
          nextFirstCheck: 'c',
          now: new Date(Date.now() - 30 * DAY), // far past the retention limit
        }),
      );
      // WS-HND-T1: the stale sweep keys on filesystem mtime, so age the file on
      // disk too (created_at alone no longer triggers the sweep).
      const old = new Date(Date.now() - 30 * DAY);
      utimesSync(join(repo, `.ditto/local/handoff/${wi.id}.md`), old, old);
    }

    // ac-4: the consume path actually invokes sweepStaleActive — observe its effect.
    // Session is BOUND to A (no handoff), so consume never touches B's STALE handoff;
    // only sweepStaleActive can remove it. After the prompt, B is gone from active.
    test('a stale sibling handoff is swept out of active by the prompt (invocation effect)', async () => {
      const a = await makeWI('A');
      const b = await makeWI('B');
      await seedStaleHandoffFor(b, 'B-stale-marker');
      await new SessionPointerStore(repo).set('sess-A', a.id);
      const hs = new HandoffStore(repo);
      expect(await hs.exists(b.id)).toBe(true); // present before
      await run({ session_id: 'sess-A', prompt: 'go' });
      expect(await hs.exists(b.id)).toBe(false); // swept into archive
      expect(await hs.listActive()).toHaveLength(0); // never re-injectable
    });

    // WS-HND-T3 (wi_260706kdx): the same prompt tick also GCs stale session
    // pointers. Seed an aged pointer file, run the prompt, assert it was swept —
    // proves SessionPointerStore.sweepStale is actually wired next to the handoff sweep.
    test('a stale session pointer is swept out by the prompt (pointer GC wiring)', async () => {
      const a = await makeWI('A');
      const store = new SessionPointerStore(repo);
      await store.set('sess-stale', a.id);
      const ptr = join(repo, '.ditto/local/sessions/sess-stale.json');
      const old = new Date(Date.now() - 30 * DAY);
      utimesSync(ptr, old, old); // age past the 7d retention
      await run({ session_id: 'sess-A', prompt: 'go' });
      expect(await store.get('sess-stale')).toBeNull(); // pointer GC'd
    });

    // ac-5: a sweep error does not break the hook — it still returns its context.
    test('a sweep failure does not break the prompt hook (fail-open)', async () => {
      const spy = spyOn(HandoffStore.prototype, 'sweepStaleActive').mockRejectedValue(
        new Error('sweep boom'),
      );
      try {
        const res = await run({ session_id: 'sess-boom', prompt: 'go' });
        expect(res.stdout).toBeDefined();
        // still produces the charter/context output despite the sweep throwing
        expect(additionalContext(res.stdout).length).toBeGreaterThan(0);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
