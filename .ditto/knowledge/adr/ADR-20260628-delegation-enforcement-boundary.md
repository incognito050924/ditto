# ADR-20260628-delegation-enforcement-boundary: 위임 규율 집행 경계 — codified-artifact까지, 행동 강제는 불가

- 상태: accepted
- 결정 일자: 2026-06-28
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: 헌장 §4-9 (위임으로 컨텍스트를 지킨다 — 이 결정이 그 규율의 *집행 가능 상한*을 명문화). 발의: wi_260627jhh(컨텍스트 관리 강화)의 ac-5 도그푸딩 + 후속 위험 리뷰. 구현 WI: clause-presence는 wi_260627jhh(621d893), repo-source 핀은 wi_260627sey(22b8ba2). 코드(권위): `src/core/instruction-bridge.ts` checkRequiredClauses·DELEGATION_CLAUSE_ANCHOR·CHARTER_IDENTITY_MARKER, `tests/core/instruction-bridge.test.ts:87-116`(clause_missing·비-charter 무탐지·repo 핀). **supersede 없음.**

## 컨텍스트

wi_260627jhh의 ac-5는 "메인 대화 에이전트의 위임 규율을 prose가 아닌 *집행 신호*로 동반한다"였고, 사용자는 "A2를 집행 가능(prose 아님)으로 못박은 것"을 명시 확인하며 진입했다. 그러나 구현은 charter 문서에 §4-9 앵커가 *존재하는지*를 결정적으로 검사하는 clause-presence였다 — 에이전트가 위임을 *수행하는지*가 아니라 규율이 *적혀 있는지*만 본다.

후속 위험 리뷰에서 이 갭을 "열린 위험"으로 분류할지 검토했다. 핵심 질문: 메인(하네스 최상위) 대화 에이전트가 실제로 탐색·벌크 분석을 subagent에 위임하도록 코드로 *강제*할 수 있는가?

## 결정

**위임 규율의 집행 상한은 codified-artifact 검사다 — 행동 자체는 코드로 강제 불가능하며, 이는 결함이 아니라 입증된 경계다.**

- 메인 대화 에이전트의 위임 *행동*은 코드로 강제하지 않는다(못한다).
- 가능한 최대 집행은 (a) charter 소스에 §4-9 앵커가 present한지 결정적 단정(clause-presence)과 (b) 이 repo 정본 charter 소스(AGENTS.md)를 코드 상수에 핀해 rename 시 loud 실패시키는 것이다. 둘 다 적용 완료.
- ac-5는 이 경계를 충족한 것으로 **accepted-limitation으로 닫는다.** 잔여(행동 미집행)는 "나중에 할 에이전트 작업"이 아니라 코드의 한계다.

## 근거 (rationale)

코드로 검증한 근거(외부 문서 경로 대신 본문에 직접 담는다, §4-11):

- **하네스 최상위 에이전트는 코드 집행점이 없다.** clause-presence 검사는 always-on `ditto doctor instructions` CLI seam에 배선되어 `runHook`이 아니므로 `DITTO_SKIP_HOOKS` kill-switch와 독립이다(`instruction-bridge.ts` checkRequiredClauses 주석). 그러나 이는 *문서의 무결성*만 보장한다 — subagent spawn은 비관측이고, 행동을 강제하려면 hook이 필요한데 hook은 kill-switch 가능하다. 즉 "행동 강제"는 우회 가능한 신호로만 가능하고, 그건 강제가 아니다.
- **projection-integrity가 못 잡는 갭을 clause-presence가 닫는다.** sha/content 매칭은 소스·투영 *양쪽에서* 앵커를 지우면 여전히 일치한다. 소스에 대한 clause-PRESENCE 단정이 그 갭을 닫는다(`instruction-bridge.test.ts:87`).
- **clause-presence는 마커 부재 시 비-charter로 보고 무탐지한다.** `checkRequiredClauses`는 CHARTER_IDENTITY_MARKER가 없으면 `[]`를 반환해 다운스트림/사용자 AGENTS.md 오탐을 막는다(`instruction-bridge.test.ts:110`). 그 부작용으로 *정본 charter가 rename되면 가드가 조용히 꺼지는* 위험이 있어, repo 정본 소스를 코드 상수에 핀하는 테스트로 닫았다(wi_260627sey).
- **intent가 이미 이 한계를 선언했다.** wi_260627jhh intent.json의 unknowns: "메인 대화 에이전트를 코드로 어디까지 강제 가능한지 미확정 — A2(ac-5)의 최대 난점." 결정은 그 미확정을 "불가"로 확정한 것이다.

기각된 대안:

- **hook으로 행동 강제** — hook은 `DITTO_SKIP_HOOKS`로 kill-switch 가능하고 정상 read-only 명령에 false-positive를 내 차단되므로, 강제의 신뢰 기반이 되지 못한다.
- **"열린 위험"으로 보류** — 처분이 아니라 미루기(헌장 §4-8 위반). 더 할 코드 작업이 없으므로 accepted-limitation으로 닫는 것이 정직하다.

## 변경 조건 (change_condition)

하네스가 subagent spawn을 관측 가능하게 노출하거나(예: 세션 후 Task 호출 telemetry), kill-switch 불가능한 행동 집행점을 제공하면 재검토한다 — 그때는 "위임했는가"의 사후 관측이 가능해져 codified-artifact 너머로 갈 수 있다. 그 전까지 이 경계는 유효하다.
