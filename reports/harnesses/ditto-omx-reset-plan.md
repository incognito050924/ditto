# DITTO OMX-Aligned Reset Plan

상태: 임시 reset 문서.

이 문서는 현재 DITTO 구현을 어떤 기준으로 엎을지 정리한다. 핵심 전제는 하나다.

OMX는 단순 참고 사례가 아니다. 우리가 1차로 도달하려는 하네스의 거의 완성형 기준점이다. DITTO는 OMX를 복제하려는 것이 아니라, OMX의 방향을 기준으로 삼고 그중 일부를 취하고, 일부를 버리고, 몇 가지 지점을 더 강화한다.

## 내가 잘못 잡았던 방향

초기 DITTO 설계는 "Codex나 Claude Code를 직접 실행하고 그 결과를 manifest로 감싸자"는 쪽으로 기울었다.

그래서 `ditto run with`가 생겼다. 사용자가 DITTO CLI를 호출하면 DITTO가 내부에서 `codex`나 `claude` binary를 spawn한다. stdout, stderr, diff, exit code를 잡아서 `.ditto/runs/<id>/manifest.json`에 기록한다.

이 구조는 얼핏 깔끔하다. DITTO가 모든 실행을 볼 수 있으니까 추적하기 쉽다. 하지만 실제 제품 방향으로는 틀렸다.

Codex와 Claude Code는 단순한 CLI binary가 아니다. 각자 session, context, permission UX, hook, skill, subagent, MCP, approval, TTY, plugin lifecycle을 가진 작업 환경이다. DITTO가 그 위에서 `Bun.spawn(["codex", ...])`처럼 감싸버리면, provider가 이미 잘하는 native 흐름을 오히려 망가뜨린다.

즉 지금의 `run with` 방향은 "오케스트레이션 강화"가 아니라 "실행기를 어설프게 재포장"하는 방향이다. OMX가 말하는 방향과 반대다.

## OMX를 기준으로 다시 보면

OMX의 README는 자기 역할을 분명하게 말한다.

OMX는 Codex CLI를 대체하지 않는다. Codex를 실행 엔진으로 유지하고, 그 주변에 더 좋은 workflow, prompt, runtime help, durable state를 붙인다. 사용자는 Codex 안에서 `$deep-interview`, `$ralplan`, `$ultragoal` 같은 표면을 호출한다. `.omx/`에는 plans, logs, memory, runtime state가 남는다.

중요한 점은 이것이다.

OMX는 "Codex 대신 일하는 프로그램"이 아니다. Codex가 일하는 방식을 더 잘 조직하는 하네스다.

DITTO도 그 방향이어야 한다.

DITTO가 직접 provider를 실행하는 것이 첫 번째 능력이 되어서는 안 된다. DITTO의 첫 번째 능력은 사용자의 의도를 더 정확히 붙잡고, 계획을 더 단단하게 만들고, 실행이 길어져도 상태와 증거를 잃지 않고, 마지막 완료 주장을 검증 가능한 형태로 닫는 것이다.

## 새 기준

앞으로의 기준은 다음이다.

1. Provider-native 실행을 기본으로 둔다.
   - Codex는 Codex답게 실행된다.
   - Claude Code는 Claude Code답게 실행된다.
   - DITTO는 그 실행을 대체하지 않는다.

2. DITTO는 intent-to-outcome orchestration을 맡는다.
   - 사용자 의도 파악
   - 모호함 정리
   - acceptance 기준화
   - 계획 승인 또는 위험 표시
   - durable goal/state
   - evidence-bound completion
   - handoff/resume

3. DITTO의 상태 파일은 실행기가 아니라 장부다.
   - `.ditto/work-items`는 작업 의도와 진행 상태를 보존한다.
   - `.ditto/runs`는 provider-native session/run에서 얻은 evidence를 연결한다.
   - `.ditto/completion`류 계약은 "완료라고 말해도 되는가"를 묻는다.

4. CLI spawn은 기본 경로가 아니다.
   - 남겨도 smoke/debug/manual import용이어야 한다.
   - 핵심 workflow가 `ditto run with`에 의존하면 다시 잘못된 방향으로 돌아간다.

## 무엇을 버릴지

### 버림: `ditto run with` 중심 설계

현재 `ditto run with`는 DITTO가 provider CLI를 직접 실행한다. 이 경로는 primary workflow에서 빼야 한다.

남길 수는 있다. 예를 들어 다음 용도라면 괜찮다.

- 설치 smoke test
- non-interactive command capture
- regression fixture
- provider wrapper 연구용

하지만 사용자의 실제 작업을 수행하는 기본 경로가 되어서는 안 된다.

