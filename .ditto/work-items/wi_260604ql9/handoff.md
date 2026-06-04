# Handoff — ACG 거버넌스 후속 (다른 PC 이어받기, 2026-06-04)

> 이 파일이 최신 thread 핸드오프다. 이전 핸드오프 `.ditto/work-items/wi_260603hzx/handoff.md`를 **대체**한다(거기 0~5장은 여전히 유효한 배경; 달라진 점만 아래에 적는다).
> 연속성 = git + work-items + `~/.claude/.../memory`. 새 PC에서 `git pull` 후 이 파일부터 읽으면 된다. 기준 커밋: **main = f7c6421**.

## 0. 새 PC 셋업 (먼저)
```bash
git pull                       # main 최신 (f7c6421 이상)
bun install                    # deps
bun run build && bun link      # ditto CLI 전역 설치 → ~/.bun/bin/ditto
which ditto                    # ~/.bun/bin/ditto (PATH에서 /usr/bin보다 앞이어야 함)
bun test                       # green 확인 (직전 세션 ~1005 pass / 1 skip(opt-in CODEQL_E2E) / 0 fail)
```
- bare `ditto …`를 skills/agents가 부르므로 `bun link` 필수. ditto 소스 변경 시 `bun run build` 재실행.
- pre-commit 게이트는 biome만(tsc 아님). 커밋은 코드(behavioral)/`.ditto`(chore) 분리, main 직접 push 관행.
- **bun.lockb는 세션 시작부터 M로 떠 있는 무관 변경 — 커밋하지 말 것.**

### 0-1. CodeQL은 로컬 설치라 새 PC에서 다시 깔아야 한다 (repo에 없음)
직전 세션이 이 PC(x86_64 mac)에 설치한 방식 — 새 PC에서 동일 재현:
```bash
# 1) 공식 번들(CLI + 표준 쿼리팩 포함). arch에 맞는 자산 선택:
#    macOS = codeql-bundle-osx64.tar.gz 단일 universal 자산(arm64·인텔 공용). 'osx-arm64' 자산은 없음 → 그 이름이면 404. linux는 linux64.
gh api repos/github/codeql-action/releases/latest --jq '.tag_name'   # 최신 태그 확인
curl -fsSL https://github.com/github/codeql-action/releases/download/codeql-bundle-vX.Y.Z/codeql-bundle-osx64.tar.gz -o /tmp/cq.tar.gz
rm -rf ~/codeql-home && mkdir -p ~/codeql-home && tar -xzf /tmp/cq.tar.gz -C ~/codeql-home
# 2) PATH 연결(심링크 너머 실제 경로를 codeql가 해석함):
mkdir -p ~/.local/bin && ln -sf ~/codeql-home/codeql/codeql ~/.local/bin/codeql
codeql version                 # 'release 2.25.x', Unpacked in ~/codeql-home/codeql
codeql resolve languages       # javascript 등 + javascript-queries 팩
rm -f /tmp/cq.tar.gz           # 1.3G tarball 정리
```
- `~/.local/bin`이 PATH에 있어야 함(이 PC는 사용자 프로필이 이미 추가). 없으면 zshrc에 추가.
- **codeql 없이도** fitness codeql provider 단위테스트는 fixture라 통과. e2e/실 `ditto codeql review`만 codeql 필요.
- 검증: `CODEQL_E2E=1 CODEQL_BIN=~/.local/bin/codeql bun test tests/core/codeql-e2e.test.ts` → pass(~30s).

## 1. 이번 세션에 끝낸 것 (전부 main push 완료)
- **남은 일 #1 — impact/fitness 완료게이트 배선** (`src/hooks/stop.ts`, 커밋 4f64a19, wi_260604ck1):
  - `assuranceSnapshotForcesContinuation` — `assurance-snapshot.json`의 outcome=fail 함수당 reason 1개(pass/skip 무시).
  - `impactForcesContinuation` — `impact-graph.json`의 `unresolved[]` 항목당 reason 1개.
  - 기존 acg-review 패턴(absent=no-op, malformed=fail-closed) 그대로. stopHandler가 두 원장을 read→malformed 배열·reasons에 배선.
