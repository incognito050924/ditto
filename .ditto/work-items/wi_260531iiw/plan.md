# Plan — wi_v04runtimewiring

## 배경

v0 (M0~M4) closure 후 outcome 매트릭스 점검(2026-05-31). 결정론 게이트 층(completionGate, convergenceGate, Stop hook fail-closed, PreCompact handoff)은 schema-level로 단단하지만, **게이트를 발동시킬 산출물을 작성하는 자율 entry가 비어있다**. 결과적으로 설계서가 약속한 outcome 중 약 60-70%가 자율 발화하지 않는다.

가장 큰 단일 갭은:

1. PreCompact가 `autopilot_id`를 handoff에 전달하지 않아(`pre-compact.ts:24-30`) 압축 후 autopilot 연속성이 끊김
2. Stop hook이 `completion.json`/`convergence.json`/`autopilot.json` 셋 다 absent이면 fail-open(`stop.ts:79-83, 127`) → "verify 안 한 채 그냥 종료" 차단 안 됨
3. UserPromptSubmit이 만든 placeholder AC("TBD — derive observable…")가 그대로 남아도 anything 알림 없음 → IntentContract outcome("의도를 검증 가능 목표로 좁힘")이 발화 안 함

본 work item은 이 3개 갭을 단일 의도로 묶어 한 번에 채운다.

## AC

- **AC-1 PreCompact autopilot 연속성**: `pre-compact.ts`가 `AutopilotStore`로 활성 autopilot을 읽어 그 `autopilot_id`를 `buildHandoff`의 `autopilotId`로 전달. autopilot 부재 시 handoff에서 omit.
- **AC-2 Stop absent-completion 차단**: `stop.ts`가 NON_TERMINAL work item + 세 ledger 모두 absent 경우 exit 2 + stderr로 차단. terminal status는 무관, 산출물 존재 case는 기존 gate 위임.
- **AC-3 UserPromptSubmit placeholder advisory**: `user-prompt-submit.ts`가 active work item의 모든 AC statement가 placeholder이면 charter에 advisory 1줄 inject.
- **AC-4 회귀 보호**: 기존 conformance 5개 + unit/hook test 회귀 zero. 신규 unit test가 각 AC를 보호.

## 변경 대상 (Tidy First — 본 work item은 동작적만)

| 파일 | 변경 | AC |
|---|---|---|
| `src/hooks/pre-compact.ts` | `AutopilotStore` 읽어 autopilotId 전달 | AC-1 |
| `tests/hooks/pre-compact.test.ts` | autopilot_id 보존 + autopilot 부재 시 omit | AC-1, AC-4 |
| `src/hooks/stop.ts` | NON_TERMINAL + 세 ledger absent → exit 2 path 추가 | AC-2 |
| `tests/hooks/stop.test.ts` | 신규 case + 기존 case 회귀 없음 | AC-2, AC-4 |
| `src/core/charter.ts` 또는 `user-prompt-submit.ts` | placeholder 감지 + advisory 추가 | AC-3 |
| `tests/hooks/user-prompt-submit.test.ts` | placeholder/non-placeholder 양 case | AC-3, AC-4 |
| `tests/conformance/m4.conformance.test.ts` | AC-1 outcome 추가 가능 시 | AC-4 |
| `tests/conformance/m1.conformance.test.ts` | AC-2/AC-3 outcome 추가 가능 시 | AC-4 |

## 검증 명령

```
bun test                                        # 전체
bun test tests/hooks/                           # hook 단위
bun test tests/conformance                      # v0 적합성 5개
bun lint                                        # biome
```

## 커밋 분리 (Tidy First)

본 work item은 동작적 변경만. 구조적 변경 없음.

1. `feat(M4.2): PreCompact propagates autopilot_id to handoff (동작적)` — AC-1
2. `feat(M1.4): Stop hook closes absent-completion path on NON_TERMINAL work items (동작적)` — AC-2
3. `feat(M1.3): UserPromptSubmit emits placeholder-AC advisory (동작적)` — AC-3
4. `docs(v0): wi_v04runtimewiring closure — completion contract + handoff entry` — closure

## 범위 밖 (out_of_scope / follow_up_candidates)

- `declared_by` enum화: 현재 `owner_profile`(workspace-write 등)로 사용 중. 설계서 "판정 주체(verifier)" semantic으로 좁히려면 `work-item-handoff.ts:114` 호출자와 모든 fixture(7건+)를 함께 바꿔야 함. 의미 재정의이므로 별도 work item에서 sharpening 사이클 필요.
- IntentContract `intent.json` 자동 작성: AC-3은 advisory까지만. 실제 intent.json을 쓰고 `bootstrapAutopilot` 호출까지 자동화하려면 deep-interview 진입까지 엮어야 해 범위 확대.
- Dialectic runtime 호출자: schema/agent 골격은 있으나 호출 트리거 없음. 별도 work item.
- Knowledge projection / E2E: v0 closure 범위 밖이고 본 work item 의도와 직교.

## 위험

- `pre-compact.ts`가 autopilot을 추가로 읽으면서 PreCompact가 무거워질 수 있음. 단 single JSON read이므로 무시 가능 수준.
- Stop absent-completion 차단은 사용자의 "그냥 끝내고 싶다" 흐름을 막을 수 있음. 따라서 **NON_TERMINAL일 때만** 발동. terminal(done/abandoned) work item은 그대로 통과. 또한 stderr 메시지에 "completion.json을 쓰거나 work item status를 abandoned로 바꿔 stop"이라는 회피경로 제시.
- placeholder advisory는 hint level (exit 0); 사용자/모델 자율에 위임. 강제 차단은 후속 작업.
