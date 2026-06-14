---
title: "ACG 개선 계획 — Cleanup(deslop) 워크플로를 ACG 게이트 위에 올리기"
kind: plan
status: proposed
last_updated: 2026-06-15 KST
scope: "LazyCodex/OmO의 remove-ai-slops 운영 패턴과 AST-grep 도구를 코드레벨로 검증한 결과를 근거로, DITTO ACG에 'cleanup을 거버넌스 게이트 위에서 도는 워크플로'로 흡수하는 구현 계획. 이 문서는 착수 가능한 작업단위·수용기준·검증·되돌리기·pre-mortem을 적재한다. 아직 구현 전(proposed)."
parent: 00-framework.md
source_report: reports/harnesses/lazycodex-remove-ai-slops-ast-grep.md
related_adr: [ADR-0006-static-analysis-engine-codeql.md]
ingests: 60-practice-ingestion-map.md
---

# ACG 개선 계획 — Cleanup(deslop)을 ACG 게이트 위에 올리기

> **이 문서의 위치.** [60-practice-ingestion-map.md](60-practice-ingestion-map.md)가 "외부 engineering practice를 ACG로 흡수하는 후보 지도"라면, 이 문서는 그 지도에서 한 후보 — **LazyCodex/OmO의 `remove-ai-slops` 운영 패턴** — 를 실제로 DITTO ACG에 내리는 구현 계획이다. 사실 근거는 코드레벨 재검증을 마친 [harness 보고서](../../harnesses/lazycodex-remove-ai-slops-ast-grep.md)(2026-06-15 재검증, OmO 루트 v4.10.0 / `245fd8f`)다.

> **상태.** `proposed`. 이 문서는 계획이며, WU-1~WU-4의 코드 구현은 별도 착수 허가가 필요하다(Charter §3 — lazy default). WU-0(결정/ADR)만 이 계획의 일부로 권고한다.

## 0. IntentContract (범위 보존)

- **달성할 결과**: OmO `remove-ai-slops`의 검증된 *전술*(테스트 선잠금 → 낮은위험부터 → 병렬 cleanup → 품질 게이트)을, DITTO ACG의 *강제력*(ChangeContract+PreToolUse 차단, SemanticCompatibility, FitnessFunction 델타, Stop 게이트) 위에서 도는 **하나의 cleanup 워크플로**로 흡수한다. cleanup이 회귀로 바뀌지 않게 막고, 정리한 slop이 미래 변경까지 추적되는 *fitness 성질*로 승격되게 한다.
- **이 계획이 아닌 것**:
  - OmO `SKILL.md`를 문자열 복제해 prompt-only skill을 만드는 것. (그러면 게이트가 없어 흡수의 핵심이 사라진다 — pre-mortem PM-7.)
  - 새 정적 분석 엔진(특히 ast-grep) 도입. **ADR-0006(CodeQL 단일 엔진)을 존중한다.** ast-grep 도입은 WU-4로 분리하고 기본 *보류*한다.
  - 모든 작은 수정에 full ACG ledger 5종(Change/Impact/Semantic/Review/Fitness)을 강제하는 것. cleanup은 **축소 ACG 프로파일**로 돈다(§3).
- **최소 구현 원칙(Charter §4-3)**: 이 capability는 신규 기계가 아니라 **기존 ACG 원시구성요소의 얇은 오케스트레이션**이다. 새 코드는 (a) scope 산정 + 축소 프로파일 배선, (b) cleanup 노드 템플릿, (c) 델타 게이트 결선뿐이다.

## 1. 근거 — 무엇을 흡수하고 무엇을 흡수하지 않는가

코드레벨 재검증으로 확정된 두 시스템의 성격(harness 보고서 §"LazyCodex/OmO와 DITTO ACG 비교"):

- OmO `remove-ai-slops`(`plugins/omo/skills/remove-ai-slops/SKILL.md`, v4.10.0): 좋은 cleanup *전술*. 그러나 slop category·품질 게이트가 **markdown 지시**라 agent가 어기면 host가 모른다. cleanup 결과가 미래 변경의 적합성 함수로 **승격되지 않는다**.
- AST-grep(`src/packages/ast-grep-mcp` + `ast-grep-core`): `sg run` 기반 구조 검색/치환 *도구*. dry-run 기본·workspace guard·output cap. 변경 의도/forbidden scope/semantic을 모른다.
- DITTO ACG: 변경 *계약·증거·완료 차단·지속 적합성* 런타임. cleanup *전술*은 없다.

