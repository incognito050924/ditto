# Handoff — semantic 거버넌스 트랙 후속 (2026-06-05 세션 종료)

> 최신 thread 핸드오프. 기준 **main = bbe7f52**. 이번 세션은 B 트랙(semantic 의미-호환성 거버넌스)을
> 거의 닫았다. 남은 건 아래 §2의 후속들 — 우선순위·영향과 함께 정리한다.
> 이전 핸드오프(`wi_260605dg2/handoff.md`)의 "B·D만 남음" 중 **B는 완료**, D는 §2-C에 이월.

## 0. 셋업 / 현재 상태
```bash
git pull                 # main bbe7f52 이상
bun install
bun run build && bun link
bun test                 # 1175 pass / 7 skip / 0 fail
```
- **CodeQL 로컬 필요**(semantic scan/observe·signature 추출 e2e). `~/.local/bin/codeql`(2.25.5 확인). 단위테스트는 CodeQL 없이 통과; e2e는 `CODEQL_E2E=1 CODEQL_BIN=~/.local/bin/codeql bun test <file>`로만 돈다(기본 skip).
- `.ditto/cache/`(codeql DB·worktree)는 gitignore. observe는 DB 2회 빌드라 비용 큼(opt-in 성격).
- bare `ditto`는 dist → 소스 변경 시 `bun run build`.

### 이번 세션에 닫은 것 (전부 main, 각 completion.json)
- **wi_260605sv1** — OBJ-43 semantic verdict 생산 MVP: 스키마(yes는 reproducibility 필수, old_meaning sentinel) + `ditto semantic detect`(수동 seed)/`verdict`(resolver, 데드락 해소). dialectic 설계(reviews/dialectic-1).
- **wi_260605de1** — semantic diff-extractor를 **CodeQL**로(1차 TS-AST는 ADR-0006 위반 → `d25c9b3` revert 후 재구현). `ditto semantic scan` + signature-codeql.ts(export 시그니처 CodeQL 추출, **javascript 바인딩만**, 타 언어 fail-loud). 실 CodeQL e2e.
- **wi_260605aw1** — autowiring(휴면 파이프라인 활성화). dialectic이 Stop 훅 CodeQL을 기각(ADR-0001) → S1(Stop AX nudge, git만·non-blocking) + S2(`ditto semantic observe`→비-게이트 observation, fingerprint skip) + S3(nudge↔observation 통합 + observe base fallback). verify 스킬에 observe 지시 배선.

### 현재 닫힌 루프 (위임 계약의 ACG '방향 유지' 기둥)
변경 → Stop nudge "observe 권유" → verify에서 `ditto semantic observe` → 비-게이트 관측 → Stop nudge "승격 권유" → 의미 깨짐이면 `detect`/`verdict`로 blocking → 게이트 발동. 0변경이면 조용히 통과. **단 실제 시그니처 추출은 javascript만** 동작(§2-A).

## 1. ditto 멘탈모델 (왜 이 작업들이 중요한가)
DITTO = **위임 계약**(메모리 `ditto-primary-lifecycle`). 사람과 Agent가 요건을 모호성 0으로 잠그고(deep-interview), Agent가 자율 오케스트레이션으로 구현하되 **ACG가 방향을 잃지 않게** 막고, **e2e가 합의된 결과를 검증**한다. semantic 트랙은 ACG의 "방향 유지" 기둥 — "잠긴 의도(시그니처/의미 호환성)에서 벗어난 done"을 차단·안내. 아래 후속들은 이 기둥을 더 넓고(다언어) 단단하게(characterization) 만든다.

## 2. 다음 작업 (우선순위순)

### A. 다언어 signature 바인딩 — [최우선]
- **무엇**: `src/acg/semantic/signature-codeql.ts`의 `SIGNATURE_QUERIES`에 java/kotlin/python export-시그니처 CodeQL 쿼리를 추가(현재 javascript만; 타 언어는 `signatureQuery()`가 fail-loud throw). relations.ts impact 쿼리(JAVA/PY 이미 있음)와 동일한 "바인딩이 분석기를 꽂는다" 패턴.
- **범위·착수**: de1의 ac-0처럼 **probe 선행**(언어별 CodeQL이 시그니처를 복원하는지 합성 DB로 실증) → 쿼리 상수 추가 → `SIGNATURE_QUERIES`에 등록 → CODEQL_E2E 테스트(언어별 fixture). Java는 `Callable.getParameterType`, Python은 best-effort(동적 타이핑). kotlin은 java 추출기 재사용(relations.ts 선례).
- **ditto 영향·효과**: **가장 크다.** 지금 semantic 거버넌스는 JS/TS 저장소에서만 작동한다. boxwood(Java/Camunda — ADR-0006 D4의 검증 대상)처럼 ditto가 실제로 겨냥하는 다언어 저장소에서 시그니처 변경이 **게이트 밖으로 빠진다**(fail-loud라 침묵 false-clean은 아니지만 커버리지 0). 이걸 닫아야 "위임받은 Agent가 어떤 스택에서든 방향을 안 잃는다"가 성립.