### 버림: DITTO가 sandbox/profile을 직접 강제한다는 착각

현재 profile 설계는 DITTO가 provider flag를 붙이고, diff를 본 뒤 profile 위반을 기록하는 쪽으로 갔다.

이것도 core가 되면 안 된다. sandbox, permission, approval은 provider-native 기능이 맡아야 한다. DITTO는 doctor로 설정을 점검하고, hook이나 evidence로 결과를 기록해야 한다.

DITTO가 직접 policy engine이 되면 얕은 보안 복제가 된다.

### 버림: run manifest를 process wrapper 로그로 보는 관점

`manifest.json`은 "DITTO가 spawn한 process의 로그"가 아니라 "어떤 provider-native 작업 사건을 DITTO ledger에 연결한 기록"이어야 한다.

따라서 앞으로 manifest에는 `capture_mode` 같은 개념이 필요하다.

예:

- `native-hook`
- `manual-record`
- `transcript-import`
- `smoke-wrapper`
- `team-runtime`

이렇게 해야 `run with`를 하나의 capture mode로 낮출 수 있다.

### 버림: cross-provider를 너무 일찍 core로 만드는 것

초기 문서에서는 Codex와 Claude Code를 거의 같은 수준의 provider로 추상화하려 했다.

하지만 OMX를 기준으로 보면 1차 목표는 Codex-native workflow 강화다. Claude Code 호환성은 중요하지만, 처음부터 동일 추상화로 묶으면 둘 다 제대로 못 쓴다.

초기 DITTO는 Codex-native lane을 먼저 제대로 잡아야 한다. Claude Code는 나중에 "같은 work contract를 공유하는 다른 native lane"으로 붙이는 편이 낫다.

## 무엇을 살릴지

### 살림: work item 개념

사용자의 요청을 검증 가능한 작업 단위로 바꾸는 것은 여전히 필요하다.

OMX에도 durable state와 ultragoal ledger가 있다. DITTO의 `work item`은 그와 같은 계열이다. 다만 지금보다 더 사용자 의도에 가까워야 한다.

work item은 단순 task id가 아니다.

- 사용자가 진짜 원한 것
- 아직 모르는 것
- acceptance criteria
- 하지 않기로 한 것
- 현재 상태
- 다음 fresh evidence

이것을 붙잡는 단위다.

### 살림: completion contract

이건 버리면 안 된다.

OMX는 강한 workflow를 제공한다. DITTO가 그 위에서 강화할 수 있는 지점은 "완료 주장"이다.

모든 acceptance가 pass인지, in-scope unverified가 남아 있는지, 검증 명령이 실제로 있었는지, 다음 handoff가 필요한지 묻는 계약은 DITTO의 핵심으로 남겨야 한다.

### 살림: handoff

긴 작업은 중간에 끊긴다. context는 줄어들고 session은 바뀐다.

handoff는 provider와 무관하게 필요하다. OMX의 durable goal/state와 같은 문제를 다룬다. DITTO에서는 handoff가 completion contract와 더 강하게 연결되어야 한다.

pass가 아니면 handoff가 있어야 한다. handoff에는 다음 fresh evidence가 있어야 한다.

### 살림: evidence ledger

명령 결과, diff, 리뷰 결과, screenshot, log는 여전히 필요하다.

다만 이것은 DITTO가 provider를 spawn해서만 얻는 것이 아니다. hook, manual record, transcript import, reviewer output, test command wrapper 등 여러 경로에서 들어올 수 있어야 한다.

### 살림: doctor와 bridge의 아이디어

OMX는 setup, doctor, smoke test 경계를 나눈다. DITTO도 이 부분은 살려야 한다.

다만 doctor는 "DITTO가 실행을 통제한다"는 증거가 아니다. doctor는 native provider 환경이 제대로 연결되어 있는지 보는 도구다.

## 무엇을 재해석할지

### run manifest

기존 manifest는 폐기하지 않아도 된다. 그러나 의미를 바꿔야 한다.

이전 의미:

> DITTO가 provider process를 실행하고 얻은 결과.

새 의미:

> provider-native 실행 또는 session 중 DITTO가 추적하기로 한 하나의 사건.

따라서 manifest는 process 중심 필드만으로는 부족하다. 앞으로 필요한 필드는 이런 것들이다.

```json
{
  "capture_mode": "native-hook|manual-record|transcript-import|smoke-wrapper",
  "provider_session_id": "optional native session id",
  "provider_surface": "codex-cli|codex-plugin|claude-code|manual",
  "started_by": "user|hook|ditto|team-runtime",
  "input_artifacts": [],
  "output_artifacts": [],
  "evidence_refs": []
}
```