→ **흡수 대상은 OmO의 전술이지 OmO의 도구가 아니다.** 전술을 ACG 게이트 위에 올리면 OmO가 못 하는 "증거 없는 완료 차단 + slop의 시간축 추적"이 붙는다. 도구(ast-grep)는 ADR-0006과 충돌하므로 분리·보류한다.

### 1.1 단계 매핑 (OmO 단계 → DITTO ACG 원시구성요소, 파일 지목)

| OmO remove-ai-slops 단계 | DITTO ACG로 내리는 방식 | 재사용 자산(파일:심볼) |
| --- | --- | --- |
| 범위 산정(merge-base diff) | `ChangeContract.allowed_scope` = diff 파일, `forbidden_scope` = 그 외(≥1 필수) | `src/core/change-contract-store.ts`, `src/schemas/acg-change-contract.ts:43`(forbidden min 1), `src/acg/scope/resolve.ts` |
| 동작 잠금(regression test first) | `SemanticCompatibility.characterization` + passing test ref. green baseline 아니면 중단 | `src/acg/semantic/semantic-produce.ts`(`buildSemanticSeed`), `src/schemas/acg-semantic-compatibility.ts:75-94` |
| cleanup category(저위험→고위험) | judgment category는 skill 지시, deterministic category(duplication/complexity/dead/coverage)는 `FitnessFunction` 델타 | `src/schemas/acg-fitness-function.ts:14-24`, `src/acg/fitness/fitness-runner.ts` |
| 병렬 cleanup(deep agent, batch 5) | autopilot 노드 + implementer/refactorer 위임, PreToolUse forbidden_scope 유지, mutating 노드 cap | `ditto:autopilot`, `ditto:implementer`/`ditto:refactorer`, `src/hooks/pre-tool-use.ts:494-518` |
| 품질 게이트(test/lint/typecheck/scan) | Stop 훅이 ledger 독해 → 완료 차단 | `src/hooks/stop.ts`(`acgReviewForcesContinuation`/`assuranceSnapshotForcesContinuation`/`semanticForcesContinuation`/`impactForcesContinuation`) |
| 3회 실패 시 중단·보고 | 동일 규칙을 cleanup 노드 실패 정책으로 | autopilot 실패 분류 |
| final report | Change Map + CompletionContract 증거 | `src/acg/change-map/render.ts`, `src/cli/commands/change-map.ts` |

## 2. 축소 ACG 프로파일 — "cleanup profile"

cleanup은 본질적으로 *동작 보존* 변경이므로, full 거버넌스(Impact/Review까지)는 과하다. cleanup profile은 다음만 강제한다:

1. **scope gate (필수)**: ChangeContract `allowed_scope`/`forbidden_scope` + PreToolUse 차단. cleanup이 범위를 넘어 "다른 코드까지 손대는" 가장 흔한 사고를 hot-path에서 막는다.
2. **behavior lock (필수)**: SemanticCompatibility characterization. green baseline 없으면 cleanup 착수 금지.
3. **fitness 델타 (필수, 델타-only)**: duplication/complexity/coverage 새 위반 0. **절대 부채가 아니라 이번 cleanup이 만든 증분만** 본다(fitness-runner의 기존 delta 지원 사용).
4. **Impact/Review (조건부)**: public surface(공개 시그니처/UI 표면)를 건드릴 때만 켠다. 순수 내부 cleanup은 생략.

> 프로파일은 새 스키마가 아니다. 기존 ledger들을 *어떤 것을 켜고 끄는지*의 결선 규칙이다. cleanup profile 토글은 work item intent에 플래그 하나로 적재한다.

## 3. 작업단위 (착수 표면)

각 WU: 목표 / 변경 대상 / 수용기준(관측 가능) / 검증 / 의존 / 되돌리기. WU-0만 이 계획의 일부로 권고하고, WU-1~4는 별도 착수 허가 대상.

### WU-0 — ADR-0017 작성 (structural; 이 계획의 일부)

