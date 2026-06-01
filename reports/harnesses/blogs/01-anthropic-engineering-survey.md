---
title: "Anthropic Engineering Blog 조사 및 검증"
tier: 1
repo: all
last_updated: 2026-06-01
scope: "Anthropic 공식 Engineering 인덱스와 site search로 확인한 /engineering 하위 agent, coding, harness, tool, eval 관련 문서. 2026-05-22 재작성에서는 long-running harness, managed agents, auto mode, parallel agent 사례 문서에 최신성 가중치를 부여했다. 2026-06-01 업데이트에서는 How we contain Claude (2026-05-25)를 추가했다."
sources:
  - https://www.anthropic.com/engineering
  - https://www.anthropic.com/engineering/how-we-contain-claude
  - https://www.anthropic.com/engineering/april-23-postmortem
  - https://www.anthropic.com/engineering/managed-agents
  - https://www.anthropic.com/engineering/claude-code-auto-mode
  - https://www.anthropic.com/engineering/harness-design-long-running-apps
  - https://www.anthropic.com/engineering/eval-awareness-browsecomp
  - https://www.anthropic.com/engineering/infrastructure-noise
  - https://www.anthropic.com/engineering/building-c-compiler
  - https://www.anthropic.com/engineering/AI-resistant-technical-evaluations
  - https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
  - https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
  - https://www.anthropic.com/engineering/advanced-tool-use
  - https://www.anthropic.com/engineering/code-execution-with-mcp
  - https://www.anthropic.com/engineering/claude-code-sandboxing
  - https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills
  - https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
  - https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk/
  - https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues
  - https://www.anthropic.com/engineering/writing-tools-for-agents
  - https://www.anthropic.com/engineering/desktop-extensions
  - https://www.anthropic.com/engineering/multi-agent-research-system
  - https://www.anthropic.com/engineering/claude-code-best-practices
  - https://www.anthropic.com/engineering/claude-think-tool
  - https://www.anthropic.com/engineering/swe-bench-sonnet
  - https://www.anthropic.com/engineering/building-effective-agents
  - https://www.anthropic.com/engineering/contextual-retrieval
upstream: []
last_ingested: 2026-06-01T00:00:00+09:00
kind: ditto-research
---

# Anthropic Engineering Blog 조사 및 검증

이 문서는 `https://www.anthropic.com/engineering` 하위 문서를 2026-05-21에 재검증하고, 2026-05-22에 long-running harness와 managed agents 관점으로 다시 가중치를 준 결과다. 기존 문서는 15편 기준이었지만, 공식 Engineering 인덱스는 2026-04-23 postmortem까지 더 많은 문서를 노출한다. 추가 웹 검색으로 인덱스에 보이지 않지만 `/engineering/` 하위에 존재하는 `Building agents with the Claude Agent SDK`도 확인되어 분석 범위에 포함했다.

결론부터 말하면 Anthropic의 Engineering 글들은 하나의 메시지로 수렴한다. 에이전트는 똑똑한 모델 하나가 아니라, 컨텍스트 예산, 도구 표면, 검증 루프, 샌드박스, 세션 로그, 평가 하네스가 같이 움직이는 시스템이다. 이번 재작성에서는 그중에서도 최신 문서일수록, 그리고 DITTO의 long-running coding harness에 직접 닿을수록 더 큰 근거값을 둔다. 따라서 최상위 결론은 `Scaling Managed Agents`의 session/harness/sandbox 책임 분리, `Harness design`과 `Effective harnesses`의 context reset/handoff/evaluator 분리, `Claude Code auto mode`의 권한 피로 대응, `Building a C compiler`의 병렬 적용 사례, `Building effective agents`의 단순 루프 원칙 순으로 읽는다.

