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
import {
  type BuildMode,
  type CodeqlDeps,
  type CodeqlLanguage,
  buildCreateArgs,
  codeqlExtractorLanguage,
  selectBuildMode,
} from './runner';

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
 * Impact(Java) — JS impact의 Java 바인딩. 동일한 (p,ln,k) 형식·동일한 정밀도 기법
 * (선언 동일성: 선언은 target 파일로 제한, 호출은 `getMethod()`로 해소된 것만 → decoy 배제,
 * wi_260605bxw probe에서 extractRequesterName 7/7 정확·동명이인 947 배제 실증). JS의 `import`
 * kind는 빼고 type 참조로 흡수한다 — Java는 미사용 import가 흔해(TypeAccess가 실사용만 잡음).
 *   value = 호출 참조(resolved callee가 target 선언 메서드)
 *   type  = 타입 위치 참조(TypeAccess가 target 선언 타입)
 *   decl  = 선언 위치(method/class/interface, target 파일) → external_surface로 매핑
 */
export const IMPACT_QUERY_JAVA = `/**
 * @name ditto impact java
 * @id ditto/impact-relations-java
 * @kind table
 */
import java

predicate inTargetFile(File f) {
  f.getRelativePath() = "{{FILE}}" or f.getRelativePath().matches("%/{{FILE}}")
}

from string p, int ln, string k
where
  (exists(MethodCall mc, Method m |
     m.getName() = "{{SYMBOL}}" and inTargetFile(m.getFile()) and mc.getMethod() = m
     and p = mc.getFile().getRelativePath() and ln = mc.getLocation().getStartLine()) and k = "value")
  or (exists(TypeAccess t, RefType rt |
     rt.getName() = "{{SYMBOL}}" and inTargetFile(rt.getFile()) and t.getType() = rt
     and p = t.getFile().getRelativePath() and ln = t.getLocation().getStartLine()) and k = "type")
  or (k = "decl" and (
      exists(Method d | d.getName() = "{{SYMBOL}}" and inTargetFile(d.getFile()) and p = d.getFile().getRelativePath() and ln = d.getLocation().getStartLine())
      or exists(RefType d | d.getName() = "{{SYMBOL}}" and d.fromSource() and inTargetFile(d.getFile()) and p = d.getFile().getRelativePath() and ln = d.getLocation().getStartLine())
  ))
select p, ln, k
`;

/**
 * Boundary(Java) — cross-file 타입 의존 edge를 usage 기반으로(TypeAccess → 선언 파일).
 * import-문이 아니라 실사용을 보므로 미사용 import를 배제한다(probe 실증: ActivityType
 * unused import 제외). 형제모듈 JAR 의존은 `fromSource()`에서 빠진다 → 단일모듈 DB면
 * cross-module은 안 잡히고(멀티모듈 reactor DB면 잡힘), 이는 ImpactGraph.unresolved
 * cross_repo가 받는 스펙 예견 케이스.
 */
export const EDGE_QUERY_JAVA = `/**
 * @name ditto edges java
 * @id ditto/edge-relations-java
 * @kind table
 */
import java
from TypeAccess ta, RefType used, string fromPath, string target
where fromPath = ta.getFile().getRelativePath()
  and ({{FILE_FILTER}})
  and used = ta.getType()
  and used.fromSource()
  and used.getFile() != ta.getFile()
  and target = used.getFile().getRelativePath()
select fromPath, target
`;

/** Symbol 선언 위치(Java) — 이름이 SYMBOL인 method/type 선언이 든 파일. 동명이인 전부(과보호). */
export const SYMBOL_DECL_QUERY_JAVA = `/**
 * @name ditto symbol decl java
 * @id ditto/symbol-decl-java
 * @kind table
 */
import java
from string p
where
  exists(Method d | d.getName() = "{{SYMBOL}}" and p = d.getFile().getRelativePath())
  or exists(RefType d | d.getName() = "{{SYMBOL}}" and d.fromSource() and p = d.getFile().getRelativePath())
select p
`;

