import { join } from 'node:path';
import { defineCommand } from 'citty';
import { type BoundaryViolation, checkBoundary } from '~/acg/boundary/boundary';
import { CodeqlEdgeAnalyzer } from '~/acg/boundary/codeql-edges';
import { AcgReviewStore } from '~/core/acg-review-store';
import { codeqlCacheDir, makeRelationDeps } from '~/core/codeql/host-deps';
import type { BuildMode, CodeqlLanguage } from '~/core/codeql/runner';
import { resolveRepoRootForCreate } from '~/core/fs';
import { acgArchitectureSpec } from '~/schemas/acg-architecture-spec';
import { acgReviewGraph } from '~/schemas/acg-review-graph';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/**
 * `ditto boundary check` — 단계6 boundary gate (DITTO/TS binding).
 *
 * Loads the ArchitectureSpec, extracts the changed files' dependency edges, and
 * flags Dependency-Rule violations. Each violation is projected as a HIGH-risk,
 * un-evidenced entry into `.ditto/work-items/<wi>/acg-review.json` so the EXISTING
 * Stop gate (`acgReviewForcesContinuation`) blocks completion — no new wiring; a
 * boundary violation is a high-risk change a human must resolve.
 */
function violationsToReviewGraph(violations: BoundaryViolation[]) {
  return acgReviewGraph.parse({
    kind: 'acg.review-graph.v1',
    files: violations.map((v) => ({
      path: v.from,
      role: 'service_logic',
      risk: 'high' as const,
      risk_reason: `boundary(${v.rule}): ${v.from} → ${v.to} — ${v.reason}`,
      unresolved: true,
    })),
    human_review_set: [...new Set(violations.map((v) => v.from))],
  });
}

export const boundaryCommand = defineCommand({
  meta: {
    name: 'boundary',
    description: 'ACG boundary gate — check a change against the ArchitectureSpec',
  },
  subCommands: {
    check: defineCommand({
      meta: {
        name: 'check',
        description: 'Flag Dependency-Rule violations in a change (단계6); blocks via acg-review',
      },
      args: {
        'work-item': { type: 'string', description: 'Work item id', required: true },
        spec: { type: 'string', description: 'Path to ArchitectureSpec JSON', required: true },
        file: {
          type: 'string',
          description: 'Changed file (repeatable; comma-separated)',
          required: true,
        },
        'no-ledger': {
          type: 'boolean',
          default: false,
          description: 'Report only; do not write acg-review.json',
        },
        language: {
          type: 'string',
          description: 'CodeQL language: javascript|java (default javascript)',
        },
        'source-root': { type: 'string', description: 'Analysis source root (default <repo>/src)' },
        'build-command': {
          type: 'string',
          description: 'Build command for manual build-mode (compiled langs; else buildless)',
        },
        output: { type: 'string', description: 'Output format: human|json', default: 'human' },
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
        try {
          const repoRoot = await resolveRepoRootForCreate();
          let spec: ReturnType<typeof acgArchitectureSpec.parse>;
          try {
            spec = acgArchitectureSpec.parse(JSON.parse(await Bun.file(args.spec).text()));
          } catch (err) {
            writeError(
              `boundary check: cannot read a valid ArchitectureSpec from ${args.spec}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            process.exit(USAGE_ERROR_EXIT);
            return;
          }
          const changedFiles = args.file
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          const language = (args.language ?? 'javascript') as CodeqlLanguage;
          const buildCommand = args['build-command'];
          const buildMode: BuildMode | undefined =
            !buildCommand && language === 'java' ? 'none' : undefined;
          const edgeAnalyzer = new CodeqlEdgeAnalyzer(
            {
              language,
              repoRoot,
              cacheDir: codeqlCacheDir(repoRoot, language),
              ...(buildMode ? { buildMode } : {}),
              ...(buildCommand ? { buildCommand } : {}),
            },
            makeRelationDeps(),
          );
          const edges = await edgeAnalyzer.edges({
            changedFiles,
            sourceRoot: args['source-root'] ?? join(repoRoot, 'src'),
          });
          const violations = checkBoundary(spec, edges);

          if (violations.length > 0 && !args['no-ledger']) {
            await new AcgReviewStore(repoRoot).write(
              args['work-item'],
              violationsToReviewGraph(violations),
            );
          }

          if (format === 'json') {
            writeJson({
              work_item_id: args['work-item'],
              edges: edges.length,
              violations: violations.map((v) => ({ rule: v.rule, from: v.from, to: v.to })),
              ledger_written: violations.length > 0 && !args['no-ledger'],
            });
          } else if (violations.length === 0) {
            writeHuman(`boundary: ok — ${edges.length} edge(s), 0 violation`);
          } else {
            for (const v of violations)
              writeHuman(`VIOLATION ${v.rule}: ${v.from} → ${v.to} (${v.reason})`);
          }
          if (violations.length > 0) process.exit(RUNTIME_ERROR_EXIT);
        } catch (err) {
          writeError(`boundary check failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(RUNTIME_ERROR_EXIT);
        }
      },
    }),
  },
});