`stdout_path`와 `stderr_path`는 optional artifact일 뿐이다. native Codex session에서는 더 중요한 것이 hook event, transcript pointer, plan artifact, goal checkpoint일 수 있다.

### context packet

이전 context packet은 provider에 직접 넘기는 prompt 파일처럼 생각했다.

새 기준에서는 context packet이 꼭 provider spawn input일 필요가 없다. Codex session 안에서 skill이 읽는 briefing일 수도 있고, hook이 보여주는 pointer일 수도 있고, `$ultragoal`에 넘기는 durable goal summary일 수도 있다.

즉 context packet은 "실행 입력"이 아니라 "작업 맥락을 압축한 artifact"다.

### language ledger

현재 language ledger는 효과가 약하다. 모든 work item에 빈 파일로 생기는 것은 noise다.

다만 사용자 의도 파악을 강화하려면 용어 합의는 중요하다. 역할은 유지하되 lazy 생성으로 바꾸는 게 낫다.

새 용어가 실제로 등장했을 때만 work item 아래에 제안 ledger를 만든다. 합의 후에는 project-level `CONTEXT.md`와 `glossary.json`으로 승격한다.

## DITTO가 OMX에서 그대로 가져올 것

### 1. "Codex가 engine, harness가 workflow"라는 정신

이것이 가장 중요하다.

DITTO는 Codex를 대체하지 않는다. Codex를 더 좋은 작업 흐름 안에 둔다.

### 2. canonical workflow

OMX의 기본 경로는 대략 이렇다.

```text
$deep-interview -> $ralplan -> $ultragoal
```

DITTO도 이 순서를 가져와야 한다.

다만 이름을 그대로 복사할 필요는 없다. 중요한 것은 단계다.

```text
intent interview -> plan synthesis -> durable goal execution -> evidence completion
```

### 3. durable state

OMX는 `.omx/`에 plans, logs, memory, runtime state를 둔다.

DITTO도 `.ditto/`에 같은 역할을 둔다. 단, 처음부터 team runtime 전체를 만들 필요는 없다. work item, plan, completion, handoff부터 제대로 잡는다.

### 4. setup/doctor/smoke test 분리

OMX는 doctor가 설치 shape를 보고, 실제 authenticated Codex 실행은 별도 smoke test로 본다.

DITTO도 같은 경계가 필요하다.

- setup: 필요한 파일과 hook을 설치
- doctor: 설치와 drift를 진단
- smoke: 실제 provider가 model call을 완료하는지 확인

### 5. native hook 기반 lifecycle

DITTO의 핵심 capture는 `run with`가 아니라 hook이어야 한다.

Codex native hooks나 plugin lifecycle에서 session start, prompt submit, stop, compact 같은 지점에 DITTO pointer를 붙이고, 필요할 때 ledger를 갱신한다.

### 6. read-only explore harness

OMX의 explore/sparkshell 계열은 DITTO에도 중요하다. 사용자 의도를 파악하려면 repo를 안전하게 읽어야 한다.

다만 첫 MVP에서는 Rust sidecar까지 가져오지 않아도 된다. 먼저 read-only allowlist, output cap, command cap, evidence pointer를 잡는다.

## DITTO가 OMX보다 강화할 지점

### 1. 사용자 의도와 acceptance 연결

OMX는 workflow가 강하다. DITTO는 그 workflow 안에서 "사용자가 실제로 원한 결과"를 더 엄격하게 붙잡아야 한다.

질문은 절차 위임이 아니라 의도 확인이어야 한다. agent가 모르는 것과 아직 조사하지 않은 것을 구분해야 한다.

이 부분은 DITTO의 Agent Behavior Charter와도 맞다.

### 2. 완료 주장의 증거성

DITTO는 completion contract를 더 강하게 가져간다.

최종 응답은 completion contract를 거슬러 말하면 안 된다. 검증하지 않은 것을 완료라고 말하지 않는다. 부분 완료는 partial이라고 말하고 handoff를 남긴다.

### 3. 미완 상태의 재진입 품질

`partial`, `unverified`, `blocked` 상태는 그냥 남기면 안 된다.

다음 fresh evidence, 다음 시작 파일, 건드리지 말아야 할 것, 현재 판단 근거가 있어야 한다.

### 4. 계획 축소 방지

agent가 사용자의 의도를 조용히 줄이는 것을 막아야 한다.

이건 OMX의 durable workflow 위에 DITTO가 더 강하게 얹을 수 있는 품질 기준이다.

## 새 MVP 제안

