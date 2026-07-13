import { join } from 'node:path';
import { defineCommand } from 'citty';
import { buildCandidateSpec, observeArchitecture } from '~/acg/architecture/propose';
import { type ForbiddenDependency, ratifyCandidateSpec } from '~/acg/architecture/ratify';
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

/** citty 반복 string arg는 undefined|string|string[] — 항상 배열로 정규화. */
function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * `--forbid "from,to,reason"` 토큰을 파싱한다. 세 필드 모두 필수(쉼표 3칸).
 * reason에 쉼표가 들어갈 수 있어 앞 2개만 분리하고 나머지를 reason으로 합친다.
 */
function parseForbidden(tokens: string[]): ForbiddenDependency[] {
  return tokens.map((t) => {
    const parts = t.split(',').map((s) => s.trim());
    const [from, to, ...rest] = parts;
    const reason = rest.join(',').trim();
    if (!from || !to || !reason) {
      throw new Error(`--forbid: expected "from,to,reason", got "${t}"`);
    }
    return { from, to, reason };
  });
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
          format = parseOutputFormat(String(args.output));
        } catch (err) {
          writeError(err instanceof Error ? err.message : String(err));
          process.exit(USAGE_ERROR_EXIT);
          return;
        }
        const repoRoot = await resolveRepoRootForCreate();
        const sourceRoot = (args['source-root'] as string | undefined) ?? join(repoRoot, 'src');
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
    ratify: defineCommand({
      meta: {
        name: 'ratify',
        description:
          'Promote a candidate ArchitectureSpec (produced_by=agent) to authoritative (produced_by=user); forbidden_dependencies come ONLY from --forbid',
      },
      args: {
        spec: {
          type: 'string',
          description: 'Candidate spec path (default .ditto/architecture-spec.json)',
        },
        forbid: {
          type: 'string',
          description:
            'Forbidden dependency "from,to,reason" (repeatable). Rules are the human\'s — never auto-derived from observation.',
        },
        output: { type: 'string', description: 'Output format: human|json', default: 'human' },
      },
      run: async ({ args }) => {
        let format: ReturnType<typeof parseOutputFormat>;
        try {
          format = parseOutputFormat(String(args.output));
        } catch (err) {
          writeError(err instanceof Error ? err.message : String(err));
          process.exit(USAGE_ERROR_EXIT);
          return;
        }
        let forbidden: ForbiddenDependency[];
        try {
          forbidden = parseForbidden(asArray(args.forbid as string | string[] | undefined));
        } catch (err) {
          writeError(err instanceof Error ? err.message : String(err));
          process.exit(USAGE_ERROR_EXIT);
          return;
        }
        try {
          const repoRoot = await resolveRepoRootForCreate();
          const specPath =
            (args.spec as string | undefined) ?? join(repoRoot, '.ditto', 'architecture-spec.json');
          let candidate: ReturnType<typeof acgArchitectureSpec.parse>;
          try {
            candidate = await readArchitectureSpec(specPath, acgArchitectureSpec);
          } catch {
            writeError(
              `ratify: no candidate spec at ${specPath} — run \`ditto architecture propose --write\` first`,
            );
            process.exit(USAGE_ERROR_EXIT);
            return;
          }
          let ratified: ReturnType<typeof acgArchitectureSpec.parse>;
          try {
            ratified = ratifyCandidateSpec(candidate, {
              forbidden,
              ratifiedAt: new Date().toISOString(),
            });
          } catch (err) {
            writeError(err instanceof Error ? err.message : String(err));
            process.exit(USAGE_ERROR_EXIT);
            return;
          }
          await writeJsonFile(specPath, acgArchitectureSpec, ratified);
          if (format === 'json') {
            writeJson(ratified);
          } else {
            writeHuman(
              `ratified ArchitectureSpec (AUTHORITATIVE, produced_by=user): ${
                Object.keys(ratified.layers).length
              } layer(s), ${ratified.public_surfaces.length} public surface(s), ${
                ratified.forbidden_dependencies.length
              } forbidden_dependencies → ${specPath}`,
            );
          }
        } catch (err) {
          writeError(`ratify failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exit(RUNTIME_ERROR_EXIT);
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
          format = parseOutputFormat(String(args.output));
        } catch (err) {
          writeError(err instanceof Error ? err.message : String(err));
          process.exit(USAGE_ERROR_EXIT);
          return;
        }
        const entries: AcgInternalPackage[] = [
          ...csv(args.glob as string | undefined).map((value) => ({
            type: 'glob' as const,
            value,
          })),
          ...csv(args.path as string | undefined).map((value) => ({
            type: 'path' as const,
            value,
          })),
        ];
        if (entries.length === 0) {
          writeError('internal-packages: provide at least one --glob or --path value');
          process.exit(USAGE_ERROR_EXIT);
          return;
        }
        try {
          const repoRoot = await resolveRepoRootForCreate();
          const specPath =
            (args.spec as string | undefined) ?? join(repoRoot, '.ditto', 'architecture-spec.json');
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
