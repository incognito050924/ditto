# DITTO Project Context

본 문서는 DITTO 개발에서 사용자와 agent가 공유하는 ubiquitous language를 정의한다. 새 용어가 합의되면 본 문서와 `glossary.json`을 동시에 갱신한다. 정의되지 않은 약어는 사용자 응답에서 self-check가 reject한다.

## 핵심 용어

### request
사용자가 한 말의 원문 또는 그에 가까운 paraphrase. 한 요청에서 여러 work item이 파생될 수 있다.

### work item
DITTO가 추적하는 작업의 정규화 단위. goal, acceptance criteria, 실행 기록, 검증 evidence, handoff를 포함한다. 식별자: `wi_*`. `task`라는 이름은 사용하지 않는다 — subagent의 작은 작업, provider의 background task, GitHub task와 충돌한다.

### run
한 번의 provider 호출. 한 work item은 여러 run을 가질 수 있다. 식별자: `run_*`.

### run manifest
run의 권위 있는 기록 파일. provider, profile, git state, prompt, stdout/stderr, diff, verifications, unverified 항목을 포함한다.

### evidence
주장(완료, 검증, 결정)을 뒷받침하는 참조. command 실행 결과, 파일, artifact path, URL, note 형태. context에 직접 넣지 않고 path/hash/preview로 참조한다.

### handoff
work item을 다른 세션, 다른 PC, 다른 agent로 이어주기 위해 정리한 사람이 읽는 문서. 무엇이 끝났나, 무엇이 남았나, 어디서 이어받나, 어떤 fresh evidence가 필요한가, 무엇을 건드리지 않아야 하는가를 담는다.

### completion contract
work item 완료 주장에 필수인 필드 집합. acceptance verdict, 변경 파일, 검증 명령, unverified 항목, remaining risk, next_handoff_path를 포함한다. `final_verdict=pass`는 모든 acceptance가 pass여야만 허용된다.

### verdict
acceptance 또는 review의 판정. 값: `pass | partial | fail | unverified`.

### profile
실행 권한과 정책의 묶음. 값: `read-only | workspace-write | networked | reviewer | isolated`.

### provider
실제로 model/tool loop를 실행하는 host. 값: `codex | claude-code | opencode | openagent | other`.

### reviewer output
generator와 분리된 evaluator의 결과. verdict, evidence, findings, unverified, recommended next action을 담는다. `cross-provider-reviewer`는 generator와 다른 provider/model family를 우선 사용한다.

### self-check
사용자에게 응답이 나가기 전에 적용하는 결정적 lint. 미합의 용어, 약어 남용, 추측 단정, 미검증 완료 선언, 근거 없는 답변을 reject한다.

### language ledger
work item 진행 중 합의되거나 수정된 용어 변경 기록. 합의 후 글로벌 glossary로 흡수된다.

### glossary / CONTEXT.md
프로젝트 ubiquitous language의 권위 원본. `CONTEXT.md`는 사람용, `glossary.json`은 기계용 view.

### ADR (Architecture Decision Record)
되돌리기 어려운 결정의 영속 기록. `adr/ADR-NNNN-<slug>.md`. 결정만 보존하고, 토론은 `decisions.md`에 둔다.

### doctor
host별 instruction, permission, MCP, skill 표면의 drift를 점검하는 명령. 실행이 아니라 진단.

### context packet
run에 넘기는 prompt. goal, acceptance, git state, relevant files, last failure, what-not-to-touch, evidence pointer, expected output contract로 구성된다.

### unverified
"검증하지 못함"의 명시적 표기. 모름은 모름으로 표기해야 하며 완료 주장과 섞지 않는다.

## 금지 표현

다음 표현은 사용자 응답에서 self-check가 reject한다.

- `wi`, `rm`, `cfg` 같은 사전에 정의되지 않은 단독 약어
- "대략", "아마도", "거의 다 됐다" 같은 근거 없는 단정/모호 표현
- "위치/ID/제목만" 언급하고 판단 맥락을 빠뜨린 응답
- 검증 명령 없이 "완료/성공/통과"를 단정하는 문장

## 진화 규칙

- 새 용어 합의 전에 work item의 `language.md`와 `language-ledger.json`에 변경을 제안한다.
- 사용자 합의 후 본 문서와 `glossary.json`에 반영하고 `language-ledger.json`의 `agreed_with_user`를 `true`로 갱신한다.
- 사용 빈도가 낮아지면 `deprecated`로 표기하고 즉시 삭제하지 않는다.
