/**
 * CodeQL 관계 추출 — ADR-0006 D3: 정적 사실(call graph·type 참조·import edge)을
 * SARIF alert이 아니라 BQRS "사실 추출" 경로로 뽑는다.
 *
 * runner.ts(SARIF analyze 경로)와 별개의 실행부다:
 *   database create(없으면) → query run(custom .ql) → bqrs decode --format=csv → rows.
 * 순수부(인자 구성·CSV 파싱·쿼리 템플릿 치환)는 CodeQL CLI 없이 단위 테스트로 검증되고,
 * 실행부는 deps 주입이라 mock spawn으로 검증한다. 실제 동등성은 opt-in e2e(CODEQL_E2E)로 닫는다.
 *
 * 쿼리는 wi_260604cqe 실증에서 ts-analyzer/ts-edges와 위치단위 동등(14/14·25/25·diff 0)이
 * 확인된 것을 상수로 들고 온다(번들 경로 문제 회피 — dist에 .ql을 싣지 않는다).
 */
import { dirname, join } from 'node:path';
import { type CodeqlDeps, type CodeqlLanguage, buildCreateArgs, selectBuildMode } from './runner';

/** symbol 식별자 화이트리스트(쿼리 주입 방지). JS/TS 식별자 문법만 허용. */
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * 쿼리 템플릿의 `{{SYMBOL}}`·`{{FILE}}`을 치환한다(순수). symbol은 식별자 화이트리스트로
 * 주입을 막고, file은 경로라 따옴표만 제거한다(suffix 매칭에 쓰임).
 */
export function renderQuery(template: string, symbol: string, file?: string): string {
  if (!IDENTIFIER.test(symbol)) {
    throw new Error(`unsafe symbol for CodeQL query: ${JSON.stringify(symbol)}`);
  }
  let q = template.replaceAll('{{SYMBOL}}', symbol);
  if (file !== undefined) q = q.replaceAll('{{FILE}}', file.replaceAll('"', ''));
  return q;
}

/**
 * Impact(영향) 쿼리 — 한 exported 심볼의 모든 참조를 (path, line, raw_kind)로.
 * 이름이 아니라 **선언 동일성**으로 해소한다(ts-analyzer의 "symbol resolution, not text
 * search"와 동치): 선언은 target 파일로 제한하고, 값 참조는 `getResolvedCallee()`로 실제
 * 그 선언으로 해소되는 호출만 잡는다 → 동명이인(decoy)을 배제한다.
 *   value  = 호출 참조(resolved callee가 target 선언)
 *   import = target 심볼 import specifier
 *   type   = 타입 위치 참조(LocalTypeAccess)
 *   decl   = 선언 위치(function/class/interface, target 파일) → external_surface로 매핑
 * 분류(test 파일 판정·external_surface)는 소비처(CodeqlImpactAnalyzer)가 한다.
 */
export const IMPACT_QUERY_JS = `/**
 * @name ditto impact
 * @id ditto/impact-relations
 * @kind table
 */
import javascript

predicate inTargetFile(File f) {
  f.getRelativePath() = "{{FILE}}" or f.getRelativePath().matches("%/{{FILE}}")
}

from string p, int ln, string k
where
  (exists(InvokeExpr ie, Function f |
     f.getName() = "{{SYMBOL}}" and inTargetFile(f.getFile()) and ie.getResolvedCallee() = f
     and p = ie.getFile().getRelativePath() and ln = ie.getLocation().getStartLine()) and k = "value")
  or (exists(ImportSpecifier s | s.getImportedName() = "{{SYMBOL}}" and p = s.getFile().getRelativePath() and ln = s.getLocation().getStartLine()) and k = "import")
  or (exists(LocalTypeAccess t | t.getName() = "{{SYMBOL}}" and p = t.getFile().getRelativePath() and ln = t.getLocation().getStartLine()) and k = "type")
  or (k = "decl" and (
      exists(Function d | d.getName() = "{{SYMBOL}}" and inTargetFile(d.getFile()) and p = d.getFile().getRelativePath() and ln = d.getLocation().getStartLine())
      or exists(ClassDefinition d | d.getName() = "{{SYMBOL}}" and inTargetFile(d.getFile()) and p = d.getFile().getRelativePath() and ln = d.getLocation().getStartLine())
      or exists(InterfaceDefinition d | d.getName() = "{{SYMBOL}}" and inTargetFile(d.getFile()) and p = d.getFile().getRelativePath() and ln = d.getLocation().getStartLine())
  ))
select p, ln, k
`;

