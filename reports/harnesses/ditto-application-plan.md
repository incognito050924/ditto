---
title: "reports/harnesses 기반 DITTO 적용 계획"
tier: 1
repo: ditto
last_updated: 2026-05-24
kind: implementation-plan
scope: "PURPOSE.md의 하네스 요구를 기준으로 reports/harnesses 하위 Markdown 분석 문서를 DITTO 구현 계획으로 통합한다."
inputs:
  - PURPOSE.md
  - reports/harnesses/03-claude-codex-adoption-map-ko.md
  - reports/harnesses/andrej-karpathy-skills.md
  - reports/harnesses/deepagents.md
  - reports/harnesses/get-shit-done.md
  - reports/harnesses/mattpocock-skills.md
  - reports/harnesses/oh-my-claudecode.md
  - reports/harnesses/oh-my-codex.md
  - reports/harnesses/oh-my-openagent.md
  - reports/harnesses/oh-my-opencode-slim.md
  - reports/harnesses/superpowers.md
  - reports/harnesses/blogs/01-anthropic-engineering-survey.md
  - reports/harnesses/blogs/02-managed-agents-annotated-ko.md
---

# reports/harnesses 기반 DITTO 적용 계획

## 0. 결론

DITTO의 초기 구현은 자체 agent runtime이 아니라 **coding agent work orchestration layer**여야 한다.

Codex, Claude Code, OpenCode 같은 host가 이미 model/tool loop, sandbox, hook lifecycle, subagent 실행, skill/plugin discovery의 상당 부분을 제공한다. DITTO가 먼저 소유해야 할 것은 그 실행 엔진 위에 남는 공통 계약이다.

- 작업 목표와 acceptance criteria
- 실행 profile과 provider 정보
- 변경 파일과 결정 기록
- 검증 명령, 로그, 스크린샷, 평가 결과
- 미검증 항목과 남은 risk
- 다음 세션이나 다른 agent가 이어받을 handoff artifact
- host별 instruction, permission, skill, MCP drift를 잡는 doctor

따라서 v0의 중심은 "더 똑똑한 agent"가 아니라 "agent가 한 일을 잃지 않고, 검증 없이 완료라고 말하지 못하게 하며, 다음 실행자가 바로 이어받게 하는 계층"이다.

## 1. 적용 기준

PURPOSE.md 기준 DITTO의 성공 기준은 다음으로 정리한다.

1. 사용자가 대화나 코드를 다시 읽지 않아도 현재 목표, 상태, 근거, 미검증 항목을 판단할 수 있다.
2. 모든 중요한 action은 감사 가능한 기록과 artifact pointer를 남긴다.
3. context에는 큰 로그와 전체 산출물을 밀어 넣지 않고, 최신 evidence와 pointer만 넣는다.
4. 구현 agent와 검증 agent는 역할, 권한, context, 출력 계약이 분리된다.
5. 장기 작업은 세션 compaction이나 provider 전환 이후에도 handoff artifact로 이어진다.
6. 병렬 subagent는 소유 범위, 금지 범위, 예산, merge owner, evidence path를 가진다.
7. sandbox, permission, network, MCP, external analyzer는 profile과 doctor로 추적된다.
8. 하네스 자체 변경은 regression evidence 없이 개선으로 간주하지 않는다.
9. 사용자와 agent가 쓰는 프로젝트별 핵심 용어는 ubiquitous language로 합의하고, `.ditto/knowledge/CONTEXT.md`에 동기화한다.
10. 사용자 질문 전에는 접근 가능한 코드, 산출물, 기록, 웹 근거로 스스로 답할 수 있는지 먼저 확인한다.
11. 출력 전에는 약어, 추측, 과대표현, 위치만 언급하는 응답, 미검증 완료 선언을 lightweight self-check로 걸러낸다.
12. long-running work item은 `partial|unverified` 상태로 조용히 방치하지 않고, 재진입 후보와 handoff 상태를 드러낸다.
13. token 비용은 multi-model 검토뿐 아니라 context packet, subagent, evidence preview, 재실행 정책의 공통 budget으로 관리한다.
14. DITTO 자체 work item은 DITTO의 work-item/run/verify/handoff 도구로 추적·검증·마감되어야 한다. v0.x 진행 work item은 자기 검증 후 `ditto work handoff`로 final_verdict가 박힌 상태로만 done이 된다.

## 2. 적용하지 않을 것

초기 구현에서 다음은 피한다.

| 항목 | 이유 | 대신 할 것 |
|---|---|---|
| Claude Code/Codex agent loop 재구현 | 얕은 복제가 되고 보안/UX 품질이 낮다. | native provider를 실행하고 DITTO run manifest로 감싼다. |
| custom sandbox provisioner | OS, network, secret boundary 구현 비용과 위험이 크다. | host native sandbox와 permission을 사용하고 doctor로 검증한다. |
| full append-only replay runtime | provider 내부 event를 안정적으로 재현하기 어렵다. | work item/run/evidence ledger부터 둔다. |
| live token-level ContextAssembler | provider context assembly를 직접 통제하지 못한다. | handoff용 context packet generator부터 만든다. |
| model-based approval classifier | 감독을 다시 모델에 맡기는 구조가 된다. | deterministic deny, native approval, sandbox, audit를 먼저 쓴다. |
| 항상 켜진 multi-model council | 비용과 지연이 크고 작은 작업에는 과하다. | evaluator lane에는 cross-provider reviewer를 1급 기능으로 두고, 다자 council만 opt-in expensive command로 둔다. |
| 대형 benchmark platform | repo 초기 단계에서는 유지 비용이 더 크다. | smoke/regression/e2e evidence부터 축적한다. |

## 3. 목표 구조

### 3.1 용어와 저장 구조

