---
title: "HANDOFF — deep-interview 의도파악 품질 측정 인프라 (다른 PC 인수인계)"
kind: handoff
last_updated: 2026-06-08 KST
audience: 다음 세션/다른 PC에서 이 작업을 이어받는 에이전트
delete_when: 측정 인프라(P0~P3) 구현·검증·푸시가 끝나면 삭제
why_git_tracked: ".ditto/local의 work item·표준 handoff는 gitignore되어 PC간 전달 불가. 이 문서가 git으로 전달되는 유일한 인수인계 수단이다."
---

# HANDOFF — deep-interview 의도파악 품질 측정 인프라

## 0. 한 줄 상태

**설계 합의 완료, 구현 0%.** 아래 [DECIDED] 설계대로 P0→P3를 구현하면 된다. 원래 work item은 `wi_260607vpe`였으나 `.ditto/local`이라 이 PC로 안 넘어온다 — **새 work item을 만들어 시작**(§6 프롬프트).

## 1. 왜 이 작업을 하는가 (잃지 말 것 = IntentContract)

사용자 관찰: "deep-interview가 있는데 실제 질문을 별로 안 한다." 진단 결과(코드 확인):
- deep-interview 진입이 좁고 advisory다(`placeholder-only AC ∧ execution-intent`, "skip 가능"). 일반 요청엔 거의 안 켜진다.
- 발동해도 **readiness gate가 질문 행위를 측정하지 않는다** — `state.readiness.score`(자기보고) + critical dimension `resolved`(자기보고)만 본다. 질문 0개여도 critical 0개 + score 0.7 자기선언이면 통과. deterministic floor는 `conflicting: 0` 하드코딩(`src/core/gates.ts:47`)으로 거의 0이라 제동을 못 건다.
- 결론: 시스템이 **"잘 메운 절약"과 "게으른 누락"을 구분하지 못한다**(honor-system).

그래서 사용자 결정: **게이트를 조이기 전에 측정이 우선**(DITTO 제1원칙 자기적용 — vibes 뒤에 상태 숨기지 않기). 그리고 측정 범위는 **(b) 결과 지표까지 포함한 제대로 된 측정**(과정 지표만 X).

핵심 목표: **"적은 질문이 절약인지 누락인지를 데이터로 판별"** — 질문 수(과정)와 사후 비용(결과)을 work item 단위로 연결해 상관을 본다. 사용자 원문 가설: "초기 의도 정렬 비용 ≪ 사후 수정 비용."

## 2. 무엇이 이미 있나 (집계만, 저비용) vs 신설 필요

| 지표 | 출처 | 상태 |
|---|---|---|
| 진입률·질문 수·closure mode·readiness·assumption | `.ditto/local/work-items/<id>/interview-state.json` + `WorkItemStore.list()` | 이미 영속 — 집계만 |
| fix 노드·retry/switch 결정·attempts | `autopilot.json` + `autopilot-decisions.jsonl` | 이미 영속 — 집계만 |
| handoff 라운드 | `HandoffStore.listActive()` | 이미 영속 — 집계만 |
| **intent drift / AC 사후 변경** | **현재 Stop 훅(`src/hooks/stop.ts:437`)에서 계산되나 stderr로 휘발** | **신설 배선 필요** |

## 3. [DECIDED] 설계 결정 (사용자 합의됨)

- **D1 저장**: `.ditto/local/work-items/<id>/metrics.jsonl` (기존 commands/edits/decisions jsonl 관례 그대로).
- **D2 drift 기록 시점**: Stop 훅의 `intentDriftGate` 계산 직후 append + **de-dup**(직전 레코드와 동일 reasons면 skip — Stop 반복 호출에 발생률 오염 방지). **exit code·blocking 로직은 절대 불변**, 부수적 기록만 추가.
- **D3 집계 CLI**: `ditto doctor intent-quality [--work-item <id>] --output json|human` (core 순수 함수 + 얇은 CLI, `src/core/distribution-doctor.ts` 패턴 복제).
- **D4 핵심 산출**: per-work-item 상관 테이블 + **"질문 수 분위 × 사후비용(drift+rework) 상관"**. 이게 판별의 핵심 데이터.
- **D5 신설 최소화**: 스키마 1개(`intent-metric`), store 메서드 1개(`appendMetricLine`), hook 배선 1곳, CLI 1개. 나머지는 전부 집계.
- **D6 self-answer 지표는 이번 범위에서 제외**(사용자 합의): `self_answer_attempts`는 스키마엔 있으나 record-turn 입력 경로가 없어 비어 있을 가능성(추측). 이건 측정 인프라가 아니라 *입력 경로 부재 버그*라 별도 추적. 결과 지표(drift/rework)로 "잘 메웠나"를 직접 판별하므로 이번 목표는 달성됨.

