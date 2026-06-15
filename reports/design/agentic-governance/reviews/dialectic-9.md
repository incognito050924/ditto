# Dialectic-9 — 추가분 재검증 (mode=review, round 1/1)

- 대상: `80-acg-cleanup-deslop-plan.md`(v3) + `ADR-0017` — **dialectic-8 이후 추가분 4개** 재검증
- work item: wi_2606158xq · 일자: 2026-06-15 KST
- **verdict: revise** — 개념 reject·blocker 없음. admissible high 5건(전부 코드 오라클 확인). required_edits 6건 반영 시 accept.

## 역할
- **Producer**(`ditto:dialectic-producer`, revise): 셋은 건전, catalog 근거가 repo 가드와 충돌. 정정 2건 제안.
- **Opponent**(`ditto:dialectic-opponent`, codex fallback, 11건): admissible high 5.
- **Synthesizer**(revise): Producer 정정 2건은 부족 → 5건으로 확장.

## admissible high 5건 (전부 코드로 확인)

| OBJ | 핵심 | oracle | disposition |
|---|---|---|---|
| **01** | catalog 변환 'TS 언어서비스 API'가 **src 0건**, `refactorer.md:20` freehand와 모순 — 미존재 능력 위 약속 | grep 0건, package.json:35 | **fixed** — catalog '재사용 자산' 철회→별도 ADR 선결 |
| **02** | 절대부채 fitness 자산 `ditto fitness drift`는 **delta-trend 엔진**(누적 신규위반), 절대 before/after 미측정 | `drift.ts:55,84,123` | **fixed** — drift 지목 삭제→신규 스냅샷 측정 |
| **03** | trace 변종 **'효과 동등 ≠ 동작 보존'** — 내부상태·순서·동시성서 깨짐. golden-master=회귀 탐지지 증명 아님 | §4.2·§4.4 Rice 긴장, 녹화/replay src 0건 | **fixed** — '회귀 탐지(통과=미반증)'로 등급 강등 |
| **04** | bar의 L1·L2가 **0-wired provider** 위 → 강등경로서 bar 축소, 자동커밋이 '연극' 자동 재생산 | `stop.ts:548-558`(L1·L2 leg 없음) | **fixed** — 자동커밋 full-bar 조건화, 미배선=diff-only |
| **05** | unit-scoped가 §0 '얇음' 깸. **boxwood 2.7%** → standing 코드 대부분 L1 미달. CLI 0건 | `40-criteria:45`, src 0건 | **deferred** — unit-scoped 후속 WU 분리, 이번엔 change-scoped+diff |

## 3대 판정
- **OBJ-04 (자동커밋 = dialectic-8 OBJ-05 회귀?)**: 부분 회귀 맞음. 권한 차원은 사용자 결정으로 해소, 남은 건 '빈약한 bar 위 자동커밋' → **full-bar 조건화 + 강등=diff-only**로 닫음(되돌릴 필요 없음).
- **OBJ-03 (trace)**: '증명'→'회귀 탐지' 등급 강등으로 닫음.
- **OBJ-05 (unit scope creep)**: unit-mode 후속 WU 분리, 이번 증분 change-scoped+diff 우선으로 닫음(폐기 아님).

## 내가 과했던 것 (정직)
trace-diff를 "OBJ-03을 닫는다"고 과장(실은 *좁힌다*), catalog를 미존재 능력 위에 약속, 절대부채를 drift 재사용으로 오지목, 자동커밋을 미배선 bar 위에 둠. dialectic이 전부 코드로 잡았다.

## accept 도달
required_edits 6건 반영 시 accept(설계 문서 정정의 accept, 구현 착수 허가 아님 — Charter §3). 정정은 본 ledger 직후 적용.
