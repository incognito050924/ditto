import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { committedWorkItemDir, localDir } from '~/core/ditto-paths';
import { type PrismRound, type PrismRoundSignature, detectDivergence } from '~/core/prism/engine';
import { PrismStore, deriveNovelty } from '~/core/prism/store';
import { WorkItemStore } from '~/core/work-item-store';
import type { QuestionRound } from '~/schemas/question-round';
import { checkCommittedBase } from '../../scripts/check-committed-base-run-artifact';

// wi_260708cdl: the prism draft's decision + backlog records are the exploratory
// Run-tier execution trail (the issue-map draft is already Run tier), consumed only
// within the same prism session. They must NOT sit in the committed Record base
// (`.ditto/work-items/<id>/` = record.json + events/ ONLY, ADR-20260706) — where they
// trip the committed-base run-artifact guard and block the commit. They belong in the
// Run tier alongside the issue-map draft.
describe('PrismStore — decisions + backlog live in the Run tier, not the committed base (wi_260708cdl)', () => {
  async function writeRecords(repo: string, wi: string): Promise<PrismStore> {
    const store = new PrismStore(repo);
    await store.appendDecision({
      schema_version: '0.1.0',
      work_item_id: wi,
      kind: 'skip',
      reason: 'test skip decision',
      recorded_at: '2026-07-08T00:00:00.000Z',
    });
    await store.writeBacklogSplit({
      schema_version: '0.1.0',
      work_item_id: wi,
      items: [],
      materialized: [],
    });
    return store;
  }

  test('ac-1: records land under .ditto/local/.../prism, never the committed base; round-trip holds', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ditto-prism-store-'));
    const wi = 'wi_cdlstore01';
    try {
      const store = await writeRecords(repo, wi);

      // Run tier (local): both records exist under the prism dir.
      const runPrism = localDir(repo, 'work-items', wi, 'prism');
      expect(existsSync(join(runPrism, 'prism-decisions.jsonl'))).toBe(true);
      expect(existsSync(join(runPrism, 'prism-backlog-split.json'))).toBe(true);

      // Committed base (Record tier): NO prism artifacts leak here.
      const committed = committedWorkItemDir(repo, wi);
      expect(existsSync(join(committed, 'prism-decisions.jsonl'))).toBe(false);
      expect(existsSync(join(committed, 'prism-backlog-split.json'))).toBe(false);

      // Round-trip from the Run-tier path is intact.
      expect((await store.readDecisions(wi)).length).toBe(1);
      expect(await store.readBacklogSplit(wi)).not.toBeNull();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('ac-2: after recording prism decisions, the committed-base guard reports zero violations', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ditto-prism-store-'));
    const wi = 'wi_cdlstore02';
    try {
      await writeRecords(repo, wi);
      // The landmine: pre-fix, the prism files sat in the committed base and this
      // guard blocked the commit. Post-fix, the committed base holds no prism leak.
      expect(await checkCommittedBase(repo)).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

// wi_260708yut: per-round admissible-novelty must survive to a durable trace so an
// offline replay can later demonstrate value-of-information (B6). The signal rides the
// preserved question-round sink as an additive-optional `novelty?: boolean`, derived
// deterministically from the existing detectDivergence verdict (no new probability
// field). These tests pin the round-trip (ac-4) and the deterministic mapping (ac-5).
describe('PrismStore — per-round novelty persistence (wi_260708yut ac-4)', () => {
  const base = (wi: string, round: number): QuestionRound => ({
    ts: '2026-07-09T00:00:00.000Z',
    work_item_id: wi,
    round,
    section: 'prism-issue-map',
    generator_count: 1,
    dry: true,
    selected: [],
    all_scored: [],
  });

  test('ac-4: novelty rides appendValueRound → readValueRounds round-trip (both true and false)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ditto-prism-store-'));
    const wi = 'wi_yutstore01';
    try {
      const store = new PrismStore(repo);
      await store.appendValueRound(wi, { ...base(wi, 1), novelty: true });
      await store.appendValueRound(wi, { ...base(wi, 2), novelty: false });

      const rounds = await store.readValueRounds(wi);
      expect(rounds.length).toBe(2);
      // Regression guard: novelty must be a real schema field, not silently dropped on
      // parse (a typo in the schema key would surface here as undefined).
      expect(rounds[0]?.novelty).toBe(true);
      expect(rounds[1]?.novelty).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('ac-4: a legacy line WITHOUT the novelty field still parses (additive-optional)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ditto-prism-store-'));
    const wi = 'wi_yutstore02';
    try {
      // A pre-novelty raw line, written straight to the shared sink (no novelty key).
      const legacy = JSON.stringify(base(wi, 1));
      expect(legacy.includes('novelty')).toBe(false);
      await new WorkItemStore(repo).appendQuestionRoundLine(wi, legacy);

      const store = new PrismStore(repo);
      const rounds = await store.readValueRounds(wi);
      expect(rounds.length).toBe(1);
      expect(rounds[0]?.novelty).toBeUndefined();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

// wi_260714aaq (#29) — the CONSUMER path for the prism/selected user-facing question
// face: appendValueRound must resolve the glossary opaque-vocab (forbidden_abbreviations)
// at RUNTIME and apply it, exactly as interview-driver.ts recordTurn does for the
// deep-interview face. This is the differential proof that the glossary is genuinely READ
// (not a dead default-[] param): a forbidden_abbreviation that is NOT in the hardcoded
// OPAQUE_VOCAB_FLOOR (`zqx`) surfaced un-glossed on a selected question must REJECT the
// round when the glossary carries it, and PASS when no glossary is present. If the wiring
// were removed (back to the default []), the reject case would false-green.
describe('PrismStore — appendValueRound reads the glossary opaque-vocab at runtime (wi_260714aaq #29)', () => {
  async function makeRepo(forbidden: string[] | null): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), 'ditto-prism-vocab-'));
    if (forbidden !== null) {
      await mkdir(join(repo, '.ditto', 'knowledge'), { recursive: true });
      await writeFile(
        join(repo, '.ditto', 'knowledge', 'glossary.json'),
        JSON.stringify({
          schema_version: '0.1.0',
          project_name: 'test',
          updated_at: '2026-07-14T00:00:00+09:00',
          entries: [
            { term: 'x-term', aliases: [], definition: 'd', forbidden_abbreviations: forbidden },
          ],
        }),
      );
    }
    return repo;
  }

  // A NON-dry round whose selected question surfaces `zqx` un-glossed on its user face.
  // user_explanation is present + gloss-free, so the ONLY violation that can trip is the
  // opaque-vocab leak of `zqx` — which is glossary-sourced, not in the hardcoded floor.
  const round = (wi: string): QuestionRound => ({
    ts: '2026-07-14T00:00:00.000Z',
    work_item_id: wi,
    round: 1,
    section: 'prism-issue-map',
    generator_count: 1,
    dry: false,
    selected: [
      {
        text: 'zqx를 어떻게 정할까요?',
        property: 'orientation',
        user_explanation: '왜 묻는지 쉬운 말로 설명하는 문장이에요.',
        scores: { consensus: 1, quality: 0.9, necessity: 0.9, answer_value: 0.9 },
      },
    ],
    all_scored: [],
  });

  test('rejects a selected question surfacing a glossary forbidden_abbreviation un-glossed', async () => {
    const repo = await makeRepo(['zqx']);
    const wi = 'wi_aaqstore01';
    try {
      await expect(new PrismStore(repo).appendValueRound(wi, round(wi))).rejects.toThrow();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('does NOT reject the same question when no glossary is present (flag is glossary-sourced)', async () => {
    const repo = await makeRepo(null);
    const wi = 'wi_aaqstore02';
    try {
      const store = new PrismStore(repo);
      await store.appendValueRound(wi, round(wi));
      const rounds = await store.readValueRounds(wi);
      expect(rounds.length).toBe(1);
      expect(rounds[0]?.selected[0]?.text).toBe('zqx를 어떻게 정할까요?');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('PrismStore — deriveNovelty from detectDivergence verdict (wi_260708yut ac-5)', () => {
  const noHistory: readonly PrismRoundSignature[] = [];

  function verdictNovelty(round: PrismRound, history: readonly PrismRoundSignature[]) {
    const verdict = detectDivergence(round, history);
    return { verdict, novelty: deriveNovelty(verdict) };
  }

  test('ac-5: admissible challenge (challenge-node) → novelty true', () => {
    const { verdict, novelty } = verdictNovelty(
      { challenge: { decided_id: 'n1', signature: 'new grounds', new_evidence: true } },
      noHistory,
    );
    expect(verdict.action).toBe('challenge-node');
    expect(novelty).toBe(true);
  });

  test('ac-5: new non-repeat question (continue, not diverged) → novelty true', () => {
    const { verdict, novelty } = verdictNovelty(
      { question: { signature: 'a fresh question', trivial: false } },
      noHistory,
    );
    expect(verdict.action).toBe('continue');
    expect(verdict.diverged).toBe(false);
    expect(novelty).toBe(true);
  });

  test('ac-5: repeat_question (cap-stop) → novelty false', () => {
    const { verdict, novelty } = verdictNovelty(
      { question: { signature: 'same thing', trivial: false } },
      [{ signature: 'same thing', trivial: false }],
    );
    expect(verdict.kind).toBe('repeat_question');
    expect(novelty).toBe(false);
  });

  test('ac-5: trivial_streak (cap-stop) → novelty false', () => {
    const { verdict, novelty } = verdictNovelty({ question: { signature: 'q3', trivial: true } }, [
      { signature: 'q1', trivial: true },
      { signature: 'q2', trivial: true },
    ]);
    expect(verdict.kind).toBe('trivial_streak');
    expect(novelty).toBe(false);
  });

  test('ac-5: decided_conflict_no_evidence (cap-stop) → novelty false', () => {
    const { verdict, novelty } = verdictNovelty(
      { challenge: { decided_id: 'n1', signature: 're-litigate', new_evidence: false } },
      noHistory,
    );
    expect(verdict.kind).toBe('decided_conflict_no_evidence');
    expect(novelty).toBe(false);
  });
});