/**
 * Impact(Python) — wi_260605py1 probe에서 합성 DB로 검증(호출 3+decl 1, decoy 제외).
 * Python은 동적 타이핑이라 JS/Java의 getResolvedCallee/getMethod 같은 선언-동일성 해소가
 * best-effort다 — 여기서는 AST 이름기반(Call.getFunc().Name.getId())으로 value 참조를 잡고
 * 선언은 target 파일로 핀한다. 결과: 같은 이름의 함수가 '다른 파일'에 또 있으면 그 호출도
 * 섞일 수 있는 한계(homonym; JS/Java보다 정밀도 낮음)를 감수한다. type kind는 Python에서
 * 신뢰도가 낮아 생략(value+decl만). decoy(이름이 다른 함수)는 정확히 배제된다.
 */
export const IMPACT_QUERY_PY = `/**
 * @name ditto impact python
 * @id ditto/impact-relations-py
 * @kind table
 */
import python

predicate inTargetFile(File f) {
  f.getRelativePath() = "{{FILE}}" or f.getRelativePath().matches("%/{{FILE}}")
}

from string p, int ln, string k
where
  (exists(Call call |
     call.getFunc().(Name).getId() = "{{SYMBOL}}"
     and p = call.getLocation().getFile().getRelativePath() and ln = call.getLocation().getStartLine()) and k = "value")
  or (k = "decl" and exists(Function d |
     d.getName() = "{{SYMBOL}}" and inTargetFile(d.getLocation().getFile())
     and p = d.getLocation().getFile().getRelativePath() and ln = d.getLocation().getStartLine()))
  or (k = "decl" and exists(Class d |
     d.getName() = "{{SYMBOL}}" and inTargetFile(d.getLocation().getFile())
     and p = d.getLocation().getFile().getRelativePath() and ln = d.getLocation().getStartLine()))
select p, ln, k
`;

/** Boundary(Python) — import 엣지(ImportExpr → 해소된 source 모듈 파일). probe 검증. */
export const EDGE_QUERY_PY = `/**
 * @name ditto edges python
 * @id ditto/edge-relations-py
 * @kind table
 */
import python
from ImportExpr ie, Module m, string fromPath, string target
where fromPath = ie.getLocation().getFile().getRelativePath()
  and ({{FILE_FILTER}})
  and m.getName() = ie.getImportedModuleName()
  and m.getFile().fromSource()
  and target = m.getFile().getRelativePath()
select fromPath, target
`;

/**
 * Cross-repo unresolved(JS) — 해소되지 않은 import specifier(raw)를 (fromPath, specifier)로.
 * 형제 패키지(workspace 내부 패키지)와 써드파티를 구분하는 신호는 소비처(분석기)의
 * internal_packages prefix 매칭이 쥔다. 여기선 "해소 실패한 import"만 후보로 넘긴다.
 */
export const UNRESOLVED_QUERY_JS = `/**
 * @name ditto unresolved js
 * @id ditto/unresolved-relations
 * @kind table
 */
import javascript
from Import imp, string fromPath, string spec
where fromPath = imp.getFile().getRelativePath()
  and not exists(imp.getImportedModule())
  and spec = imp.getImportedPath().getValue()
select fromPath, spec
`;

/**
 * Cross-repo unresolved(Java) — source에서 쓰지만 DB에 없는(NOT fromSource) RefType 참조를
 * (fromPath, package)로. 형제모듈 JAR 타입(예: kr.co.ecoletree.boxwood.domain.Requester)이
 * 단일모듈 DB에선 fromSource가 아니라 edge 쿼리에서 조용히 빠진다 — 그 손실을 여기서 후보로
 * 표면화한다. java.lang/org.springframework 같은 써드파티도 같이 나오지만, cross_repo 판정은
 * 분석기가 internal_packages prefix로 좁힌다(써드파티 무시). 결과 튜플은 QL set 의미로 자동
 * 중복 제거되어 (파일 × 외부 패키지)로 제한된다.
 */
export const UNRESOLVED_QUERY_JAVA = `/**
 * @name ditto unresolved java
 * @id ditto/unresolved-relations-java
 * @kind table
 */
import java
from TypeAccess ta, RefType used, string fromPath, string pkg
where fromPath = ta.getFile().getRelativePath()
  and used = ta.getType()
  and not used.fromSource()
  and pkg = used.getPackage().getName()
select fromPath, pkg
`;

