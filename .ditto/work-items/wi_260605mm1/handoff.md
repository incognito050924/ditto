> ⛔ SUPERSEDED → 최신 핸드오프는 `.ditto/work-items/wi_260605dg2/handoff.md`. cross_repo emitter(§3)는 wi_260605cr1로 완료됨. 아래는 이력용.

# Handoff — ACG 후속 (cross_repo emitter 구체화 + 세션 상태, 2026-06-05)

> 최신 thread 핸드오프. 이전(`wi_260604ql9/handoff.md`)을 대체. 기준 커밋 **main = fd90c5f**.
> 다음 세션의 주 작업은 §3 **cross_repo emitter**. 나머지는 배경/연속성.

## 0. 새 PC 셋업
```bash
git pull                         # main fd90c5f 이상
bun install                      # deps (yaml 포함)
bun run build && bun link        # ditto 전역
bun test                         # green (직전 ~1066 pass / 3 skip / 0 fail)
```
- **CodeQL는 로컬 설치 필요**(repo에 없음). 새 PC: 공식 번들 osx64(arm64도 osx64) → `~/codeql-home` → `~/.local/bin/codeql` symlink. (이전 핸드오프 §0-1 절차 동일.) 없어도 단위테스트는 fixture라 통과; 실 분석/e2e만 codeql 필요.
- bare `ditto`는 dist → 소스 변경 시 `bun run build`, 또는 `bun run dev <cmd>`로 소스 직접 실행.
- `.ditto/cache/`(codeql DB)·`.ditto/work-items/*/evidence/`는 gitignore. bun.lockb는 세션시작 변경분이면 커밋 주의(yaml 추가분은 정상).

## 1. 이번 세션에 끝낸 것 (전부 main push 완료)
순서대로:
- **impact/fitness 완료게이트 배선 + CodeQL fitness provider** (wi_260604ck1) — stop.ts assurance/impact 게이트, codeql-sarif fitness provider.
- **CodeQL 설치 + `codeql review` 부모디렉터리 버그수정** (wi_260604ql9).
- **leak#1 정식 바인딩 — Java** (wi_260605bxj): `relations.ts`를 언어별 템플릿 레지스트리(`RELATION_QUERIES[language]`)로 리팩터 + Java QL 템플릿. `ditto impact/boundary --language java`로 boxwood automation-engine 실분석(probe 7/7 동일).
- **boxwood Java probe + 검증보강** (wi_260605bxw, wi_260605bxg) — 스펙 저장소독립성 실증, N=348 정밀도, 멀티모듈 cross-module 해소, taint buildless 판정.
- **batch-1 (오케스트레이션 병렬 worktree 구현)** — archspec-yaml(wi_260605ya1: YAML 입력), fitness 판정 주입 provider(wi_260605fv1: llm_judged/executed, fail-closed), Change Map 렌더러(wi_260605cm1: `ditto change-map`).
- **Python 바인딩** (wi_260605py1): relations.ts python 템플릿(AST 이름기반, homonym 한계 문서화), 합성 DB probe + 실 e2e.
- **Kotlin 바인딩** (wi_260605kt1): java(java-kotlin) 추출기 재사용 + **buildless 금지 안전수정**(`codeqlExtractorLanguage` kotlin→java, selectBuildMode autobuild 강제). 라이브 e2e는 portal-backend Gradle 빌드 실패로 [VERIFY].
- **multi-module 결정** (wi_260605mm1, 이 핸드오프): 능력은 신규 코드 없이 이미 존재(§2). cross_repo emitter는 다음 세션(§3).

## 2. multi-module reactor DB — 이미 동작(신규 코드 0)
probe(wi_260605bxg)에서 실증: `--source-root=<모듈 상위(workspace)>`로 빌드하면 cross-module(형제모듈 JAR) 의존이 source로 해소됨(엣지 10→12). `buildCreateArgs`는 임의 source-root 수용, CLI도 `--source-root` 노출 → **오늘 그대로 가능**. 주의: source-root를 상위로 올리면 `getRelativePath()`가 `<module>/...` 접두라 ArchitectureSpec glob을 모듈 접두로 작성해야 함(스펙 작성 이슈, 코드 버그 아님; impact는 `%/{{FILE}}` suffix라 무관).

## 3. ★ 다음 작업: cross_repo unresolved emitter (구체 스펙)
**문제**: 단일모듈 DB 분석 시 형제모듈(JAR) 의존이 `fromSource()`에서 빠져 **조용히 사라진다**. 거버넌스 도구는 이를 `ImpactGraph.unresolved: kind=cross_repo`로 **기록**해야 한다(스키마 `src/schemas/acg-impact-graph.ts`의 `acgUnresolvedImpact`에 `cross_repo` 이미 존재). 스펙 근거: 20-contracts §2(boxwood-domain-model JAR을 cross_repo 대표사례로 명시).

