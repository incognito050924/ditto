---
title: "CodeQL × DITTO 접목 실행 계획"
kind: plan
last_updated: 2026-06-02 KST
depends_on:
  - "codeql-research-ko.md (연구·PoC·창발 연구 부록2~5)"
status: draft (착수 전, 사용자 승인 대기)
scope: "DITTO 하네스가 target repo를 CodeQL로 분석한 결과를 게이트·증거·변증법에 결정론 입력으로 주입"
---

# CodeQL × DITTO 접목 실행 계획

> 계획 원칙(charter §5-2): 각 단계는 **검증 가능한 목표**다. 변경 대상 + done_when + 검증 방법 + 위험/되돌리기를 함께 둔다. Tidy First — 구조적/동작적 변경 별도 커밋, 구조 먼저. schema first(ADR-0002) — 스키마 필요 시 zod 먼저. 의도를 조용히 축소하지 않는다.

## 0. 목표와 한 줄 정의

> DITTO 게이트가 현재 못 보는 빈칸(증거의 *내용*, opponent의 *결정론성*, 변경의 *영향 반경*)을, **target repo에 대한 CodeQL 결정론 사실**로 채운다. CodeQL은 reviewer lane에서 1회 실행·캐시되고, 게이트/변증법은 그 산출물만 읽는다.

근거: 연구 부록5 관통 진단 — `completionEvidenceGate`(`src/core/gates.ts:188-200`)는 verification 존재만 보고 내용을 안 본다.

## 1. 아키텍처 결정 (변하지 않는 전제)

| 결정 | 이유 | 근거 |
|---|---|---|
| CodeQL은 **`run-with` reviewer profile**에서 실행, **1회 DB 캐시** | DB 생성 13.8초~3분(부록2~4). 매 게이트 재생성 비현실적 | `src/core/run-with.ts:159`, 부록3 비용 |
| **stop hook은 CodeQL을 직접 호출하지 않음**, 산출물(SARIF/evidence)만 read | stop은 동기·고빈도. 비용 구조 불일치 | 부록2 결론 |
| CodeQL **pack/model/쿼리는 target repo 자산**, DITTO는 실행·증거화만 | "자동차는 안 만든다" 경계 | 멘탈모델, 부록5 비판 |
| 게이트 연결은 **절대값 alert이 아니라 delta(순증)** 기준 | false-positive가 곧 무한루프(부록2 PoC-2: 구조쿼리 56건) | 부록3 line-noise 교훈 |
| 쿼리는 **taint(path-problem)** 우선, 구조 쿼리 지양 | 구조 쿼리는 noisy → 게이트 거짓 차단 | 부록2/3 |

## 2. 단계별 실행 (의존 순서대로)

### WI-1 — 기반: CodeQL runner (reviewer lane)
- **목표**: `run-with` reviewer profile에서 **target repo**에 대해 CodeQL DB 생성 → taint 쿼리 → SARIF 산출 → 캐시. 모든 후속 WI의 기반.
- **변경 대상**: `src/core/run-with.ts`(reviewer profile에 codeql 단계), `src/core/hosts/spawn.ts`(CLI spawn 재사용). 신규 `src/core/codeql/runner.ts`(DB 생성·쿼리·캐시 경로 관리).
- **핵심 설계**: 언어별 build mode 분기 — 해석/소스 언어(JS/TS/Python)는 `--build-mode=none`, 컴파일 언어(Kotlin/Java)는 격리 worktree + clean build(부록4 실증). **`LGTM_INDEX_FILTERS` 사용 금지**(JS autobuild 깨짐, 부록4).
- **done_when**: target 샘플 2종(JS/TS 1개, Kotlin 1개)에 대해 DB 생성→SARIF 산출이 fresh evidence(로그+SARIF 파일)로 성공. 산출물은 `.ditto/` 런타임 영역(코드와 분리, charter §9).
- **검증**: `bun test` 신규 runner 단위 테스트(SARIF 파싱) + 실제 target 1종 e2e 스모크.
- **위험/되돌리기**: 대형 target 비용 → DB 캐시 키(commit sha) + 재사용. 되돌리기: runner 모듈 제거, run-with reviewer 단계 원복(독립 모듈이라 격리됨).
- **Tidy**: 구조(runner 모듈 추가) → 동작(reviewer 단계 연결) 분리 커밋.

### WI-2 — E: `doctor codeql` target 적합성 사전판정 (fail-closed) ⭐1순위
- **목표**: 분석 *전*에 target repo의 (a) 언어 CodeQL 지원 (b) **build 재현성/추출 완전성**을 판정. 미달 시 exit 1(fail-closed). **빈 분석이 '깨끗함'으로 오판되는 거짓통과 방지**(부록4: Kotlin build-mode none → 6/666 클래스).
- **변경 대상**: `src/cli/commands/doctor.ts`(서브커맨드 `codeql` 추가, 기존 instructions/permissions/mcp/capability 패턴 복제), `src/core/capability-inventory.ts`(fail-closed finding 패턴 재사용).
- **판정 휴리스틱**: WI-1 runner를 probe 모드로 호출 → "추출된 source 심볼 수 / 파일 수 > 임계"(예: 클래스/파일 비율). build 실패 또는 추출량 미달이면 finding.
- **done_when**: (red→green) ① 지원 언어+정상추출 target → exit 0. ② Kotlin을 build 없이 준 경우(추출 6클래스) → **finding + exit 1**. ③ 미지원 언어(PHP) → finding + exit 1.
- **검증**: `bun test` doctor codeql 테스트 3 케이스 + `bun run lint`.
- **위험/되돌리기**: 임계값 오탐(정상인데 미달 판정) → `--advisory` 플래그로 exit 0 강등(doctor.ts 기존 패턴). 되돌리기: 서브커맨드 제거.
- **왜 1순위**: 최저 비용·최고 안전. **다른 모든 CodeQL 게이트의 전제** — 이게 없으면 거짓 음성 위에 게이트가 선다.