지금 구현을 전부 밀어버리기 전에, 새 MVP를 이렇게 잡는다.

### MVP 0: 방향 정정

- `ditto-application-plan.md`에서 Phase 3 `provider wrapper`를 폐기 또는 legacy로 표시한다.
- `run with`를 primary path에서 제외한다.
- DITTO의 정체성을 "OMX-aligned intent-to-outcome orchestration layer"로 다시 쓴다.

### MVP 1: Codex-native work contract

- Codex session 안에서 읽을 수 있는 DITTO work briefing을 만든다.
- work item은 사용자 의도, acceptance, non-goals, fresh evidence를 담는다.
- context packet은 provider spawn input이 아니라 Codex-native briefing artifact가 된다.

### MVP 2: completion/handoff gate

- Codex native workflow가 끝날 때 DITTO completion contract를 작성하거나 갱신한다.
- pass가 아니면 handoff와 re-entry를 강제한다.
- 이 단계는 hook으로 자동화할 수 있으면 좋지만, 처음에는 manual command여도 된다.

### MVP 3: setup/doctor

- Codex plugin/setup/hook 상태를 점검한다.
- setup과 doctor와 smoke를 분리한다.
- 기존 사용자 설정은 managed block만 다룬다.

### MVP 4: OMX-style workflow surface

- deep interview
- plan synthesis
- durable goal
- reviewer/critic

이 표면은 CLI 명령일 수도 있고, Codex skill/plugin surface일 수도 있다. 중요한 것은 DITTO CLI가 provider 실행을 소유하지 않는다는 점이다.

## 현재 구현에 대한 판정

| 영역 | 판정 | 이유 |
|---|---|---|
| `work-item.json` schema | 살림 | 사용자 의도와 acceptance를 보존하는 중심축이다. |
| `completion-contract.ts` | 살림 | DITTO가 OMX보다 강화할 수 있는 핵심이다. |
| `handoff` 생성 | 살림/수정 | 필요하다. 다만 native workflow 종료와 연결해야 한다. |
| `run-manifest.ts` | 재해석 | process wrapper manifest가 아니라 native event/evidence manifest가 되어야 한다. |
| `RunStore` | 부분 살림 | 저장소 역할은 유효하지만 생성 경로와 필드 의미를 바꿔야 한다. |
| `run-with.ts` | 폐기 또는 legacy | primary workflow로 두면 OMX 방향과 충돌한다. |
| provider `spawnRun` adapters | 폐기 또는 smoke-only | native provider 실행을 DITTO가 감싸면 안 된다. |
| profile sandbox mapping | 폐기/doctor로 이동 | native permission/sandbox를 설정하고 점검해야지, DITTO가 얕게 재현하면 안 된다. |
| doctor/bridge | 살림/확장 | OMX setup/doctor 경계와 맞다. |
| context packet | 재해석 | spawn input이 아니라 native workflow briefing artifact로 바꾼다. |
| language ledger | lazy로 축소 | 모든 work item에 빈 파일은 noise다. 실제 용어 변경 때만 만든다. |
| password-strength fixture | 수정 | process-wrapper fixture가 아니라 partial completion/handoff fixture로 남기는 쪽이 낫다. |

## 당장 하지 말아야 할 것

- `run-with.ts`를 더 고도화하지 않는다.
- provider sandbox flag mapping을 더 늘리지 않는다.
- Claude Code와 Codex를 같은 spawn abstraction으로 묶으려 하지 않는다.
- run manifest를 stdout/stderr 중심으로 더 굳히지 않는다.
- 팀 runtime을 바로 만들지 않는다. OMX에서도 강력하지만 무겁다. 먼저 single-session durable workflow를 잡는다.

## 다음 작업

첫 작업은 구현 삭제가 아니다. 기준 문서를 바꾸고, 테스트와 파일 구조가 새 기준을 반영하게 만드는 것이다.

1. `ditto-application-plan.md`에 reset note를 추가한다.
2. Phase 3 provider wrapper를 legacy/deprecated path로 표시한다.
3. 새 Phase 3를 "Codex-native workflow bridge"로 바꾼다.
4. `runManifest` schema에 `capture_mode`를 추가하고 stdout/stderr/diff를 optional artifact로 낮춘다.
5. `run-with` 관련 테스트를 primary에서 제외하거나 smoke-only로 이름을 바꾼다.
6. Codex-native setup/doctor/hook/skill surface를 다음 구현 대상으로 잡는다.

이렇게 해야 DITTO가 OMX를 잘못 복제하지 않고, OMX가 이미 잘하는 부분 위에 DITTO가 강화할 부분을 얹을 수 있다.