**설계 난점 = 신호**: 형제모듈(cross_repo)과 써드파티(Spring/JDK)를 구분해야 함(안 하면 Spring까지 cross_repo 노이즈). → **'내부 패키지 prefix' 신호**가 필요.

**구현 스케치(최소)**:
1. **스키마**: `acgArchitectureSpec`(`src/schemas/acg-architecture-spec.ts`)에 `internal_packages: z.array(z.string()).default([])` 추가(예: `["kr.co.ecoletree.boxwood"]`). ArchitectureSpec이 per-repo 카탈로그라 자연스러운 위치. Zod SoT → `bun run schemas:export`로 JSON 갱신. (대안: CLI `--internal-prefix` 플래그 — 더 가볍지만 spec이 정석.)
2. **언어별 unresolved 쿼리**(`relations.ts`): 기존 edge 쿼리는 `fromSource()`로 라이브러리를 버린다. 추가로 "target이 NOT fromSource"인 import/type-ref를 `(fromPath, importedPackageOrModule)`로 뽑는 쿼리(언어별). Java: `Import`/`TypeAccess`→RefType `not used.fromSource()` → 패키지명. Python: `ImportExpr`에서 `Module.getName()`이 source로 안 풀리는 것. JS: edge 쿼리의 `not exists(getImportedModule())` 분기(raw specifier)를 재사용.
3. **analyzer 분류**(`codeql-analyzer.ts` impact / 또는 boundary): unresolved 후보 중 패키지가 `internal_packages` prefix에 매칭되면 `AnalyzerResult.unresolved`에 `{ kind: 'cross_repo', path: <fromFile>, reason: '<pkg> resolves to a sibling module not in this DB' }` emit. 매칭 안 되는 써드파티는 무시. (impact 우선; boundary는 위반 개념이라 cross_repo는 impact-graph로.)
4. **수용기준**: ① 단일모듈 automation-engine DB + `internal_packages=["kr.co.ecoletree.boxwood.domain"]`로 impact 분석 시 Requester·StructuredErrorInfo(그 2 JAR 타입)가 `unresolved: cross_repo`로 기록됨. ② 써드파티(org.springframework 등)는 cross_repo로 안 잡힘. ③ 멀티모듈 reactor DB에선 같은 의존이 source로 해소돼 unresolved 0(§2). ④ 전체 테스트·lint green.
5. **검증**: boxwood automation-engine으로 probe 재현(Java DB, CodeQL 설치 환경). 단위는 mock CSV(unresolved 후보 행 주입)로 분류 로직 검증.

**참고 위치**: 바인딩 패턴은 wi_260605bxj(Java)·wi_260605py1(Python) 완료분, 분석기 `src/acg/{impact/codeql-analyzer,boundary/codeql-edges}.ts`, 쿼리 `src/core/codeql/relations.ts`.

## 4. gotcha (이번 세션 신규 + 이월)
- **codeql 언어 바인딩 패턴**: 언어 추가 = `RELATION_QUERIES[lang]` 템플릿 3종 + `isTestFile`(codeql-analyzer) + `stripModuleExt`(codeql-edges) + CLI 도움말. kotlin은 java 재사용(`codeqlExtractorLanguage` kotlin→java).
- **kotlin은 빌드 필수**(autobuild/manual). buildless=빈추출(false-clean) → `NO_BUILD_LANGUAGES`에서 제외돼 selectBuildMode가 autobuild 강제. portal-backend Gradle 빌드는 이 환경에서 실패(내부 의존).
- **Python impact는 AST 이름기반**(resolved-callee 아님) → 다른 파일 동명함수 호출이 섞일 수 있음(homonym). 이름 다른 decoy는 정확 배제.
- **boxwood read-only**: codeql/grep 읽기만, DB는 /tmp 또는 .ditto/cache. boxwood git 쓰기/커밋/푸시 금지.
- **오케스트레이션**: 병렬 스코핑=안전. 병렬 구현은 **파일 disjoint일 때만** worktree 격리로. 구조화출력으로 받은 patch는 JSON 왕복에 깨짐 → **잔존 worktree에서 `git -C <wt> diff --cached --binary`로 clean 패치를 뽑아** main에 apply. 새 의존(yaml)은 apply 후 `bun install`.
- (이월) work item id=`wi_`+8자↑영숫자. completion `evidence.kind`∈command/file/artifact/url/note. final_verdict=pass면 in-scope unverified 금지(범위밖이면 out_of_scope=true). CLAUDE.md managed/knowledge 블록 손편집 금지. `--no-ledger`는 citty `--no-` 처리와 충돌하는 기존 CLI 퀴크(별도 건).

## 5. 이 work item(wi_260605mm1) 상태
multi-module 능력 확인 + cross_repo emitter 연기 결정(final_verdict=pass). 재개 대상 아님. cross_repo emitter는 §3 스펙으로 새 work item에서 착수.
