import { join } from 'node:path';
import { localDir } from '~/core/ditto-paths';
import { ensureDir, readJson, writeJson } from '~/core/fs';
import { WorkItemStore } from '~/core/work-item-store';
import {
  type PrismDecision,
  type PrismIssueMap,
  prismDecision,
  prismIssueMap,
} from '~/schemas/prism';
import { type QuestionRound, questionRound } from '~/schemas/question-round';
import { loadGlossaryVocab, warnMalformedGlossary } from '../knowledge-bridge';
import { normalizePresentedText } from '../question-context';
import { assertSelectedPresentationContract } from '../question-round';
import { type PrismBacklogSplit, prismBacklogSplit } from './backlog';
import type { DivergenceVerdict } from './engine';

/**
 * Deterministically derive per-round admissible novelty from the existing prism
 * divergence verdict (wi_260708yut ac-5) — no new probability/credence field, only the
 * already-deterministic detectDivergence judgement reused:
 *   - `challenge-node` (admissible re-challenge with new evidence) → true;
 *   - `continue` with `diverged=false` (a fresh non-repeat question) → true;
 *   - any flagged divergence (`diverged=true`, cap-stop: repeat_question /
 *     trivial_streak / decided_conflict_no_evidence) → false.
 * All three collapse to `!verdict.diverged` (challenge-node and continue are both
 * non-diverged; every cap-stop kind is diverged).
 */
export function deriveNovelty(verdict: DivergenceVerdict): boolean {
  return !verdict.diverged;
}

/**
 * PrismStore — persistence for the prism issue map (wi_260707oi1).
 *
 * ALL prism state is Run tier (`.ditto/local/work-items/<id>/prism/`), the exploratory
 * execution trail of a draft that PRECEDES the committed WI (DI-3):
 *  - `issue-map.json`: the exploratory DRAFT. Single-writer, full-replace
 *    (intent-store.ts pattern) — every node-state transition must have already passed
 *    through the addNode/closeNode pure functions before it is handed here; the store
 *    never edits map fields.
 *  - `prism-decisions.jsonl` + `prism-backlog-split.json`: the draft's decision-grade
 *    trail (approval / unknown-close / skip / early-exit / notified / backlog split).
 *
 * These are NOT Record tier. The committed Record base (`.ditto/work-items/<id>/`) holds
 * `record.json` + `events/` ONLY (ADR-20260706); the `check-committed-base-run-artifact`
 * guard enforces it. Prism decisions are same-session execution trail (like intent.json /
 * runs / graph), consumed only within the prism draft — not shared project memory — so
 * they belong in the discardable Run tier, never the committed base (wi_260708cdl).
 *
 * The VALUE trail reuses the preserved question-round sink (WorkItemStore
 * `appendQuestionRoundLine` / `readQuestionRounds`) so `ditto doctor intent-quality`
 * keeps seeing prism rounds — appended directly (not via `recordRound`) because a
 * prism draft session precedes the committed WI (DI-3).
 */
export class PrismStore {
  private readonly workItems: WorkItemStore;

  constructor(public readonly repoRoot: string) {
    this.workItems = new WorkItemStore(repoRoot);
  }

  private dir(workItemId: string): string {
    return localDir(this.repoRoot, 'work-items', workItemId, 'prism');
  }

  private mapPath(workItemId: string): string {
    return join(this.dir(workItemId), 'issue-map.json');
  }

  private decisionsPath(workItemId: string): string {
    return join(this.dir(workItemId), 'prism-decisions.jsonl');
  }

  private backlogSplitPath(workItemId: string): string {
    return join(this.dir(workItemId), 'prism-backlog-split.json');
  }

  async exists(workItemId: string): Promise<boolean> {
    return Bun.file(this.mapPath(workItemId)).exists();
  }

  async getMap(workItemId: string): Promise<PrismIssueMap> {
    return readJson(this.mapPath(workItemId), prismIssueMap);
  }