/**
 * Boundary(경계) 쿼리 — import edge를 (from, to)로. tsconfig path alias는
 * CodeQL extractor가 이미 해소하므로 `getImportedModule()`이 repo-relative 경로를 준다
 * (실증: `~/schemas/common` → `src/schemas/common.ts`). 해소 실패(외부 패키지)는
 * raw specifier를 verbatim으로(글로브 매칭 유지). `{{FILE_FILTER}}`로 변경 파일 한정.
 */
export const EDGE_QUERY_JS = `/**
 * @name ditto edges
 * @id ditto/edge-relations
 * @kind table
 */
import javascript
from Import imp, string fromPath, string target
where fromPath = imp.getFile().getRelativePath()
  and ({{FILE_FILTER}})
  and (
    target = imp.getImportedModule().getFile().getRelativePath()
    or (not exists(imp.getImportedModule()) and target = imp.getImportedPath().getValue())
  )
select fromPath, target
`;

/**
 * edge 템플릿의 `{{FILE_FILTER}}`을 구성한다(순수). 빈 목록 ⇒ 전체(any).
 * 필터는 `fromPath = "..."` 형식으로 모든 언어 edge 템플릿이 공유한다.
 */
export function renderEdgeQuery(
  changedFiles: string[],
  language: CodeqlLanguage = 'javascript',
): string {
  const files = changedFiles.map((f) => f.trim()).filter((f) => f.length > 0);
  const filter =
    files.length === 0
      ? 'any()'
      : files.map((f) => `fromPath = "${f.replaceAll('"', '')}"`).join(' or ');
  return relationQueries(language).edge.replaceAll('{{FILE_FILTER}}', filter);
}

/**
 * Symbol 선언 위치 쿼리 — 이름이 SYMBOL인 선언(function/class/interface)이 든 파일 경로.
 * impact 쿼리와 달리 declFile 제한이 없다: forbidden_scope의 symbol은 선언 파일을 모르고
 * "그 이름의 선언을 건드리지 마라"는 의미라, 이름으로 선언 파일을 찾아 path로 편다.
 * 동명이인은 모두 반환한다(forbidden = 보호이므로 과보호가 안전).
 */
export const SYMBOL_DECL_QUERY_JS = `/**
 * @name ditto symbol decl
 * @id ditto/symbol-decl
 * @kind table
 */
import javascript
from string p
where
  exists(Function d | d.getName() = "{{SYMBOL}}" and p = d.getFile().getRelativePath())
  or exists(ClassDefinition d | d.getName() = "{{SYMBOL}}" and p = d.getFile().getRelativePath())
  or exists(InterfaceDefinition d | d.getName() = "{{SYMBOL}}" and p = d.getFile().getRelativePath())
select p
`;

/**
 * 한 언어 바인딩의 관계쿼리 3종. 결과 형식(impact: p,ln,k / edge: from,to /
 * symbol-decl: p)은 언어 무관이고, 쿼리 본문만 언어별로 다르다 — "바인딩이 분석기를
 * 꽂는다"(10-methodology §6)의 실현체. 새 언어 바인딩은 여기 한 항목만 추가한다.
 */
export interface RelationQueryTemplates {
  /** `{{SYMBOL}}`·`{{FILE}}` 치환. impact 영향집합(value/type/decl). */
  impact: string;
  /** `{{FILE_FILTER}}` 치환. cross-file import/type 의존 edge. */
  edge: string;
  /** `{{SYMBOL}}` 치환. 이름으로 선언 파일을 찾는다(forbidden_scope symbol kind). */
  symbolDecl: string;
}