- **목표**: 두 결정을 권위있게 박는다. (a) DITTO는 OmO remove-ai-slops *운영 패턴*을 ACG-grounded `deslop` 워크플로로 흡수한다. (b) DITTO는 **2차 정적 분석 엔진(ast-grep 포함)을 도입하지 않는다 — ADR-0006 유지**. slop의 결정론 검출이 필요하면 기존 CodeQL provider 또는 command/executed provider를 쓴다. ast-grep 재고 조건을 명시(WU-4 철회조건).
- **변경 대상**: `.ditto/knowledge/adr/ADR-0017-cleanup-deslop-on-acg.md`(신규), CLAUDE.md ACG 지식 projection 갱신.
- **수용기준**: ADR 파일이 기존 ADR 포맷(상태/일자/결정자/컨텍스트/결정/대안/철회조건)을 따른다. ADR-0006과의 관계(보강·비충돌)가 본문에 명시된다. ast-grep "도입 안 함 + 철회조건"이 결정으로 박힌다.
- **검증**: `ls .ditto/knowledge/adr/ADR-0017*` + 본문에 ADR-0006 참조 grep. `ditto adr` 가드가 있으면 통과.
- **의존**: 없음.
- **되돌리기**: 파일 삭제 + projection revert.

### WU-1 — `deslop` skill: scope + behavior lock (축소 프로파일 진입)

- **목표**: branch diff에서 cleanup scope를 산정해 ChangeContract(allowed/forbidden)를 만들고, 대상 파일의 동작을 characterization으로 잠근다. green baseline 아니면 중단.
- **변경 대상**:
  - `.claude/skills/deslop/SKILL.md`(신규) — 절차 문서. OmO 단계를 ACG 명령으로 번역(복제 아님).
  - scope 산정 헬퍼: 기존 `merge-base main..HEAD --name-only` + 제외 규칙(deleted/binary/generated/vendor/lockfile). 가능하면 `src/cli/commands/change-map.ts`/`impact.ts`가 이미 쓰는 diff 유틸 재사용.
  - ChangeContract 생성: `src/core/change-contract-store.ts` 재사용. `allowed_scope`=diff 파일 glob, `forbidden_scope`=`["**/*"]` minus allowed(스키마상 ≥1).
  - behavior lock: `src/acg/semantic/semantic-produce.ts`의 characterization seed 경로 재사용.
  - dist projection: `dist/plugin/skills/deslop/`, `dist/codex-plugin/skills/deslop/`.
- **수용기준**:
  1. 더러운 브랜치에서 skill 실행 → `change-contract.json`이 생기고 `allowed_scope`가 정확히 diff 파일을, `forbidden_scope`가 그 외를 가리킨다.
  2. `forbidden_scope`에 든 파일을 편집하려 하면 **PreToolUse가 `exitCode:2`로 차단**한다(관측: 실제 차단 로그/테스트).
  3. baseline 테스트가 red이면 skill이 cleanup 착수 없이 중단·보고한다.
- **검증**: DITTO 자체에서 dogfood — 의도적 slop을 심은 브랜치에 실행. `tests/acg/`에 scope 산정·차단 단위 테스트 추가. `bun test tests/hooks/pre-tool-use.test.ts`(차단 경로 회귀).
- **의존**: WU-0.
- **되돌리기**: skill 파일·projection 삭제. ChangeContract 경로는 기존 자산이라 영향 없음.

### WU-2 — slop category → FitnessFunction 델타 게이트

- **목표**: cleanup 대상 category 중 결정론 가능한 것(duplication/complexity/coverage)을 FitnessFunction으로 선언하고, cleanup 전·후 스냅샷의 **델타(새 위반)만** 게이트한다.
- **변경 대상**:
  - fitness 선언: ICL `judge/cmd/query` 또는 직접 `FitnessFunction[]`. **신규 엔진 없음** — `command`/`executed` provider로 changed-file 한정 실행, 또는 이미 배선된 CodeQL provider(`src/acg/fitness/codeql-provider.ts`) 사용.
  - 델타 결선: `src/acg/fitness/fitness-runner.ts`의 `assessDelta`/`normalizeViolationIdentity`(raw line 제외) 재사용. cleanup profile에서는 **delta>0이면 fail**.
  - Stop 게이트는 이미 `outcome=fail`을 소비(`src/hooks/stop.ts` `assuranceSnapshotForcesContinuation`) — 추가 결선 불필요.
