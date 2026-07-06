# HANDOFF (remote / cross-PC) — WS3 관제탑 context-rot 레인 ✅ 완료

> **이전 방송("WS3 병렬 착수")을 교체함 — WS3-T1·T2는 이미 구현·랜딩됨. 착수하지 말 것(중복 방지).**
> **작성**: 2026-07-06 · 권위=코드+커밋(charter §4-11). file:line은 fresh 재확인.
> ⚠ prism(wi_260705lc8)은 여전히 parked — 재개 금지(별도 브랜치, issue #11 미확정). 변동 없음.

## 0. 상태 한 줄
WS3-T1·T2 = **done**. wi_2607068bo, land commit `8e90912`(main). 6/6 AC fresh 증거 pass. `.ditto/local` WI 레코드는 gitignored라 이 PC엔 안 옴 — 재개할 것 없음(코드가 권위).

## 1. 무엇이 랜딩됐나 (main)
- `8e90912` — `src/core/autopilot-loop.ts` + `skills/autopilot/SKILL.md` + `tests/core/autopilot-context-pressure.test.ts` + `bin/ditto`. WS3-T1(컨텍스트 압력 회계+임계치 신호) + WS3-T2.
- `1153bd2` — 설계 백로그 §WS3 완료 표시 + T2 접근 재정의 기록.

## 2. T2는 백로그 원문과 다르게 구현됨 (중요)
백로그 §WS3-T2의 "checkpoint→handoff→reset" 프레이밍은 **사용자가 기각**(강제 중단·새 세션 유도가 의도 아님). 실제 구현 = **서브에이전트 적극 위임 + 보고 체계(리셋 없음, §4-9)**:
- `readContextPressure` — 디스크 파생 프록시(`2*(decisionCount+nodeCount)+postCost`, `CONTEXT_PRESSURE_THRESHOLD`), 신규 stored counter 없음. `computePostCost` 헬퍼 추출(중복 제거).
- additive-optional `ContextPressureSignal` → `RecordResultOutcome`/`NextNodeResult`(임계 미만이면 byte-identical).
- **edge-triggered** `ReportDirective`(디스크 band-artifact 존재를 latch로 → 매 라운드 재발화 없음) + `assembleProgressReport`(decisions.jsonl+autopilot.json 결정적 합성, `collectRetroContext` 확장·`projectRetroNarrative` 재사용, fail-open **distinct degraded** 상태).
- `skills/autopilot/SKILL.md:45` — 압력→위임보고 discipline 문서화. (파일은 `skills/handoff` 아님.)

## 3. 남은 것 (후속, 미착수)
- **WS3-T3** — 역할 분리 실측 가드 테스트(`autopilot-dispatch.ts`, tests). 미완.
- 후속 후보(intent 기록): shed-effectiveness on-disk observability 신호(수용된 잔여), collect-side verbatim 경량화, 드라이버 inline 판단/coverage-sweep 재위임, 임계치 실측 튜닝+config 노출.

## 4. Gotchas
- dogfood CLI = `./bin/ditto`(working-tree). src 변경 후 `bun run build:bin`.
- 커밋 훅(`.githooks` pre-commit)이 bin/ditto 재빌드+dist/plugin 재조립 → 문서-only 커밋은 `DITTO_SKIP_HOOKS=1`로 건너뛰어도 됨.
- 전체 `bun test` 중 surface-catalog 5~6건은 gitignored `.ditto/local/surfaces*.json` 부재로 환경-fail(신규 회귀 아님).