/** 언어 → 관계쿼리 템플릿. 미등록 언어는 바인딩 미구현(throw로 드러냄). */
export const RELATION_QUERIES: Partial<Record<CodeqlLanguage, RelationQueryTemplates>> = {
  javascript: { impact: IMPACT_QUERY_JS, edge: EDGE_QUERY_JS, symbolDecl: SYMBOL_DECL_QUERY_JS },
};

/** 언어 바인딩 템플릿을 가져온다. 미등록이면 명시적 에러(빈 결과로 오판 금지). */
export function relationQueries(language: CodeqlLanguage): RelationQueryTemplates {
  const q = RELATION_QUERIES[language];
  if (!q) {
    const supported = Object.keys(RELATION_QUERIES).join(', ');
    throw new Error(
      `CodeQL relation queries not bound for language '${language}' (supported: ${supported})`,
    );
  }
  return q;
}

/** 언어별 표준 라이브러리 팩(번들 내장; pack install은 no-op). */
function qlpackYml(language: CodeqlLanguage): string {
  return `name: ditto/acg-relations\nversion: 0.0.1\ndependencies:\n  codeql/${language}-all: "*"\n`;
}

/** `codeql query run ...` 인자(순수). */
export function buildQueryRunArgs(input: {
  dbPath: string;
  queryPath: string;
  bqrsOut: string;
}): string[] {
  return [
    'query',
    'run',
    `--database=${input.dbPath}`,
    `--output=${input.bqrsOut}`,
    input.queryPath,
  ];
}

/**
 * `codeql bqrs decode --format=csv ...` 인자(순수).
 * 결과를 stdout이 아니라 `--output` 파일로 받는다 — 파이프로 결과를 전달하지 않으므로
 * stdout 파이프가 가득 차 교착할 여지를 없앤다(파이프는 로그 전용이 되어 비우기만 하면 됨).
 */
export function buildBqrsDecodeArgs(bqrsPath: string, csvOut: string): string[] {
  return ['bqrs', 'decode', '--format=csv', `--output=${csvOut}`, bqrsPath];
}

/** CodeQL CSV 한 줄을 필드로 파싱(따옴표·이스케이프 처리, 순수). */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else inQ = !inQ;
    } else if (c === ',' && !inQ) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** CSV 본문(헤더 1줄 + 데이터)을 행 배열로(순수). 헤더만/빈 ⇒ []. */
export function parseCsvRows(csv: string): string[][] {
  const lines = csv.split('\n').filter((l) => l.length > 0);
  if (lines.length <= 1) return [];
  return lines.slice(1).map(parseCsvLine);
}

/** relations 실행에 필요한 의존(runner deps + 쿼리 파일 IO). */
export interface RelationDeps extends CodeqlDeps {
  writeText: (path: string, content: string) => Promise<void>;
  ensureDir: (path: string) => Promise<void>;
  dirExists: (path: string) => Promise<boolean>;
}

export interface RunRelationInput {
  repoRoot: string;
  sourceRoot: string;
  language: CodeqlLanguage;
  /** DB 캐시 디렉터리(예: .ditto/cache/codeql/<sha>-<lang>). 존재하면 create 생략. */
  dbPath: string;
  /** 쿼리·BQRS를 둘 작업 디렉터리(임시·gitignored). */
  workDir: string;
  /** 렌더 완료된 쿼리 소스(symbol/filter 치환 끝난 상태). */
  query: string;
  buildCommand?: string;
  binary?: string;
}

const CODEQL_BINARY = 'codeql';

/**
 * 관계 쿼리를 실행해 CSV 행을 돌려준다(실행부).
 *   DB(캐시 미스 시 create) → qlpack/ql 작성 → query run → bqrs decode → parse.
 * spawn 실패는 throw(빈 결과를 '깨끗함'으로 오판하지 않음 — fail-loud).
 */