### WI-3 — 변환: SARIF → evidence + objection 모양
- **목표**: CodeQL SARIF를 DITTO 두 소비처 형태로 변환. (a) codeFlow → `evidenceRef{kind:'artifact'}`+sha256 → `EvidenceRecord`. (b) finding → `kind=finding, maps_to=file:line, backed_by=codeFlow` objection 모양.
- **변경 대상**: 신규 `src/core/codeql/sarif-adapter.ts`. `src/core/evidence-store.ts:87`(appendRecord 재사용). 스키마는 **변경 없음 예상**(reviewer-output/evidence-record/dialectic이 이미 수용) — 확인 후 필요 시 zod 먼저.
- **done_when**: 실제 SARIF(부록3 frontend) → EvidenceRecord N개 + objection N개로 변환, 각 필드 충족(maps_to·backed_by 비어있지 않음) 테스트 green.
- **검증**: `bun test` 변환 단위 테스트(고정 SARIF fixture → 기대 레코드).
- **위험/되돌리기**: SARIF에 snippet/severity 기본 미포함(부록1) → source 파일에서 보강(Vulnhalla 방식). 되돌리기: adapter 모듈 제거.
- **Tidy**: 순수 변환 함수(구조) — 동작 변경 없음, 단일 커밋.

### WI-4 — B: dialectic 결정론 opponent ⭐2순위
- **목표**: WI-3가 만든 objection을 dialectic ledger에 주입 → `dialecticForcesContinuation`(`src/hooks/stop.ts:25-51`)이 admissible(severity high/critical + maps_to)인 CodeQL objection 미해결 시 종료 차단. **synthesizer가 명시적으로 반박(rejected_objections+근거) 또는 수정해야만 통과.**
- **변경 대상**: `src/schemas/dialectic.ts:63-81`(objection source에 'codeql' 추가 — zod 먼저), dialectic opponent 주입 경로, `src/hooks/stop.ts:43-49`(admissibility 그대로 재사용).
- **done_when**: (red→green) ① CodeQL high-severity objection 미해결 → stop **차단(exit 2)**. ② synthesizer가 grounded rejection 또는 fix 후 → 통과. ③ **round_cap 도달 시 무한루프 안 됨**(convergence.ts round 제한).
- **검증**: `bun test` stop hook 테스트 3 케이스. 정당한 종료 회귀 테스트 유지.
- **위험/되돌리기**: **false-positive = 무한루프**(최대 위험). 완화: ① taint 쿼리만(구조 쿼리 금지) ② delta(순증)만 objection화 ③ round_cap 강제 ④ `--advisory`로 비차단 모드 우선 배포 후 관측. 되돌리기: objection source 'codeql' 비활성 플래그.
- **왜 2순위**: 최고 창발성·스키마 최소 변경. 단 WI-1~3 + 위험 완화가 선행돼야 안전.

## 3. backlog (검증된 가치, MVP 이후)
- **C** 언어원장 → model pack 컴파일 (`language-ledger.ts`) — 난이도 높음, 용어→tuple 매핑 PoC 선행.
- **D** 핸드오프 도달성 델타 (`context-packet.ts:57-85`).
- **G** convergence score에 도달성 델타 (`gates.ts:204-213`).
- **H** cross-service 매칭 evidence sidecar (`evidence-record.ts`, 부록4 승격).

## 4. 명시적 비범위 (안 한다)
- **PreToolUse + CodeQL** — 동기·고빈도 상극, 정규식 가드로 충분(부록5 기각).
- **stop hook 내 CodeQL 직접 호출** — 비용 구조 불일치.
- **DITTO의 CodeQL 쿼리/pack 소유** — 경계 침범. target 자산으로.
- **end-to-end MCP/KG 자동화(D-1)** — 미실증, 별도 연구 후.

## 5. MVP 정의와 완료 기준
- **MVP = WI-1 + WI-2 + WI-3 + WI-4(advisory 모드)**. 즉 "target을 reviewer lane에서 CodeQL 분석 → doctor가 적합성 보장 → 결과가 evidence/objection으로 변환 → dialectic에 비차단 주입".
- WI-4 차단 모드 전환은 **advisory 관측에서 false-positive율 확인 후** 별도 결정.
- 전체 완료: 각 WI done_when green + `bun test`·`bun run lint`·`bun build --compile` 그린 + 각 WI 별도 커밋(구조/동작 분리).

## 6. 핵심 위험 종합
1. **false-positive → 무한루프** (WI-4): taint+delta+round_cap+advisory-first로 4중 완화.
2. **빈 분석 거짓통과** (WI-2가 방어): doctor fail-closed가 전제.
3. **대형 target 비용** (WI-1): commit-sha 캐시.
4. **CodeQL 한계(reflection/dynamic)**: `unverified{out_of_scope}`로 정직하게 표기(스키마 이미 지원, completion-contract `unverified[]`).
