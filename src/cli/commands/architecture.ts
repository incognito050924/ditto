import { join } from 'node:path';
import { defineCommand } from 'citty';
import { buildCandidateSpec, observeArchitecture } from '~/acg/architecture/propose';
import { CodeqlEdgeAnalyzer } from '~/acg/boundary/codeql-edges';
import { codeqlCacheDir, makeRelationDeps } from '~/core/codeql/host-deps';
import { resolveRepoRootForCreate } from '~/core/fs';
import { USAGE_ERROR_EXIT, parseOutputFormat, writeError, writeHuman, writeJson } from '../util';

/**
 * `ditto architecture propose` — ADR-0004 Q3 agent candidate path.
 *
 * Emits a NON-AUTHORITATIVE candidate ArchitectureSpec (produced_by=agent) from
 * the observed import graph: layer NAMES + cross-layer public surfaces, and NO
 * forbidden_dependencies (rules are the human's to declare). Prints to stdout
 * for a human to review/ratify — it never overwrites an authoritative spec.
 */
export const architectureCommand = defineCommand({
  meta: {
    name: 'architecture',
    description: 'ACG ArchitectureSpec tools (agent candidate proposal)',
  },
  subCommands: {
    propose: defineCommand({
      meta: {
        name: 'propose',
        description:
          'Propose a NON-AUTHORITATIVE candidate ArchitectureSpec from the import graph (human ratifies)',
      },
      args: {
        'source-root': { type: 'string', description: 'Analysis source root (default <repo>/src)' },
        output: { type: 'string', description: 'Output format: human|json', default: 'json' },
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
        const repoRoot = await resolveRepoRootForCreate();
        const sourceRoot = args['source-root'] ?? join(repoRoot, 'src');
        const edgeAnalyzer = new CodeqlEdgeAnalyzer(
          { language: 'javascript', repoRoot, cacheDir: codeqlCacheDir(repoRoot, 'javascript') },
          makeRelationDeps(),
        );
        const obs = await observeArchitecture(repoRoot, sourceRoot, edgeAnalyzer);
        const candidate = buildCandidateSpec(obs, new Date().toISOString());
        if (format === 'json') {
          writeJson(candidate);
        } else {
          writeHuman(
            `candidate ArchitectureSpec (NON-AUTHORITATIVE, produced_by=agent): ${
              Object.keys(candidate.layers).length
            } layer(s), ${candidate.public_surfaces.length} public surface(s), 0 forbidden_dependencies (declare rules by hand).`,
          );
        }
      },
    }),
  },
});
