# ADR-0018: L2 동작 보존 — effect interception(record/replay) 프레임워크

- 상태: proposed (2026-06-15 사용자 결정 — "① CLI 단독 full-bar" 조사 후 옵션 채택. **결정 채택이며 구현/dialectic 재검증은 미완** — implementation·반증 라운드로 검증되기 전까지 proposed 유지. 관련: wi_260615t8o + full-bar-wiring WI)
- 결정 일자: 2026-06-15
- 결정자: hskim, claude
- 관련: ADR-0017(정리 워크플로 — 이 ADR이 그 D5의 L2 differential을 미수정 standing 코드로 확장), ADR-0006(정적 분석 엔진 = CodeQL 단일 — 이 ADR은 그 D2 "TS-AST 금지"를 침범하지 않음을 명시), `src/acg/tidy/l2-differential.ts`(현 pure/trace 모드), `reports/design/agentic-governance/80-acg-cleanup-deslop-plan.md` §4.2·§4.3·§4.4, wi_260615t8o(record/replay/intercept DEFERRED 항목)

## 컨텍스트

Tidy의 L2 behavior-lock(ADR-0017 §4.4 / 80-plan §4.4)은 리팩터가 동작을 보존했는지 *증인*해야 full-bar 자동커밋을 정당화한다. 현재 `src/acg/tidy/l2-differential.ts`는 pure 모드와 trace 모드를 갖지만, trace 모드는 대상 코드가 EffectRecorder seam(`rec.call(...)`)을 **직접 호출해야만** 효과를 기록한다 → 미수정 standing 코드(ditto 대부분이 side-effect: CLI/store/hook)에는 자동 적용 불가이고, 실제로 `src/` 호출자 0건이다.

80-plan §4.2는 record/replay/intercept를 "`src/` 0건 신규 프레임워크"로 명시했고(wi_260615t8o), 그간 DEFERRED 상태였다. pure-only로는 L2의 적용 범위가 순수 함수로 한정돼 full-bar가 도달 불가하므로, 미수정 코드의 실 I/O를 가로채는 계측 경로가 필요하다.

## 결정 — 개발 시 지켜야 할 구조

### D1 — 미수정 코드의 실 I/O를 가로채는 effect interception 프레임워크를 신규 구축한다

등록된 effect 채널(예: `node:fs` 메서드, `node:child_process`, `fetch` 등 **명시적 화이트리스트**)을 런타임에 monkey-patch하여, 대상 함수 실행 중 발생하는 `(channel, args, ordered)` 호출 trace를 기록하고 원복한다. OLD(HEAD 워크트리) · NEW(워킹트리) 두 실행의 effect trace를 기존 `l2-differential` 비교 로직으로 diff한다. 통과 = 미반증(autoCommit `'full'` 자격), 불통과 = 확정 반증.

### D2 — 이것은 런타임 계측이지 정적 분석이 아니다 (ADR-0006과 비충돌)

TS 컴파일러 API/AST를 쓰지 않으므로 ADR-0006(D2: TS-AST 금지)과 충돌하지 않는다. 단, seam 주입을 위해 TS-AST를 쓰는 경로는 **금지**(ADR-0006 유지). 구현은 Bun의 module mock / 명시적 글로벌 메서드 패치 등 런타임 수단으로 한다.

### D3 — 비결정성 정직화 (80-plan §4.3 일관)

trace는 회귀 *탐지*이지 보존 *증명*이 아니다(Rice). 정규화 불가한 시간 / 랜덤 / 동시성 race는 trace도 불안정하므로, 그런 잔여는 'seam 부족'이 아니라 **본질적 자동 검증 불가**로 보고 §4.4의 충분 bar 미달(미검증 강등 → diff-only)로 처리한다. 화이트리스트 밖 effect를 쓰는 코드는 trace 불완전으로 간주해 degraded.

### D4 — 안전: 단일 스코프 패치 + finally 원복 + 격리 실행

패치는 단일 실행 스코프에서만 적용하고 `finally`로 반드시 원복한다(전역 오염 금지). 실 I/O를 RECORD 모드에서 실제로 수행하면 부수효과가 외부에 남으므로, full-bar 자동 정리 대상은 격리(워크트리 / 샌드박스)에서만 실행한다.

## 철회/재검토 조건

- interception 유지비가 적용 범위 대비 과하면 → pure-only로 후퇴.
- 비결정성으로 false 반증이 빈발하면 → pure-only로 후퇴.
- 표준 record/replay 라이브러리가 정책에 맞으면 → 자체 구현을 그 라이브러리로 대체 검토.

## 대안과 기각 이유

- **(a) pure-only** — 적용 범위가 순수 함수로 한정돼 ditto 대부분(side-effect)이 제외된다. 사용자 기각.
- **(b) EffectRecorder seam을 대상 코드에 viral 도입** — 코드 침습적(미수정 코드를 고쳐야 함). 기각.
- **(c) TS-AST 기반 seam 자동 주입** — ADR-0006 D2 위반. 기각.
