# ADR-20260713-directive-fidelity-banner-gate: 사용자향 배너이면서 동작 지시인 문자열의 리라이트는 operative-cue 충실도로 게이트한다 (가독성만으로는 불충분)

- 상태: accepted
- 결정 일자: 2026-07-13
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: ADR-20260625-premortem-relevance-gate·ADR-0023 (pre-mortem 카테고리-완전 커버리지 — `directive-fidelity`는 그 스윕에서 발견돼 상설 tier-② 카테고리로 승격된 산물), ADR-0024 (완료=per-AC oracle 수렴 — cue-fidelity 검사는 가독성 oracle과 **AND**되는 별도 oracle이지 대체가 아니다), ADR-20260708-autopilot-test-tier-boundary (유닛/목 barrier가 못 잡는 검증 부류가 있음 — coherent-but-unfaithful 리라이트가 그 사례; per-cue 단언 또는 live 행동만 잡는다). 코드(권위): `src/core/charter.ts`(`PRIME_DIRECTIVE`:60 + `charterProjection`:149 — work-item advisory 합성), `src/hooks/user-prompt-submit.ts`(`charterProjection` → `additionalContext`:341/348 — 매 UserPromptSubmit 주입), `src/core/mode-doctor.ts`(`formatModeBanner`), `src/hooks/session-start.ts`(`formatModeBanner` → SessionStart `additionalContext`:48/54), 커버리지 카테고리 `.ditto/coverage-taxonomy.json`(`id: "directive-fidelity"`, disposition `code-verify`), 회귀 락 `tests/core/charter.test.ts`(operative-cue 배열 단언:128-158 — "PRIME_DIRECTIVE keeps every operative cue"). 촉발 WI: wi_260713nlg(ac-3).

## 컨텍스트

DITTO는 사용자에게 보이는 배너 문자열 몇 개를 매 턴/세션 시작에 LLM 컨텍스트로 주입한다:

- **charter projection** — `PRIME_DIRECTIVE` + work-item advisory가 `charterProjection`으로 합성돼 매 UserPromptSubmit마다 `additionalContext`로 주입된다.
- **SessionStart 모드 배너** — `formatModeBanner`가 SessionStart 훅에서 `additionalContext`로 주입된다.

이 문자열들은 화면 표시용 copy처럼 읽히지만, 실제로는 **매 턴 에이전트 행동을 조종하는 런타임 LLM 지시**다. 명령(imperative), 금지(prohibition), 가중치-라우팅 임계값(weight-routing threshold), 완료 게이트(completion gate), 모드-배너 종료 지시(exit instruction)가 그 안에 operative cue로 실려 있다.

wi_260713nlg는 이 문자열들을 "plain-Korean"으로 리라이트/평문화/번역하는 작업이었다. 문제: 이런 리라이트를 **어떤 기준으로 게이트할 것인가**. 기본 검사(스냅샷 + 미설명-약어-수 + 가독성 자가점수)는 리라이트가 *읽기 쉬워졌는가*만 본다. 그런데 이 문자열은 표시 copy가 아니라 지시이므로, 게이트가 놓치면 실패는 매 미래 세션의 에이전트 행동 저하로 나타난다.

## 결정

**사용자향이면서 동시에 동작 지시(operative directive)인 배너 문자열**(charter projection, 모드 배너)의 리라이트/평문화/번역은 **operative-cue 충실도(directive-fidelity)로 게이트한다** — 가독성만으로는 통과시키지 않는다.

