import { join } from 'node:path';
import { defineCommand } from 'citty';
import { CodeqlImpactAnalyzer } from '~/acg/impact/codeql-analyzer';
import { produceImpactGraph } from '~/acg/impact/impact-graph';
import { loadInternalPackages, runInternalPackagesGuard } from '~/acg/internal-packages';
import { codeqlCacheDir, makeRelationDeps } from '~/core/codeql/host-deps';
import type { BuildMode, CodeqlLanguage } from '~/core/codeql/runner';
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
    language: {
      type: 'string',
      description:
        'CodeQL language: javascript|java|kotlin|python (default javascript). kotlin needs --build-command (Gradle) or autobuild.',
    },
    'build-command': {
      type: 'string',
      description: 'Build command for manual build-mode (compiled langs; else buildless)',
    },
    'user-exposed': {
      type: 'boolean',
      default: false,
      description: 'Diff touches a user-facing surface (triggers default-deny journey check)',
    },
    'journey-id': { type: 'string', description: 'JourneySpec.id when the surface is mapped' },
    spec: {
      type: 'string',
      description:
        'ArchitectureSpec (.yaml/.yml/.json) — its internal_packages drive cross_repo unresolved recording for sibling-module deps absent from a single-module DB',
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
    const changeType = (args['change-type'] ?? 'signature') as AcgImpactGraph['change_type'];
    try {
      const repoRoot = await resolveRepoRootForCreate();
      const sourceRoot = args['source-root'] ?? join(repoRoot, 'src');
      const language = (args.language ?? 'javascript') as CodeqlLanguage;
      const buildCommand = args['build-command'];
      // 관계추출은 컴파일 언어도 buildless(none)로 충분(probe 실증). 빌드명령이 주어지면
      // manual(selectBuildMode가 처리)로 두고, 아니면 Java는 none을 강제한다.
      const buildMode: BuildMode | undefined =
        !buildCommand && language === 'java' ? 'none' : undefined;
      // ArchitectureSpec.internal_packages를 형제모듈(cross_repo) 식별 신호로 쓴다. --spec이
      // 있으면 그 경로, 없으면 기본 .ditto/architecture-spec.json을 optional 로드(부재면 빈 목록
      // → cross_repo 수집/가드 비활성, 기존 동작 보존).
      const internalPackages = await loadInternalPackages(repoRoot, args.spec);

      // JVM 가드: 로컬 JAR이 있는데 선언에 누락이 있으면 차단(형제모듈 impact 침묵 손실 방지),
      // 그 외 미선언은 경고 후 진행.
      const guard = await runInternalPackagesGuard({
        language,
        entries: internalPackages,
        sourceRoot,
      });
      if (guard.decision === 'block') {
        writeError(`internal_packages guard: ${guard.reason}`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      if (guard.decision === 'warn') {
        writeError(`internal_packages guard (warning): ${guard.reason}`);
      }
      const analyzer = new CodeqlImpactAnalyzer(
        {
          symbol: args.symbol,
          declFile: args.file,
          language,
          repoRoot,
          cacheDir: codeqlCacheDir(repoRoot, language),
          internalPackages,
          ...(buildMode ? { buildMode } : {}),
          ...(buildCommand ? { buildCommand } : {}),
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
          cross_repo: graph.unresolved.filter((u) => u.kind === 'cross_repo').length,
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