이 문서에서 사용자 입력 원문은 `request`로 부르고, DITTO가 추적하는 작업 단위는 `work item`으로 부른다. `request`는 사용자가 한 말에 가깝고, `work item`은 그 요청을 검증 가능한 목표, acceptance criteria, 실행 기록, 검증 evidence, handoff까지 포함하도록 정규화한 단위다.

`task`라는 이름은 subagent의 작은 작업, provider의 background task, GitHub issue/task와 쉽게 충돌하므로 top-level 저장 단위 이름으로 쓰지 않는다.

DITTO는 대화 transcript를 신뢰 가능한 유일 상태로 두지 않는다. repo-local 상태는 사람이 읽을 수 있는 문서와 기계가 읽을 수 있는 JSON을 나눈다.

```text
.ditto/
  config.toml
  work-items/
    <work-id>/
      work-item.json
      progress.md
      decisions.md
      language.md
      context-packet.md
      handoff.md
      evidence/
        commands.jsonl
        tests.md
        screenshots/
        logs/
  runs/
    <run-id>/
      manifest.json
      prompt.md
      stdout.log
      stderr.log
      diff.patch
      result.md
      eval.md
  knowledge/
    CONTEXT.md
    glossary.json
    adr/
    out-of-scope.md
```

원칙은 단순하다.

- `work-item.json`은 현재 작업의 authoritative state다.
- `progress.md`, `decisions.md`, `handoff.md`는 사람이 이어받기 위한 view다.
- 큰 출력은 `evidence/`와 `runs/`에 두고, context에는 path, hash, 짧은 요약만 넣는다.
- summary는 원본을 대체하지 않는다.
- `language.md`는 해당 work item에서 새로 합의되거나 수정된 용어를 기록한다.
- `.ditto/knowledge/CONTEXT.md`는 현재 프로젝트의 ubiquitous language와 domain glossary의 사람이 읽는 원본이다.
- `.ditto/knowledge/glossary.json`은 lint, prompt build, self-check에서 쓰는 기계 판독 view다.

### 3.2 core interface

v0에서 바로 코드로 크게 만들지는 않더라도, 다음 책임선은 초기에 고정한다.

| Interface | 책임 | v0 구현 형태 |
|---|---|---|
| `WorkItemStore` | 목표, 상태, acceptance criteria, 변경 파일, risk, handoff | `.ditto/work-items/<id>/work-item.json` |
| `RunStore` | provider 실행 manifest, logs, diff, result, eval | `.ditto/runs/<id>/manifest.json` |
| `ArtifactStore` | logs, screenshots, traces, reports, generated context | repo-local artifact paths |
| `ProviderAdapter` | Codex/Claude/OpenCode 실행과 profile 번역 | thin wrapper |
| `PolicyGate` | profile, permission, network, destructive action 점검 | doctor + wrapper preflight |
| `ContextPacket` | 최신 goal/evidence 중심 run prompt | generated Markdown |
| `Evaluator` | generator와 분리된 검증 report | reviewer/verifier contract |
| `InstructionBridge` | AGENTS/CLAUDE/rules/skills drift 관리 | projection + doctor |
| `LanguageLedger` | 프로젝트 용어 합의, 변경, 적용 범위 추적 | `CONTEXT.md` + `glossary.json` + work item `language.md` |
| `SelfCheck` | 출력 전 정제, 질문 전 self-answer, 완료 주장 lint | Stop hook + completion contract lint |

DITTO 구현 자체도 Deep Module 원칙을 따른다. public interface는 좁고 안정적으로 유지하고, provider별 실행, evidence 수집, lint, sync 같은 복잡도는 interface 뒤의 깊은 구현으로 숨긴다.

새 interface는 한 번에 전면 적용하지 않고 다음 순서로 통합한다.

| Interface | v0.1 | v0.3 | v0.6 |
|---|---|---|---|
| `SelfCheck` | contract fixture와 정적 lint 규칙 | context packet의 expected output contract에 포함 | Stop hook에서 완료/질문/표현 lint 활성화 |
| `LanguageLedger` | `CONTEXT.md`, `glossary.json`, `language.md` fixture | prompt build와 context packet에 glossary 반영 | doctor/lint와 Stop hook에서 불일치와 미합의 용어 감지 |
| `PolicyGate` | schema와 preflight fixture | provider wrapper 실행 전 profile 점검 | hook과 safety shim evidence 연결 |

### 3.3 공통 운영 예산

token 비용은 특정 기능의 옵션이 아니라 모든 phase의 공통 제약이다.

- context packet은 target/max token 또는 문자 수 budget을 가진다.
- subagent는 time cap, output cap, evidence preview cap, 재시도 횟수를 가진다.
- evaluator는 기본 reviewer와 expensive council을 분리하고, partial result도 artifact로 남긴다.
- evidence collector는 큰 로그를 context에 직접 넣지 않고 path/hash/preview만 포함한다.
- 같은 실패를 반복 실행할 때는 새 근거가 생겼는지 기록하고, 없으면 재실행을 막거나 명시적으로 `repeat-without-new-evidence`로 남긴다.

## 4. 구현 로드맵

### Phase 0: 계약과 fixture 먼저 고정

목표: 코드를 많이 쓰기 전에 DITTO가 소유할 상태와 완료 조건을 고정한다.

산출물:

- `work-item.json` schema
- `manifest.json` schema
- `completion contract`
- `completion self-check contract`
- `reviewer/evaluator output contract`
- `provider profile matrix`
- ubiquitous language 합의 workflow와 `CONTEXT.md`/`glossary.json` schema
- ask-user policy: 질문 전 self-answer 가능성 점검 contract
- persistence policy: `partial|unverified|blocked` work item의 재진입/알림 규칙
- `.ditto` commit/sync policy: 다른 PC나 새 세션에서 이어받기 위한 포함/제외 범위
- 샘플 `.ditto/work-items/<id>`와 `.ditto/runs/<id>` fixture