### B. characterization 게이트 — [중상]
- **무엇**: `semantic_safe='yes'`(의미 안전) verdict가 **behavior test를 인용하도록 강제**. 현재 yes는 `reproducibility(model_version)`만 요구(`acg-semantic-compatibility.ts:55`) — LLM이 "안전하다"고 판정만 하면 통과한다. sv1 dialectic의 O6 후속: `characterization.exists + test_ref`(또는 동등 증거)를 yes의 추가 조건으로.
- **범위·착수**: 스키마 superRefine에 "yes ∧ agent-produced → characterization.exists==true ∧ test_ref 존재" 규칙 추가 + schemas:export + 테스트. 기존 yes fixture들 갱신 필요(stop.test.ts 등).
- **ditto 영향·효과**: ACG 게이트의 **assurance를 한 단계 올린다**. "검증 안전"이 LLM 판정만이 아니라 **실제 통과하는 characterization test**에 묶인다 → 위임 계약의 "합의된 결과" 보증이 단단해짐. e2e 기둥과도 직결(yes는 테스트가 증인).

### C. D — 호스트-추상 기계 결정 (ADR) — [저, 아마 보류]
- **무엇**: provider-슬롯(analyzer 주입) 위에 추가 호스트-추상 계층을 둘지 **결정**(빌드 아님). 이전 핸드오프 판정: "결정하되 아마 보류" — provider 슬롯이 이미 stack-agnostic이라 조기 추상화는 헌장이 경고하는 바로 그것.
- **범위·착수**: 짧은 dialectic 또는 분석 → ADR로 "보류 + 철회조건" 기록. 코드 변경 0 가능.
- **ditto 영향·효과**: 낮음. 열린 아키텍처 질문을 닫아 **모호성을 제거**하는 가치(다음 세션이 또 고민 안 하게). 빌드 효과는 없음.

### 소소 (옵션)
- **aw1 refinement**: ① `semantic-scan-status.json`(observe 실패의 durable 가시화, OBJ-7) — 지금은 observe가 실패를 즉시 노출하지만 nudge가 "observe 권유"를 반복할 수 있음. ② nudge 침묵용 opt-out(의미무관 work item). 둘 다 저가치.
- **executed 자동 stop 트리거**(ex1 후속): 현재 `--execute` opt-in만. 비용 회피로 의도된 보류.
- **어휘 enum 승격**(`risk_reason_code` 등): 설계상 "2nd 바인딩에서 반복성 확인 후" 보류. 미미.

## 3. gotcha / 연속성
- **연속성 = memory + git + work-items**(별도 핸드오프 불필요가 원칙이나, 이번엔 사용자 요청으로 명시 작성). 메모리: `ditto-primary-lifecycle`(위임 계약·세 기둥 WHY), `ditto-mental-model`(자율주행 이식·native-first), `dogfooding-increment-thread`.
- **semantic 명령 4개**: `scan`(수동 단일 seed, blocking), `observe`(자동 관측, 비-게이트, fingerprint skip), `detect`(명시 단일 seed), `verdict`(resolver). scan↔observe 차이 = blocking seed vs non-gated list.
- **nudge는 git만**(CodeQL 미실행) — Stop 성능계약(ADR-0001) 준수. observe만 CodeQL(비쌈, 명시 발동).
- **ADR-0006이 load-bearing**: 구조/관계/시그니처의 결정론 추출은 **CodeQL 단일**, 언어-컴파일러 직접 분석기(TS 컴파일러 등) **금지**. de1 1차 시도가 이걸 어겨 revert함 — 같은 실수 반복 금지.
- **schema는 Zod가 정본**(ADR-0002): `src/schemas/*.ts` 수정 후 `bun run schemas:export`로 JSON 파생. 손편집 금지.
- work item id = `wi_`+8자↑. completion `evidence.kind`∈command/file/artifact/url/note. final_verdict=pass면 in-scope unverified 금지.

## 4. forbidden scope creep
- A를 ADR-0006 어기고 언어 컴파일러로 직행 금지(CodeQL 쿼리만).
- B를 characterization "생성 파이프라인"으로 부풀리지 말 것 — yes의 **증거 요구**만(테스트 생성은 별개).
- C를 호스트-추상 기계 **빌드**로 직행 금지(결정 먼저, 보류가 기본값).
- 닫힌 work item(sv1/de1/aw1) 재작업 금지.
- Stop 훅에 CodeQL 넣지 말 것(aw1 dialectic이 기각한 바로 그것).
