# Plan — wi_v04intent_autopilot_entry

## 배경

`wi_v04runtimewiring`에서 만든 placeholder advisory는 **hint 수준**(charter에 한 줄 inject). 그 advisory가 가리키는 `/ditto:deep-interview` 호출과 그 뒤 따라야 할 `bootstrapAutopilot` 호출은 여전히 LLM/사용자가 직접 해야 함. 결과적으로 실세션 `.ditto/work-items/*/`에 `intent.json`/`autopilot.json`이 0건이고, `IntentContract`·`AutopilotContract`·`QuestionGate` outcome이 발화하지 않음.

본 work item은 그 자동 진행 path를 코드로 깔고, `deep-interview` skill 본문을 절차로 채운다.

## 새 용어 도입 (사용자가 처음 보는 것)

| 이름 | 1줄 정의 |
|---|---|
| `intent.json` | work item의 진짜 목표, 안 할 범위, 검증 가능한 acceptance criteria를 박는 sidecar 파일 (`IntentContract` schema) |
| `interview-state.json` | `deep-interview` 진행 상태(질문/응답, 모호한 dimension, readiness score)를 담는 sidecar 파일 |
| `interviewReadinessGate` | interview-state가 "충분히 진행됐는지" 판정하는 순수 함수 (코드에 이미 있음) |
| `bootstrapAutopilot` | ready intent를 받아 `autopilot.json`(작업 그래프)을 자동 생성하는 함수 (코드에 이미 있음, 호출자 부재) |
| autopilot 그래프 노드 | `design → implement → verify` 체인. 각 노드에 owner(planner/implementer/verifier)와 acceptance_refs |
| `approval_gate` | autopilot 그래프에 박히는 승인 게이트. high-risk 변경은 `pending`, safe는 `not_required` |

## AC

- **AC-1 UserPromptSubmit directive inject**: placeholder-only AC + execution 의도 prompt → charter에 "Run `/ditto:deep-interview` now" 한 줄 추가
- **AC-2 ditto deep-interview CLI**: `start` / `record-turn` / `check-readiness` / `finalize` 4개 서브 명령
- **AC-3 bootstrap 자동 호출**: `finalize` 성공 시 같은 호출 안에서 `bootstrapAutopilot` 실행 + 별도 `ditto autopilot bootstrap` 명령도 idempotent하게 제공
- **AC-4 skill 본문**: `skills/deep-interview/SKILL.md`에 CLI 4개 호출 절차 명시
- **AC-5 QuestionGate advisory**: charter에 "self-answer first" 한 줄(휴리스틱 trigger 시)
- **AC-6 회귀**: bun test 전부 + conformance 신규 단언 (예상 +6~8 케이스)

## 변경 대상

| 파일 | 변경 | AC |
|---|---|---|
| `src/core/interview-driver.ts` (신규) | start/recordTurn/checkReadiness/finalize 함수 | AC-2 |
| `src/cli/commands/deep-interview.ts` (신규) | CLI 서브 명령 | AC-2 |
| `src/cli/commands/autopilot.ts` (신규) | `ditto autopilot bootstrap` 명령 | AC-3 |
| `src/cli/index.ts` | 새 명령 registration | AC-2, AC-3 |
| `src/core/work-item-store.ts` | acceptance_criteria mirror update path | AC-2 |
| `src/core/charter.ts` | 새 ctx field: `deepInterviewDirective`, `selfAnswerHint` | AC-1, AC-5 |
| `src/hooks/user-prompt-submit.ts` | 진입 조건 평가 + directive inject + QuestionGate 휴리스틱 | AC-1, AC-5 |
| `skills/deep-interview/SKILL.md` | v0 skeleton 'TBD' 본문 제거, CLI 절차로 채움 | AC-4 |
| tests | unit + conformance | AC-6 |
| plan/matrix 본문 | M1.3 + M2.1b update | AC-6 |

## Tidy First 분리 (예상 commits)

구조적 먼저:
1. `refactor(M1.3): extract directive/advisory fields into CharterContext (구조적)` — charter.ts 확장, hook은 아직 호출 안 함
2. `refactor(M2.1b): expose bootstrapAutopilot via ditto autopilot bootstrap CLI (구조적)` — bootstrapAutopilot은 코어 함수 그대로, CLI surface만 추가

동작적:
3. `feat(M6.3): ditto deep-interview CLI (start/record-turn/check-readiness/finalize) (동작적)` — AC-2
4. `feat(M6.3): finalize triggers bootstrapAutopilot for ready intent (동작적)` — AC-3 자동 호출 path
5. `feat(M1.3): UserPromptSubmit emits deep-interview directive + QuestionGate advisory (동작적)` — AC-1, AC-5
6. `feat(M6.3): deep-interview skill body — CLI procedure (동작적)` — AC-4
7. `docs(v0): conformance matrix + plan §M1.3 / §M2.1b reflect wi_v04intent_autopilot_entry (검증 전용)` — AC-6 매트릭스 + plan 업데이트
8. `docs(ditto): close wi_v04intent_autopilot_entry — AC-1..AC-6 pass`

## 검증

```
bun test
bun test tests/cli/deep-interview.test.ts (신규)
bun test tests/hooks/user-prompt-submit.test.ts
bun test tests/conformance
bun run lint
```

## 위험

- deep-interview CLI 4개 서브 명령 추가 → CLI 표면 증가. 각 명령에 invalid 인자 reject test.
- AC-3의 자동 호출 path + manual `ditto autopilot bootstrap` 두 path → 같은 `bootstrapAutopilot` 코어 함수 호출로 idempotent.
- AC-1 directive를 사용자가 무시하고 싶을 수 있음. exit 0 advisory이라 강제 못 함 — 그러나 LLM이 강하게 따를 가능성. 문구에 "recommended; may be skipped if the request is small or reversible" 명시.
- AC-5 휴리스틱 false-positive → advisory라 비용 작음.

## 범위 밖

- deep-interview의 LLM 자율 영역(어떤 질문을 할지, dimension 식별, 응답 해석): driver는 schema만 강제, 내용은 LLM에 위임.
- Verifier 본문 (②), DialecticDeliberationContract runtime (③), declared_by enum화 (②): 별도 work item.
- 실세션 wall-clock에서 인터뷰 품질 평가: post-v0 evaluator lane.

## 예상 작업량

대략 800–1500 lines (코드 + test + 문서), 7~8개 commit. 한 sitting 가능. 진행 중 도중에 사용자에게 중간 보고 시점 3회 예상 (AC-2/3 후, AC-4 후, AC-1/5 후, closure).
