# ADR-20260723-parity-audit-disposition: 옛 src 능력 24영역 처분 확정 — keep 13 · redesign 2 · drop 9 (행별 철회조건 포함)

- 상태: accepted
- 결정 일자: 2026-07-23
- 결정자: hskim (사용자 일괄 리뷰 + flagged 15행 전건 개별 확정), claude (추천 저작)
- 관련: ADR-20260723-parity-audit-classification-principles (판정 원칙 — 이 ADR은 그 원칙의 **적용 결과**), ADR-0022 (flip의 상위 틀), 에픽 #64. 촉발 WI: wi_260723czc. 상세 근거·증거 상태·사용자 응답 축자는 `.ditto/work-items/wi_260723czc/classification-table.md`(Record tier, 커밋)가 정본이며, 이 ADR은 **처분과 철회조건의 색인 가능한 영속 기록**이다.

## 컨텍스트

zero-start 재구축(rebuild/)이 옛 src 표면(core 167파일·CLI 39·skills 18·agents 21, 2026-07-23 실측)을 대체한다. 전수 이식이 아니라 keep-only 재진입 — 24개 능력영역을 keep/drop/redesign으로 분류했고, 2026-07-23 사용자 일괄 리뷰에서 전 행이 확정됐다. 사용자 flip 3건(A5·A17·A21: 추천 drop → keep 확정)이 있었고, flip이 만든 의존 불일치 2건도 같은 왕복에서 해소·확정됐다.

