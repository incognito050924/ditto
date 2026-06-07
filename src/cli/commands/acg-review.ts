import { defineCommand } from 'citty';
import { projectReviewerOutputToAcgReview } from '~/acg/review/acg-review-adapter';
import { AcgReviewStore } from '~/core/acg-review-store';
import { resolveRepoRootForCreate } from '~/core/fs';
import { reviewerOutput } from '~/schemas/reviewer-output';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/**
 * `ditto acg-review --from <reviewer-output.json>` — the ReviewGraph producer.
 *
 * Reads a reviewer-output JSON, projects it to the `acg_review` ledger with the
 * existing DETERMINISTIC adapter (severity→risk is code, never an LLM's hand
 * calculation), and persists it to `.ditto/local/work-items/<wi>/acg-review.json` so
 * the Stop gate can block completion on un-evidenced high-risk changes.
 *
 * Fail-closed: a missing/invalid reviewer-output exits non-zero and writes
 * nothing, so a broken input can never silently produce an empty (passing)
 * ledger.
 */
export const acgReviewCommand = defineCommand({
  meta: {
    name: 'acg-review',
    description:
      'Project a reviewer-output into the acg_review ledger (.ditto/local/work-items/<wi>/acg-review.json)',
  },
  args: {
    from: {
      type: 'string',
      description: 'Path to the reviewer-output JSON to project',
      required: true,
    },
    'work-item': {
      type: 'string',
      description:
        'Work item id to write the ledger under; defaults to reviewer-output.work_item_id',
      required: false,
    },
    output: {
      type: 'string',
      description: 'Output format: human|json',
      default: 'human',
    },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }

    // Read + validate the reviewer-output. Any failure (missing file, bad JSON,
    // schema violation) is a usage error → exit non-zero, write nothing.
    let parsedOutput: ReturnType<typeof reviewerOutput.parse>;
    try {
      const raw = await Bun.file(args.from).text();
      parsedOutput = reviewerOutput.parse(JSON.parse(raw));
    } catch (err) {
      writeError(
        `acg-review: cannot read a valid reviewer-output from ${args.from}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }

    const workItemId = args['work-item'] ?? parsedOutput.work_item_id;

    try {
      const graph = projectReviewerOutputToAcgReview(parsedOutput);
      const store = new AcgReviewStore(await resolveRepoRootForCreate());
      await store.write(workItemId, graph);
      const highRiskUnevidenced = graph.files.filter(
        (f) => f.risk === 'high' && f.evidence === undefined,
      ).length;
      if (format === 'json') {
        writeJson({
          work_item_id: workItemId,
          files: graph.files.length,
          human_review_set: graph.human_review_set.length,
          high_risk_without_evidence: highRiskUnevidenced,
        });
      } else {
        writeHuman(
          `wrote acg-review.json for ${workItemId}: ${graph.files.length} file(s), ${highRiskUnevidenced} high-risk without evidence`,
        );
      }
    } catch (err) {
      writeError(
        `acg-review: failed to write ledger: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});
