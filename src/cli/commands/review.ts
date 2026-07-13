import { join } from 'node:path';
import { defineCommand } from 'citty';
import { aggregateUnitReview, planUnitReview } from '~/acg/review/unit-review';
import { type UnitScope, parseUnitScope, resolveUnitScope } from '~/acg/scope/unit-resolve';
import { AcgReviewStore } from '~/core/acg-review-store';
import { readArchitectureSpec, resolveRepoRootForCreate } from '~/core/fs';
import { acgArchitectureSpec } from '~/schemas/acg-architecture-spec';
import { type ReviewerOutput, reviewerOutput } from '~/schemas/reviewer-output';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/**
 * `ditto review --scope <unit>` — UNIT-scoped consistency/security
 * audit of STANDING code (baseline = HEAD), the WHOLE unit, NOT a work-item diff. The
 * unit-scoped SIBLING of `ditto acg-review` (work-item scoped). The user names an
 * architecture unit (`all | component:<name> | layer:<name> | api | <glob>`); it is
 * resolved to a standing-code file set via the SHARED resolver (`~/acg/scope/unit-resolve`,
 * also used by WU-4 `ditto refactor`), DECOMPOSED into review batches that BOTH the
 * `code-reviewer` and `security-reviewer` roles operate over (with progress + a guarantee
 * that 0 files are silently dropped — every dropped file is logged, PM-5), and the role
 * outputs are AGGREGATED into ONE unit `acg-review.json` ledger the Stop gate reads.
 *
 * REVIEWER-EXECUTION SEAM: a CLI cannot spawn the LLM reviewer/security-reviewer
 * subagents (those are autopilot-dispatched owners). This command is the DETERMINISTIC
 * seam: scope → batched plan (both roles) → aggregation → ledger. With `--from
 * <r1.json,r2.json>` (the role outputs) it aggregates + writes the single ledger; without
 * it, it emits the resolved file set + batched plan the roles will run over.
 */

/** Tracked standing files under `src/` at HEAD (git ls-files — deterministic). */
function trackedSrcFiles(repoRoot: string): string[] {
  const r = Bun.spawnSync(['git', 'ls-files', '--', 'src'], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (r.exitCode !== 0) {
    throw new Error(`git ls-files failed: ${r.stderr?.toString().trim() ?? ''}`);
  }
  return r.stdout
    .toString()
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /\.[cm]?tsx?$/.test(s) && !/\.(test|spec)\./.test(s));
}

/** Load the repo's ArchitectureSpec if present (layer:<name> needs it); else undefined. */
async function loadArchSpec(repoRoot: string) {
  const specPath = join(repoRoot, '.ditto', 'architecture-spec.json');
  try {
    return await readArchitectureSpec(specPath, acgArchitectureSpec);
  } catch {
    return undefined; // layer:<name> resolves to nothing (conservative); other units unaffected.
  }
}

/** Read + validate one reviewer-output role file (fail-closed on any error). */
async function readReviewerOutput(path: string): Promise<ReviewerOutput> {
  const raw = await Bun.file(path).text();
  return reviewerOutput.parse(JSON.parse(raw));
}

/** Parse a positive integer CLI arg, or undefined when absent/blank. */
function parseIntArg(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`expected a positive integer, got "${raw}"`);
  return n;
}

export const reviewCommand = defineCommand({
  meta: {
    name: 'review',
    description:
      'Unit-scoped consistency/security audit of standing code (baseline=HEAD) — `--scope all|component:<name>|layer:<name>|api|<glob>`',
  },
  args: {
    scope: {
      type: 'string',
      description: 'Architecture unit: all | component:<name> | layer:<name> | api | <glob>',
      required: true,
    },
    from: {
      type: 'string',
      description:
        'Comma-separated reviewer-output JSON paths (code-reviewer, security-reviewer) to aggregate into one unit acg-review.json ledger',
      required: false,
    },
    'work-item': {
      type: 'string',
      description: 'Work item id to write the unit ledger under (required with --from)',
      required: false,
    },
    'batch-size': { type: 'string', description: 'Files per review batch (default 25)' },
    'file-limit': {
      type: 'string',
      description: 'Hard cap on reviewed files (overflow dropped + logged, never silent — PM-5)',
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    let unit: UnitScope;
    let batchSize: number | undefined;
    let fileLimit: number | undefined;
    try {
      format = parseOutputFormat(args.output);
      unit = parseUnitScope(args.scope);
      batchSize = parseIntArg(args['batch-size']);
      fileLimit = parseIntArg(args['file-limit']);
    } catch (err) {
      writeError(`review: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }

    try {
      const repoRoot = await resolveRepoRootForCreate();
      const files = trackedSrcFiles(repoRoot);
      const archSpec = await loadArchSpec(repoRoot);
      // SHARED WU-4 resolver — the unit means the SAME thing for review and refactor.
      const resolved = resolveUnitScope(unit, files, archSpec);
      const plan = planUnitReview(resolved, { batchSize, fileLimit });

      // Ledger mode: aggregate the role outputs into ONE unit acg-review.json the Stop
      // gate reads. Fail-closed — a missing/invalid role output writes nothing.
      let ledgerWritten = false;
      let highRiskUnevidenced = 0;
      if (typeof args.from === 'string' && args.from.trim().length > 0) {
        const workItemId = args['work-item'];
        if (workItemId === undefined || workItemId.trim().length === 0) {
          writeError('review: --from requires --work-item to locate the unit ledger');
          process.exit(USAGE_ERROR_EXIT);
          return;
        }
        const paths = args.from
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p.length > 0);
        const outputs: ReviewerOutput[] = [];
        for (const p of paths) outputs.push(await readReviewerOutput(p));
        const graph = aggregateUnitReview(outputs);
        await new AcgReviewStore(repoRoot).write(workItemId, graph);
        ledgerWritten = true;
        highRiskUnevidenced = graph.files.filter(
          (f) => f.risk === 'high' && f.evidence === undefined,
        ).length;
      }

      if (format === 'json') {
        writeJson({
          unit: args.scope,
          files: resolved,
          roles: plan.roles,
          batches: plan.batches,
          progress: plan.progress,
          resolvedCount: plan.resolvedCount,
          reviewedCount: plan.reviewedCount,
          dropped: plan.dropped,
          ledgerWritten,
          highRiskWithoutEvidence: highRiskUnevidenced,
        });
      } else {
        writeHuman(
          `review ${args.scope}: ${plan.resolvedCount} file(s), ${plan.batches.length} batch(es) [${plan.progress}], roles=${plan.roles.join('+')}`,
        );
        for (const d of plan.dropped) writeHuman(`  dropped (over --file-limit, logged): ${d}`);
        if (ledgerWritten) {
          writeHuman(`  wrote acg-review.json: ${highRiskUnevidenced} high-risk without evidence`);
        }
      }
    } catch (err) {
      writeError(`review failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});