- **남은 일 #3 — CodeQL→fitness deterministic provider** (커밋 4f64a19, wi_260604ck1):
  - `src/acg/fitness/codeql-provider.ts`: SARIF findings → RawViolation(rule+path, **line 제외=OBJ-11**) → normalizeViolationIdentity. enclosing symbol이 없어 site=`<top>`로 collapse(보수적, 새 위반 과소검출 방향).
  - `src/cli/commands/fitness.ts`: deterministic provider가 spec `codeql-sarif:<path>`를 인식해 SARIF를 violationIds로 사용. 부재 시 fail-closed skip(+reason). 그 외 spec은 기존 shell command.
- **CodeQL 설치 + 버그수정** (커밋 8f353ac, wi_260604ql9):
  - 설치 중 `ditto codeql review`가 codeql DB 부모 디렉터리 미생성으로 create 실패(exit 2)하던 **잠복 버그** 발견·수정 — `src/cli/commands/codeql.ts`가 spawn 전 `.ditto/cache/codeql/<key>/`와 sarif 부모(`evidence/`) ensureDir. e2e 테스트가 mkdir로 마스킹하고 있었음.
  - `.gitignore`에 `.ditto/cache/`(commit-sha 키 codeql DB 캐시) 추가.
- (참고) 내 푸시 이후 다른 작업이 **ADR-0005**(런타임 산출물 저장)와 **dialectic-6/7 문서 정합**(설계문서를 실제 코드 구현 상태에 맞춤)을 올림 — main f7c6421. 설계문서 00~50은 이제 코드와 정합된 상태.