검증:

- fixture만 읽고도 사람이 목표, 진행 상태, 검증 결과, 다음 행동을 설명할 수 있어야 한다.
- schema validation 실패 사례를 포함한다.
- 합의되지 않은 용어, 근거 없는 완료 주장, 불필요한 사용자 질문 fixture가 self-check에서 실패해야 한다.
- `.ditto` sync fixture만으로 다른 clone/session에서 work item 상태와 handoff를 재구성할 수 있어야 한다.

근거:

- `03-claude-codex-adoption-map-ko.md`: task state를 DITTO 용어의 work item state로 해석하고, run manifest, completion contract를 Apply now로 분류한다.
- `get-shit-done.md`: phase artifact와 PLAN frontmatter가 병렬 실행과 재개성을 만든다.
- `blogs/02-managed-agents-annotated-ko.md`: session은 context window가 아니며 handoff artifact가 장기 작업의 핵심이다.

### Phase 1: 최소 CLI와 repo-local 상태 저장

목표: DITTO가 작업과 실행을 기록할 수 있는 최소 명령을 만든다.

우선 명령:

- `ditto work start`
- `ditto work status`
- `ditto work handoff`
- `ditto run record`
- `ditto verify`

동작:

- 새 work item을 만들 때 source request, goal, acceptance criteria, owner profile을 기록한다.
- 실행 결과를 run으로 연결한다.
- handoff는 변경 파일, 결정, 검증, 미검증, 다음 fresh evidence를 포함한다.
- `partial|unverified|blocked` 상태는 명시적 next evidence 또는 re-entry command를 가져야 한다.
- commit 대상 `.ditto` 파일과 로컬 전용 artifact를 구분한다.

검증:

- 새 work item 생성, run 연결, handoff 생성까지 golden fixture와 diff로 확인한다.
- dirty git 상태에서 기존 사용자 변경을 덮거나 삭제하지 않는지 확인한다.
- 새 clone/session에서 committed `.ditto` 상태만으로 `work status`와 `work handoff`가 동작해야 한다.

근거:

- `oh-my-codex.md`, `oh-my-claudecode.md`: state와 artifact를 분리하고 stage handoff를 둔다.
- `superpowers.md`: 완료 전 fresh evidence와 handoff를 요구한다.
- `mattpocock-skills.md`: durable artifact와 throwaway artifact를 분리한다.

### Phase 2: doctor와 instruction bridge

목표: host별 지침과 설정 drift를 실행 전에 드러내고, host instruction projection을 source(AGENTS.md)와 결정적으로 동기화한다.

우선 명령:

- `ditto doctor instructions`
- `ditto doctor permissions`
- `ditto doctor mcp`
- `ditto doctor surface`
- `ditto bridge sync` — AGENTS.md를 host projection의 managed block에 동기화. read-only doctor와 분리해 destructive 동작을 격리.

Host adapter 구조:

- `src/core/hosts/types.ts`의 `HostAdapter` interface와 registry. 두 builtin: `codex`, `claude-code`. v0.3+에서 OpenCode/OpenAgent 같은 host를 같은 interface로 추가.
- 모든 doctor 명령은 `--host codex|claude-code` 옵션을 받고, 미지정 시 등록된 모든 host를 검사.

검사 항목:

- AGENTS.md(source)와 host projection의 drift. claude-code는 CLAUDE.md의 managed block과 marker sha256까지 3단 비교(content/marker/source). codex는 AGENTS.md 자체와 marker 부재 확인.
- managed block marker 형식: `<!-- ditto:managed:start source=AGENTS.md sha256=<64hex> -->` ~ `<!-- ditto:managed:end -->`. sha256은 LF/trailing whitespace 정규화 후 계산.
- `.codex/config.toml`, `.claude/settings.json`의 위험 표면(dangerous mode, network-on, approval bypass, secrets-read 가능성, write_outside_workspace).
- MCP server/tool inventory와 scope:
  - Codex: `~/.codex/config.toml`의 `[mcp_servers.*]` (scope=user).
  - Claude Code: 공식 scope 순서 `.mcp.json` → `~/.claude.json` project entry → user entry. `.claude/settings.json`의 mcpServers는 주 경로가 아니므로 발견 시 unverified로 별도 보고.
- skill/agent/command manifest와 실제 파일의 일치. v0.2는 인벤토리 수집 + missing/extra/renamed 분류까지, schema 검증은 Phase 9 skill catalog 확정 후.

검증:

- 정상 fixture와 의도적으로 drift가 있는 fixture를 모두 테스트한다.
- doctor/bridge 모두 human output과 JSON output, 결정적 exit code(drift→1, usage→65, runtime→70)와 `--advisory` 옵션을 제공한다.
- `bridge sync --check`는 dry-run이며 파일을 수정하지 않는다.
- `bridge sync`는 managed block 밖의 사용자 자유 영역을 어떤 경우에도 수정하지 않는다.

근거:

- `oh-my-codex.md`: plugin discovery와 setup, doctor의 증명 경계를 분리한다.
- `oh-my-opencode-slim.md`: 설정 schema, doctor, host smoke가 완료 증거가 된다.
- `andrej-karpathy-skills.md`, `mattpocock-skills.md`: host별 instruction 수동 복제는 drift를 만든다.

### Phase 3: provider wrapper와 profile

목표: v0.1에서 만든 RunStore와 `ditto run record`가 *수동 입력*으로만 manifest를 채우는 한계를 넘어, 실제 provider CLI를 spawn하고 그 결과를 manifest에 자동으로 기록한다.

v0.1/v0.2에서 이미 준비된 것 (재구현 금지):

