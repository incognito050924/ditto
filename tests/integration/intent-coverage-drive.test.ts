import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoverageStore } from '~/core/coverage-store';
import { localDir } from '~/core/ditto-paths';
import {
  projectInterviewDimensions,
  promotePremortem,
  recordTurn,
  startInterview,
} from '~/core/interview-driver';
import { InterviewStore } from '~/core/interview-store';
import { WorkItemStore } from '~/core/work-item-store';
import { coverageMap } from '~/schemas/coverage';

/**
 * ac-4 runtime/integration evidence (premortem-coverage §6.3/§3.2/§9 + deep-interview §5).
 * Drives the INTENT-stage flow through the same shared coverage engine the plan
 * stage uses (nextCoverageNode/recordCoverageRound + CoverageStore — NOT a forked
 * engine) and asserts the three ac-4 outcomes ON DISK:
 *   (1) Deep Interview dimensions projected onto the coverage tree;
 *   (2) .ditto/local/runs/<wi>/intent-dialog.md generated on disk;
 *   (3) interview-state premortem 승격 took effect (recorded + §5 gate enforced).
 * kind:file runtime evidence, not unit-only.
 */

let repo: string;
let WI: string;
const NOW = new Date('2026-06-01T00:00:00.000Z');

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-intent-cov-'));
  const wis = new WorkItemStore(repo);
  const wi = await wis.create(
    {
      title: 'intent coverage drive test',
      source_request: 'drive the intent-stage coverage projection',
      goal: 'the deep interview projects dimensions onto the shared coverage tree',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'intent projected', verdict: 'unverified', evidence: [] },
      ],
    },
    NOW,
  );
  WI = wi.id;
  await startInterview(repo, { workItemId: WI, now: NOW });
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('intent-stage coverage projection drives the SHARED engine to disk (ac-4 runtime)', () => {
  test('dimensions → coverage tree + intent-dialog.md ON DISK, resolved closes via false-green gate', async () => {
    // Record two interview turns: one resolved dimension, one still-partial.
    await recordTurn(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        dimension: {
          id: 'data-scope',
          critical: true,
          state: 'resolved',
          ambiguity: 0,
          notes: 'data boundary is the local sidecar only',
        },
        question: {
          text: 'Which data does this touch?',
          why_matters: 'blast radius depends on it',
          user_explanation:
            '이 작업이 어떤 데이터에 닿는지 확인해 영향 범위를 사용자 언어로 정하는 질문입니다.',
          info_gain_estimate: 'high',
        },
        answer: { text: 'only local runtime files', kind: 'user' },
        readiness_score: 0.5,
      },
    });
    await recordTurn(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        dimension: {
          id: 'ui-surface',
          critical: false,
          state: 'partial',
          ambiguity: 0.4,
          notes: 'CLI surface still open',
        },
        question: {
          text: 'Any UI surface?',
          why_matters: 'changes the test plan',
          user_explanation:
            '사용자 화면(UI) 변경이 있는지 확인해 테스트 계획을 사용자 언어로 정하는 질문입니다.',
          info_gain_estimate: 'medium',
        },
        readiness_score: 0.6,
      },
    });

    // ── Drive the INTENT stage through the shared engine. ──
    const result = await projectInterviewDimensions(repo, WI);

    // (1) dimensions projected onto the coverage tree.
    const store = new CoverageStore(repo);
    expect(await store.exists(WI)).toBe(true);
    const map = await store.getMap(WI);
    const ids = map.nodes.map((n) => n.id);
    expect(ids).toContain('cov-root');
    expect(ids).toContain('cov-dim-data-scope');
    expect(ids).toContain('cov-dim-ui-surface');
    // wi_260709mqt: data-scope is CRITICAL and this 2-arg projection passes no opponent
    // config → the intent-dissent opponent degrades to host_absent (ADR-0018). An honest
    // degrade deferral-closes the critical dim (out_of_scope) rather than faking a
    // resolved-with-opponent_ran close (the old blanket fake neutrality). It is still a
    // CLOSED (non-open) node, so it leaves the sweep and appears under 닫힌 항목 below.
    expect(map.nodes.find((n) => n.id === 'cov-dim-data-scope')?.state).toBe('out_of_scope');
    // partial dimension stays open.
    expect(map.nodes.find((n) => n.id === 'cov-dim-ui-surface')?.state).toBe('open');
    // root stays open while a child is open (false-green invariant, §3.2).
    expect(map.nodes.find((n) => n.id === 'cov-root')?.state).toBe('open');

    // coverage.json is valid schema on disk.
    const runDir = localDir(repo, 'runs', WI);
    const covRaw = await readFile(join(runDir, 'coverage.json'), 'utf8');
    expect(coverageMap.safeParse(JSON.parse(covRaw)).success).toBe(true);

    // (2) intent-dialog.md generated ON DISK (kind:file evidence).
    expect(result.intentDialogPath).toBe(`.ditto/local/runs/${WI}/intent-dialog.md`);
    const dialog = await readFile(join(runDir, 'intent-dialog.md'), 'utf8');
    expect(dialog).toContain('kind: intent-dialog');
    expect(dialog).toContain('# intent-dialog');
    expect(dialog).toContain('## 사용자 Q&A');
    expect(dialog).toContain('Which data does this touch?');
    expect(dialog).toContain('## 닫힌 항목');
    expect(dialog).toContain('cov-dim-data-scope');
    expect(dialog).toContain('## 열린 항목');
    expect(dialog).toContain('cov-dim-ui-surface');
  });

  test('projection is idempotent — a second run does not duplicate dimension nodes', async () => {
    await recordTurn(repo, {
      workItemId: WI,
      now: NOW,
      payload: {
        dimension: { id: 'd1', critical: false, state: 'partial', ambiguity: 0.5, notes: 'd1' },
        question: {
          text: 'q?',
          why_matters: 'w',
          user_explanation: '무엇을 결정하는 질문인지 사용자 언어로 설명합니다.',
          info_gain_estimate: 'low',
        },
      },
    });
    await projectInterviewDimensions(repo, WI);
    const after1 = (await new CoverageStore(repo).getMap(WI)).nodes.length;
    await projectInterviewDimensions(repo, WI);
    const after2 = (await new CoverageStore(repo).getMap(WI)).nodes.length;
    expect(after2).toBe(after1);
  });

  // 기제 C fail-open (wi_260706n4w ac-4): a seeded-but-unanswered user-intent
  // dimension projects as an OPEN closeable cov-dim-* node — it REMAINS in the
  // sweep (no silent hole). Only an actual interview resolution closes it.
  test('seeded user-intent dims stay OPEN in the sweep until the interview actually resolves them (ac-4)', async () => {
    // fresh WI: start WITH user-intent seeding (the beforeEach start has none).
    const wi2 = await new WorkItemStore(repo).create(
      {
        title: 'fail-open seed drive',
        source_request: 'seed user-intent dims',
        goal: 'user-intent categories ride the interview, fail-open',
        acceptance_criteria: [
          { id: 'ac-1', statement: 'projected', verdict: 'unverified', evidence: [] },
        ],
      },
      NOW,
    );
    await startInterview(repo, { workItemId: wi2.id, now: NOW, seedUserIntentDimensions: true });

    // project with NO answers — both seeds must land as OPEN cov-dim nodes.
    await projectInterviewDimensions(repo, wi2.id);
    const store = new CoverageStore(repo);
    let map = await store.getMap(wi2.id);
    const authModel = map.nodes.find((n) => n.id === 'cov-dim-authorization-model');
    const regulatory = map.nodes.find((n) => n.id === 'cov-dim-regulatory');
    expect(authModel?.state).toBe('open');
    expect(regulatory?.state).toBe('open');
    // the probing question (lens) rides the node label — the sweep sees the question.
    expect(authModel?.label ?? '').toContain('인가');

    // the user answers ONE of them → only that one leaves the sweep.
    await recordTurn(repo, {
      workItemId: wi2.id,
      now: NOW,
      payload: {
        dimension: {
          id: 'authorization-model',
          critical: false,
          state: 'resolved',
          ambiguity: 0,
          notes: '',
        },
        question: {
          text: '누가 접근 가능해야 하나요?',
          why_matters: '인가 모델이 의도를 결정',
          user_explanation:
            '누가 이 기능에 접근할 수 있어야 하는지 확인해 인가 모델을 사용자 언어로 정하는 질문입니다.',
          info_gain_estimate: 'high',
        },
        answer: { text: '소유자 단일 사용자만', kind: 'user' },
      },
    });
    await projectInterviewDimensions(repo, wi2.id);
    map = await store.getMap(wi2.id);
    expect(map.nodes.find((n) => n.id === 'cov-dim-authorization-model')?.state).toBe('resolved');
    // the unanswered seed is STILL open — fail-open, never silently dropped.
    expect(map.nodes.find((n) => n.id === 'cov-dim-regulatory')?.state).toBe('open');
  });

  test('(3) premortem 승격: recorded into interview-state + §5 gate enforced', async () => {
    // A promoted critical item passes; an unpromoted critical item is flagged.
    const ok = await promotePremortem(
      repo,
      WI,
      {
        items: [
          {
            scenario: 'migration overwrites a column → data loss',
            likelihood: 'low',
            blast_radius: 'critical',
            reversibility: 'irreversible',
            early_signal: 'row counts drop',
            promoted_to: 'ac',
            ref: 'ac-2',
          },
        ],
      },
      NOW,
    );
    expect(ok.unpromoted).toHaveLength(0);

    // Recorded ON DISK in interview-state.json.
    const state = await new InterviewStore(repo).get(WI);
    expect(state.premortem).toHaveLength(1);
    expect(state.premortem[0]?.promoted_to).toBe('ac');

    // §5 fail-closed: an irreversible item left promoted_to:'none' is flagged.
    const bad = await promotePremortem(
      repo,
      WI,
      {
        items: [
          {
            scenario: 'deletes user data with no backup',
            likelihood: 'medium',
            blast_radius: 'high',
            reversibility: 'irreversible',
            early_signal: 'support tickets',
            promoted_to: 'none',
            ref: '',
          },
        ],
      },
      NOW,
    );
    expect(bad.unpromoted).toHaveLength(1);
    expect(bad.unpromoted[0]?.scenario).toContain('deletes user data');
  });
});