- **수용기준**:
  1. cleanup 전 스냅샷과 후 스냅샷이 생기고, 후-전 델타가 0이면 통과.
  2. cleanup이 **새 duplication/complexity 위반을 만들면** Stop 훅이 완료를 차단한다(테스트).
  3. **기존(이전부터 있던) 부채는 게이트하지 않는다** — 델타-only임을 테스트로 고정.
- **검증**: `bun test tests/acg/fitness-runner.test.ts` + cleanup-델타 시나리오 신규 테스트. dogfood 브랜치에서 전·후 `assurance-snapshot.json` 대조.
- **의존**: WU-1.
- **되돌리기**: fitness 선언 제거. fitness-runner는 기존 자산이라 무변경.

### WU-3 — 병렬 cleanup 노드 (autopilot 위임, scope gate 유지)

- **목표**: 파일 단위 cleanup을 implementer/refactorer 서브에이전트에 배치 위임. 각 child 제약(동작 보존, public API 시그니처 불변, 최소 diff, category별 근거 보고). 한 파일 3회 실패 시 중단·보고.
- **변경 대상**:
  - cleanup 노드 템플릿: autopilot 노드 그래프에 cleanup lifecycle stage 매핑(refactorer=Tidy First, behavior-preserving는 이미 존재).
  - 배치 cap: autopilot의 mutating-node cap 재사용(메모리노트 `project_dogfooding_thread`: wave 병렬 spawn + mutating 1개 cap). cleanup은 파일 독립이라 cap을 높일지 여부는 dogfood로 결정.
  - 실패 정책: 3-strikes → stop+report(OmO 미러).
- **수용기준**:
  1. 의도적 slop 브랜치에서 cleanup 완료 → reviewer가 behavior-preserving 확인.
  2. cleanup 중 forbidden_scope 편집 시도가 차단된다(WU-1 게이트가 병렬에서도 유효).
  3. fitness 델타 ≤ 0, CompletionContract 통과.
  4. 한 파일 3회 실패 시 사용자에게 파일/시도/실패/가설 보고하고 멈춘다.
- **검증**: DITTO 자체 dogfood end-to-end. reviewer 서브에이전트 verdict + `ditto verify`로 AC 증거 확인.
- **의존**: WU-1, WU-2.
- **되돌리기**: cleanup 노드 템플릿 제거. autopilot 코어 무변경.

### WU-4 — (보류) 구조 검출 헬퍼 / ast-grep 평가

- **상태**: **기본 보류.** WU-0 ADR이 2차 정적 엔진 비도입을 박는다.
- **목표(보류 해제 시)**: judgment이 아닌 결정론 category(예: single-use pass-through wrapper, `any`/`object` 남발)에 대해 cheap 구조 검출이 필요하다고 *측정으로* 입증되면, CodeQL 쿼리(엔진 추가 없음)로 우선 시도하고, 그래도 비용/표현력이 안 맞으면 ast-grep을 별도 ADR로 재고.
- **철회조건(보류 해제 트리거)**: (1) WU-2의 CodeQL/command provider가 cleanup detection에서 DB 빌드 비용 때문에 실사용 불가로 측정됨, **그리고** (2) 동일 검출을 CodeQL 쿼리로 표현했을 때 표현력/비용이 명백히 열위임이 실측됨. 둘 다 충족 전에는 도입하지 않는다.
- **검증(보류 해제 시)**: 별도 ADR + dialectic-review.

## 4. Pre-mortem — "6개월 뒤 이 개선이 실패했다면 왜인가"

각 실패모드에 완화책과 그것을 담는 WU/수용기준을 명시한다.