- `RunStore` core와 `manifest.json` schema (work_item_id, provider, profile, git_before/after, stdout/stderr/diff path, verifications, unverified 등).
- `ditto run record` CLI 골격 — 현재는 git_before snapshot 자동 캡처 + 명시 인자로 manifest 생성. provider 자체는 spawn하지 않음.
- `HostAdapter` interface — provider별 spawn 방식을 어댑터에 흡수할 수 있는 토대.

새로 추가할 것:

- `ditto run with --provider codex|claude-code --profile <name> -- <args...>` — 지정 provider를 spawn하고 stdout/stderr/diff/exit_code를 manifest에 자동으로 채움.
- profile별 환경 격리:

| Profile | 용도 | 기본 정책 |
|---|---|---|
| `read-only` | 조사, 계획, 리뷰 | write/network off |
| `workspace-write` | 일반 구현 | workspace write, network off |
| `networked` | 문서/패키지 확인 | network explicit, artifact logging |
| `reviewer` | 독립 검증 | read-only, write 금지 |
| `isolated` | 위험 작업 | worktree/container/cloud 우선 |

우선 provider:

1. Codex CLI (사용자 기본 host)
2. Claude Code
3. OpenCode/OpenAgent 계열은 adapter contract가 안정된 뒤 검토

wrapper가 남길 것 (v0.1 schema 채움):

- provider, entrypoint, model reported/unknown
- profile, cwd, git head, dirty before/after (`run record`로 이미 채워지지만 spawn 결과로 갱신)
- prompt/context packet path
- stdout/stderr, diff, exit status (자동 capture)
- verification command/result (기존 `verify` 명령과 연결)
- unverified 항목

검증:

- provider command가 실패해도 manifest와 logs가 남아야 한다.
- 실행 전후 git state와 changed files가 기록되어야 한다.
- networked profile이 아닌데 network 사용이 필요한 경우 미검증 또는 차단으로 남아야 한다.
- v0.1의 `run record`(수동 manifest)와 v0.3의 `run with`(spawn 기반)가 같은 schema에 부합한다.

근거:

- `03-claude-codex-adoption-map-ko.md`: provider wrapper와 profile을 Apply now로 둔다.
- `oh-my-claudecode.md`: external analyzer는 raw CLI가 아니라 wrapper로 통제해야 한다.
- `oh-my-opencode-slim.md`: expensive council과 webfetch는 opt-in/allowlist가 필요하다.

### Phase 4: workflow loop와 completion gate

목표: DITTO의 기본 작업 루프를 산출물과 권한으로 고정한다.

기본 흐름:

```text
intent/context
  -> self-answer check before asking user
  -> clarify only if necessary
  -> plan
  -> plan-check
  -> execute
  -> verify
  -> review if needed
  -> handoff/postmortem
```

단계별 계약:

| 단계 | 수정 권한 | 출력 |
|---|---|---|
| intent/context | read-only | goal, acceptance criteria, unknowns |
| plan | read-only | plan artifact, verification plan |
| plan-check | read-only | coverage/conflict/risk/devil's-advocate verdict |
| execute | scoped write | implementation summary, changed files |
| verify | read-only 우선 | test/eval/browser evidence |
| review | read-only | findings with file/path/evidence |
| handoff | write to `.ditto` only | handoff.md, updated work item state |

plan-check 책임:

- 계획이 acceptance criteria를 빠뜨리지 않았는지 확인한다.
- 기존 가설을 의도적으로 반박하고, 반례와 더 단순한 대안을 제시한다.
- 근거가 약한 전제는 `assumption` 또는 `unknown`으로 낮춘다.
- 실행 전에 충돌, 되돌리기 어려운 결정, 비용이 큰 검증을 드러낸다.

completion contract 필수 필드:

- 변경 요약
- 변경 파일
- acceptance criteria별 상태
- 실행한 검증 명령과 결과
- 검증하지 못한 항목
- 남은 risk
- 다음 session handoff 위치

사용자 질문 gate:

- 질문 전에 코드, 문서, 기존 `.ditto` artifact, 접근 가능한 외부 근거로 답할 수 있는지 확인한다.
- 스스로 답할 수 없고 제품 의미나 되돌리기 어려운 판단이 필요한 경우에만 질문한다.
- 질문에는 사용자가 현재 응답만 보고 판단할 수 있는 충분한 맥락과 선택 결과의 차이를 포함한다.
- 절차 위임형 질문, 안부성 질문, 자동 꼬리물기 추천은 self-check 실패로 본다.

출력 전 self-check:

- 합의되지 않은 약어와 프로젝트 용어를 `LanguageLedger`와 대조한다.
- 위치, ID, 제목만 언급하고 판단 맥락을 빠뜨린 응답을 막는다.
- 추측, 과대표현, 미검증 완료 선언을 completion contract 위반으로 기록한다.
- 근거 없는 단정을 막고, 확실한 근거가 없으면 `모름`, `근거 부족`, `미검증`으로 표시한다.
- 사용자가 이전 대화나 코드를 다시 읽지 않아도 판단할 수 있도록 필수 맥락과 근거 요약을 함께 제공한다.
- 검증하지 못한 항목은 `unverified`로 남기고 완료 문장과 분리한다.

검증:

- 검증 명령이 없으면 완료가 아니라 `unverified`로 기록한다.
- 일부러 결함 있는 diff를 주고 reviewer가 `partial|fail`로 판정하는지 확인한다.
- 불필요한 사용자 질문 fixture와 과대표현 응답 fixture가 self-check에서 실패해야 한다.

근거:

- `get-shit-done.md`: planner/checker/executor/verifier 역할 분리.
- `superpowers.md`: verification-before-completion과 2단계 리뷰.
- `blogs/01-anthropic-engineering-survey.md`: generator와 evaluator 분리.

### Phase 5: context packet과 evidence collector

목표: context rot을 "더 긴 prompt"가 아니라 evidence selection으로 줄인다.

우선 기능:

