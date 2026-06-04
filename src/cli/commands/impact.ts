import { join } from 'node:path';
import { defineCommand } from 'citty';
import { CodeqlImpactAnalyzer } from '~/acg/impact/codeql-analyzer';
import { produceImpactGraph } from '~/acg/impact/impact-graph';
import { codeqlCacheDir, makeRelationDeps } from '~/core/codeql/host-deps';
import { ensureDir, resolveRepoRootForCreate, writeJson as writeJsonFile } from '~/core/fs';
import type { AcgImpactGraph } from '~/schemas/acg-impact-graph';
import { acgImpactGraph } from '~/schemas/acg-impact-graph';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/**
 * `ditto impact` — 단계3 ImpactGraph producer (DITTO/TS binding).
 *
 * Resolves the changed symbol through the TypeScript checker (not text search),
 * classifies affected nodes, applies the default-deny journey invariant, and
 * writes `.ditto/work-items/<wi>/impact-graph.json`. The caller-graph analyzer
 * is the TS binding's; other-language impact is left `unresolved` (never hidden).
 */
export const impactCommand = defineCommand({
  meta: {
    name: 'impact',
    description: 'Produce an ImpactGraph for a changed TS symbol (단계3, symbol resolution)',
  },
  args: {
    'work-item': { type: 'string', description: 'Work item id', required: true },
    file: { type: 'string', description: 'File declaring the changed symbol', required: true },
    symbol: { type: 'string', description: 'Changed exported symbol name', required: true },
    'change-type': {
      type: 'string',
      description: 'rename|signature|behavior|delete|add|move (default signature)',
    },
    'source-root': { type: 'string', description: 'Analysis source root (default <repo>/src)' },
    'user-exposed': {
      type: 'boolean',
      default: false,
      description: 'Diff touches a user-facing surface (triggers default-deny journey check)',
    },
    'journey-id': { type: 'string', description: 'JourneySpec.id when the surface is mapped' },
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
    const changeType = (args['change-type'] ?? 'signature') as AcgImpactGraph['change_type'];
    try {
      const repoRoot = await resolveRepoRootForCreate();
      const sourceRoot = args['source-root'] ?? join(repoRoot, 'src');
      const analyzer = new CodeqlImpactAnalyzer(
        {
          symbol: args.symbol,
          declFile: args.file,
          language: 'javascript',
          repoRoot,
          cacheDir: codeqlCacheDir(repoRoot, 'javascript'),
        },
        makeRelationDeps(),
      );
      const graph = await produceImpactGraph(
        {
          workItemId: args['work-item'],
          changeTarget: `${args.file}: ${args.symbol} (${changeType})`,
          changeType,
          producedAt: new Date().toISOString(),
          userExposed: args['user-exposed'],
          journeyId: args['journey-id'],
        },
        analyzer,
        sourceRoot,
      );
      const path = join(repoRoot, '.ditto', 'work-items', args['work-item'], 'impact-graph.json');
      await ensureDir(join(repoRoot, '.ditto', 'work-items', args['work-item']));
      await writeJsonFile(path, acgImpactGraph, graph);

      if (format === 'json') {
        writeJson({
          work_item_id: args['work-item'],
          affected: graph.affected_nodes.length,
          unresolved: graph.unresolved.length,
          journey_unknown: graph.unresolved.filter((u) => u.kind === 'journey_unknown').length,
        });
      } else {
        writeHuman(
          `impact: ${graph.affected_nodes.length} affected, ${graph.unresolved.length} unresolved → impact-graph.json`,
        );
      }
    } catch (err) {
      writeError(`impact failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});
