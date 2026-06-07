import { type AcgReviewGraph, acgReviewGraph } from '~/schemas/acg-review-graph';
import { localDir } from './ditto-paths';
import { readJson, writeJson } from './fs';

/**
 * Persists the ACG ReviewGraph ledger to `.ditto/local/work-items/<wi>/acg-review.json`
 * — the file the Stop gate reads (`acgReviewForcesContinuation`). Mirrors the
 * CompletionStore pattern: atomic, schema-validated writes via `writeJson`.
 *
 * The `acg.review-graph.v1` object rides reviewer-output and carries no own
 * `work_item_id` envelope (D3), so the work item id is passed explicitly to
 * locate the file rather than read off the graph.
 */
export class AcgReviewStore {
  constructor(public readonly repoRoot: string) {}

  private path(workItemId: string): string {
    return localDir(this.repoRoot, 'work-items', workItemId, 'acg-review.json');
  }

  async exists(workItemId: string): Promise<boolean> {
    return Bun.file(this.path(workItemId)).exists();
  }

  async get(workItemId: string): Promise<AcgReviewGraph> {
    return readJson(this.path(workItemId), acgReviewGraph);
  }

  async write(workItemId: string, graph: AcgReviewGraph): Promise<AcgReviewGraph> {
    return writeJson(this.path(workItemId), acgReviewGraph, graph);
  }
}