- `ditto context build`
- `ditto explore`
- `ditto codemap`
- `ditto evidence add`

context packet 구성:

1. Current goal
2. Acceptance criteria
3. Current git state
4. Relevant files
5. Last failure
6. What not to touch
7. Evidence and artifact pointers
8. Expected output contract

evidence collector 원칙:

- read-only allowlist
- env scrub
- timeout/process/output cap
- line range, hash, command 기록
- 큰 출력은 artifact로 저장하고 context에는 preview만 남김

검증:

- 큰 로그를 넣어도 context packet이 정해진 크기 안에서 pointer 중심으로 생성되어야 한다.
- read-only explore가 write side effect를 내지 않는지 테스트한다.

근거:

- `oh-my-codex.md`: read-only 탐색/요약 하네스와 line range/hash.
- `deepagents.md`: large tool result offload와 progressive disclosure.
- `oh-my-openagent.md`: LSP/AST/Playwright 같은 근거 기반 도구.

### Phase 6: evaluator lane과 E2E 검증

목표: 구현자 자기평가를 신뢰하지 않는 검증 lane을 만든다.

우선 agent/profile:

- `explorer`
- `plan-checker`
- `verifier`
- `code-reviewer`
- `security-reviewer`
- `e2e-reviewer`
- `cross-provider-reviewer`

cross-provider reviewer:

- generator와 다른 provider 또는 모델 family를 우선 사용한다.
- 같은 provider 안에서도 성격이 다른 모델 조합을 reviewer matrix에 둘 수 있다.
- 비용 budget 안에서 기본 evaluator lane의 1급 선택지로 둔다.
- multi-model council은 여러 reviewer의 정반합이 필요한 고위험 변경에만 opt-in으로 실행한다.
- provider unavailable 또는 budget 초과는 `unverified`가 아니라 `review-not-run` 사유와 함께 별도 기록한다.

reviewer output:

```text
Verdict: pass|partial|fail|unverified
Evidence:
- command/result or artifact path
Findings:
- severity, file/path, reason
Unverified:
- unchecked item and why
Recommended next action:
- concrete next step
```

E2E 방향:

- MCP 의존만 두지 않는다.
- Playwright CLI 또는 browser automation command를 DITTO evidence path에 연결한다.
- screenshot, trace, console log, network failure를 run artifact로 저장한다.

검증:

- 실패하는 테스트/브라우저 시나리오가 `fail` 또는 `partial`로 기록되어야 한다.
- 브라우저 설치 실패는 성공으로 포장하지 않고 `unverified`로 남긴다.
- 같은 변경을 generator와 다른 provider/model reviewer가 독립 contract로 평가한 fixture를 포함한다.
- 최소 두 provider family와 같은 provider 내 대체 model family를 표현하는 reviewer matrix fixture를 둔다.

근거:

- PURPOSE.md: E2E 테스트 도구와 멀티 모델 적대적 검토를 요구한다.
- `oh-my-openagent.md`: Playwright CLI 계열 브라우저 검증.
- `mattpocock-skills.md`: diagnose의 deterministic pass/fail feedback loop.

### Phase 7: bounded subagent와 병렬 coordination

목표: subagent를 context rot 완화 장치로 쓰되, 충돌과 비용을 통제한다.

child work item contract:

- parent work id
- child work id
- assigned scope
- forbidden scope
- allowed files/tools
- expected output
- evidence path
- merge owner
- budget/time cap
- cancel/timeout policy
- token/output cap

처음 적용할 사용처:

- 대형 코드베이스 read-only 탐색
- 독립 리뷰
- 로그 분석
- E2E 실패 원인 조사
- 문서/코드 근거 수집

병렬 실행 gate:

- 같은 wave의 파일 수정 범위가 겹치면 직렬화한다.
- nested delegation은 기본 금지한다.
- child transcript 전체를 parent context에 넣지 않는다.
- parent는 answer, evidence, uncertainty만 받는다.
- child가 `partial|unverified`로 끝나면 parent work item에 재진입 후보로 연결한다.

검증:

- 같은 파일을 수정하는 두 child work item이 동시에 실행되지 않아야 한다.
- child output이 contract를 어기면 merge 전에 실패해야 한다.

근거:

- `get-shit-done.md`: PLAN frontmatter, wave, file overlap gate.
- `oh-my-opencode-slim.md`: bounded subtask, session reuse, TTL/read cap.
- `deepagents.md`: stateless subagent와 async task handle.
- `oh-my-codex.md`: claim/lease/mailbox/heartbeat/terminal guard.

### Phase 8: hooks, tool safety shim, policy gate

목표: native lifecycle에 DITTO 기록과 guardrail을 붙인다.

우선 hook:

- SessionStart: work item/context pointer 표시
- PreToolUse: 위험 command, secret path, workspace 밖 write 감지
- PostToolUse: command/file/tool result evidence 기록
- Stop: completion contract와 self-check 검사, handoff 생성 유도

tool safety shim:

- stale patch rescue는 ambiguity에서 실패
- AST replace는 dry-run 기본
- URL fetch는 redirect/content limit와 cache
- git destructive command는 structured parser 또는 wrapper로 제한
- dependency 추가는 package legitimacy/provenance check

주의:

- hook은 유일한 보안 경계가 아니다.
- prompt 지시만으로 권한을 통제하지 않는다.
- advisory hook과 CI blocking scan을 분리한다.

검증:

- block 대상 command가 실제 차단되거나 명확히 warning/evidence로 남아야 한다.
- hook 실패가 사용자 작업을 불필요하게 망가뜨리지 않는지 확인한다.
- Stop hook은 검증 없는 완료 주장, 불필요한 사용자 질문, 합의되지 않은 용어 사용을 lint해야 한다.

근거:

- `oh-my-opencode-slim.md`: apply_patch hook, AST-grep dry-run, webfetch limit.
- `mattpocock-skills.md`: regex guardrail의 한계와 structured parsing 필요.
- `get-shit-done.md`: prompt injection/secret scan은 runtime advisory와 CI blocking을 분리한다.

### Phase 9: skill catalog와 knowledge 관리

목표: 반복 workflow를 ad hoc prompt가 아니라 progressive disclosure skill로 관리한다.

초기 skill pack:

| Skill | 목적 |
|---|---|
| `diagnose` | 재현, 가설, 계측, 수정, 회귀 확인 |
| `tdd` | public behavior 중심 red-green-refactor |
| `handoff` | 새 세션용 상태 압축 |
| `review-work` | 목표 적합성, QA, 보안, 코드 품질 분리 검토 |
| `playwright` | 사용자 시나리오 기반 브라우저 검증 |
| `deep-interview` | 도메인/제품 의미가 불명확할 때만 질문 |
| `codemap` | repo map과 변경 감지 |
| `write-a-skill` | skill description discipline과 references/scripts 분리 |
| `using-git-worktrees` | 작업공간 격리와 cleanup 소유권 |

skill 규칙:

- description은 "언제 쓰는가"만 담는다.
- 본문 절차는 `SKILL.md`에 둔다.
- 큰 예제와 reference는 `references/`에 둔다.
- deterministic helper는 `scripts/`에 둔다.
- hard dependency와 soft dependency를 구분한다.
- public/private/in-progress/deprecated surface를 manifest로 검증한다.

knowledge 규칙:

- `CONTEXT.md`는 ubiquitous language와 domain glossary만 저장한다.
- ADR은 되돌리기 어려운 결정만 저장한다.
- out-of-scope는 반복 제안과 반려 사유를 보존한다.
- stale memory는 owner, timestamp, freshness check가 있어야 한다.
- `agent-intelligence-memory-report.md`는 DITTO 자체 지식관리 요구의 source reference로 연결한다.
- Karpathy LLM Wiki에서 흡수한 원칙은 그대로 복사하지 않고 skill/reference 또는 regression fixture로 분리한다.
- 외부 reference에서 온 지식은 source, imported_at, freshness policy를 남긴다.

검증:

- skill manifest와 실제 파일의 drift를 lint한다.
- description만으로 routing은 가능하되 절차 shortcut이 생기지 않는지 fixture로 확인한다.
- `CONTEXT.md`와 `glossary.json`이 불일치하면 doctor/lint가 실패해야 한다.

근거:

- `mattpocock-skills.md`: repo-local setup, hard/soft dependency, CONTEXT.md, ADR.
- `superpowers.md`: description discipline과 session-start bootstrap test.
- `andrej-karpathy-skills.md`: 짧은 원칙과 긴 예제 분리.
- `deepagents.md`: progressive disclosure skill과 always-loaded memory 분리.

### Phase 10: 하네스 regression과 postmortem

목표: DITTO 자체 변경을 감이 아니라 evidence로 수락한다.

대상:

- prompt 변경
- tool description 변경
- context packet policy 변경
- provider profile 변경
- permission/hook 변경
- skill routing 변경

필수 artifact:

- 변경 전후 manifest
- affected contract
- smoke/regression 결과
- 실패 transcript 또는 재현 명령
- rollback plan
- postmortem note, 필요 시 ADR

초기 평가 fixture:

- 요청 밖 기능 추가 방지
- 단일 사용 추상화 방지
- 검증 없는 완료 방지
- stale context 기반 잘못된 판단 방지
- destructive git command 방지
- E2E 실패를 성공으로 포장하지 않기

검증:

- fixture가 실패하면 하네스 변경을 release하지 않는다.
- benchmark는 versioned로 관리하고, 공개 prompt는 오염 가능성을 표시한다.

근거:

- `blogs/01-anthropic-engineering-survey.md`: postmortem 없는 harness는 품질 저하 원인을 가를 수 없다.
- `deepagents.md`: better-harness의 train/holdout/scorecard/proposal artifact.
- `andrej-karpathy-skills.md`: 나쁜 예/좋은 예 pair를 regression prompt로 사용할 수 있다.

### Phase 11: 팀업 통합

목표: 개인 harness를 팀의 backlog, issue, project, 문서 시스템과 연결하되 v0의 evidence ledger를 흐리지 않는다.

범위:

- GitHub Issues와 GitHub Projects의 work item backlink
- scrum backlog item과 DITTO work item의 상태 mapping
- Confluence 또는 지식베이스 저장소로 handoff/decision publish
- 팀 공유 glossary와 repo-local `CONTEXT.md` 동기화
- multi-repo workspace에서 공통 work item과 repo별 run/evidence 연결

원칙:

- v0.1-v0.6의 local-first ledger가 먼저다.
- 외부 도구는 source of truth를 빼앗지 않고 pointer와 sync artifact를 남긴다.
- 외부 write는 profile과 audit log를 가진 명시 명령으로만 수행한다.
- 팀 도구 unavailable 상태는 작업 완료 여부와 분리해 기록한다.

검증:

- GitHub/Confluence API 없이도 dry-run fixture로 payload와 mapping을 검증한다.
- sync 실패가 work item의 local handoff를 손상하지 않아야 한다.

상태:

- v0 구현에서는 deferred다.
- PURPOSE의 팀업 요구를 추적하기 위해 phase는 남기되, local evidence ledger와 session resume이 안정된 뒤 시작한다.

## 5. 우선순위별 첫 구현 묶음

### v0.1: Evidence-bearing work ledger (done)

진행 상태: wi_v01bootstrap + wi_v01implement로 완료, final_verdict=pass.

포함:

- `.ditto/work-items`와 `.ditto/runs` zod schema (work-item / run-manifest / completion-contract / reviewer-output / glossary / language-ledger / command-log-entry)
- `work start/status/handoff`, `run record`, `verify` CLI (Bun + TypeScript + citty)
- completion contract와 cross-field 룰: final_verdict=pass는 모든 acceptance pass + in-scope unverified 0건. 비-pass는 next_handoff_path 강제. status=partial/unverified/blocked는 re_entry 강제.
- handoff 시 git diff 기반 changed_files 자동 수집 (`work handoff --base <ref>`).
- ubiquitous language ledger와 `CONTEXT.md`/`glossary.json` fixture (password-strength 골든 fixture + DITTO 자체 .ditto/knowledge/).
- fixture 기반 schema test + 본 repo .ditto self-validation 테스트.
- `.gitignore`로 `.ditto/runs/`, `evidence/`, `dist/`, `.bun/` 제외.

v0.x 진행 중 deferred:

- **self-check contract**: 현재는 completion contract의 cross-field 룰 + handoff의 stale resume 차단으로 부분 구현. 출력 lint(약어/추측/과대표현 정규식 검사)와 자기 답변 가능성 검사는 별도 work item으로 분리 예정.
- **ask-user policy fixture**: 현재 PURPOSE.md의 원칙만 있고 결정적 lint는 미구현. Phase 4 workflow loop 단계에서 hook으로 흡수 예정.
- **정식 `.ditto` commit/sync policy 문서**: 현재 `.gitignore`로만 표현. ADR로 정리는 별도 task.

완료 기준:

- 한 작업의 목표, 변경, 검증, 미검증, handoff를 대화 없이 artifact만으로 재구성할 수 있다.
- 다른 clone/session에서 committed `.ditto` 파일만으로 현재 상태와 다음 fresh evidence를 확인할 수 있다.
- DITTO 자체 v0.1 work item이 DITTO 도구로 검증·마감되어 있다.

### v0.2: Doctor and instruction bridge (done)

진행 상태: wi_v02doctor로 완료, final_verdict=pass.

포함:

- `doctor instructions` — AGENTS.md ↔ host projection drift 3단 sha256 비교 (claude-code 5종 finding) + codex 2종 finding (`marker_in_source`, `source_missing`).
- `doctor permissions` — 두 host 위험 표면을 공통 enum(`dangerous_mode|network_on|secrets_read|write_outside_workspace|approval_bypass`)으로 정규화.
- `doctor mcp` — 두 host MCP 설정 파일 합산. Claude는 공식 scope 순서(.mcp.json → ~/.claude.json project/user → 그 외 unverified).
- `doctor surface` — 두 host의 skill/agent/command/plugin 디렉터리 인벤토리. `.ditto/surfaces.json` mock catalog와 missing/extra/renamed 분류.
- `bridge sync --host claude-code` — AGENTS.md → CLAUDE.md managed block. marker 형식 + sha256. `--check` dry-run. 자유 영역 보존.
- `HostAdapter` interface + 두 builtin host(codex, claude-code) + registry. v0.3+에서 새 host 추가가 어댑터 파일 + 등록만으로 끝남.
- `surface-catalog` zod schema와 self-validation.

완료 기준:

- Codex/Claude Code가 읽는 지침, permission, MCP, skill 표면의 drift가 human/json 결과와 exit code(drift→1, usage→65, runtime→70, `--advisory` 옵션)로 드러난다.
- `bridge sync`로 host projection을 결정적으로 동기화하고, doctor instructions는 read-only로 검사만 한다.
- DITTO 자체 v0.2 work item이 DITTO 도구로 검증·마감되어 있다.

### v0.3: Provider wrapper and context packet (next)

포함:

- `ditto run with --provider codex|claude-code --profile <name> -- <args...>` — provider CLI spawn + manifest 자동 채움. v0.1 RunStore와 manifest.json schema를 그대로 재사용.
- Codex wrapper와 Claude Code wrapper를 `HostAdapter`(v0.2 도입) 위에 얹어 `spawnRun`/`captureArtifacts` 같은 메서드로 확장.
- read-only/workspace-write/reviewer/networked/isolated profile의 실행 정책(권한 격리, network 차단, worktree 격리 등).
- `ditto context build` — 현재 work item과 git/evidence 상태로 prompt(context packet) 생성. v0.1 schema에는 prompt_path만 있는데, 그 path에 들어갈 markdown을 자동 생성.
- stdout/stderr/diff/verification capture를 manifest에 연결.
- v0.1의 수동 `run record`와 v0.3의 자동 `run with`가 같은 schema에 부합 (회귀 fixture로 확인).

완료 기준:

- provider 실행 실패와 성공이 모두 `.ditto/runs/<id>`에 재현 가능한 evidence로 남는다.
- profile별 권한 격리가 실제로 적용된다(workspace-write에서 cwd 밖 write가 차단되는지 회귀 fixture).
- DITTO 자체 v0.3 work item이 DITTO 도구로 검증·마감되어 있다.

### v0.4: Evaluator and E2E lane

포함:

- verifier/reviewer contract
- `verify-work`
- Playwright CLI evidence path
- review result schema
- cross-provider reviewer profile
- reviewer model/provider matrix fixture
- expensive multi-model council command는 별도 opt-in

완료 기준:

- 구현 agent 결과를 별도 read-only verifier가 acceptance criteria별로 pass/partial/fail/unverified로 판정한다.
- 고위험 변경은 generator와 다른 provider/model reviewer가 독립 verdict를 남길 수 있다.

### v0.5: Bounded subagent and skill catalog

포함:

- child work item contract
- file overlap gate
- codemap/explore/review subagents
- subagent budget envelope
- 초기 skill pack manifest
- skill drift lint

완료 기준:

- 독립 조사/검증 작업을 parent context 오염 없이 실행하고, 결과가 evidence summary로 병합된다.
- child의 `partial|unverified` 상태가 parent handoff와 재진입 후보로 연결된다.

