/**
 * CodeQL impact analyzer — ADR-0006: ImpactAnalyzer의 CodeQL 구현(언어 중립 엔진).
 *
 * TsImpactAnalyzer(typescript 컴파일러 API)를 대체한다. 한 exported 심볼의 영향집합을
 * CodeQL 관계 추출(relations.ts)로 뽑아 AnalyzerResult로 분류한다. 분류 의미는 기존
 * 바인딩과 동일하게 유지한다(wi_260604cqe 실증: 위치단위 동등 14/14·25/25):
 *   - 타입 위치 참조        → type_contract
 *   - import/값 참조(테스트 파일) → test
 *   - import/값 참조(그 외)  → direct_caller
 *   - 선언(exported)        → external_surface
 *
 * 정적으로 잡히지 않는 영향(dynamic dispatch·reflection·cross-repo)은 CodeQL도 보지
 * 못하며 select에 나타나지 않는다 — ts-analyzer와 동일하게 `unresolved`는 비운다(없는 것을
 * 지어내지 않음). CodeQL 실행 실패는 throw로 드러난다(빈 결과를 '깨끗함'으로 오판 금지).
 */
import { join } from 'node:path';
import {
  type RelationDeps,
  relationQueries,
  renderQuery,
  runRelationQuery,
} from '~/core/codeql/relations';
import type { BuildMode, CodeqlLanguage } from '~/core/codeql/runner';
import type { AnalyzerResult, ImpactAnalyzer } from './impact-graph';

/**
 * 테스트 파일 판정. JS/TS는 .test/.spec 접미사, Java는 src/test 경로 또는 *Test/*Tests/*IT.
 * 분류 의미(test vs direct_caller)는 ts-analyzer와 동일하게 유지.
 */
function isTestFile(path: string, language: CodeqlLanguage): boolean {
  if (language === 'java') {
    return path.includes('/test/') || /(Test|Tests|IT)\.java$/.test(path);
  }
  if (language === 'python') {
    return /(^|\/)(test_[^/]+|[^/]+_test)\.py$/.test(path) || path.includes('/tests/');
  }
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

export interface CodeqlImpactTarget {
  /** 변경된 exported 심볼 이름. */
  symbol: string;
  /** 심볼이 선언된 파일(repo 또는 source-root 상대). 선언을 이 파일로 제한해 동명이인을 배제한다. */
  declFile: string;
  /** 분석 언어(현재 javascript; ts/tsx 포함). */
  language: CodeqlLanguage;
  /** repo 루트(절대). */
  repoRoot: string;
  /** commit-sha + 언어로 키된 캐시 디렉터리(절대). DB·쿼리 작업물이 여기 산다. */
  cacheDir: string;
  /** build-mode 강제(컴파일 언어 buildless 등). 미지정이면 언어 기본. */
  buildMode?: BuildMode;
  /** manual build-mode 빌드 명령(컴파일 언어). */
  buildCommand?: string;
  /** codeql 실행 바이너리(기본 'codeql'). */
  binary?: string;
}

export class CodeqlImpactAnalyzer implements ImpactAnalyzer {
  constructor(
    private readonly target: CodeqlImpactTarget,
    private readonly deps: RelationDeps,
  ) {}

  async analyze(input: { changeTarget: string; sourceRoot: string }): Promise<AnalyzerResult> {
    const rows = await runRelationQuery(
      {
        repoRoot: this.target.repoRoot,
        sourceRoot: input.sourceRoot,
        language: this.target.language,
        dbPath: join(this.target.cacheDir, 'db'),
        workDir: join(this.target.cacheDir, `q-impact-${this.target.symbol}`),
        query: renderQuery(
          relationQueries(this.target.language).impact,
          this.target.symbol,
          this.target.declFile,
        ),
        ...(this.target.buildMode ? { buildMode: this.target.buildMode } : {}),
        ...(this.target.buildCommand ? { buildCommand: this.target.buildCommand } : {}),
        ...(this.target.binary ? { binary: this.target.binary } : {}),
      },
      this.deps,
    );

    const affected: AnalyzerResult['affected'] = [];
    for (const row of rows) {
      const [path, lineStr, raw] = row;
      if (!path || !raw) continue;
      const line = Number(lineStr);
      let kind: 'type_contract' | 'test' | 'direct_caller' | 'external_surface';
      if (raw === 'type') kind = 'type_contract';
      else if (raw === 'decl') kind = 'external_surface';
      else kind = isTestFile(path, this.target.language) ? 'test' : 'direct_caller'; // import | value
      affected.push({
        kind,
        path,
        symbol: this.target.symbol,
        reason:
          kind === 'external_surface'
            ? 'exported symbol — public surface (단계3 gate: exported must be surfaced)'
            : `references ${this.target.symbol} at line ${line}`,
      });
    }

    return { affected, unresolved: [] };
  }
}