| # | 실패 시나리오 | 근본 원인 | 완화책 | 어디서 막나 |
| --- | --- | --- | --- | --- |
| **PM-1** | cleanup용으로 ast-grep을 "잠깐만" 추가했다가 2차 엔진이 영구화 → ADR-0006이 죽인 유지비용 재발 | 편의를 위한 엔진 도입 creep | WU-0 ADR이 비도입을 결정으로 박고, ast-grep은 WU-4로 분리·보류. `ditto adr` 가드로 회귀 감시 | WU-0, WU-4 |
| **PM-2** | full ACG ledger가 무거워 cleanup이 그냥 손편집보다 느림 → 아무도 안 씀 | cleanup에 거버넌스 과적용 | **축소 cleanup profile**(§2): scope+behavior-lock+fitness델타만, Impact/Review는 public surface일 때만 | §2, WU-1 |
| **PM-3** | duplication/complexity 결정론 게이트가 노이즈/오탐 → agent가 게이트와 싸우거나 끔 | 절대 부채를 게이트 | **델타-only 게이팅**(이번 cleanup이 *만든* 위반만). 기존 부채 무시 | WU-2 수용기준 3 |
| **PM-4** | characterization 테스트를 cleanup하는 같은 agent가 작성 → 상상한 동작을 검증(horizontal slicing) | 테스트가 동작이 아닌 가정을 고정 | characterization은 cleanup 편집 *전에* 작성·green이어야 하고, SemanticCompatibility가 passing test ref를 스키마로 요구. 가능하면 작성/cleanup 단계 분리 | WU-1 수용기준 3 |
| **PM-5** | 큰 diff에 deslop 실행 → 노드 폭발, 컨텍스트/비용 blowup | 배치/파일수 무제한 | autopilot mutating cap 재사용 + 파일수 상한, **드롭된 파일은 log로 명시**(silent truncation 금지) | WU-3 |
| **PM-6** | cleanup detection 위해 5파일 정리에 CodeQL DB 빌드 → 비현실적 오버헤드 | 무거운 엔진을 경량 작업에 | cleanup detection은 changed-file 한정 command/executed provider 우선, 구조 fitness는 선택. CodeQL fitness는 지속/drift 용도(스케줄)로 한정 | WU-2, WU-4 |
| **PM-7** | OmO SKILL.md를 그대로 복제 → prompt-only skill, 게이트 미결선 → 흡수의 핵심(강제력) 상실 | "도구 복제"를 "흡수"로 착각 | 수용기준이 *skill 텍스트 존재*가 아니라 **PreToolUse/Stop 훅이 실제로 차단함을 테스트로** 요구 | WU-1/2/3 수용기준 |
| **PM-8** | cleanup이 public 시그니처를 건드렸는데 SemanticCompatibility/Impact를 안 켜서 호출자 깨짐 | 축소 profile이 과하게 깎임 | profile은 public surface 변경 감지 시 Impact/Semantic을 **자동 승격**(§2-4). cleanup child 제약에 "public API 시그니처 불변" 명시 | §2, WU-3 child 제약 |

## 5. 검증 전략(전체)

- cleanup이 회귀로 바뀌지 않는다 = **DITTO 자체 dogfood**가 1차 증거. 의도적 slop을 심은 브랜치에 deslop을 돌려 (a) scope 차단, (b) behavior-lock, (c) fitness 델타 ≤ 0, (d) reviewer behavior-preserving verdict, (e) CompletionContract 통과를 모두 fresh evidence로 확인.
- 각 WU는 단위 테스트(`tests/acg/`, `tests/hooks/`)로 게이트 동작을 고정하고, 통합은 dogfood로 닫는다.
- 모든 게이트 주장은 "차단됨"의 실제 exit code/로그로 증명한다(Charter 완료 게이트).

## 6. 미해결 질문

- **Q1.** cleanup profile 토글을 work item intent에 어떻게 적재하나 — 전용 플래그 vs intent kind. (기본값 추천: intent에 `profile: "cleanup"` 한 필드. 비가역 아님 → agent 결정 가능.)
- **Q2.** duplication/complexity의 결정론 evaluator를 어떤 command provider로 채울지(예: 기존 toolchain의 lint/복잡도 룰 재사용 여부). DITTO 자체 toolchain 조사 필요 — WU-2 착수 시 1차 자료 확인.
- **Q3.** WU-3 배치 cap을 cleanup(파일 독립)에서 1보다 높일지. dogfood 측정으로 결정(설계 단계에서 고정 금지).

> Q1~Q3는 모두 구현 세부(저위험)라 agent 판단 영역이다(Charter §4-8). 도메인/제품 가치 판단이 필요한 미해결 질문은 **없음**.