/**
 * Cross-repo unresolved(Python) — source 모듈로 해소되지 않는 import 대상 모듈명을
 * (fromPath, moduleName)로. 형제 패키지(같은 모노레포의 다른 distribution)와 써드파티의
 * 구분은 분석기의 internal_packages prefix가 쥔다.
 */
export const UNRESOLVED_QUERY_PY = `/**
 * @name ditto unresolved python
 * @id ditto/unresolved-relations-py
 * @kind table
 */
import python
from ImportExpr ie, string fromPath, string mod
where fromPath = ie.getLocation().getFile().getRelativePath()
  and mod = ie.getImportedModuleName()
  and not exists(Module m | m.getName() = mod and m.getFile().fromSource())
select fromPath, mod
`;

/** Symbol 선언 위치(Python) — 이름이 SYMBOL인 function/class 선언이 든 파일. 동명이인 전부. */
export const SYMBOL_DECL_QUERY_PY = `/**
 * @name ditto symbol decl python
 * @id ditto/symbol-decl-py
 * @kind table
 */
import python
from string p
where exists(Function d | d.getName() = "{{SYMBOL}}" and p = d.getLocation().getFile().getRelativePath())
  or exists(Class d | d.getName() = "{{SYMBOL}}" and p = d.getLocation().getFile().getRelativePath())
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
  /** 치환 없음. NOT fromSource인 import/type 참조 후보(fromPath, package/specifier). cross_repo 분류 입력. */
  unresolved: string;
}

/** 언어 → 관계쿼리 템플릿. 미등록 언어는 바인딩 미구현(throw로 드러냄). */
export const RELATION_QUERIES: Partial<Record<CodeqlLanguage, RelationQueryTemplates>> = {
  javascript: {
    impact: IMPACT_QUERY_JS,
    edge: EDGE_QUERY_JS,
    symbolDecl: SYMBOL_DECL_QUERY_JS,
    unresolved: UNRESOLVED_QUERY_JS,
  },
  java: {
    impact: IMPACT_QUERY_JAVA,
    edge: EDGE_QUERY_JAVA,
    symbolDecl: SYMBOL_DECL_QUERY_JAVA,
    unresolved: UNRESOLVED_QUERY_JAVA,
  },
  // Kotlin은 java(java-kotlin) 추출기로 분석되어 동일 Java AST/쿼리를 그대로 재사용한다.
  kotlin: {
    impact: IMPACT_QUERY_JAVA,
    edge: EDGE_QUERY_JAVA,
    symbolDecl: SYMBOL_DECL_QUERY_JAVA,
    unresolved: UNRESOLVED_QUERY_JAVA,
  },
  python: {
    impact: IMPACT_QUERY_PY,
    edge: EDGE_QUERY_PY,
    symbolDecl: SYMBOL_DECL_QUERY_PY,
    unresolved: UNRESOLVED_QUERY_PY,
  },
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

/** 언어별 표준 라이브러리 팩(번들 내장; pack install은 no-op). kotlin→java-all 매핑. */
function qlpackYml(language: CodeqlLanguage): string {
  return `name: ditto/acg-relations\nversion: 0.0.1\ndependencies:\n  codeql/${codeqlExtractorLanguage(language)}-all: "*"\n`;
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
  /** DB 캐시 디렉터리(예: .ditto/local/cache/codeql/<sha>-<lang>). 존재하면 create 생략. */
  dbPath: string;
  /** 쿼리·BQRS를 둘 작업 디렉터리(임시·gitignored). */
  workDir: string;
  /** 렌더 완료된 쿼리 소스(symbol/filter 치환 끝난 상태). */
  query: string;
  buildCommand?: string;
  /**
   * build-mode 강제. 미지정이면 selectBuildMode(언어/빌드명령)로 자동. 관계추출은
   * 컴파일 언어도 buildless(none)로 충분(probe 실증)하므로 Java 바인딩은 'none'을 넣는다.
   */
  buildMode?: BuildMode;
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
    const buildMode = input.buildMode ?? selectBuildMode(input.language, input.buildCommand);
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
  buildMode?: BuildMode;
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