### v0.6: Hooks and policy safety

포함:

- SessionStart/PostToolUse/Stop evidence hooks
- PreToolUse advisory guardrail
- Stop self-check lint
- patch/git/fetch/dependency safety shim
- CI blocking scan 분리

완료 기준:

- 위험 action은 native permission과 DITTO policy 양쪽에서 추적되고, hook 결과가 work item/run evidence에 연결된다.
- 검증 없는 완료 주장과 불필요한 사용자 질문은 Stop hook에서 완료 상태로 통과하지 못한다.

## 6. 문서별 적용 매핑

| 입력 문서 | DITTO 적용 |
|---|---|
| `03-claude-codex-adoption-map-ko.md` | Apply now/delegate/defer/avoid의 상위 분류. 이 계획의 기본 경계다. |
| `blogs/01-anthropic-engineering-survey.md` | session/harness/sandbox, ContextAssembler, evaluator, sandbox/eval/postmortem 원칙. |
| `blogs/02-managed-agents-annotated-ko.md` | SessionLog, HarnessLoop, Sandbox, ContextAssembler, Evaluator 책임선. |
| `oh-my-codex.md` | workflow layer, state/handoff, read-only evidence collector, doctor/setup 분리, team state API. |
| `oh-my-claudecode.md` | stage handoff, primary loop authority, continuation exception, external analyzer wrapper, deep interview. |
| `oh-my-openagent.md` | host-neutral core/adapter, delegation prompt contract, background explore/review, LSP/AST/Playwright evidence. |
| `oh-my-opencode-slim.md` | explicit agent registry, bounded subtask/session reuse, tool safety shim, doctor/host smoke, opt-in council. |
| `get-shit-done.md` | thin command/lazy workflow, planner/checker/executor/verifier, PLAN frontmatter, overlap gate, inventory/lint. |
| `deepagents.md` | scaffolding protection, structured file tools, offload, stateless subagent, better-harness eval loop. |
| `superpowers.md` | session bootstrap test, skill description discipline, subagent-driven development, verification-before-completion, worktree ownership. |
| `andrej-karpathy-skills.md` | think/simplicity/surgical/goal-driven behavior, bad/good examples as regression fixtures, host instruction projection. |
| `mattpocock-skills.md` | repo-local setup, hard/soft dependency, CONTEXT.md/ADR, diagnosis loop, AFK-ready brief, deep module skill. |

## 7. 남은 설계 질문

다음은 구현 중 확정해야 한다. 지금 문서 단계에서 사용자에게 결정 책임을 넘길 문제는 아니며, prototype evidence를 보고 좁혀야 한다.

1. `.ditto` artifact 보존 정책: commit/sync 대상은 v0.1에서 정하되 logs/screenshots/traces의 용량, 만료, 개인정보 scrub 정책이 필요하다.
2. Codex와 Claude Code wrapper의 command shape: provider별 CLI 안정성과 output capture 방식이 실제 확인되어야 한다.
3. host별 hook coverage: PreToolUse가 enforcement인지 advisory인지 provider마다 구분해야 한다.
4. E2E browser 설치와 cache 위치: local/CI/cloud 실행 환경별 실패 모드를 나눠야 한다.
5. knowledge freshness: CONTEXT.md와 ADR이 오래된 결정을 강화하지 않도록 owner와 review trigger가 필요하다.
6. cross-provider reviewer와 multi-model council의 비용 정책: 기본 reviewer budget, opt-in council budget, timeout, partial result contract가 필요하다.
7. 팀업 통합의 source of truth: GitHub Issues/Projects, Confluence, 지식베이스 저장소 중 어떤 필드가 DITTO local ledger와 양방향 sync되는지 prototype이 필요하다.
8. 지식관리 reference 흡수 방식: `agent-intelligence-memory-report.md`와 Karpathy LLM Wiki에서 어떤 내용을 skill, ADR, regression fixture로 나눌지 기준이 필요하다.
9. workspace-level state: v0.1-v0.6은 single-repo `.ditto`를 기준으로 하고, 여러 repo에 걸친 work item은 Phase 11의 workspace state 설계에서 확정한다.
10. v0.1에서 deferred된 self-check contract와 ask-user policy: 현재는 completion contract cross-field 룰로 부분 보장. 출력 lint와 사용자 질문 전 self-answer 검사가 별도 work item으로 정리되어야 한다.
11. v0.2에서 deferred된 host CLI 호출 보강: 현재 doctor mcp는 설정 파일 파싱만 사용. `codex mcp list`/`claude mcp list` 같은 host CLI를 보조 inventory로 추가할지, 어떤 시점에 추가할지 결정 필요.
12. v0.2의 `side_effect_label` enum: 현재 "external_process|stdio|unknown" 같은 free-form. plan에 명시된 `read|write|network|unknown` enum과 일치시키려면 host adapter에서 별도 분류 함수 필요.

## 8. 다음 작업

v0.1, v0.2 모두 완료. 다음은 v0.3(provider wrapper와 context packet)으로, v0.1에서 만든 RunStore/manifest schema와 v0.2에서 만든 HostAdapter 위에 `ditto run with`와 `ditto context build`를 얹는다.

`ditto-application-plan.md`는 wi_v01bootstrap에서 도입했고, v0.1/v0.2 진행 중 결정·deferral을 반영해 갱신되어 있다. v0.3 work item을 시작하기 전 본 plan의 Phase 3 본문 + v0.3 우선순위 묶음과 실제 구현 가정이 일치하는지 한 번 더 점검한다.

DITTO의 초기 구현은 "많은 agent를 부리는 시스템"보다 "작업과 증거를 잃지 않는 작은 시스템"이어야 한다. 그 기반이 있어야 subagent, E2E, multi-model review, long-running orchestration이 실제로 안전해진다.
