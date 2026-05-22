---
title: "Scaling Managed Agents 한국어 주석 해설"
tier: 1
repo: all
last_updated: 2026-05-22
scope: "Anthropic Engineering의 Scaling Managed Agents 원문과 본문 직접 연결 문서에 대한 상세 한국어 의역, 근거 주석, DITTO 적용 해설"
kind: ditto-research
sources:
  - https://www.anthropic.com/engineering/managed-agents
  - https://platform.claude.com/docs/en/managed-agents/overview
  - https://www.anthropic.com/engineering/building-effective-agents
  - https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
  - https://www.anthropic.com/engineering/harness-design-long-running-apps
  - https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
  - https://arxiv.org/abs/2512.24601
  - https://incompleteideas.net/IncIdeas/BitterLesson.html
  - https://www.catb.org/~esr/writings/taoup/html/ch01s06.html
  - https://cloudscaling.com/blog/cloud-computing/the-history-of-pets-vs-cattle/
---

# Scaling Managed Agents 한국어 주석 해설

이 문서는 Anthropic Engineering의 [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents)를 중심으로, 원문 본문에서 직접 연결된 문서들을 함께 읽기 위한 한국어 주석본이다.

저작권상 원문 전체를 문장 단위로 직역하지 않는다. 대신 원문의 섹션 순서와 논리 구조를 유지하면서 상세 한국어 의역, 근거 주석, DITTO 적용 해설을 붙인다. 직접 인용은 짧은 용어 수준으로만 제한한다.

## 0. 연결 문서 범위

이 문서에서 "연결 문서"는 `Scaling Managed Agents` 본문에서 직접 연결되거나, 그 문서의 핵심 논지를 받치는 공식 Anthropic Engineering 문서로 한정한다.