export async function runRelationQuery(
  input: RunRelationInput,
  deps: RelationDeps,
): Promise<string[][]> {
  const binary = input.binary ?? CODEQL_BINARY;
  const env = { set: {}, unset: ['LGTM_INDEX_FILTERS'] };

  // 1. DB — commit-sha 캐시 디렉터리가 없으면 생성. create는 부모 디렉터리가 선재해야 한다.
  if (!(await deps.dirExists(input.dbPath))) {
    await deps.ensureDir(dirname(input.dbPath));
    const buildMode = selectBuildMode(input.language, input.buildCommand);
    const create = deps.spawn({
      binary,
      args: buildCreateArgs({
        dbPath: input.dbPath,
        language: input.language,
        sourceRoot: input.sourceRoot,
        buildMode,
        ...(input.buildCommand ? { buildCommand: input.buildCommand } : {}),
      }),
      repoRoot: input.repoRoot,
      cwd: '.',
      env,
    });
    // stderr·stdout을 동시에 비운다. database create는 stdout에 추출 로그를 대량으로
    // 쏟으므로 순차로 읽으면 stdout 파이프가 가득 차 codeql이 블록되고 교착한다.
    await Promise.all([deps.drain(create.stderr), deps.drain(create.stdout)]);
    const done = await create.completion;
    if (done.exit_code !== 0) {
      throw new Error(
        `codeql database create failed (exit ${done.exit_code}${done.error ? `: ${done.error}` : ''})`,
      );
    }
  }

  // 2. qlpack + 쿼리 작성(임시 작업 디렉터리).
  await deps.ensureDir(input.workDir);
  await deps.writeText(join(input.workDir, 'qlpack.yml'), qlpackYml(input.language));
  const queryPath = join(input.workDir, 'relation.ql');
  await deps.writeText(queryPath, input.query);
  const bqrsOut = join(input.workDir, 'relation.bqrs');

  // 3. query run.
  const run = deps.spawn({
    binary,
    args: buildQueryRunArgs({ dbPath: input.dbPath, queryPath, bqrsOut }),
    repoRoot: input.repoRoot,
    cwd: '.',
    env,
  });
  await Promise.all([deps.drain(run.stderr), deps.drain(run.stdout)]);
  const runDone = await run.completion;
  if (runDone.exit_code !== 0) {
    throw new Error(
      `codeql query run failed (exit ${runDone.exit_code}${runDone.error ? `: ${runDone.error}` : ''})`,
    );
  }

  // 4. bqrs decode → CSV 파일(stdout 캡처 대신 --output, 파이프 교착 원천 차단).
  const csvOut = join(input.workDir, 'relation.csv');
  const decode = deps.spawn({
    binary,
    args: buildBqrsDecodeArgs(bqrsOut, csvOut),
    repoRoot: input.repoRoot,
    cwd: '.',
    env,
  });
  await Promise.all([deps.drain(decode.stderr), deps.drain(decode.stdout)]);
  const decodeDone = await decode.completion;
  if (decodeDone.exit_code !== 0) {
    throw new Error(
      `codeql bqrs decode failed (exit ${decodeDone.exit_code}${decodeDone.error ? `: ${decodeDone.error}` : ''})`,
    );
  }

  return parseCsvRows(await deps.readText(csvOut));
}

export interface SymbolDeclInput {
  symbol: string;
  repoRoot: string;
  sourceRoot: string;
  language: CodeqlLanguage;
  dbPath: string;
  workDir: string;
  binary?: string;
}

/** 이름이 symbol인 선언이 든 파일 경로 집합(중복 제거). 없으면 빈 배열. */
export async function resolveSymbolDeclFiles(
  input: SymbolDeclInput,
  deps: RelationDeps,
): Promise<string[]> {
  const rows = await runRelationQuery(
    { ...input, query: renderQuery(relationQueries(input.language).symbolDecl, input.symbol) },
    deps,
  );
  const files = rows.map((r) => r[0]).filter((p): p is string => p !== undefined && p.length > 0);
  return [...new Set(files)];
}
