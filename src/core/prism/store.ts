import { join } from 'node:path';
import { committedWorkItemDir, localDir } from '~/core/ditto-paths';
import { ensureDir, readJson, writeJson } from '~/core/fs';
import { WorkItemStore } from '~/core/work-item-store';
import {
  type PrismDecision,
  type PrismIssueMap,
  prismDecision,
  prismIssueMap,
} from '~/schemas/prism';
import { type QuestionRound, questionRound } from '~/schemas/question-round';
import { type PrismBacklogSplit, prismBacklogSplit } from './backlog';

/**
 * PrismStore — persistence for the prism issue map (wi_260707oi1).
 *
 * Two tiers (design decision 3):
 *  - Run tier (`.ditto/local/work-items/<id>/prism/issue-map.json`): the exploratory
 *    issue-map DRAFT. Single-writer, full-replace (intent-store.ts pattern) — every
 *    node-state transition must have already passed through the addNode/closeNode
 *    pure functions before it is handed here; the store never edits map fields.
 *  - Record tier (`.ditto/work-items/<id>/prism-decisions.jsonl`): the decision-grade,
 *    durable log (approval / unknown-close / skip / early-exit / notified) that must
 *    survive a Run-tier wipe.
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
    return join(committedWorkItemDir(this.repoRoot, workItemId), 'prism-decisions.jsonl');
  }

  private backlogSplitPath(workItemId: string): string {
    return join(committedWorkItemDir(this.repoRoot, workItemId), 'prism-backlog-split.json');
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

  /** Append one decision-grade record to the durable Record-tier log. */
  async appendDecision(decision: PrismDecision): Promise<PrismDecision> {
    const validated = prismDecision.parse(decision);
    const path = this.decisionsPath(validated.work_item_id);
    await ensureDir(committedWorkItemDir(this.repoRoot, validated.work_item_id));
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
   * ac-8 backlog-split record (Record tier, durable). Holds the proposal items, the
   * one-time approval (once approved), and the per-item back-link ledger. Record tier
   * so the approval evidence + materialization ledger survive a Run-tier wipe.
   * Single-writer, schema-validated full-replace (mirrors writeMap).
   */
  async writeBacklogSplit(split: PrismBacklogSplit): Promise<PrismBacklogSplit> {
    await ensureDir(committedWorkItemDir(this.repoRoot, split.work_item_id));
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
    const validated = questionRound.parse(round);
    await this.workItems.appendQuestionRoundLine(workItemId, JSON.stringify(validated));
    return validated;
  }

  async readValueRounds(workItemId: string): Promise<QuestionRound[]> {
    return this.workItems.readQuestionRounds(workItemId);
  }
}