| ID | 문서 | 이 문서에서 보는 역할 |
|---|---|---|
| MA | [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents) | 중심 문서. session, harness, sandbox 책임 분리를 제안한다. |
| MAD | [Claude Managed Agents docs](https://platform.claude.com/docs/en/managed-agents/overview) | Managed Agents 제품/베타 문서. 개념을 실제 API와 운영 제약으로 옮긴다. |
| BEA | [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | agent/workflow 기본 원칙. 단순하고 조합 가능한 패턴에서 시작하라는 바닥 규칙이다. |
| EHA | [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | long-running coding에서 initializer/coding split, feature JSON, progress handoff를 제시한다. |
| HDL | [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps) | planner/generator/evaluator 분리와 context reset을 설명한다. |
| ECE | [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | context를 유한한 예산으로 보고 context rot, compaction, subagent, notes를 다룬다. |
| RLM | [Recursive Language Models](https://arxiv.org/abs/2512.24601) | context를 모델 바깥의 객체처럼 조작하는 접근이다. MA의 session/context 분리와 닿아 있다. |
| BL | [The Bitter Lesson](https://incompleteideas.net/IncIdeas/BitterLesson.html) | 특정 모델 한계에 맞춘 hand-coded 보정이 장기적으로 낡을 수 있다는 배경 철학으로 연결된다. |
| TAOUP | [The Art of Unix Programming](https://www.catb.org/~esr/writings/taoup/html/ch01s06.html) | 안정적인 interface가 예상 못 한 프로그램을 가능하게 한다는 Unix식 설계 배경이다. |
| PVC | [The History of Pets vs Cattle](https://cloudscaling.com/blog/cloud-computing/the-history-of-pets-vs-cattle/) | 개별 환경을 애지중지 관리하지 말고 재생성 가능한 자원으로 보라는 운영 은유다. |

주의: 외부 배경 글인 BL, TAOUP, PVC는 Anthropic 공식 문서가 아니다. 이 문서에서는 MA가 그 글들을 참조한 맥락만 좁게 사용한다.

## 1. 중심 논지 한 줄

`Scaling Managed Agents`의 핵심은 "agent를 하나의 긴 대화나 하나의 컨테이너로 보지 말고, session, harness, sandbox라는 세 책임으로 나누라"는 것이다. 이 분리는 확장성만을 위한 것이 아니다. 오래 실행되는 agent에서 context가 낡고, session 상태가 사라지고, 실행 환경이 특별한 애완 환경처럼 변하는 문제를 줄이기 위한 설계다. [MA]

DITTO 해설: DITTO가 장기 작업을 제대로 이어가려면 "현재 모델에게 무엇을 넣을까"보다 먼저 "원본 작업 기록은 어디에 남고, 실행은 어디서 일어나며, 모델 loop는 무엇을 책임지는가"를 분리해야 한다.

## 2. MA 원문 상세 의역과 주석

### 2.1 오래 실행되는 agent의 문제는 모델만의 문제가 아니다

원문은 Anthropic이 Claude Code에서 코딩 agent를 확장해 가며 여러 실험을 했다고 시작한다. 이때 단순히 모델 능력을 키우는 것만으로는 부족했다. agent를 오래 실행하고, 여러 작업을 동시에 돌리고, 사용자의 세션을 이어받게 하려면 주변 시스템이 모델만큼 중요해진다. [MA]

근거 주석:
- MA는 이 글이 "managed agents" 구현 과정에서 얻은 engineering lesson이라고 밝힌다.
- BEA도 agent가 모델 단독이 아니라 tool, prompt, workflow, orchestration의 조합이라고 본다. [BEA]

DITTO 해설: "모델이 더 좋아지면 해결된다"는 해석은 반만 맞다. 모델이 좋아져도 session log가 사라지거나, context trimming이 잘못되거나, sandbox 권한이 섞이면 품질은 떨어진다. DITTO의 경쟁력은 모델 호출 래퍼가 아니라 agent가 작업을 잃지 않게 하는 harness에 있다.

### 2.2 기존 harness 가정은 낡을 수 있다

MA는 harness가 특정 시점의 모델 약점을 보정하기 위해 만들어진다고 본다. 예를 들어 어떤 모델이 context window가 커질수록 불안해하거나, 이전 내용을 과도하게 신뢰하거나, 긴 작업에서 집중을 잃는다면 harness는 그 약점을 보완하는 규칙을 넣는다. 하지만 모델이 발전하면 그 보정이 더 이상 필요 없거나, 오히려 방해가 될 수 있다. [MA]

관련 근거:
- ECE는 context rot과 long-context degradation을 설명하며, 많은 token을 넣는 것이 항상 좋은 전략이 아니라고 말한다. [ECE]
- HDL은 긴 앱 개발 작업에서 coherence loss와 context anxiety를 관찰하고, 단순 compaction이 아니라 context reset과 structured handoff가 필요하다고 본다. [HDL]
- BL은 hand-coded 지식이나 특정 시점의 가정이 장기적으로 general method에 밀릴 수 있다는 배경 논리로 연결된다. [BL]

DITTO 해설: DITTO는 "context를 더 많이 넣자"를 기본값으로 삼으면 안 된다. 특정 모델의 현재 습관에 맞춘 prompt/hook/context policy는 버전이 올라가면 회귀 원인이 될 수 있다. 따라서 policy는 코드에 흩뿌리지 말고, 버전이 남고 rollback 가능한 harness 설정으로 관리해야 한다.

### 2.3 해결 방향은 가상화된 interface다

MA의 중요한 전환은 "agent를 잘 돌리는 법"이 아니라 "agent 구성 요소 사이의 interface를 안정화하는 법"이다. 원문은 operating system과 virtualization의 비유를 든다. 하드웨어나 구현 세부사항이 바뀌어도 process, file, socket 같은 interface가 안정적이면 상위 프로그램은 오래 버틴다. [MA]

관련 근거:
- TAOUP는 좁고 안정적인 interface가 나중에 예상하지 못한 조합을 가능하게 한다는 Unix 설계 철학을 제공한다. [TAOUP]
- BEA는 처음부터 복잡한 framework보다 단순하고 조합 가능한 pattern을 권한다. [BEA]

DITTO 해설: DITTO에서 먼저 고정해야 할 것은 `OpenAIProvider`나 `AnthropicProvider` 같은 provider interface만이 아니다. 더 위에 `SessionLog`, `HarnessLoop`, `Sandbox`, `ContextAssembler`, `PolicyGate`, `Evaluator`의 계약이 있어야 한다. 모델 provider는 그중 하나의 하위 구현이다.

### 2.4 책임 분리 1: session

MA에서 session은 Claude context window가 아니다. session은 작업의 영속 기록이다. 사용자 요청, tool call, tool result, system event, agent decision 같은 event가 append-only로 쌓이고, harness는 그중 필요한 slice를 골라 모델 context로 만든다. [MA]

관련 근거:
- EHA는 long-running coding에서 progress document, feature JSON, git commit 같은 handoff artifact를 남기라고 한다. [EHA]
- RLM은 context를 모델 내부의 고정 버퍼가 아니라 바깥에서 조작 가능한 객체로 보는 방향을 탐구한다. [RLM]

DITTO 해설: DITTO의 session은 "마지막 요약"이 아니다. 요약은 파생물이고, 원본 event stream이 진짜 session이다. 요약만 남기면 왜 실패했는지, 어떤 tool result를 근거로 판단했는지, 어느 시점에 context가 망가졌는지 재현할 수 없다.

구현 메모:
- `SessionLog.append(event)`
- `SessionLog.query(filter)`
- `ContextAssembler.select(session, task_state)`
- `ContextAssembler.render(selection)`

### 2.5 책임 분리 2: harness

MA에서 harness는 모델 호출과 tool routing loop를 담당한다. 모델이 다음 행동을 정하고, harness가 tool을 실행하고, 결과를 다시 모델에게 제공한다. 중요한 점은 harness가 session 저장소나 sandbox 구현과 강하게 묶이면 안 된다는 것이다. [MA]

관련 근거:
- BEA는 workflow와 agent를 구분한다. workflow는 미리 정해진 경로로 LLM과 tool을 조합하고, agent는 LLM이 process와 tool 사용을 동적으로 지휘한다. [BEA]
- MAD는 Managed Agents에서 agent environment, session events, tools를 별도 개념으로 다룬다. [MAD]

DITTO 해설: DITTO의 harness는 "모델 응답을 받아 tool을 부르는 while loop"보다 깊어야 한다. 다만 interface는 좁아야 한다. 예를 들면 harness는 다음만 책임진다.

- model input assembly 요청
- model call 실행
- tool call dispatch
- policy check 요청
- event emit
- stop/continue 판단

파일 실행, 네트워크 격리, event 보존, context selection은 다른 모듈 책임으로 뺀다.

### 2.6 책임 분리 3: sandbox

MA에서 sandbox는 agent가 손으로 만지는 세계다. 파일, command execution, network, dependency, workspace가 여기에 있다. 원문은 단일 container를 오래 살려두는 방식이 scale에서 문제가 된다고 설명한다. container가 특별한 상태를 품기 시작하면 재현, 이동, 회복이 어려워진다. [MA]

관련 근거:
- PVC의 "pets vs cattle" 비유는 특별히 보살피는 개별 서버 대신 재생성 가능한 서버 집합으로 운영하라는 cloud 운영 철학이다. [PVC]
- HDL과 EHA 모두 장기 작업에서 다음 agent가 이어받을 수 있는 artifact를 남기는 쪽을 권한다. 실행 환경 자체를 유일한 기억 장소로 만들지 않는다. [HDL], [EHA]

보안 주석: MA는 단일 container 설계에서 generated code와 credential이 같은 공간에 놓이는 문제를 지적한다. 구조적 해결은 token이 sandbox에서 닿을 수 없도록 하는 것이다. Git token은 sandbox 초기화 과정에만 쓰고, custom tool의 OAuth token은 vault와 proxy를 통해 사용한다. harness도 credential을 직접 알지 못하게 한다. [MA]

DITTO 해설: DITTO sandbox는 작업 상태의 유일한 저장소가 되면 안 된다. `node_modules`, build cache, temp file, local server state에 의존해 성공한 작업은 다음 세션에서 재현되지 않을 수 있다. sandbox는 disposable하게 만들고, 살아남아야 하는 것은 session log와 artifact로 올려야 한다. 또한 secret은 "모델이 읽지 않으면 된다"가 아니라 "sandbox에 존재하지 않는다"가 기본값이어야 한다.

구현 메모:
- sandbox 생성은 idempotent해야 한다.
- repo checkout, dependency install, env var injection은 runbook 또는 provision step으로 재현 가능해야 한다.
- secret은 sandbox 파일에 직접 남기지 말고 proxy/vault boundary를 둔다.

### 2.7 brain과 hands를 분리한다

MA는 agent의 brain과 hands를 분리해 생각한다. brain은 model/harness 쪽이고, hands는 sandbox/tool 쪽이다. brain이 바뀌어도 hands interface가 같으면 실행 환경을 재사용하거나 교체할 수 있고, hands가 바뀌어도 brain이 같은 session을 이어갈 수 있다. [MA]

관련 근거:
- BEA는 tool이 agent의 행동 공간을 만든다고 본다. [BEA]
- ECE는 필요한 context를 선별하는 것이 성능에 중요하다고 설명한다. brain이 모든 hands 상태를 매번 알아야 하는 것은 아니다. [ECE]

DITTO 해설: DITTO에서 `exec_command` 같은 low-level 실행 도구와 "작업 의도"를 다루는 high-level harness를 섞으면 안 된다. 모델이 파일을 읽고 명령을 실행할 수 있어야 하지만, 실행 환경의 lifetime과 권한은 harness 밖 policy/sandbox가 통제해야 한다.

### 2.8 session은 context window가 아니다

MA의 가장 중요한 문장 구조는 이것이다. context window는 모델 호출마다 들어가는 입력이고, session은 전체 작업의 영속 상태다. context window는 잘라낼 수 있고 다시 만들 수 있지만, session은 원본 event log로 남아야 한다. [MA]

관련 근거:
- ECE는 context가 sampling 시 모델에 들어가는 token 집합이라고 정의한다. 즉 context는 영속 저장소가 아니다. [ECE]
- EHA는 long-running agent가 다음 feature를 처리할 때 progress file과 git commit을 이용해 이어받게 한다. [EHA]

DITTO 해설: compaction을 session storage처럼 쓰면 DITTO는 언젠가 근거를 잃는다. "지난번에 그렇게 판단했다"라는 요약만 남고, 그 판단의 tool output, test log, user correction이 사라진다. DITTO는 원본 event, artifact pointer, 요약 view를 분리해야 한다.

### 2.9 context transformation은 harness의 핵심 기능이다

MA는 session event 전체를 모델에게 그대로 넣지 않는다. harness가 event stream에서 필요한 부분을 골라 context로 변환한다. 이 변환은 단순 truncation이 아니다. 어떤 event를 넣고, 어떤 artifact는 pointer만 넣고, 어떤 summary를 붙일지 결정한다. [MA]

관련 근거:
- ECE는 context engineering을 "모델에 들어가는 token 집합을 설계하는 일"로 본다. [ECE]
- HDL은 context reset 시 새 worker가 이해할 수 있는 structured handoff를 만들라고 한다. [HDL]

DITTO 해설: `ContextAssembler`는 DITTO의 핵심 모듈이다. 이 모듈 없이 "최근 N개 메시지"만 넣으면 long-running 작업에서 품질이 무너진다. 반대로 너무 많은 것을 넣으면 token 비용, attention 분산, stale fact 문제가 생긴다.

구현 메모:
- 항상 들어가는 것: active instruction, current task, safety policy
- 선택적으로 들어가는 것: recent errors, current diff summary, changed files, last test result
- pointer로 남기는 것: large logs, full transcripts, screenshots, generated artifacts
- subagent로 처리할 것: 큰 코드베이스 조사, 긴 문서 비교, 여러 실패 로그 분석

### 2.10 many brains, many hands

MA는 brain과 hands가 분리되면 여러 brain이 같은 session을 다루거나, 하나의 brain이 여러 hands를 사용할 수 있다고 설명한다. 이것은 단순 병렬 호출이 아니다. agent 실행의 소유권, 상태 조회, 실행 환경 provision, event emission을 interface로 나누면 다양한 조합이 가능해진다. [MA]

관련 근거:
- EHA는 initializer agent와 coding agent를 분리한다. [EHA]
- HDL은 planner, generator, evaluator를 나눈다. [HDL]
- BEA는 parallelization, routing, evaluator-optimizer 같은 workflow pattern을 설명한다. [BEA]

성능 주석: MA는 brain이 container 안에 있던 설계에서는 모든 session이 container provision 비용을 먼저 냈다고 설명한다. brain과 hands를 분리한 뒤에는 container가 필요할 때만 tool call로 붙으므로 inference를 더 빨리 시작할 수 있었고, TTFT가 p50 기준 약 60%, p95 기준 90% 넘게 줄었다고 보고한다. [MA]

DITTO 해설: DITTO에서 subagent는 "더 많은 답변을 받는 기능"이 아니다. subagent는 별도 context를 태우고, 근거와 불확실성을 압축해서 parent에게 돌려주는 장치다. parent에게 모든 transcript를 던지면 분리의 이점이 사라진다.

### 2.11 managed agents는 meta-harness다

MA는 managed agent를 단순 SDK wrapper가 아니라 meta-harness로 보는 쪽에 가깝다. agent를 만들고, 깨우고, session을 조회하고, event를 흘려보내고, sandbox를 연결하는 상위 관리 계층이다. [MA], [MAD]

관련 근거:
- MAD는 Managed Agents가 agent environment와 session event를 관리하는 API surface를 제공한다. [MAD]
- BEA는 agent system 설계에서 framework보다 underlying prompt/response/tool 흐름을 이해해야 한다고 본다. [BEA]

DITTO 해설: DITTO가 단일 CLI assistant에서 "여러 장기 작업을 관리하는 harness"로 가려면 meta-harness가 필요하다. 이 계층은 어떤 agent가 어떤 session을 소유하는지, 어떤 sandbox가 붙었는지, 어떤 권한으로 실행되는지, 어느 evaluator가 검증하는지 관리한다.

## 3. 연결 문서별 한국어 의역과 해설

### 3.1 MAD: Claude Managed Agents docs

상세 의역: 이 문서는 Managed Agents를 실제 Claude API에서 쓰는 방법을 설명하는 제품 문서다. 핵심 개념은 agent environment와 session event다. 개발자는 agent를 만들고, 세션을 다루고, agent가 외부 도구나 환경과 상호작용하게 만들 수 있다. 문서는 베타 기능임을 전제로 하며, 특정 보안/컴플라이언스 조건에서는 아직 사용할 수 없다는 제약도 둔다. [MAD]

MA와의 연결: MA가 철학과 아키텍처를 설명한다면, MAD는 그 개념을 API 표면으로 내린다. session/harness/sandbox 분리가 실제 제품에서 별도 객체와 event로 드러난다.

DITTO 적용:
- DITTO도 초기부터 internal API를 문서화해야 한다.
- `SessionEvent` schema를 먼저 고정하면 later harness가 바뀌어도 추적과 replay가 가능하다.
- 베타/제약 조건처럼, DITTO도 위험 기능에 대해 "지원하지 않는 사용 조건"을 명시해야 한다.

### 3.2 BEA: Building effective agents

상세 의역: 이 문서는 agent를 만들 때 복잡한 framework부터 시작하지 말고, 단순하고 조합 가능한 pattern을 쓰라고 권한다. workflow와 agent를 구분한다. workflow는 코드가 정해 둔 경로로 LLM과 tool을 오케스트레이션하는 구조이고, agent는 LLM이 다음 행동과 tool 사용을 동적으로 정하는 구조다. 언제 agent를 쓸지, 언제 더 단순한 workflow가 충분한지 판단해야 한다. [BEA]

MA와의 연결: MA는 BEA의 원칙을 더 긴 실행과 managed runtime으로 확장한다. BEA가 "agent란 무엇인가"를 정리한다면, MA는 "agent를 오래, 많이, 안정적으로 돌리려면 무엇을 분리해야 하는가"를 답한다.

DITTO 적용:
- DITTO v0는 복잡한 orchestration graph보다 투명한 loop로 시작한다.
- 하지만 단순 loop 안에서도 session/harness/sandbox 책임선은 고정한다.
- "agent로 풀 문제"와 "workflow로 충분한 문제"를 구분해야 비용과 실패가 줄어든다.

### 3.3 EHA: Effective harnesses for long-running agents

상세 의역: 이 문서는 long-running coding agent를 위해 initializer agent와 coding agent를 분리한다. initializer는 전체 작업을 feature list로 쪼개고, repository와 기반 파일을 준비하고, progress document를 만든다. coding agent는 한 번에 하나의 feature를 맡아 구현하고, test를 실행하고, git commit과 progress update를 남긴다. 중요한 것은 다음 session이 이전 session의 대화가 아니라 artifact를 보고 이어받을 수 있게 만드는 것이다. [EHA]

MA와의 연결: EHA는 session/handoff artifact의 실전 운영 예시다. MA의 "session은 context window가 아니다"라는 말이 EHA에서는 `features.json`, `progress.md`, git commit, run script 같은 형태로 나타난다.

DITTO 적용:
- long-running 작업은 `features.json` 또는 동등한 structured task state를 가져야 한다.
- Markdown progress만으로는 부족하다. machine-readable 상태와 human-readable 설명을 같이 둔다.
- agent가 한 feature를 끝낼 때마다 evidence를 남겨야 한다. 예: test result, changed files, known failures.

### 3.4 HDL: Harness design for long-running application development

상세 의역: 이 문서는 긴 앱 개발 작업에서 planner, generator, evaluator를 분리한다. planner는 작업을 나누고, generator는 구현하며, evaluator는 산출물을 독립적으로 평가한다. 특히 같은 agent가 자기 결과를 평가하면 과하게 긍정적으로 판단하는 문제가 있다고 본다. 그래서 evaluator에게 구체적인 기준과 Playwright 같은 실제 조작 도구를 제공한다. 또한 compaction만으로는 긴 작업의 coherence loss를 해결하기 어렵고, context reset plus handoff가 필요할 수 있다고 말한다. [HDL]

MA와의 연결: MA가 session/harness/sandbox를 분리한다면, HDL은 역할과 평가 책임을 분리한다. 둘 다 "한 agent가 모든 것을 한 context 안에서 붙잡고 있는 구조"를 버린다.

DITTO 적용:
- 구현 agent와 검증 agent는 같은 context를 공유하지 않는 편이 좋다.
- 검증 agent는 산출물 자체, acceptance criteria, 실행 도구, 로그를 보고 판단해야 한다.
- frontend/UX 작업에서는 screenshot, DOM inspection, Playwright trace 같은 evidence가 필요하다.

### 3.5 ECE: Effective context engineering

상세 의역: 이 문서는 context를 prompt보다 넓은 개념으로 본다. context는 모델이 sampling할 때 실제로 받는 모든 token이다. system prompt, user message, tool result, retrieved document, memory, file content가 모두 context다. context는 많을수록 좋은 것이 아니라, high-signal token을 골라 넣어야 하는 제한된 예산이다. context rot, attention budget, long-context degradation 때문에 무작정 긴 context는 품질을 떨어뜨릴 수 있다. [ECE]

MA와의 연결: MA의 session/context 분리는 ECE의 전제 위에 있다. session은 큰 저장소이고, context는 그중 모델 호출마다 골라 넣는 view다.

DITTO 적용:
- `ContextAssembler`를 독립 모듈로 둔다.
- "최근 메시지 N개"는 context policy가 아니라 임시 방편이다.
- 각 context entry에는 출처와 freshness가 있어야 한다.
- 오래된 결정, 실패한 가설, 낡은 tool output은 명시적으로 낮은 우선순위로 내려야 한다.

### 3.6 RLM: Recursive Language Models

상세 의역: 이 논문은 language model이 context를 단순한 입력 문자열로만 받는 것이 아니라, 외부 context object를 재귀적으로 다룰 수 있는 방향을 탐구한다. MA는 이 논문을 연결하며, session과 context를 분리하고 context를 programmatic하게 조작하는 흐름이 연구적으로도 이어지고 있음을 보여준다. [RLM], [MA]

MA와의 연결: MA의 session event stream과 context transformation은 RLM의 문제의식과 닿아 있다. 둘 다 context를 모델 안의 고정 창이 아니라 외부에서 구성하고 조작하는 대상으로 본다.

DITTO 적용:
- context는 string append가 아니라 typed object selection이어야 한다.
- 나중에 vector search, summarizer, subagent result, artifact pointer를 같은 context object model로 다룰 수 있어야 한다.

### 3.7 BL: The Bitter Lesson

상세 의역: 이 글은 AI 역사에서 사람이 특정 문제에 맞춰 세심하게 만든 지식이나 구조보다, 계산 자원과 general method를 잘 활용하는 접근이 장기적으로 더 강했다는 주장으로 알려져 있다. MA가 이 글을 연결한 이유는 harness에도 비슷한 위험이 있기 때문이다. 특정 모델의 약점을 보정하려고 손으로 만든 규칙은 모델이 발전하면 낡을 수 있다. [BL], [MA]

MA와의 연결: MA가 말하는 stale harness assumption은 BL의 설계 철학과 연결된다. 좋은 harness는 모델 약점을 영구 전제로 박아 넣는 것이 아니라, 교체 가능한 policy와 stable interface로 둔다.

DITTO 적용:
- 모델별 특수 보정은 core abstraction에 넣지 않는다.
- prompt hack은 versioned policy로 남긴다.
- 회귀가 생기면 model, prompt, context, tool, sandbox를 분리해 ablation한다.

### 3.8 TAOUP: The Art of Unix Programming

상세 의역: 이 연결은 Unix식 interface 설계 배경으로 읽는다. 핵심은 단순하고 안정적인 interface가 나중에 예상하지 못한 조합과 프로그램을 가능하게 한다는 것이다. MA는 agent 시스템에서도 같은 관점을 취한다. session, harness, sandbox라는 안정된 interface를 두면 구현이 바뀌어도 상위 조합이 살아남는다. [TAOUP], [MA]

MA와의 연결: MA의 "가상화된 agent component" 사고는 Unix/OS의 stable interface 사고와 닿아 있다.

DITTO 적용:
- `SessionLog`는 특정 모델 message format에 묶이지 않는다.
- `Sandbox`는 특정 container runtime에 묶이지 않는다.
- `ToolExecutor`는 특정 tool schema dump 방식에 묶이지 않는다.
- 좁은 interface 위에 깊은 구현을 둔다.

### 3.9 PVC: The History of Pets vs Cattle

상세 의역: 이 글은 cloud infrastructure에서 개별 서버를 특별하게 돌보는 방식보다, 언제든 교체 가능한 자원으로 관리하는 방식이 scale에 맞다고 설명한다. MA는 이를 agent sandbox 운영에 연결한다. 하나의 container를 오래 살리며 모든 상태를 거기에 쌓으면, 그 container가 특별해지고 재현이 어려워진다. [PVC], [MA]

MA와의 연결: sandbox는 disposable해야 한다. 살아남아야 하는 것은 session log, repo state, artifact, progress file이다.

DITTO 적용:
- sandbox는 언제든 버리고 다시 만들 수 있어야 한다.
- 작업 상태는 sandbox 밖에 남긴다.
- 재현 가능한 provision script와 runbook이 필요하다.

## 4. DITTO 설계로 번역한 핵심 결정

### 4.1 top-level interface

DITTO의 최상위 interface는 다음 순서로 잡는다.

1. `SessionLog`
   - append-only event stream
   - 원본 transcript, tool call, tool result, artifact pointer 보존
   - summary는 파생 view로만 유지

2. `HarnessLoop`
   - model call과 tool routing
   - stop/continue 판단
   - context assembly 요청
   - event emission

3. `Sandbox`
   - command/file/network 실행 환경
   - disposable provision
   - secret boundary와 permission boundary

4. `ContextAssembler`
   - session event에서 model input slice 구성
   - artifact pointer와 summary 선택
   - freshness와 relevance policy 적용

5. `Evaluator`
   - generator와 분리된 검증 lane
   - deterministic test, browser automation, log inspection, human-readable critique

### 4.2 context rot 대응

MA를 DITTO 언어로 옮기면 context rot 대응은 "요약을 잘하자"가 아니다. 더 정확히는 다음이다.

- 원본 event stream을 보존한다.
- context window와 session을 분리한다.
- 오래된 가정과 최신 evidence를 구분한다.
- context selection policy를 versioning한다.
- reset 가능한 handoff artifact를 만든다.
- evaluator가 generator의 자기 확신을 견제한다.

### 4.3 완료 조건

DITTO의 long-running task 완료 조건은 다음 evidence를 요구해야 한다.

- 변경 요약
- acceptance criteria별 상태
- 실행한 test/eval 명령
- 실패 로그와 남은 risk
- 다음 session이 시작할 수 있는 handoff
- session event와 artifact pointer

## 5. 읽는 순서

처음 읽는다면 다음 순서를 권한다.

1. MA: session/harness/sandbox 분리라는 중심 구조를 잡는다.
2. ECE: context가 왜 저장소가 아닌 예산인지 이해한다.
3. EHA: long-running coding handoff를 구체화한다.
4. HDL: generator/evaluator 분리와 context reset을 이해한다.
5. BEA: 단순 agent/workflow pattern을 바닥 규칙으로 둔다.
6. MAD: 실제 제품 API가 이 구조를 어떻게 드러내는지 본다.
7. BL, TAOUP, PVC, RLM: 배경 철학과 연구 흐름을 보조 근거로 읽는다.

## 6. 빠른 결론

`Scaling Managed Agents`는 단순히 Anthropic의 제품 소개 글이 아니다. 장기 실행 agent harness가 어디서 망가지는지, 그리고 그 망가짐을 줄이려면 어떤 interface를 먼저 고정해야 하는지 보여주는 설계 문서다.

DITTO에 가장 직접적인 결론은 다음이다.

1. session은 context window가 아니다.
2. sandbox는 기억 장소가 아니다.
3. harness는 model loop만이 아니라 책임 분리의 중심이다.
4. context는 append가 아니라 selection이다.
5. generator와 evaluator는 분리해야 한다.
6. 모델별 보정은 core abstraction이 아니라 versioned policy여야 한다.
7. 장기 작업은 대화 이어가기보다 structured handoff다.