## 4. 구현 단계 (Tidy First: 구조/동작 분리, 커밋도 분리)

- **P0 구조적**: `WorkItemStore.appendMetricLine`이 기존 private `appendEvidenceJsonl`(`src/core/work-item-store.ts:167` 패턴) 재사용하도록 준비. 동작 불변.
- **P1 동작적(저비용)**: `src/core/intent-quality-doctor.ts` 신설 — `collectIntentQualityReport(repoRoot)`가 interview-state + autopilot + autopilot-decisions.jsonl + handoff만으로 per-item 행·aggregate 생성. `src/cli/commands/doctor.ts`에 `intent-quality` 서브커맨드 추가(`distributionCommand` 패턴).
- **P2 구조적**: `src/schemas/intent-metric.ts` 신설(zod) + export. `WorkItemStore`에 `appendMetricLine`/`readMetrics` 추가(`appendCommandLogLine` 대칭). 스키마 export 대상이면 `scripts/export-schemas.ts`에 등록 + `bun run schemas:export`.
- **P3 동작적(고비용)**: `src/hooks/stop.ts:437` drift 계산 직후 → `intent-metric` 레코드로 변환해 `appendMetricLine`(de-dup 포함). `collectIntentQualityReport` 확장: metrics.jsonl 읽어 `drift_events`/`ac_changes`를 행에 합치고 상관 테이블 산출.

### intent-metric 레코드 (제안 형태)
```
{ ts, work_item_id, kind: 'intent_drift', source: 'stop_hook'|'cli',
  blocking_reasons: string[], advisories: string[], hops: ('H1'|'H2'|'H3')[] }
```
(AC 사후 변경은 drift gate의 H1 scope grow/shrink가 이미 잡음 → 같은 레코드 reasons로 표현. 별도 AC-diff 추적은 옵션·후순위.)

## 5. 근거 파일 (critical, file:line)

- `src/hooks/stop.ts:437` — drift 기록 배선 지점(현재 휘발)
- `src/core/gates.ts:411` — `intentDriftGate` 정의; `:35-71` readiness gate + deterministic floor; `:47` `conflicting:0` 하드코딩(floor 무력화 원인)
- `src/core/work-item-store.ts:167` — `appendEvidenceJsonl` 헬퍼(재사용 대상), `:182-189` append 메서드 대칭 패턴
- `src/cli/commands/doctor.ts` — 서브커맨드 추가 자리; `src/core/distribution-doctor.ts` — 집계 core 패턴 복제 대상
- `src/schemas/interview-state.ts:86-109` — 과정 지표 전부의 원천(questions·dimensions·readiness·exit.closure_mode)
- `src/core/interview-driver.ts:375` — closure_mode 기록 지점; `:71-103` record-turn 페이로드(self_answer 입력 경로 부재 확인 대상)
- `src/core/autopilot-store.ts:16-34` — `autopilot-decisions.jsonl`(재작업 신호 출처: failure_class·decision·attempts)
- `src/schemas/autopilot.ts:21,104` — fix 노드 kind·attempts.fix

## 6. 검증 기준 (완료 게이트)

- P1: 더미 work item에 `ditto doctor intent-quality --output json` → 질문수/closure/fix/handoff 채워짐. core 단위 테스트.
- P3: work-item.json AC를 intent와 어긋나게 만들어 Stop 훅 실행 → metrics.jsonl에 H1 레코드 1줄, **재실행 시 de-dup으로 추가 안 됨**. 이어 `ditto doctor intent-quality`가 상관 테이블에 반영.
- 전체 `bun test` green, biome·adr-guard 통과(pre-commit 훅).

## 7. 주의 / 함정

- **de-dup이 정확성의 핵심**: Stop은 같은 상태에서 여러 번 호출됨. de-dup 없으면 drift 발생률이 Stop 횟수에 오염됨.
- **Stop 훅 동작 불변**: drift 기록은 부수 효과만. blocking/advisory/exit code 로직 건드리지 말 것.
- self-answer 비율은 이번 범위 밖(D6). 0으로 나와도 정상 — 입력 경로 부재 별도 버그.
- 이 repo는 main 직접 운영(dogfooding). 커밋은 structural/behavioral 분리(글로벌 CLAUDE.md), 메시지에 유형 명시, `Co-Authored-By` 푸터.
- PreToolUse 훅이 repo 밖 쓰기를 차단함. 메모리 등 repo 밖 작업 시 `DITTO_SKIP_HOOKS=1`.

## 8. 이 문서 처리

구현 완료·푸시 후 이 핸드오프 문서는 삭제(frontmatter `delete_when`). 측정 결과로 deep-interview 게이트를 조일지는 데이터를 본 *다음* 별도 결정이다(이번 범위 아님).