  /** Single-writer, atomic, schema-validated full-replace of the Run-tier draft. */
  async writeMap(map: PrismIssueMap): Promise<PrismIssueMap> {
    await ensureDir(this.dir(map.work_item_id));
    return writeJson(this.mapPath(map.work_item_id), prismIssueMap, map);
  }

  /** Append one decision-grade record to the Run-tier prism decision trail. */
  async appendDecision(decision: PrismDecision): Promise<PrismDecision> {
    const validated = prismDecision.parse(decision);
    const path = this.decisionsPath(validated.work_item_id);
    await ensureDir(this.dir(validated.work_item_id));
    const file = Bun.file(path);
    const existing = (await file.exists()) ? await file.text() : '';
    const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
    await Bun.write(path, `${prefix}${JSON.stringify(validated)}\n`);
    return validated;
  }

  async readDecisions(workItemId: string): Promise<PrismDecision[]> {
    const file = Bun.file(this.decisionsPath(workItemId));
    if (!(await file.exists())) return [];
    return (await file.text())
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => prismDecision.parse(JSON.parse(l)));
  }

  /**
   * ac-8 backlog-split record (Run tier). Holds the proposal items, the one-time
   * approval (once approved), and the per-item back-link ledger. Same-session prism
   * draft trail — consumed during materialization, not shared project memory (the
   * materialized child WIs are the durable, committed outcome). Single-writer,
   * schema-validated full-replace (mirrors writeMap).
   */
  async writeBacklogSplit(split: PrismBacklogSplit): Promise<PrismBacklogSplit> {
    await ensureDir(this.dir(split.work_item_id));
    return writeJson(this.backlogSplitPath(split.work_item_id), prismBacklogSplit, split);
  }

  async readBacklogSplit(workItemId: string): Promise<PrismBacklogSplit | null> {
    const file = Bun.file(this.backlogSplitPath(workItemId));
    if (!(await file.exists())) return null;
    return readJson(this.backlogSplitPath(workItemId), prismBacklogSplit);
  }

  /**
   * VALUE trail: append one prism round to the preserved question-round sink so the
   * intent-quality retro keeps consuming it. Appended directly (bypassing
   * `recordRound`'s WI-exists gate) because a prism draft precedes the committed WI.
   */
  async appendValueRound(workItemId: string, round: QuestionRound): Promise<QuestionRound> {
    const parsed = questionRound.parse(round);
    // ac-2: run the user-reaching selected face (text + user_explanation — the fields persisted
    // AND shown to the user) through the shared `normalizePresentedText` display transform BEFORE
    // validate/persist, so the stored form is the clean form and validate/persist stay consistent
    // (a broken-char marker or typographic dash is normalized in what prism persists).
    const validated: QuestionRound = {
      ...parsed,
      selected: parsed.selected.map((q) => ({
        ...q,
        text: normalizePresentedText(q.text),
        ...(q.user_explanation !== undefined
          ? { user_explanation: normalizePresentedText(q.user_explanation) }
          : {}),
      })),
    };
    // Same presentation contract as record-turn / recordRound: reject an
    // under-contextualized user-reaching selected question BEFORE persisting (ac-1).
    // Resolve the glossary opaque-vocab (forbidden_abbreviations) ONCE at this consumer
    // site (wi_260714aaq, #29) and pass it, mirroring interview-driver.ts recordTurn — so
    // the prism selected face enforces the glossary half, not just the hardcoded floor. A
    // bad glossary fails open to floor-only WITH a warning (never silent, never a crash).
    const opaqueVocab = await loadGlossaryVocab(this.repoRoot, () =>
      warnMalformedGlossary(this.repoRoot),
    );
    assertSelectedPresentationContract(validated.selected, opaqueVocab);
    await this.workItems.appendQuestionRoundLine(workItemId, JSON.stringify(validated));
    return validated;
  }

  async readValueRounds(workItemId: string): Promise<QuestionRound[]> {
    return this.workItems.readQuestionRounds(workItemId);
  }
}