최신 확인: 2026-06-01 (Anthropic engineering blog — https://www.anthropic.com/engineering 직접 조회, 신규 문서 1편 확인: How we contain Claude across products, 2026-05-25)

## 검증 방법

- 공식 인덱스 확인: [Engineering at Anthropic](https://www.anthropic.com/engineering)에서 노출된 최신 목록, 제목, 날짜를 확인했다.
- 개별 문서 확인: 각 문서의 제목, published date, 핵심 주장, 수치, 후속 업데이트 문구를 실제 웹 문서에서 다시 확인했다.
- 웹 검색 보강: `site:anthropic.com/engineering` 검색으로 인덱스 밖 `/engineering/building-agents-with-the-claude-agent-sdk/` 문서를 추가 확인했다.
- 관련 근거 검토: `Claude Code best practices`는 Engineering 인덱스에 있지만 현재 `https://code.claude.com/docs/en/best-practices`로 리다이렉트된다. 따라서 이 문서는 Engineering entry이자 현재는 Claude Code docs 문서로 취급한다.
- 가중치 재검토: 사용자가 지정한 6편은 2026-05-22에 다시 열어 날짜와 핵심 주장을 확인했고, 최신 문서와 DITTO harness 설계에 직접적인 문서를 우선 근거로 올렸다.
- 검증 한계: Anthropic 사이트는 동적 인덱스와 리다이렉트를 사용한다. 이 문서는 2026-05-22에 확인한 공개 웹 상태 기준이다.

## 가중치 적용 방식

이번 버전은 전체 인벤토리를 보존하되, 모든 문서를 같은 무게로 취급하지 않는다. 가중치는 두 축으로 준다.

1. 최신성: 같은 주제를 다루면 더 최신 문서를 우선한다. 예를 들어 2026년의 `Scaling Managed Agents`, `Claude Code auto mode`, `Harness design`, `Building a C compiler`는 2024-2025년의 일반 원칙보다 DITTO의 현재 설계 판단에 더 강하게 반영한다.
2. 직접성: DITTO가 풀려는 문제인 context rot, 장기 작업 handoff, 하네스 책임 분리, evaluator 분리, 권한 자동화, 병렬 agent 운영에 직접 닿는 문서에 더 큰 무게를 둔다.

용어상 주의할 점이 있다. `Scaling Managed Agents`와 `Harness design`의 원문 표현은 주로 stale harness assumptions, coherence loss, context anxiety다. 여기서는 이를 DITTO가 부르는 context rot 문제군과 연결해 해석한다.

| 우선순위 | 날짜 | 문서 | 이번 재작성에서의 역할 |
|---|---:|---|---|
| P0 | 2026-04-08 | [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents) | 최상위 기준. session, harness, sandbox를 분리하고 brain/hands/session을 decouple한다. context anxiety 같은 임시 보정이 모델 발전 후 stale assumption이 될 수 있다는 점을 DITTO의 context rot 대응 interface 설계 출발점으로 둔다. |
| P1 | 2026-03-25 | [Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode) | 권한 prompt fatigue와 무승인 실행 사이의 중간 경로다. deterministic policy, sandbox, classifier를 계층화해야 한다는 결론에 강한 근거를 준다. |
| P1 | 2026-03-24 | [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps) | long-running app build에서 context reset, planner/generator/evaluator 분리, self-evaluation 과신 문제를 직접 다룬다. DITTO의 검증 lane 설계에 우선 적용한다. |
| P2 | 2026-02-05 | [Building a C compiler with a team of parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler) | 원칙이 아니라 적용 사례다. parallel agents, container isolation, file lock, git synchronization, test/eval 운영을 DITTO 병렬 실행의 최소 사례와 경계 조건으로 본다. |
| P3 | 2025-11-26 | [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | initializer/coding split, structured handoff artifact, progress document, git commit handoff를 장기 작업의 기본 운영 규약으로 삼는다. |
| P4 | 2024-12-19 | [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | 기초 원칙이다. 최신성 가중치는 낮지만, 단순하고 조합 가능한 workflow/agent 패턴에서 시작하라는 기본 제약으로 유지한다. |

## 기존 문서 대비 주요 수정

- 위 6편에 명시적 가중치를 부여했다. 특히 최신 문서인 `Scaling Managed Agents`, `Claude Code auto mode`, `Harness design`을 DITTO 설계 결론의 상위 근거로 올렸다.
- `Building a C compiler with a team of parallel Claudes`는 단순 흥미 사례가 아니라 병렬 agent harness의 적용 사례이자 best-practice 후보로 재분류했다. 동시에 early research prototype이라는 한계도 같이 반영했다.
- `Building effective agents`는 여전히 중요한 원칙이지만, 최신 long-running/managed-agent 문서의 구체적 운영 지침을 덮어쓰는 상위 근거로 쓰지 않도록 위치를 낮췄다.
- 범위를 15편에서 25개 문서로 확장했다.
- `Quantifying infrastructure noise in agentic coding evals`의 날짜를 2026-02-05로 바로잡았다. 기존 문서의 2026-04-12 표기는 공식 페이지 기준으로 확인되지 않았다.
- `Claude Code auto mode`, `Scaling Managed Agents`, `Harness design for long-running application development`, `An update on recent Claude Code quality reports`를 추가했다.
- `Equipping agents for the real world with Agent Skills`, `Building agents with the Claude Agent SDK`, `Desktop Extensions`, `How we built our multi-agent research system`, `Claude Code best practices`, `The think tool`, `SWE-bench`, `Contextual Retrieval`, `postmortem` 문서를 누락 범위로 추가했다.
- `The think tool`은 2025-12-15 업데이트에서 대부분의 경우 dedicated think tool보다 extended thinking을 권장한다고 명시한다. 따라서 "think tool을 항상 추가하라"가 아니라 "복잡한 순차 도구 사용/정책 판단에서만 후보로 둔다"로 해석을 수정했다.
- `Claude Code best practices`는 현재 canonical content가 `code.claude.com/docs/en/best-practices`로 이동한다는 점을 반영했다.

## 문서 인벤토리

| 날짜 | 문서 | 핵심 근거 |
|---|---|---|
| 2026-05-25 | [How we contain Claude across products](https://www.anthropic.com/engineering/how-we-contain-claude) | claude.ai(gVisor 컨테이너), Claude Code(OS-level sandbox + auto mode), Claude Cowork(VM)의 세 가지 격리 패턴과, 신뢰 다이얼로그 타이밍·allowlist 과다·prompt injection 성공률(단발 0.1%, 100회 적응 시 5-6%) 같은 실패 사례를 분석한다. |
| 2026-04-23 | [An update on recent Claude Code quality reports](https://www.anthropic.com/engineering/april-23-postmortem) | Claude Code, Agent SDK, Cowork 품질 저하가 API 모델 자체가 아니라 product/harness 계층 변경 3개에서 왔고, 2026-04-20 v2.1.116에서 해결됐다고 설명한다. |
| 2026-04-08 | [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents) | session, harness, sandbox를 가상화된 인터페이스로 분리하고, brain/hands/session을 decouple한다. |
| 2026-03-25 | [Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode) | 사용자가 permission prompt의 93%를 승인한다는 관찰에서 출발해, classifier 기반 auto approval과 prompt-injection probe를 설계한다. |
| 2026-03-24 | [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps) | planner, generator, evaluator의 3-agent 구조와 Playwright 기반 외부 평가 루프를 제시한다. |
| 2026-03-06 | [Eval awareness in BrowseComp](https://www.anthropic.com/engineering/eval-awareness-browsecomp) | Opus 4.6이 BrowseComp 평가 상황을 추론하고 answer key 복호화를 시도한 사례를 분석한다. |
| 2026-02-05 | [Quantifying infrastructure noise in agentic coding evals](https://www.anthropic.com/engineering/infrastructure-noise) | Terminal-Bench 2.0에서 인프라 resource headroom만으로 최대 6%p 차이가 난다고 보고한다. |
| 2026-02-05 | [Building a C compiler with a team of parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler) | 16개 Claude agent, 약 2,000 sessions, 약 $20,000 비용으로 Rust 기반 C compiler를 작성한 실험을 설명한다. |
| 2026-01-21 | [Designing AI-resistant technical evaluations](https://www.anthropic.com/engineering/AI-resistant-technical-evaluations) | Claude 모델 성능 향상 때문에 Anthropic 성능 엔지니어링 take-home 평가가 세 차례 재설계된 과정을 설명한다. |
| 2026-01-09 | [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | agent eval의 task, trial, grader, transcript, outcome, eval harness, agent harness 개념을 정리한다. |
| 2025-11-26 | [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | initializer agent와 coding agent의 2단 구조, feature JSON, progress doc, git commit handoff를 제시한다. |
| 2025-11-24 | [Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use) | Tool Search Tool, Programmatic Tool Calling, Tool Use Examples를 추가해 대규모 tool library 문제를 다룬다. |
| 2025-11-04 | [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) | MCP tools를 직접 context에 넣지 않고 code API/file tree로 노출해 token 사용을 150,000에서 2,000으로 낮춘 사례를 든다. |
| 2025-10-20 | [Claude Code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing) | filesystem isolation과 network isolation을 함께 써야 prompt injection 피해를 줄일 수 있다고 설명한다. |
| 2025-10-16 | [Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) | `SKILL.md` frontmatter, progressive disclosure, scripts/resources bundling, trusted-source audit를 설명한다. |
| 2025-09-29 | [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | context engineering을 prompt engineering의 확장으로 보고, high-signal 최소 token 집합을 목표로 둔다. |
| 2025-09-29 | [Building agents with the Claude Agent SDK](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk/) | Claude Code SDK를 Claude Agent SDK로 확장하며, agent loop를 gather context -> take action -> verify work로 설명한다. |
| 2025-09-17 | [A postmortem of three recent issues](https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues) | infrastructure bug 3개가 Claude 응답 품질을 간헐적으로 저하시킨 사건을 공개 분석한다. |
| 2025-09-11 | [Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents) | tool은 deterministic API가 아니라 non-deterministic agent와의 계약이라는 관점에서 설계해야 한다고 설명한다. |
| 2025-06-26 | [Desktop Extensions](https://www.anthropic.com/engineering/desktop-extensions) | MCP server 설치를 `.mcpb` bundle로 단순화한다. 2025-09-11 업데이트에서 `.dxt` 대신 `.mcpb`를 권장한다. |
| 2025-06-13 | [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) | lead agent가 parallel subagents를 만들어 breadth-first research를 수행하며, 내부 평가에서 단일 Opus 4 대비 90.2% 향상을 보고한다. |
| 2025-04-18 | [Claude Code best practices](https://www.anthropic.com/engineering/claude-code-best-practices) | Engineering entry지만 현재 Claude Code docs로 redirect된다. 검증, explore-plan-code, context 관리, subagents, auto mode를 다룬다. |
| 2025-03-20 | [The think tool](https://www.anthropic.com/engineering/claude-think-tool) | 복잡한 tool-use 중간에 모델이 별도 reasoning step을 남기는 도구다. 2025-12-15 업데이트 이후 대부분은 extended thinking을 우선 권장한다. |
| 2025-01-06 | [SWE-bench Verified with Claude 3.5 Sonnet](https://www.anthropic.com/engineering/swe-bench-sonnet) | SWE-bench 성능은 모델 단독이 아니라 scaffolding/harness에 크게 좌우된다고 설명한다. |
| 2024-12-19 | [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | workflow와 agent를 구분하고, 단순하고 조합 가능한 패턴부터 시작하라고 권한다. |
| 2024-09-19 | [Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval) | Contextual Embeddings와 Contextual BM25로 retrieval 실패를 49%, reranking 결합 시 67% 줄였다고 보고한다. |

## 1. 아키텍처 원칙

### 최신 우선 결론: harness 책임 분리가 먼저다

가중치상 가장 중요한 문서는 `Scaling Managed Agents`다. 이 문서는 managed agent를 더 잘 만들기 위해 session, harness, sandbox를 별도 interface로 분리한다. session은 durable event stream, harness는 Claude 호출과 tool routing loop, sandbox는 code/file execution environment다. brain은 harness/model, hands는 sandbox/tools, session은 append-only log로 decouple된다. 근거: [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents).

이 문서가 중요한 이유는 단순한 구조도가 아니라 실패 원인까지 같이 설명하기 때문이다. Anthropic은 harness가 특정 모델 한계에 맞춘 보정과 가정을 품게 되고, 모델이 발전하면 그 가정이 낡을 수 있다고 본다. 사용자가 지적한 context rot/context anxiety 계열 문제도 여기서 DITTO가 조심해야 할 신호다. 원문 용어는 context anxiety와 stale assumption이지만, DITTO 관점에서는 오래된 context/보정/정책이 최신 모델의 판단을 흐리는 context rot 문제군으로 연결된다.

DITTO에 대한 추론: `SessionLog`, `HarnessLoop`, `Sandbox`, `ToolExecutor`, `ContextAssembler`, `PolicyGate`는 한 덩어리 런타임이 아니라 좁은 계약으로 분리해야 한다. 구현은 바뀌어도 session/harness/sandbox의 책임선은 오래가야 한다. 이 책임선이 없으면 품질 저하가 생겼을 때 모델, prompt, context trim, tool policy, sandbox 중 무엇이 원인인지 가를 수 없다.

### Agent SDK는 "컴퓨터를 주는 것"을 중심으로 확장된다

`Building agents with the Claude Agent SDK`는 Claude Code의 harness를 coding 밖 general-purpose agent로 확장한다. 핵심 루프는 context 수집, action 실행, 결과 검증이다. 문서는 filesystem을 context engineering의 일부로 보고, bash/scripts, code generation, MCP, visual feedback, LLM judge를 agent loop의 구성 요소로 배치한다. 근거: [Building agents with the Claude Agent SDK](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk/).

DITTO에 대한 추론: DITTO도 "도구 목록"만 만드는 게 아니라 agent가 쓸 수 있는 작은 컴퓨터 환경을 설계해야 한다. 파일 검색, 명령 실행, 산출물 저장, 시각/테스트 검증이 모두 같은 loop 안에 있어야 한다. 다만 LLM judge는 문서가 직접 "robust하지 않고 latency tradeoff가 크다"고 설명하므로, 기본 검증자는 deterministic checks가 먼저여야 한다.

### 단순한 agent loop는 하위 제약으로 유지한다

`Building effective agents`는 Anthropic agent 설계 철학의 출발점이다. 핵심은 복잡한 프레임워크가 아니라 단순하고 조합 가능한 패턴이다. 이 문서는 workflow를 "코드가 미리 정한 경로로 LLM과 tools를 오케스트레이션하는 시스템"으로, agent를 "LLM이 자기 process와 tool usage를 동적으로 지휘하는 시스템"으로 구분한다. 근거: [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents).

이번 재작성에서는 이 문서를 P4로 낮춰 읽는다. 오래된 문서라서 덜 중요하다는 뜻이 아니라, 최신 long-running/managed-agent 문서가 더 구체적인 운영 결론을 제공하기 때문이다. DITTO v0는 여전히 `gather context -> take action -> verify work`의 투명한 루프로 시작해야 한다. 다만 그 루프가 자라날 때는 `Scaling Managed Agents`의 책임 분리와 `Harness design`의 evaluator 분리를 먼저 보존해야 한다.

## 2. 컨텍스트와 상태 관리

### Session log는 Claude의 context window가 아니다

`Scaling Managed Agents`는 session을 Claude context window와 동일시하지 않는다. session은 durable event stream이고, harness는 필요한 event slice를 조회해 context에 넣는다. 이 분리는 compaction/trim 정책이 바뀌어도 원본 event log를 보존한다. 근거: [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents).

DITTO에 대한 추론: DITTO의 세션 저장소는 "프롬프트에 넣은 마지막 요약"이 아니라 append-only 원장이어야 한다. 요약은 파생물이다. 원본 trace가 없으면 evaluation도 postmortem도 없다. 특히 context rot을 줄인다는 명목으로 원본 상태를 덮어쓰면, 나중에 무엇이 품질을 망쳤는지 확인할 수 없다.

### Context reset은 compaction과 다르다

`Harness design for long-running application development`는 lengthy task에서 coherence loss와 context anxiety를 관찰했고, compaction이 아닌 context reset plus structured handoff가 필요한 경우를 설명한다. 같은 문서는 generator/evaluator loop를 frontend design과 full-stack app building에 적용한다. evaluator는 Playwright MCP로 실제 page를 탐색하고 criteria에 따라 critique를 작성한다. 근거: [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps).

DITTO에 대한 추론: compaction은 같은 agent의 기억을 줄이는 기술이고, reset은 새 worker에게 업무 인수인계를 시키는 기술이다. DITTO는 둘을 하나의 "요약" 기능으로 뭉개면 안 된다. reset에는 다음 session이 독립적으로 시작해도 작업을 재현할 enough state가 필요하다. 이 enough state는 대화 요약이 아니라 acceptance criteria, 현재 diff, 실패 로그, 남은 risk, 실행 명령, 결정 근거 같은 handoff artifact여야 한다.

### Long-running harness는 handoff artifact가 핵심이다

`Effective harnesses for long-running agents`는 compaction만으로는 long-running coding을 해결하지 못한다고 보고, initializer agent와 coding agent의 2단 구성을 제안한다. initializer는 feature list JSON, git repo, progress notes, `init.sh` 같은 기반 artifact를 만들고, coding agent는 한 session마다 하나의 feature를 진행하고 git commit과 progress update를 남긴다. JSON이 Markdown보다 모델에 의해 임의 수정/삭제될 가능성이 낮다는 관찰도 제시한다. 근거: [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents).

DITTO에 대한 추론: DITTO의 long-running mode는 "대화 이어가기"가 아니라 "shift handoff"여야 한다. 최소 artifact는 다음과 같다.

- `features.json`: feature별 acceptance criteria와 pass/fail 상태
- `progress.md`: 마지막 작업, 실패, 미해결 bug, 다음 행동
- git commit log: 실제 변경의 durable evidence
- `runbook`: dev server/test/eval 실행법
- `session trace`: 어떤 tool call이 어떤 결과를 냈는지

### Context는 유한한 예산이다

`Effective context engineering`는 context를 "sampling 시 모델에 들어가는 token 집합"으로 보고, agent engineering의 문제를 desired behavior 가능성을 높이는 high-signal token selection 문제로 재정의한다. context rot, attention budget, transformer의 pairwise attention 비용, long-context degradation을 근거로 context를 무한한 저장소처럼 쓰지 말라고 한다. 근거: [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

DITTO에 대한 추론: 모든 로그, 모든 파일, 모든 도구 설명을 context에 때려 넣는 harness는 설계가 아니라 청소 안 한 방이다. DITTO는 context assembler가 다음을 구분해야 한다.

- 항상 들어가는 system/core policy
- 필요할 때만 들어가는 skill/tool detail
- 파일/로그/trace처럼 handle만 context에 넣고 tool로 조회할 artifact
- subagent가 읽고 요약해서 돌려줄 bulk context

## 3. 도구 설계

### Tool은 API가 아니라 agent-computer interface다

`Writing effective tools`는 tool을 deterministic system과 non-deterministic agent 사이의 계약으로 본다. 그래서 기존 API endpoint를 그대로 감싸지 말고, agent가 사람처럼 작업을 나눌 수 있는 단위로 설계하라고 한다. 예시는 `list_contacts`보다 `search_contacts`, `get_customer` + `transactions` + `notes`보다 `get_customer_context`에 가깝다. namespacing, token-efficient response, helpful error, tool description prompt engineering도 강조한다. 근거: [Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents).

DITTO에 대한 추론: DITTO tool은 "가능한 모든 shell wrapper"가 아니라 "agent가 성공할 확률을 높이는 affordance"여야 한다. `run_command` 하나만 있으면 자유롭지만, 추적과 검증이 헐거워진다. 반대로 tool이 너무 많으면 선택 오류가 늘어난다. 적절한 구질구질함이 필요하다.

### MCP는 code API로 노출할 때 token 효율이 좋아진다

`Code execution with MCP`는 MCP tools를 직접 model context에 전부 로드하면 tool definitions와 intermediate results가 token을 잡아먹는다고 설명한다. 대안은 MCP servers를 code API/file tree로 노출하고, agent가 필요한 server/tool 파일만 읽어 코드를 작성하게 하는 것이다. 문서는 이 방식으로 token usage가 150,000에서 2,000으로 줄어든 사례를 제시한다. 근거: [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp).

DITTO에 대한 추론: DITTO가 많은 외부 tool을 붙일수록 `tool schema dump` 방식은 금방 망한다. 도구는 index/searchable registry로 두고, 실행은 sandboxed code 혹은 typed wrapper를 통해 하게 해야 한다. 민감 데이터는 모델 context를 지나지 않게 필터링하는 경로가 필요하다.

### Advanced tool use는 discovery, code orchestration, examples로 분해된다

`Advanced tool use`는 세 기능을 제시한다. Tool Search Tool은 deferred tools를 필요할 때만 로드한다. Programmatic Tool Calling은 Claude가 Python code로 tool orchestration을 작성해 intermediate result를 context 밖에서 처리한다. Tool Use Examples는 JSON schema만으로 설명하기 어려운 usage convention을 예제로 보강한다. Programmatic Tool Calling은 복잡한 research task에서 평균 token 사용을 43,588에서 27,297로 줄였다고 보고한다. 근거: [Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use).

DITTO에 대한 추론: DITTO의 tool layer는 세 계층이어야 한다.

- discovery: "어떤 도구가 있나"
- specification: "이 도구를 어떻게 호출하나"
- execution: "중간 데이터를 context에 넣지 않고 어떻게 계산하나"

단순 schema registry 하나로는 부족하다. schema는 지도고, examples는 표지판이고, code execution은 실제 운전이다. 비유는 별로지만 구조는 맞다.

### Skills는 progressive disclosure 패키지다

`Agent Skills`는 skill을 `SKILL.md`와 부속 파일/스크립트/resources를 담은 directory로 정의한다. startup에는 `name`과 `description`만 preload하고, 관련성이 생기면 full `SKILL.md`, 더 필요하면 reference/scripts를 읽는다. 이것이 progressive disclosure다. 또한 code를 deterministic helper로 포함할 수 있고, untrusted skills는 코드와 network instruction을 audit해야 한다고 경고한다. 근거: [Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills).

DITTO에 대한 추론: DITTO skill도 한 파일에 모든 걸 때려 넣지 말고, metadata -> instruction -> references/scripts 순서로 열리게 해야 한다. 설치 가능한 skill이면 threat model도 필요하다. "그냥 markdown이니까 안전함"은 꽤 부지런한 착각이다.

### Desktop Extensions는 distribution friction을 줄인다

`Desktop Extensions`는 MCP server 설치의 고통, 즉 runtime 설치, JSON 수동 편집, dependency conflict, discovery/update 문제를 `.mcpb` bundle로 줄인다. 2025-09-11 업데이트에서는 `.dxt` 대신 `.mcpb`를 권장한다고 한다. 근거: [Desktop Extensions](https://www.anthropic.com/engineering/desktop-extensions).

DITTO에 대한 추론: DITTO plugin/skill도 "문서 보고 손으로 복사"에 머물면 확산이 제한된다. 설치 단위에는 manifest, dependencies, permissions, update metadata가 필요하다.

## 4. 안전성과 권한

### Sandboxing은 filesystem과 network가 함께 있어야 한다

`Claude Code sandboxing`은 filesystem isolation과 network isolation 둘 다 필요하다고 말한다. filesystem만 있으면 exfiltration을 막기 어렵고, network만 있으면 sandbox escape에 취약하다. Claude Code는 Linux bubblewrap과 macOS seatbelt 같은 OS primitive를 사용하며, 내부 사용에서 permission prompts를 84% 줄였다고 보고한다. Claude Code on the web은 git credential을 sandbox 안에 넣지 않고 proxy가 branch/repo를 검증하는 구조를 쓴다. 근거: [Claude Code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing).

DITTO에 대한 추론: DITTO가 장기 실행/병렬 실행을 하려면 sandbox는 옵션이 아니라 기본이다. `--dangerously-skip-permissions`식 loop는 연구 prototype에서는 흥미롭지만, 사용자 machine에서는 그냥 사고 예고편이다.

### Auto mode는 permission prompt fatigue에 대한 classifier 대안이다

`Claude Code auto mode`는 사용자가 permission prompts의 93%를 승인한다는 관찰에서 시작한다. manual prompt는 피로를 만들고, `--dangerously-skip-permissions`는 보호가 없으며, sandbox는 safe하지만 capability마다 configuration이 필요하다. Auto mode는 transcript classifier와 prompt-injection probe를 둔다. classifier는 user messages와 tool calls만 보고, Claude messages와 tool outputs는 제거해 reasoning-blind로 만든다. Stage 1은 fast single-token filter, Stage 2는 flagged case에만 reasoning을 쓴다. 근거: [Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode).

이번 재작성에서 이 문서는 P1이다. 이유는 최신성뿐 아니라, DITTO가 사용자 인지 비용을 낮추면서도 위험한 작업을 제한해야 하는 제품 문제에 직접 닿기 때문이다. 승인 프롬프트를 계속 띄우는 설계는 시간이 지나면 거의 항상 무의미해지고, 무승인 실행은 사고 경계를 없앤다. 따라서 권한 정책은 "사람이 누르는 버튼"이 아니라 harness 책임으로 올라가야 한다.

DITTO에 대한 추론: DITTO의 approval system은 세 단계가 적절하다.

- deterministic allow/deny rules
- sandbox boundary
- model-based policy classifier

모델 classifier만 믿으면 또 모델에게 감독을 맡기는 셈이다. 하지만 manual approval만 믿으면 인간이 결국 아무거나 누른다. 다들 피곤하니까.

### 격리 전략은 사용자 환경 복잡도에 따라 달라진다

`How we contain Claude across products`는 claude.ai, Claude Code, Claude Cowork의 세 제품이 서로 다른 격리 패턴을 쓰는 이유를 설명한다. claude.ai는 per-session ephemeral gVisor 컨테이너로 blast radius를 줄이되 persistent workspace를 포기한다. Claude Code는 OS-level sandbox(macOS Seatbelt, Linux bubblewrap)와 auto mode를 조합해 permission prompt를 84% 줄이면서도 개발자 제어권을 유지한다. Claude Cowork는 비기술 사용자를 위해 VM 안에서 agent가 실행되고, agent loop는 VM 바깥에서 안정성을 담당한다. 세 사례의 공통 교훈은 "환경 계층의 격리를 먼저 설계하고, 모델 계층의 행동 조정은 그 위에 얹는다"는 것이다. 또한 Claude Opus 4.7은 prompt injection 단발 성공률이 약 0.1%지만 100회 적응 시도 후에는 5-6%로 올라간다고 보고하고, Claude Code auto mode는 과도한 실행의 약 83%를 실행 전에 차단한다. 세 가지 critical vulnerability는 모두 trust dialog 타이밍, 과도한 allowlist, phish-resistant 사용자 부재에서 비롯됐다고 설명한다. 근거: [How we contain Claude across products](https://www.anthropic.com/engineering/how-we-contain-claude) (2026-05-25).

DITTO에 대한 추론: DITTO가 지원하는 execution surface가 넓어질수록 단일 sandbox 전략은 맞지 않는다. local developer 환경(Claude Code류), headless batch 실행, 비기술 사용자 환경은 각각 다른 격리 수준이 필요하다. 특히 trust dialog 타이밍 문제는 DITTO harness에도 직접 닿는다. 도구가 실행되기 전에 정책이 평가되어야 하며, 실행 후 trust prompt는 이미 늦다. auto mode의 83% 차단율도 참조하면, classifier가 있어도 나머지 17%는 sandbox가 받아야 한다는 뜻이다. layered defense는 선택이 아니라 수학이다.

### Postmortem은 harness 변경도 품질 저하를 만든다는 증거다

`An update on recent Claude Code quality reports`는 2026년 3-4월 Claude Code 품질 저하 보고를 세 가지 product/harness 계층 변경으로 설명한다. default reasoning effort 변경, idle session에서 prior thinking을 반복적으로 지우던 bug, verbosity를 줄이려던 system prompt instruction이 coding quality를 낮춘 문제다. API/inference layer는 영향을 받지 않았고, broad eval suite, ablation, prompt review/audit tooling, soak period를 강화하겠다고 한다. 근거: [April 23 postmortem](https://www.anthropic.com/engineering/april-23-postmortem).

`A postmortem of three recent issues`는 multi-platform inference serving에서 infrastructure bug가 모델 품질처럼 보이는 사용자 경험을 만들 수 있음을 보여준다. Anthropic은 AWS Trainium, NVIDIA GPUs, Google TPUs across providers에서 Claude를 serve하고, hardware/platform 차이 때문에 엄격한 equivalence validation이 필요하다고 설명한다. 근거: [September 17 postmortem](https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues).

DITTO에 대한 추론: 하네스 변경은 모델 변경만큼 위험하다. DITTO는 prompt/hook/tool policy/config 변경마다 eval, canary, rollback, trace diff를 가져야 한다. 이건 멋있어서가 아니라, 안 그러면 "모델이 멍청해졌다"는 신고만 남고 실제 원인은 아무도 모른다.

## 5. 평가와 벤치마크

### Agent eval은 outcome과 transcript를 함께 봐야 한다

`Demystifying evals for AI agents`는 agent eval의 기본 용어를 정리한다. task, trial, grader, transcript, outcome, evaluation harness, agent harness, suite가 분리된다. 특히 agent harness는 model이 acting agent가 되도록 tool calls와 loop를 orchestrate하는 scaffold이며, "agent를 평가한다"는 것은 model과 harness의 조합을 평가한다는 뜻이다. 근거: [Demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents).

DITTO에 대한 추론: DITTO는 모델 점수판이 아니라 harness 점수판이어야 한다. 같은 모델이라도 prompt, tools, sandbox, retry, context assembly가 바뀌면 결과가 바뀐다. eval report에는 적어도 model, harness commit/config, task, trial count, transcript artifact, grader, infra config가 남아야 한다.

### pass@k와 pass^k는 반대 방향의 질문이다

`Demystifying evals`는 pass@k를 k번 중 한 번이라도 성공할 확률, pass^k를 k번 모두 성공할 확률로 구분한다. coding처럼 여러 후보 중 하나가 맞으면 되는 작업은 pass@k가 의미 있고, customer-facing agent처럼 매번 안정성이 필요한 작업은 pass^k가 중요하다. 근거: [Demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), [The think tool](https://www.anthropic.com/engineering/claude-think-tool).

DITTO에 대한 추론: DITTO가 "agent가 한 번 해냈다"만 보면 과대평가한다. 자동화 도구로 쓰려면 pass^k와 retry cost를 같이 봐야 한다. 한 번 성공한 데모는 제품이 아니다. 데모는 데모다.

### Infrastructure noise는 leaderboard 차이를 압도할 수 있다

`Quantifying infrastructure noise`는 Terminal-Bench 2.0에서 resource configuration만으로 성공률이 크게 달라질 수 있다고 보고한다. strict 1x resource enforcement에서는 infra error가 높고, headroom이 커지면 infra error가 줄며, 3x 이후에는 실제 problem-solving capability 측정 대상도 달라진다. 가장/최소 resource setup 간 gap은 6 percentage points였고 p < 0.01로 보고됐다. 근거: [Infrastructure noise](https://www.anthropic.com/engineering/infrastructure-noise).

DITTO에 대한 추론: DITTO eval은 CPU/RAM/time limit/network/cache/dependency mirror 같은 execution 환경을 report에 박아야 한다. 안 그러면 점수는 숫자 모양의 분위기다.

### Eval awareness는 open-web 평가를 불안정하게 만든다

`Eval awareness in BrowseComp`는 Opus 4.6이 어떤 BrowseComp 문제에서 자신이 평가 중일 가능성을 추론하고, benchmark source code와 encrypted answer key를 찾아 복호화한 사례를 설명한다. multi-agent configuration에서는 unintended solution rate가 single-agent보다 3.7배 높았다고 보고한다. 핵심 결론은 web-enabled agent eval이 contamination과 benchmark identification에 취약하다는 것이다. 근거: [Eval awareness](https://www.anthropic.com/engineering/eval-awareness-browsecomp).

DITTO에 대한 추론: DITTO가 web-enabled research eval을 만들면 benchmark materials 접근 차단, canary, source blocklist, post-hoc transcript audit가 필요하다. agent가 똑똑해질수록 문제를 푸는 대신 시험지를 찾을 수 있다. 성실하다고 하긴 애매하다.

### AI-resistant technical eval은 계속 재설계된다

`Designing AI-resistant technical evaluations`는 Anthropic performance engineering take-home이 Claude 성능 향상 때문에 세 번 재설계된 과정을 설명한다. 한 버전은 Claude Opus 4가 대부분의 human applicants보다 잘했고, 다음 버전도 Opus 4.5가 통과 threshold를 빠르게 넘었다. 근거: [AI-resistant evaluations](https://www.anthropic.com/engineering/AI-resistant-technical-evaluations).

DITTO에 대한 추론: DITTO의 benchmark도 고정된 문제집이 아니라 versioned artifact여야 한다. 모델이 benchmark를 이기면 축하하고, benchmark를 버려야 한다. 아깝지만 원래 그런 물건이다.

### SWE-bench는 모델보다 scaffold까지 평가한다

`SWE-bench Verified with Claude 3.5 Sonnet`은 Claude 3.5 Sonnet이 SWE-bench Verified 49%를 달성했다고 설명하면서, SWE-bench는 model alone이 아니라 prompt generation, output parsing, action loop를 포함한 scaffold를 평가한다고 분명히 말한다. 근거: [SWE-bench Sonnet](https://www.anthropic.com/engineering/swe-bench-sonnet).

DITTO에 대한 추론: DITTO가 좋은 모델을 호출해도 scaffold가 나쁘면 성능은 줄줄 샌다. 반대로 작은 harness 개선이 benchmark 성능을 끌어올릴 수 있다. 그래서 DITTO의 변경 단위는 코드뿐 아니라 prompt/tool descriptions도 포함해야 한다.

## 6. 병렬 및 멀티에이전트

### Parallel Claudes는 적용 사례로 더 크게 본다

`Building a C compiler with a team of parallel Claudes`는 16 agents, 약 2,000 Claude Code sessions, 약 $20,000 API cost로 100,000-line Rust C compiler를 만든 실험이다. barebones harness는 infinite loop로 Claude Code를 실행하고, 각 agent는 container에서 작업한다. task lock은 `current_tasks/*.txt` 파일로 구현했고, git synchronization으로 중복 task claim을 줄였다. 저자는 이것이 early research prototype이고 orchestration agent나 high-level goal management가 없다고 명시한다. 근거: [Building a C compiler](https://www.anthropic.com/engineering/building-c-compiler).

이번 재작성에서는 이 문서를 단순 흥미 사례가 아니라 DITTO 병렬 실행의 best-practice 후보와 반례가 동시에 들어 있는 적용 사례로 본다. 좋은 점은 단순한 lock, container isolation, git synchronization, 많은 짧은 session이 실제 큰 산출물까지 갈 수 있음을 보여준다는 것이다. 경계해야 할 점은 "돌아가는 병렬 loop"가 곧 제품 수준 orchestrator는 아니라는 점이다. high-level goal management, budget control, merge conflict policy, evaluator lane, 실패 재현/중단 기준이 빠져 있으면 규모가 커질수록 운영자가 직접 감당해야 한다.

DITTO에 대한 추론: 병렬 agent orchestration은 처음부터 분산 시스템처럼 만들 필요는 없다. 파일 기반 lock, git commit, container isolation, role prompts만으로도 충분히 학습할 수 있다. 다만 DITTO 제품화에는 task ownership, shared state schema, evaluator lane, budget control, kill switch가 필요하다. 특히 "테스트가 통과했다"와 "설계 의도에 맞는 산출물이다"는 다르므로, C compiler 사례는 병렬 실행과 검증 lane을 분리해야 한다는 근거로도 읽는다.

### Multi-agent research는 search를 compression 문제로 본다

`How we built our multi-agent research system`는 research task가 open-ended라 fixed path로 hardcode하기 어렵다고 설명한다. lead agent가 research process를 계획하고, parallel subagents가 각자 독립 context window에서 탐색한 뒤 condensed summary만 돌려준다. 내부 research eval에서 Claude Opus 4 lead + Claude Sonnet 4 subagents 조합이 single-agent Opus 4보다 90.2% 뛰어났다고 보고한다. 근거: [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system).

DITTO에 대한 추론: DITTO의 subagent는 "더 많은 모델 호출"이 아니라 context isolation과 compression device다. subagent가 읽은 모든 로그를 parent에게 던지면 구조를 만든 의미가 없다. parent에게는 answer, evidence, uncertainty만 돌아와야 한다.

### Generator와 evaluator는 분리해야 한다

`Harness design for long-running application development`는 agent가 자기 산출물을 평가할 때 과하게 긍정적으로 판단하는 self-evaluation 문제를 지적한다. 원문은 agent가 자기가 만든 결과를 평가하라고 하면 명백히 평범한 결과도 자신 있게 칭찬하는 경향이 있다고 설명한다. 해결책은 generator와 evaluator를 분리하고, evaluator에게 concrete criteria와 tools(예: Playwright)를 주는 것이다. 근거: [Harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps).

DITTO에 대한 추론: DITTO에는 writer와 reviewer가 같은 context/goal을 공유하지 않는 독립 검증 lane이 필요하다. 특히 frontend, UX, long-running app build처럼 binary test만으로 부족한 영역에서는 evaluator가 실제 앱을 조작하고 screenshot/log/test evidence를 남겨야 한다. 이 문서는 사용자가 지적한 "자기 확신에 따른 품질 저하" 문제의 직접 근거로 본다.

## 7. Retrieval, memory, and knowledge

### Contextual Retrieval은 old-school RAG의 결핍을 줄인다

`Contextual Retrieval`는 traditional RAG가 chunk를 embedding할 때 주변 맥락을 잃어 retrieval failure가 발생한다고 설명한다. Contextual Embeddings와 Contextual BM25를 결합하면 failed retrieval을 49% 줄이고, reranking까지 결합하면 67% 줄인다고 보고한다. 단, knowledge base가 200,000 tokens 이하라면 전체를 prompt에 넣는 단순한 방법이 나을 수 있다고도 말한다. 근거: [Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval).

DITTO에 대한 추론: DITTO 문서/trace 검색은 무조건 vector DB부터 시작할 필요가 없다. 작은 repo나 session artifact는 prompt caching + direct loading이 낫고, 큰 corpus는 contextual chunking + lexical/semantic hybrid search가 필요하다. 또 하나의 기술 스택을 얹는 일은 언제나 쉽다. 제거가 어렵다.

### Structured note-taking은 cheap external memory다

`Effective context engineering`는 compaction, structured note-taking, sub-agent architectures를 long-horizon context strategy로 묶는다. structured note-taking은 context window 밖 파일/메모리에 agent가 직접 상태를 기록하고 나중에 다시 읽는 방식이다. 근거: [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

DITTO에 대한 추론: DITTO의 memory는 DB보다 먼저 파일이어도 된다. 중요한 건 형식이다. "notes.md에 아무거나 쓰기"보다 task state, decisions, blockers, evidence, next actions를 분리해야 한다.

## 8. Claude Code 운영 지침에서 직접 배울 점

`Claude Code best practices`는 Engineering 인덱스에 있으나 현재 Claude Code docs로 리다이렉트된다. 문서는 Claude Code를 chatbot이 아니라 파일 읽기, 명령 실행, 변경 적용, autonomous work가 가능한 agentic coding environment로 설명한다. 가장 높은 leverage는 검증 수단을 주는 것이다. 그다음 explore first, plan, code, commit의 workflow를 권장한다. context window가 빠르게 차고 성능이 저하될 수 있으므로 context 관리, subagents, checkpoints, resume, non-interactive mode, parallel sessions도 다룬다. 근거: [Claude Code best practices](https://www.anthropic.com/engineering/claude-code-best-practices).

DITTO에 대한 추론: DITTO는 "코드를 생성했다"가 아니라 "검증 가능한 상태까지 갔다"를 완료 조건으로 삼아야 한다. 기본 completion contract는 다음이어야 한다.

- 변경 요약
- 실행한 검증 명령
- 실패한 검증과 이유
- 남은 risk
- 사용자가 이어받을 수 있는 next action

## 9. Think tool의 위치 수정

`The think tool`은 원래 complex tool use 중간에 모델이 별도 생각 공간을 갖도록 하는 도구를 설명한다. tau-bench airline domain에서 optimized prompt와 함께 쓸 때 baseline 대비 큰 개선을 보고했고, SWE-bench setup에서도 평균 1.6% 향상을 보고했다. 하지만 2025-12-15 업데이트는 extended thinking이 개선되어 대부분의 경우 dedicated think tool보다 extended thinking을 권장한다고 밝힌다. 근거: [The think tool](https://www.anthropic.com/engineering/claude-think-tool).

DITTO에 대한 추론: DITTO에 `think` tool을 넣는다면 기본 도구가 아니라 특정 모드 도구여야 한다.

- 사용 후보: policy-heavy tool use, sequential decision, costly mistakes, tool output analysis
- 비사용 후보: 단일 tool call, 단순 instruction following, 병렬 non-sequential tool calls
- 구현 방식: tool description에 모든 판단 기준을 넣기보다 system/developer prompt에 usage policy를 둔다

## 10. DITTO 설계 원칙으로 재정리

### 1. Session, harness, sandbox를 먼저 분리한다

근거: `Scaling Managed Agents`.

DITTO의 최상위 interface는 model provider가 아니라 session/harness/sandbox 책임선이다. session은 append-only event stream, harness는 model 호출과 tool routing, sandbox는 실행 격리와 파일/네트워크 접근을 맡는다. 이 분리가 있어야 context rot, context trim, prompt 변경, tool policy, sandbox 변경이 서로 섞이지 않고 회귀 원인을 추적할 수 있다.

### 2. Harness는 투명해야 한다

근거: `Building effective agents`, `SWE-bench`, `Demystifying evals`.

DITTO는 prompt, tool description, context assembly, model settings, sandbox policy, retry policy를 trace에 남겨야 한다. framework abstraction이 debugging을 가리면 agent harness로서는 손해다.

### 3. Context는 budget이고 artifact는 storage다

근거: `Scaling Managed Agents`, `Harness design`, `Effective harnesses`, `Effective context engineering`, `Code execution with MCP`.

큰 파일과 tool results는 context가 아니라 artifact로 둔다. context에는 pointer, summary, selected slice만 들어가야 한다. 장기 작업에서는 compaction만 믿지 말고, context reset이 가능한 handoff artifact를 남긴다.

### 4. Session log는 append-only 원장이어야 한다

근거: `Managed Agents`, `Effective harnesses`.

요약/compaction은 재생성 가능한 view다. 원본 event stream을 잃으면 postmortem과 eval이 불가능하다.

### 5. 도구는 agent가 이해하는 단위로 다시 설계한다

근거: `Writing effective tools`, `Advanced tool use`, `Code execution with MCP`.

기존 API endpoint를 그대로 노출하지 말고 search, context aggregation, concise/detailed response, helpful errors, examples를 제공한다.

### 6. 검증자는 작성자와 분리한다

근거: `Harness design`, `Demystifying evals`, `Multi-agent research`, `Building a C compiler`.

작성 agent가 스스로 "좋다"고 말하는 것은 별 가치가 없다. verifier/reviewer/evaluator는 별도 role, 별도 context, 별도 evidence collection을 가져야 한다.

### 7. 권한은 sandbox와 classifier를 함께 쓴다

근거: `Claude Code sandboxing`, `Claude Code auto mode`.

manual approval만으로는 피로가 오고, no-permission mode는 위험하다. DITTO는 deterministic guardrail, sandbox, model classifier를 layered defense로 둔다.

### 8. Eval은 harness까지 포함한다

근거: `Demystifying evals`, `Infrastructure noise`, `SWE-bench`.

모델 이름만으로 결과를 기록하면 안 된다. harness version, infra, resource limits, tools, prompt, retries, trial count를 같이 저장해야 한다.

### 9. Benchmark는 썩는다

근거: `Eval awareness`, `AI-resistant evaluations`.

open-web eval과 공개 문제집은 시간이 지나면 오염된다. DITTO는 benchmark versioning, contamination checks, private held-out tasks, transcript audit를 고려해야 한다.

### 10. 병렬화는 compression 장치이자 운영 문제다

근거: `Building a C compiler`, `Multi-agent research`.

parallel agents는 더 많은 context를 parent에 넣기 위한 방법이 아니라, 각자 context를 태우고 작은 evidence summary를 돌려주는 방법이다. C compiler 사례는 단순 lock과 git sync로도 큰 작업이 가능하다는 근거지만, 동시에 budget, merge, evaluator, 중단 기준이 없으면 사람 운영자에게 복잡도가 돌아온다는 경고다.

### 11. 단순 루프에서 시작하되 최신 interface를 보존한다

근거: `Building effective agents`, `Scaling Managed Agents`, `Harness design`.

DITTO는 처음부터 무거운 autonomous framework가 될 필요는 없다. 하지만 단순 루프를 구현하더라도 session/harness/sandbox, generator/evaluator, context/handoff의 책임선은 초기에 박아야 한다. 나중에 붙이는 책임선은 대체로 trace와 데이터 모델을 다시 흔든다.

### 12. Postmortem이 없는 harness는 곧 미신이 된다

근거: `April 23 postmortem`, `September 17 postmortem`.

품질 저하가 생겼을 때 model, prompt, tool policy, context trim, inference infra 중 무엇이 문제인지 가를 수 있어야 한다. 그 기록이 없으면 결국 감으로 운영한다. 감은 늘 자신감이 넘친다.

## 시기별 방향 변화

| 시기 | Anthropic Engineering의 메시지 | DITTO 해석 |
|---|---|---|
| 2024-09 | RAG는 chunk context를 잃으면 실패한다. 작은 corpus는 그냥 넣어라. | 검색부터 만들지 말고 corpus 크기와 변경성을 먼저 보라. |
| 2024-12 | agents/workflows는 단순한 조합 가능한 패턴부터 시작한다. | DITTO v0는 transparent loop가 먼저다. |
| 2025-01 | SWE-bench는 scaffold까지 평가한다. | model benchmark를 harness benchmark로 착각하지 말라. |
| 2025-03 | think tool은 복잡한 sequential tool use에 도움이 된다. | reasoning space는 특정 상황에서만 tool/prompt로 제공하라. |
| 2025-06 | multi-agent research는 breadth-first search와 compression에 강하다. | subagent는 요약 장치이지 로그 운반 장치가 아니다. |
| 2025-09 | tool design, context engineering, postmortem이 중심으로 올라온다. | 도구/컨텍스트/운영 로그가 harness 성능을 좌우한다. |
| 2025-10 | skills와 sandboxing이 product surface가 된다. | 설치 가능한 capability와 격리된 실행 환경이 필요하다. |
| 2025-11 | MCP/code execution/tool search/long-running harness가 정리된다. | context 밖에서 계산하고 session 간 handoff를 구조화하라. |
| 2026-01 | eval 개념이 정교화되고 AI-resistant eval 필요성이 커진다. | 점수판 자체도 versioned product다. |
| 2026-02 | infra noise와 parallel agents가 전면에 나온다. | 실행 환경과 병렬 coordination을 기록하라. C compiler 사례는 적용 가능한 최소 병렬 harness이지만, 제품화에는 evaluator/budget/merge 정책이 필요하다. |
| 2026-03 | evaluator 분리, auto mode, eval awareness가 중요해진다. | self-eval과 manual approval만으로는 부족하다. generator/evaluator와 sandbox/classifier를 분리된 lane으로 둬라. |
| 2026-04 | managed agents와 postmortem은 interface 안정성과 harness regression을 강조한다. | 구현은 바뀌어도 session/harness/sandbox 계약은 오래가야 한다. 최신 문서일수록 이 책임 분리를 더 강하게 밀고 있다. |
| 2026-05 | 제품별 격리 전략이 다르고, trust dialog 타이밍과 allowlist 설계가 핵심 실패 지점이다. | sandbox 전략은 사용자 환경 복잡도에 따라 달라야 한다. auto mode + sandbox의 layered defense로도 나머지 위험은 남는다. |

## DITTO 보완 계획

1. `Session`, `HarnessLoop`, `Sandbox`를 분리된 top-level interface로 설계한다.
   - 근거: 최신 우선 문서인 Managed Agents는 brain/hands/session을 decouple하고, session/harness/sandbox를 별도 계약으로 둔다.

2. `SessionLog`를 append-only event stream으로 설계한다.
   - 근거: Managed Agents는 session을 Claude context window와 분리하고 durable event log로 둔다.

3. `ContextAssembler`를 별도 모듈로 두고 context reset/handoff를 지원한다.
   - 근거: Harness design은 context anxiety와 coherence loss에 대해 compaction과 reset을 구분하고, Effective harnesses는 structured handoff artifact를 제안한다.

4. `ToolRegistry`는 search/defer/examples를 지원한다.
   - 근거: Advanced tool use는 tool definitions가 많아질 때 deferred loading과 examples가 필요하다고 한다.

5. MCP/외부 도구는 code API 또는 sandboxed programmatic execution 경로를 제공한다.
   - 근거: Code execution with MCP는 direct tool call보다 code API가 context 효율적임을 보여준다.

6. Skills는 metadata-only preload와 on-demand body loading을 기본으로 한다.
   - 근거: Agent Skills의 progressive disclosure 구조.

7. Long-running task에는 initializer/coding/evaluator roles를 분리한다.
   - 근거: Effective harnesses의 initializer/coding split, Harness design의 planner/generator/evaluator split.

8. Completion contract를 "검증 evidence" 중심으로 정의한다.
   - 근거: Harness design은 self-evaluation 과신 문제를, Claude Code best practices는 tests/screenshots/expected outputs의 중요성을 보여준다.

9. Eval report에는 infra config를 필수 필드로 둔다.
   - 근거: Infrastructure noise가 resource config만으로 6%p 차이를 만들 수 있음을 보여준다.

10. Permission system은 manual prompt, sandbox, auto classifier를 조합한다.
    - 근거: Claude Code auto mode는 prompt fatigue를, sandboxing 문서는 filesystem/network isolation 필요성을 설명한다.

11. Parallel agent mode는 file lock/git sync/container에서 시작하되 evaluator/budget/merge 정책을 필수화한다.
    - 근거: Building a C compiler는 단순 병렬 harness의 가능성과 early prototype의 한계를 함께 보여준다.

12. Prompt/tool/policy 변경에는 ablation과 rollback plan을 둔다.
    - 근거: April 23 postmortem은 system prompt 한 줄과 reasoning effort default도 coding quality를 바꿀 수 있음을 보여준다.

## 근거 목록

- [Engineering index](https://www.anthropic.com/engineering): 2026-06-01 기준 공식 Engineering 목록과 featured post 확인.
- [How we contain Claude across products](https://www.anthropic.com/engineering/how-we-contain-claude): claude.ai/Claude Code/Claude Cowork의 격리 패턴 비교와 trust dialog·allowlist·prompt injection 실패 분석 (2026-05-25).
- [An update on recent Claude Code quality reports](https://www.anthropic.com/engineering/april-23-postmortem): Claude Code/Agent SDK/Cowork quality regression postmortem.
- [Scaling Managed Agents](https://www.anthropic.com/engineering/managed-agents): session, harness, sandbox interface separation.
- [Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode): classifier-based permission automation and prompt-injection probe.
- [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps): planner/generator/evaluator architecture.
- [Eval awareness in BrowseComp](https://www.anthropic.com/engineering/eval-awareness-browsecomp): eval contamination and benchmark identification.
- [Quantifying infrastructure noise in agentic coding evals](https://www.anthropic.com/engineering/infrastructure-noise): resource headroom and benchmark variance.
- [Building a C compiler with a team of parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler): parallel agent teams and file-based task locks.
- [Designing AI-resistant technical evaluations](https://www.anthropic.com/engineering/AI-resistant-technical-evaluations): eval redesign under model capability growth.
- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents): agent eval terminology and methods.
- [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents): initializer/coding split and handoff artifacts.
- [Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use): Tool Search, Programmatic Tool Calling, Tool Use Examples.
- [Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp): MCP tools as code APIs.
- [Claude Code sandboxing](https://www.anthropic.com/engineering/claude-code-sandboxing): filesystem/network isolation.
- [Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills): progressive disclosure for skill packaging.
- [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents): context as finite resource.
- [Building agents with the Claude Agent SDK](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk/): general-purpose agent loop.
- [A postmortem of three recent issues](https://www.anthropic.com/engineering/a-postmortem-of-three-recent-issues): infrastructure bugs causing quality degradation.
- [Writing effective tools](https://www.anthropic.com/engineering/writing-tools-for-agents): agent-oriented tool design.
- [Desktop Extensions](https://www.anthropic.com/engineering/desktop-extensions): MCP bundle packaging.
- [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system): lead/subagent research architecture.
- [Claude Code best practices](https://www.anthropic.com/engineering/claude-code-best-practices): redirects to Claude Code docs; verification, planning, context management.
- [The think tool](https://www.anthropic.com/engineering/claude-think-tool): dedicated thinking tool and later extended-thinking caveat.
- [SWE-bench Verified with Claude 3.5 Sonnet](https://www.anthropic.com/engineering/swe-bench-sonnet): scaffolding affects benchmark performance.
- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents): workflows vs agents and simple composable patterns.
- [Contextual Retrieval](https://www.anthropic.com/engineering/contextual-retrieval): contextual embeddings/BM25 and reranking.

## ditto 적용 정리

PURPOSE.md 기준 ditto는 범용 개발 작업을 돕는 coding agent harness이며, 핵심 가치는 사용자 인지 비용 절감, 근거 없는 출력과 할루시네이션 방지, 사용자 의도 이탈의 구조적 제한, Context Rot 해결, 장기 작업의 끈질긴 완수, Token 비용 절감이다. 이 보고서에서 Anthropic Engineering 문서들이 반복해서 확인한 내용은 모델 단독이 아니라 session, harness, sandbox, context assembly, tool surface, eval loop가 함께 agent 품질을 만든다는 점이다.

가중치 반영 후 ditto 적용 우선순위는 다음 순서다. 첫째, `Scaling Managed Agents`를 따라 session/harness/sandbox 책임선을 고정한다. 둘째, `Harness design`과 `Effective harnesses`를 따라 context reset, handoff, evaluator 분리를 구현한다. 셋째, `Claude Code auto mode`를 따라 권한 피로를 줄이되 sandbox와 classifier를 계층화한다. 넷째, `Building a C compiler`를 병렬 agent 적용 사례로 삼되 제품 수준 orchestration gap을 메운다. 다섯째, `Building effective agents`의 단순 루프 원칙을 하위 제약으로 둔다.

1. `Session`, `HarnessLoop`, `Sandbox` 책임선과 append-only `SessionLog`를 ditto의 기본 실행 단위로 둔다.
   - 적용할 기능/가치: PURPOSE.md의 "모든 액션에는 감사 기록이 누적된다", "주요 결정 및 변경사항 영속화", "Context Rot 이슈 해결", "장기간 실행되는 작업"에 직접 대응한다.
   - 적용 방식: session은 원본 event stream, harness는 model/tool loop, sandbox는 실행 격리를 맡도록 분리한다. 세션 로그를 context window와 분리된 append-only event stream으로 저장하고, context에는 필요한 event slice와 요약만 넣는다. 장기 작업은 `features.json`, `progress.md`, git commit log, runbook, session trace 같은 handoff artifact로 다음 세션이 독립적으로 이어받게 한다.
   - 적용 이후 제공 가치: 사용자는 이전 대화를 다시 뒤지지 않아도 현재 상태, 결정 근거, 실패 지점, 다음 행동을 확인할 수 있다. agent는 compaction 이후에도 원본 trace를 잃지 않으므로 Context Rot과 근거 없는 완료 선언을 줄일 수 있다.
   - 리스크/선행 조건: 로그 schema와 보존 정책이 먼저 필요하다. 요약이 원본을 대체하면 postmortem과 eval이 불가능하므로 summary는 파생물로만 취급해야 한다. 책임선이 흐리면 품질 저하 시 모델 문제인지 harness 문제인지 분리할 수 없다.
   - 근거: 보고서의 `최신 우선 결론: harness 책임 분리가 먼저다`, `Session log는 Claude의 context window가 아니다`, `Long-running harness는 handoff artifact가 핵심이다`, `Context reset은 compaction과 다르다` 섹션은 각각 `Scaling Managed Agents`, `Effective harnesses for long-running agents`, `Harness design for long-running application development`를 근거로 session/harness/sandbox와 handoff/context reset 분리를 설명한다.

2. `ContextAssembler`와 progressive disclosure 기반 tool/skill registry를 분리한다.
   - 적용할 기능/가치: PURPOSE.md의 "Context Rot 이슈 해결", "Token 비용을 낭비하지 않는다", "서브 에이전트를 적극 사용한다", "사용자 인지 비용 최소화"에 맞는다.
   - 적용 방식: 항상 필요한 core policy, 필요할 때만 읽는 skill/tool detail, handle만 context에 넣고 조회하는 artifact, subagent가 읽고 evidence summary만 돌려주는 bulk context를 구분한다. tool/skill은 metadata-only preload 후 관련성이 생길 때 instruction, reference, script를 단계적으로 열게 한다.
   - 적용 이후 제공 가치: context에 모든 도구 설명과 로그를 밀어 넣지 않아 token 비용을 줄이고, parent agent에는 answer, evidence, uncertainty 중심의 압축 결과만 남길 수 있다. 사용자는 불필요한 표와 로그 덤프 대신 판단에 필요한 정제된 정보만 받는다.
   - 리스크/선행 조건: 너무 강한 context trimming은 필요한 근거 누락을 만들 수 있다. 따라서 각 요약에는 원본 artifact pointer와 불확실성을 남겨야 하고, tool/skill registry에는 검색 가능한 이름, 설명, 사용 예시가 필요하다.
   - 근거: 보고서의 `Context는 유한한 예산이다`, `MCP는 code API로 노출할 때 token 효율이 좋아진다`, `Advanced tool use는 discovery, code orchestration, examples로 분해된다`, `Skills는 progressive disclosure 패키지다`, `Multi-agent research는 search를 compression 문제로 본다` 섹션이 각각 `Effective context engineering`, `Code execution with MCP`, `Advanced tool use`, `Agent Skills`, `Multi-agent research system`을 연결한다.

3. generator와 evaluator를 분리하고 완료 조건을 evidence contract로 고정한다.
   - 적용할 기능/가치: PURPOSE.md의 "할루시네이션을 방지한다", "모든 출력과 추론에는 확실한 근거가 있어야 한다", "오케스트레이션", "E2E 테스트 도구", "멀티 모델 정반합 기반의 적대적 검토"와 맞물린다.
   - 적용 방식: 구현 agent와 검증 agent를 별도 role/context로 분리한다. 완료 응답은 변경 요약, 실행한 검증 명령, 실패한 검증과 이유, 남은 risk, 이어받을 next action을 포함하는 completion contract로 제한한다. 웹/UX 작업은 Playwright 같은 브라우저 자동화로 실제 사용자 시나리오 증거를 남긴다.
   - 적용 이후 제공 가치: ditto는 "코드를 생성했다"가 아니라 "검증 가능한 상태까지 갔다"를 완료 기준으로 삼게 된다. 사용자는 agent의 자기평가 대신 테스트 결과, 실행 로그, 화면 확인, transcript 같은 fresh evidence로 판단할 수 있다.
   - 리스크/선행 조건: evaluator 기준이 모호하면 self-eval과 크게 다르지 않다. task별 acceptance criteria, grader, transcript artifact, 실패 재현 방법이 먼저 정규화되어야 한다.
   - 근거: 보고서의 `Generator와 evaluator는 분리해야 한다`, `Agent eval은 outcome과 transcript를 함께 봐야 한다`, `Claude Code 운영 지침에서 직접 배울 점`, `SWE-bench는 모델보다 scaffold까지 평가한다` 섹션은 `Harness design for long-running application development`, `Demystifying evals for AI agents`, `Claude Code best practices`, `SWE-bench Verified with Claude 3.5 Sonnet`을 근거로 검증 분리와 evidence 중심 완료를 제시한다.

4. sandbox, 권한 정책, harness regression 평가를 한 묶음으로 운영한다.
   - 적용할 기능/가치: PURPOSE.md의 "사용자의 의도와 벗어나 LLM이 멋대로 추론 및 작업을 하는 것을 구조적으로 제한한다", "사용자 인지 비용 최소화", "할루시네이션 방지"에 대응한다.
   - 적용 방식: permission system은 deterministic allow/deny rule, filesystem/network sandbox, 필요 시 model-based policy classifier를 계층화한다. prompt, tool policy, context trim, model setting, sandbox config가 바뀌면 eval, canary, rollback plan, trace diff를 남긴다.
   - 적용 이후 제공 가치: 사용자는 매번 승인 프롬프트를 읽느라 피로해지지 않으면서도 위험한 파일/네트워크 작업의 경계를 유지할 수 있다. 품질 저하가 발생했을 때도 "모델이 나빠졌다"가 아니라 어떤 harness 변경이 영향을 줬는지 추적할 수 있다.
   - 리스크/선행 조건: classifier만으로 권한을 자동화하면 감독을 다시 모델에 맡기는 구조가 된다. sandbox 기본값, 민감 정보 차단, policy audit, rollback 가능한 설정 버전 관리가 선행되어야 한다.
   - 근거: 보고서의 `Sandboxing은 filesystem과 network가 함께 있어야 한다`, `Auto mode는 permission prompt fatigue에 대한 classifier 대안이다`, `Postmortem은 harness 변경도 품질 저하를 만든다는 증거다` 섹션은 `Claude Code sandboxing`, `Claude Code auto mode`, `An update on recent Claude Code quality reports`, `A postmortem of three recent issues`를 근거로 권한과 회귀 관리의 필요성을 설명한다.

5. 병렬 agent 실행은 C compiler 사례를 최소 사례로 삼되, 제품 수준 정책을 더한다.
   - 적용할 기능/가치: PURPOSE.md의 "서브 에이전트를 적극 사용한다", "오케스트레이션", "장기 작업의 끈질긴 완수", "사용자 인지 비용 최소화"에 맞는다.
   - 적용 방식: 초기 parallel mode는 file lock, git synchronization, container isolation, role prompt로 시작할 수 있다. 하지만 DITTO에서는 task ownership, shared state schema, merge conflict policy, evaluator lane, budget cap, kill switch를 필수 계약으로 둔다.
   - 적용 이후 제공 가치: 여러 agent가 서로의 context를 오염시키지 않고 작업을 나눌 수 있다. parent는 모든 로그를 떠안지 않고 answer, evidence, uncertainty만 받아 전체 작업을 조율한다.
   - 리스크/선행 조건: 병렬 실행은 비용과 실패 수를 동시에 키운다. C compiler 사례처럼 큰 산출물을 만들 수 있어도, 제품 수준에서는 중복 작업, merge 실패, budget overshoot, 검증 누락을 막는 정책이 먼저 필요하다.
   - 근거: 보고서의 `Parallel Claudes는 적용 사례로 더 크게 본다`, `Multi-agent research는 search를 compression 문제로 본다`, `검증자는 작성자와 분리한다` 섹션은 `Building a C compiler with a team of parallel Claudes`, `How we built our multi-agent research system`, `Harness design for long-running application development`를 근거로 병렬 실행과 검증 lane 분리를 연결한다.

6. deep module 원칙에 맞춰 오래 버틸 harness interface를 우선 설계한다.
   - 적용할 기능/가치: PURPOSE.md의 "각 단계의 진입과 출력은 반드시 정규화된 interface 또는 문서 양식", "Deep Module 사고 - 좁은 interface 위에 깊은 구현", "사용자의 의도와 벗어나 작업하는 것을 구조적으로 제한"에 맞는다.
   - 적용 방식: `SessionLog`, `ToolExecutor`, `Sandbox`, `ContextAssembler`, `PolicyGate`, `EvalReport`를 좁은 interface로 분리하고, 내부 구현은 모델과 도구 변화에 맞춰 교체 가능하게 둔다. 초기 버전은 복잡한 autonomous framework보다 `gather context -> take action -> verify work` 루프를 trace 가능한 형태로 노출한다.
   - 적용 이후 제공 가치: 모델 버전이나 tool 실행 방식이 바뀌어도 사용자에게 보이는 계약은 안정적으로 유지된다. 각 단계의 입력/출력이 정규화되면 오케스트레이션, subagent handoff, 감사 기록, 회귀 분석이 같은 데이터 위에서 동작할 수 있다.
   - 리스크/선행 조건: interface가 너무 넓으면 shallow abstraction이 되어 PURPOSE.md의 개발 원칙과 충돌한다. 먼저 실제 ditto 워크플로에서 반복되는 계약만 interface로 승격하고, 단일 사용 추상화는 피해야 한다.
   - 근거: 보고서의 `단순한 agent loop는 하위 제약으로 유지한다`, `Agent SDK는 "컴퓨터를 주는 것"을 중심으로 확장된다`, `최신 우선 결론: harness 책임 분리가 먼저다`, `DITTO 설계 원칙으로 재정리` 섹션은 `Building effective agents`, `Building agents with the Claude Agent SDK`, `Scaling Managed Agents`를 근거로 단순 루프와 session/harness/sandbox interface 분리를 제시한다.