- **게이트 기준 = before→after per-cue 검사.** 모든 imperative·prohibition·weight-routing threshold·completion gate·mode-banner exit instruction이 리라이트 후에도 **동일한 힘(force)과 극성(polarity)으로 살아남는지**를 큐 단위로 단언한다. 극성까지 본다 — 금지가 제안으로, "반드시"가 "가능하면"으로 부드러워지는 것을 잡아야 한다.
- **가독성 검사와 AND된다.** 가독성(짧은 문장·전사어 감소)은 별개 oracle로 남되, cue-fidelity 검사와 **동시 충족**해야 리라이트가 통과한다(ADR-0024의 다중-oracle AND 정합). 가독성이 올라가도 cue가 약화되면 red.
- **집행 위치.** cue-fidelity는 `tests/core/charter.test.ts`의 operative-cue 배열 단언(각 cue substring이 `charterProjection()` 출력에 존재)으로 코드에서 강제한다. wi_260713nlg ac-3는 이를 27-cue 배열 + 1회성 사람 before/after 대조 읽기로 착지시켰다.
- **커버리지 카테고리로 상설화.** `directive-fidelity`는 `.ditto/coverage-taxonomy.json`에 disposition `code-verify`인 상설 tier-② 커버리지 카테고리로 등록됐다 — 이후 배너-지시 리라이트는 이 카테고리를 통과해야 한다.

## 근거 (rationale)

- **이 문자열은 매 턴 에이전트를 조종한다.** charter/mode 배너는 표시된 뒤 사라지는 copy가 아니라 `additionalContext`로 주입돼 LLM 추론의 일부가 된다. 그래서 문자열의 회귀는 UI 회귀가 아니라 *행동 회귀*다 — 모든 미래 세션에 걸쳐, 눈에 안 보이게 누적된다.
- **가독성 검사는 operative force에 직교~적대적이다.** 스냅샷은 *어떤 문자열이 나왔든* 그것을 고정할 뿐 힘을 검증하지 않는다. 미설명-약어-수와 가독성 자가점수(전사어 감소·문장 단축)는 **금지가 조용히 제안으로 약화되거나 라우팅 임계값이 누락되는 동안에도 올라갈 수 있다.** 즉 기본 검사가 초록인 채로 지시가 무너진다.
- **유닛/목 테스트는 coherent-but-unfaithful 리라이트를 못 잡는다.** 문법적으로 매끄럽고 의미가 통하지만 operative cue 하나가 빠진/약해진 리라이트는 스냅샷·가독성·일반 유닛 테스트를 모두 통과한다. 오직 **per-cue before→after 단언** 또는 **live 에이전트 행동**만 잡는다(ADR-20260708이 못박은 "barrier가 못 잡는 검증 부류"의 구체 사례).
- **pre-mortem이 발견한 실 카테고리다.** 이 위험은 wi_260713nlg 커버리지 스윕에서 발견된 pre-mortem 카테고리이고 adversarial opponent가 확인했다 — 사변이 아니라 실제로 표면화돼 상설 커버리지 카테고리로 승격됐다.

## 기각된 대안 (rejected alternative)

- **배너 리라이트를 평범한 문자열 편집으로 취급하고 가독성 + 스냅샷만으로 게이트.** 기각. 이 게이트는 operative-cue 회귀를 **검출하지 못한다** — 실패가 배포된 자동 검사(스냅샷·가독성·유닛)에 전부 보이지 않고, 매 미래 세션의 에이전트 행동 저하로만 나타난다. 문자열이 지시라는 사실을 무시하고 표시 copy로 오분류하는 것이 근본 오류다.

## 변경 조건 (change_condition)

- **charter/배너 주입이 더 이상 operative가 아니게 되면** — 예: 배너가 순수 표시용이 되고 별도의 machine-readable 지시 채널(에이전트가 실제로 읽는)이 operative 규칙을 운반하게 되면 — 배너 텍스트에 대한 cue-fidelity 게이트는 완화할 수 있다. 그때 게이트는 표시 copy가 아니라 그 새 지시 채널로 옮겨간다.
- `directive-fidelity` 카테고리가 실사용에서 정당한 리라이트를 반복 차단하거나(너무 촘촘) 반대로 실 회귀를 흘리면(너무 성김) → cue 열거 방식(고정 배열 vs 구조적 추출)을 재검토. 단, "가독성만으로는 불충분"이라는 코어 결정은 유지.