## 2. 남은 일 (우선순위 = 사용자 결정, 미착수)
원래 8개 중 #1·#3 완료. 남은 것:
2. **path-alias 잔여** — alias 해석은 boundary/architecture에 적용됨. FF-4 architecture가 실 ditto에서 public surface를 검출하는지 재확인 권장.
4. **executed/llm_judged provider** — 현재 fail-closed skip. (CodeQL deterministic은 #3로 됨.)
5. **ArchitectureSpec YAML 입력**(현재 JSON만), `layers`→경로 path-glob 정식화(현재 관례: 레이어명이 경로 세그먼트).
6. **CodeQL 자율루프 advisory-first**(계획 WI-4, 무한루프 위험). 현재는 reviewer-invoked만.
7. **boxwood 2번째 바인딩** — 스펙 저장소독립성 검증(가장 큰 구조적 수확). **이번 세션에 계획만 논의, 미착수. §4 참조.**
8. **PreToolUse forbidden_scope 집행 / Change Map 렌더러** — v0 OUT. **이번 세션에 중요 공백 확인: §5 참조.**

## 3. 코드 위치 (이번 세션 추가분)
- 완료게이트: `src/hooks/stop.ts` — `acgReviewForcesContinuation`(기존) + `assuranceSnapshotForcesContinuation` + `impactForcesContinuation`. 읽는 파일: `.ditto/work-items/<wi>/{assurance-snapshot,impact-graph,acg-review}.json`.
- fitness codeql provider: `src/acg/fitness/codeql-provider.ts` + CLI dispatch `src/cli/commands/fitness.ts`(spec `codeql-sarif:`).
- codeql review dir-fix: `src/cli/commands/codeql.ts`.
- scope 해소 관련(§5): `src/schemas/acg-change-contract.ts`(acgScopeRef kinds), `src/schemas/acg-architecture-spec.ts`, `src/acg/boundary/boundary.ts`(pathToLayer/checkEdge).
- (기존) 스키마 `src/schemas/acg-*.ts`(Zod SoT), producer/어댑터 `src/acg/*`, CodeQL `src/core/codeql/*`.

## 4. boxwood 2번째 바인딩 — 논의된 접근 (미착수)
- **정의**: ACG 스펙(00~50, lock)을 다른 저장소(boxwood)에 실현 → 스펙이 DITTO/TS에 몰래 결합됐는지 검증. "가장 큰 수확"= 시도 자체가 DITTO leak 지점을 드러냄.
- **재사용(스펙, 불변)**: 9개 acg-*.ts 스키마, 거버넌스 불변식(default-deny/review-by-exception/fitness delta_only+ADR-0004), ICL DSL+컴파일러.
- **새로 꽂음(바인딩별 provider)**: impact 분석기(TsImpactAnalyzer→Java/Kotlin 심볼·호출그래프), boundary edge 분석기(TsEdgeAnalyzer/tsconfig alias→Java import/package), deterministic evaluator는 **CodeQL이 가장 이식성 높음**(`--language java`, runner가 이미 컴파일언어 build-mode 지원), 저장위치·완료게이트(.ditto/Stop훅은 DITTO 전용).
- **제약(사용자 명시)**: boxwood 실제 커밋/푸시 금지. → 두 번째 바인딩은 본질적으로 **boxwood read-only 관측**. 산출물은 DITTO `.ditto/` 또는 /tmp 스크래치에, boxwood 트리·git 절대 건드리지 않음. (CodeQL DB도 .ditto/cache나 /tmp로.)
- **첫 슬라이스 후보**: (A) 기존 `ditto impact`/`boundary`를 boxwood에 돌려 unresolved/빈결과로 leak 목록화(새 코드 0). (B) `ditto codeql review --language java --source-root <boxwood>`로 SARIF→ledger(가장 빨리 동작 증명). (정식) boxwood 변경의도 1개 .icl→ChangeContract 컴파일(provider 없이 스펙 이식성 증명).
- **착수 전 사용자만 답할 것 2가지**: (1) 어느 boxwood가 대상인가 — 로컬에 `~/dev/project/boxwood-{workspace,packages,with-hannes,frontend-dsl-mvp,knowledge,...}` 다수 존재, 설계문서는 Java/Kotlin을 가리키나 일부 디렉터리는 JS/TS로 보임. (2) 범위 = leak 탐침/문서화(작음) vs 실제 boxwood provider 구현(큼).

## 5. ChangeContract 추상 scope 해소 — 확인된 구현 공백 (남은 일 #8과 직결)
질문: `forbidden_scope[].kind`가 `layer`/`public_surface`(추상)면 구체 파일을 어떻게 식별?
- **설계 의도**: 구체 범위를 계약에 저장하지 않음. 추상 kind는 이름(간접참조)이고, 게이트 시점에 **per-repo ArchitectureSpec + 바인딩 분석기**가 해소. 3단 간접: ChangeContract(추상 이름)→ArchitectureSpec(이 repo에서 그 이름의 정의)→분석기(현재 트리의 구체 파일로 전개).
  - `path`/`glob`→이미 구체. `symbol`→impact 분석기. `layer`→`ArchitectureSpec.layers` 키, 관례상 레이어명이 경로 세그먼트로 등장(`boundary.ts:pathToLayer`). `public_surface`→`ArchitectureSpec.public_surfaces` 엔트리.
  - 추상으로 두는 이유 = 구체 경로는 이동/리네임에 썩음; 매 게이트 재해소가 안정적. **저장소 독립성의 핵심**(boxwood와 직결).
- **구현 현황(정직)**:
  - 존재: boundary 게이트의 `layer` 해소(`pathToLayer`+glob) — 단 **의존 엣지**(layers.can_call)용이지 frame 집행용 아님.
  - **부재**: `forbidden_scope`(kind=layer/public_surface)를 "건드리면 안 되는 구체 파일 집합"으로 펴는 **일반 resolveScopeRef + PreToolUse 집행 전무**(v0 OUT). grep 확인: forbidden_scope 소비처는 ICL(생산만)+handoff(무관 동명필드)뿐. 계약에 추상 scope를 적어도 강제하는 코드가 없음.
  - 메우려면: `resolveScopeRef(scopeRef, archSpec, analyzer)→구체경로집합` + PreToolUse 훅(#8).

## 6. gotcha (이월 + 신규)
- (이월) work item id = `wi_`+8자 이상 영숫자(언더스코어/짧은이름 금지). `ditto work start`는 멀티워드 positional 잘라먹으니 work-item.json 직접 편집.
- (이월) status=partial work item은 `re_entry` 필수(빠지면 repo self-validation 깨짐). `.ditto` 커밋 후 `bun test`.
- (이월) CLAUDE.md의 `ditto:managed`/`ditto:knowledge` 블록은 sha-managed projection — **손편집 금지**. knowledge.json 고친 뒤 `bun run dev bridge knowledge`로 재생성.
- (이월) TS 분석기는 `typescript` devDep 컴파일러 API 사용.
- **(신규) completion.json은 evidenceRef.kind가 command/file/artifact/url/note**(ACG의 test/build/log 아님).
- **(신규) completion.json final_verdict=pass면 in-scope unverified 금지** — 의도적 범위 밖이면 `out_of_scope: true` 표시(안 하면 repo self-validation의 schema superRefine이 거부). 이번 세션에 한 번 걸림.
- **(신규) CodeQL은 로컬 설치(§0-1), .ditto/cache/는 gitignored.**
- **(신규, 2026-06-04 ②) macOS CodeQL 번들 자산 = `codeql-bundle-osx64.tar.gz` 단일 universal(§0-1 정정). `osx-arm64`는 존재하지 않음 → 404. arm64 mac도 osx64 받음.**
- **(신규, 2026-06-04 ②) 새 PC에서 `bun link`된 `ditto`는 dist를 가리킴 → 빌드 전이면 새 명령(예: `impact`)이 'Unknown command'. `bun run build` 하거나 `bun run dev <cmd>`로 소스 직접 실행.**

## 7. 이 work item(wi_260604ql9) 상태
CodeQL 설치 + codeql.ts 버그수정 완료(final_verdict=pass, ac-1~4). 재개 대상 아님. 이 핸드오프는 thread 문서로 여기 얹음.

### 7-1. 후속 thread (2026-06-04 ②): ADR-0006 — 정적 분석 엔진 CodeQL 통일 (wi_260604cqe, **status=done, final_verdict=pass**)
"ImpactGraph가 CodeQL/AST냐, LLM 추론은 규모 비례로 부정확"이라는 사용자 문제제기 → **ADR-0006 accepted**(impact/boundary analyzer를 CodeQL 단일로 통일, TS 컴파일러 분석기 제거, fast-path 폴백 없음, boxwood 2번째 바인딩으로 검증). 사용자 결정: accept 대신 **실증 데이터로 판정**.
- **슬라이스1 실증 완료**(ac-2 pass): DITTO src를 CodeQL JS DB로 빌드(real 9.51s), `parseSarif` 영향집합을 TS type checker 정답지(`ditto impact`, 14노드)와 비교 → **위치 14/14 완전 일치, 차이 0**. custom .ql(`callers/all-refs/imports/decl.ql`)→BQRS decode. CodeQL이 import/call/decl 분리로 TS보다 세밀. 증거 스크래치 `/tmp/cq-proof/`(gitignored, PC 재부팅 시 소멸 — 재현은 §0-1 설치 후 `codeql database create --language=javascript` + 그 4쿼리).
- **ac-2~6 전부 pass(실측)**: type_contract 25/25(ac-3)·boundary import-edge diff 0(ac-4)·boxwood Java call graph(ac-6). **ac-5 마이그레이션 완료**: CodeqlImpact/EdgeAnalyzer 구현(`src/acg/{impact,boundary}/codeql-*.ts`, 실행부 `src/core/codeql/relations.ts`·`host-deps.ts`) + 호출처 교체(impact/boundary/architecture, observeArchitecture는 EdgeAnalyzer DI) + ts-analyzer/ts-edges **삭제**. 전체 회귀 1011 pass/0 fail.
- **신규 gotcha(ac-5)**: ① CodeQL CLI에서 결과는 stdout 캡처 말고 `--output` 파일로 받아라(stdout 파이프 풀이면 `database create`가 교착 — drain은 stderr/stdout 동시에 `Promise.all`). ② 이름기반 쿼리(`VarAccess/Function.getName()`)는 동명이인(decoy) 과검출 → `getResolvedCallee()`+선언 target-file 제한으로 정밀화해야 ts-analyzer의 symbol-resolution과 동등. ③ CodeQL DB는 `--output`/create 모두 **부모 디렉터리 선재 필요**(ensureDir). ④ macOS codeql 번들 = `osx64`(arm64도), `osx-arm64` 자산 없음.
- e2e는 opt-in: `CODEQL_E2E=1 CODEQL_BIN=~/.local/bin/codeql bun test tests/acg/codeql-analyzer-e2e.test.ts`(decoy 배제 검증).
- boxwood 실체: Java/Camunda automation-engine 코어 + JS/TS 모델러 혼재 모노레포(§4 해소). 로컬 소스 `~/Downloads/Boxwwo_workspace_sk/boxwood-engine`(read-only 관측에 사용). **clone된 repo 아님** — 실제 바인딩(autobuild build-mode) 구현 시 정식 클론.
- **잔여 한계(완료, 후속 선택)**: import/type 참조는 아직 이름기반(동명 모듈/타입 과검출 여지, 단일심볼에선 미발생). 비호출 value 참조는 getResolvedCallee 미포착(드묾). 캐시는 commit-sha 키라 working-tree dirty면 stale 여지.