**버킷 의미**: keep = 계약·동작을 rebuild 체계에 재진입 / drop = 재진입하지 않고 옛 src와 함께 은퇴(가역 — 옛 src·git 이력 보존, 행별 철회조건 발동 시 복귀) / redesign = 재진입하되 형태 재설계(**전부 flip(#69) 전 완료 의무**).

## 결정 — 24행 처분 확정표

### keep 13행 (재진입 대상)

| 행 | 영역 | 범위(분할) | 비고 |
|---|---|---|---|
| A2 | 완료게이트·증거·검증 (core 5) | 방어가치 입증 게이트 + ADR 집행 게이트만. **untargeted 게이트 9종은 입증 전 재진입 제외**(개별 입증 시에만 복귀) | |
| A3 | work item 생애주기·handoff (9) | Record/Run 2-tier 저장 계약·handoff 계약 코어. 부속 편의 명령은 재진입 시 개별 재평가 | |
| A5 | coverage·pre-mortem (8) | **옛 구현 그대로 재진입** (사용자 flip — 실측 비용 ~670k~2-3M 토큰/소변경 고지 후에도 keep 선택) | 소비처(계획 단계)가 옛 루프(A1 drop)라 재배선 전 잠시 고아 상태 — 사용자 인지·수용 |
| A6b | dialectic (core 0) | 스킬·에이전트·스키마 표면 전체 | 결정을 실질 변경한 포착 4건(ADR 본문) |
| A7 | memory (11) | 코어 계약(events/sources 저장·query/projection·off 스위치)만. 확장 게이트(push 확대·자동 curator)는 재진입 안 함 | ADR-0021 D4 seam 연속성이 drop 금지 — 전환조건부 keep |
| A8 | knowledge 투영 (2) | 전체 (ADR·glossary 저작·투영·정합 검사) | |
| A11 | github 연계 (8) | SoT 3층 read/write 계약 코어. 보드 조작 편의는 개별 재평가 | |
| A15 | charter·config·recipe (10) | 공용 기반(경로·설정)만. charter 주입·recipe 로더는 제외(charter는 rebuild 프롬프트로 이관 — 리라이트 시 operative-cue 충실도 게이트 적용 의무) | |
| A17 | semantic·lsp·codeql (11) | **전체 keep (사용자 flip)** — A21 keep과의 의존 정합으로 flip | CodeQL 단일 엔진 결정 유지 |
| A19 | push-gate 배포게이트 (2) | 전체 | |
| A21 | ACG 변경 거버넌스 (core 3 + src/acg 37) | **전체 keep (사용자 flip)** — 종결 방향 추천(drop)을 사용자가 기각 | ADR-0009의 "표면 닫힘" 선언과 긴장 — 사용자 직접 표명이 우선, 재진입 시 ADR-0009 개별 항목과의 정합은 그 시점 재확인 |
| A22 | 공용 기반 유틸 (3) | 파생 keep(keep 집합의 전제). rebuild 자체 유틸과 중복분은 rebuild로 수렴 | |
| hooks | hooks 집행 표면 (src/hooks 10) | 안전 게이트(scope-out·secret·apply_patch)·편집 증거·mode-doctor 배너 운반만. pre-compact·charter 주입·semantic-nudge는 drop | Stop은 rebuild 등가 존재 |

### redesign 2행 (재진입하되 재설계 — **전부 flip 전 완료 의무**)

| 행 | 영역 | 형태 |
|---|---|---|
| A4 | deep-interview·의도 (6) | rebuild intent-lock 계약 위에 의도 형성 표면 재설계 — 옛 드라이버의 누적 레이어 그대로 이식 금지. 근거: 무거운 경로는 의도 산출 없이 출발 불가(제품 축1 공백) |
| A16 | setup·provision·init·teardown (10) | 최소 진입(결정적 진입+scaffold)만 재구축. wizard 5파일·teardown·provision 부속은 drop — 단 CodeQL 설치분은 A17 keep에 연동해 재평가 |

### drop 9행 (은퇴 — 가역, 행별 철회조건)

| 행 | 영역 | 부속 확정 | **철회조건 (발동 시 재진입 후보 복귀)** |
|---|---|---|---|
| A1 | autopilot 오케스트레이션 (17) | **행동 계약 ADR 5건(materialize≠drive·종료 완전성·결함 클래스 체인구동·envelope 무손실·barrier tier)을 rebuild 루프의 인수 의무로 지정** — 인수 실패 시 intent 충돌로 승격 | rebuild 루프가 비사소 실증에서 다중 노드 병렬·역할 분리 없이 완주 불가로 실증되면 확장(그래프·wave dispatch) 재진입 재개 |
| A6 | prism 기획·spec (9) | spec-doc 부분 구제 불선택(전체 drop) | rebuild 계획 단계에서 spec 진화·중립 컴파일 요구가 실증되면 spec-doc 계약부터 재진입 |
| A9 | e2e (23) | 기능 4축 중 축3 보류 — 제품 정의 차원의 사용자 결정 | 사용자 웹 프로젝트에서 E2E 수요가 직접 표명되면 기존 계약(ADR-0014·ADR-20260702) 그대로 재진입 — 설계는 ADR에 보존돼 재진입 설계비 선불 |
| A10 | journey 저작 (7) | A9 연동(유일 소비처) | A9 재진입 시 함께 재진입(DSL은 e2e의 입력 계약 — 분리 불가) |
| A12 | doctor·드리프트 진단 (10) | **mode-doctor 배너만 keep 분할**(실사고 기반 ADR-0022 명시 안전망), 나머지 은퇴 | rebuild 표면 배포 시 배포계약 점검(ADR-0011 D1 매핑)이 필요해지면 해당 doctor만 재진입 |
| A13 | worktree·workspace (2) | — | 병렬 feature 개발 요구 재부상 시 ADR-20260626·ADR-20260715 계약대로 재진입 |
| A14 | cleanup 정리 (3) | ADR-0017 결정은 보존(구현 미착수 상태 그대로), 착수만 rebuild 이후로 | ADR-0017 선결조건(provider 배선) 충족 시점이 자연 재개점 |
| A18 | host seam (6) | adapter 계약은 rebuild 등가로 대체. **Codex측(어댑터·capabilities)은 재진입 백로그 등재 — 폐기 아님, 시점 미정** (후행 이슈로 물질화) | Codex 트랙 착수 결정 시 — dual-host 구조(ADR-0016)·Codex 격리(ADR-0025) 계약 보존 |
| A20 | 회고·측정 (2) | **측정 계약(ADR-0024 결정4, 2지표 분리) 인수처 = rebuild net-efficacy 상태로 지정** — 측정 자체 포기는 intent 충돌 | rebuild 루프에 회고 seam이 생기면 그 계약대로 재실현 |

## 확정 절차 기록 (요지)

- 일괄 리뷰: 무플래그 9행(A3·A6b·A7·A8·A11·A15·A19·A22·hooks) 일괄 확정, 이의 0.
- 강제 개별 확인: flagged 15행 전건 개별 응답(2026-07-23 11:04~11:42Z, 구조화 질문). 사용자 응답 축자와 행별 기록은 분류표 §사용자 확정 기록.
- flip 3건(A5·A17·A21)은 추천 근거(비용·종결 정렬) 고지 후의 사용자 직접 표명 — 원칙 ADR D3의 증거 ④(사용자 체감 직접 표명)로 validated.
- 의존 불일치 해소 2건: A17↔A21(A17도 keep으로 정합), A5↔A1(옛 구현 그대로 재진입, 재배선 전 고아 상태 수용).
- flagged 요약 14→15 정정: A16 행의 (b) 플래그가 저작 시점 요약에서 누락 — 발견 즉시 정정하고 개별 확정 수령.

## 재진입 순서 (원칙 ADR D7 적용)

실증 부품 사슬 구성원 최우선(M-chain) → 나머지 keep+redesign 의존 위상정렬(M-topo). 사슬 도출과 이슈별 배정은 per-feature 이슈 manifest(분류표 부기)가 정본.

## 변경 조건 (이 ADR의 철회 조건)

- 개별 행의 철회는 위 표의 행별 철회조건 발동 또는 사용자 직접 결정으로 한다 — 발동 시 해당 행만 재분류하고 이 ADR에 상태를 부기한다(전면 재작성 아님).
- flip(#69) 완료로 옛 src가 은퇴하면 drop 행들의 철회조건은 "재진입 백로그 신설" 절차로 대체되고 이 ADR은 historical 처리한다.
- 대체 로드맵 자체가 중단·방향 전환되면 원칙 ADR과 함께 전체 재검토한다.
