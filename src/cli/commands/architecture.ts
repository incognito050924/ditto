import { join } from 'node:path';
import { defineCommand } from 'citty';
import { buildCandidateSpec, observeArchitecture } from '~/acg/architecture/propose';
import { CodeqlEdgeAnalyzer } from '~/acg/boundary/codeql-edges';
import { withInternalPackages } from '~/acg/internal-packages';
import { codeqlCacheDir, makeRelationDeps } from '~/core/codeql/host-deps';
import {
  ensureDir,
  readArchitectureSpec,
  resolveRepoRootForCreate,
  writeJson as writeJsonFile,
} from '~/core/fs';
import { type AcgInternalPackage, acgArchitectureSpec } from '~/schemas/acg-architecture-spec';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/** csv(쉼표 구분) → 트림·빈값 제거된 토큰 배열. */
function csv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

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
        write: {
          type: 'boolean',
          default: false,
          description:
            'Also save to .ditto/architecture-spec.json (forbidden_scope layer/surface 집행 입력)',
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
        const repoRoot = await resolveRepoRootForCreate();
        const sourceRoot = args['source-root'] ?? join(repoRoot, 'src');
        const edgeAnalyzer = new CodeqlEdgeAnalyzer(
          { language: 'javascript', repoRoot, cacheDir: codeqlCacheDir(repoRoot, 'javascript') },
          makeRelationDeps(),
        );
        const obs = await observeArchitecture(repoRoot, sourceRoot, edgeAnalyzer);
        const candidate = buildCandidateSpec(obs, new Date().toISOString());
        if (args.write) {
          await ensureDir(join(repoRoot, '.ditto'));
          await writeJsonFile(
            join(repoRoot, '.ditto', 'architecture-spec.json'),
            acgArchitectureSpec,
            candidate,
          );
        }
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
    'internal-packages': defineCommand({
      meta: {
        name: 'internal-packages',
        description:
          'Declare internal sibling-module descriptors on the ArchitectureSpec (drives cross_repo recording + the JVM guard)',
      },
      args: {
        glob: {
          type: 'string',
          description:
            'Package-name glob(s), comma-separated (e.g. "kr.co.ecoletree.boxwood.domain.**") — classified as cross_repo',
        },
        path: {
          type: 'string',
          description:
            'Local sibling-artifact glob(s), comma-separated (e.g. "libs/*.jar"), source-root-relative — covers the JVM guard',
        },
        spec: {
          type: 'string',
          description: 'ArchitectureSpec path (default .ditto/architecture-spec.json)',
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
        const entries: AcgInternalPackage[] = [
          ...csv(args.glob).map((value) => ({ type: 'glob' as const, value })),
          ...csv(args.path).map((value) => ({ type: 'path' as const, value })),
        ];
        if (entries.length === 0) {
          writeError('internal-packages: provide at least one --glob or --path value');
          process.exit(USAGE_ERROR_EXIT);
          return;
        }
        try {
          const repoRoot = await resolveRepoRootForCreate();
          const specPath = args.spec ?? join(repoRoot, '.ditto', 'architecture-spec.json');
          // 기존 스펙이 있으면 보존하며 internal_packages만 교체, 없으면 최소 스펙 생성.
          let existing: ReturnType<typeof acgArchitectureSpec.parse> | undefined;
          try {
            existing = await readArchitectureSpec(specPath, acgArchitectureSpec);
          } catch {
            existing = undefined;
          }
          const next = withInternalPackages(existing, entries, new Date().toISOString());
          await ensureDir(join(repoRoot, '.ditto'));
          await writeJsonFile(specPath, acgArchitectureSpec, next);
          if (format === 'json') {
            writeJson({ spec: specPath, internal_packages: next.internal_packages });
          } else {
            const g = entries.filter((e) => e.type === 'glob').length;
            const p = entries.filter((e) => e.type === 'path').length;
            writeHuman(
              `internal_packages declared: ${g} glob, ${p} path → ${specPath}${
                existing ? '' : ' (new spec)'
              }`,
            );
          }
        } catch (err) {
          writeError(
            `internal-packages failed: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exit(RUNTIME_ERROR_EXIT);
        }
      },
    }),
  },
});
