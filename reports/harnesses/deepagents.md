# deepagents 참고 하네스 분석 보고서

## 분석 대상 및 기준 커밋

- 대상 저장소: `https://github.com/langchain-ai/deepagents`
- 로컬 분석 경로: `/private/tmp/ditto-harness-analysis/deepagents`
- 최초 기준 커밋: `84daa1a2e27963a6d7694dc9278de83782b4a7b7`
- **갱신된 기준 커밋: `1906af985906369b6ab5bfbee039c9dabc1dd840` @ 2026-06-01**
  - 이전 기준: `84daa1a`, 갱신: `1906af98` @ 2026-06-01
  - 관련 SDK 커밋 수: 22건 (libs/deepagents/ 변경 기준)
- 분석 범위: 루트 README, `libs/deepagents` 패키지 메타데이터/소스/테스트/Makefile, `examples/better-harness` 예제, 루트 개발 지침과 Makefile.
- 아래의 모든 `repo-relative/path:line` 근거는 별도 표기가 없으면 최초 기준 커밋 `84daa1a2e27963a6d7694dc9278de83782b4a7b7`에서 확인한 것이다. "@ 1906af98" 표기가 있는 근거는 갱신된 HEAD에서 확인한 것이다.

## 조사 방법

1. 지정 경로 `/private/tmp/ditto-harness-analysis/deepagents`에 `gh repo clone langchain-ai/deepagents`로 저장소를 클론했다. 최초 네트워크 제한 실패 후 escalated 실행으로 재시도해 성공했다.
2. `git rev-parse HEAD`로 기준 커밋 `84daa1a2e27963a6d7694dc9278de83782b4a7b7`를 확정했고, 분석용 클론의 작업 트리는 clean 상태로 확인했다.
3. `README.md`, `AGENTS.md`, `libs/deepagents/README.md`, `libs/deepagents/pyproject.toml`, `libs/deepagents/Makefile`, `libs/Makefile`을 읽어 저장소의 공개 목적, 패키지 경계, 개발/테스트 명령을 확인했다.
4. `libs/deepagents/deepagents` 아래의 그래프 생성, 미들웨어, 백엔드, 프로파일, 서브에이전트, 스킬, 메모리, 컨텍스트 요약/오프로딩 구현을 정적 분석했다.
5. `libs/deepagents/tests/unit_tests`와 `examples/better-harness`를 읽어 의도된 동작, 검증 범위, 외부 루프 하네스 최적화 예제를 확인했다.
6. 이번 작업은 참고 하네스 분석이 목적이므로 테스트 실행은 하지 않았다. 판단은 문서, 설정, 소스, 테스트 코드에 기반한 정적 분석이다.

## 핵심 특징

- deepagents는 스스로를 "batteries-included agent harness"라고 정의한다. 루트 README의 표제는 "The batteries-included agent harness"이고, 설명은 LangGraph 위의 오픈소스 에이전트 하네스로서 기본 동작을 제공하되 개별 구성요소를 확장/교체할 수 있다고 설명한다. 근거: `README.md:12`, `README.md:24`, `README.md:28-31`.
- 핵심 기능은 하위 에이전트, 가상 파일시스템, 컨텍스트 관리, 셸 실행, 메모리, HITL, 스킬, 외부 도구/MCP이다. README가 해당 기능 목록을 직접 열거한다. 근거: `README.md:35-42`.
- 공개 API의 중심은 `create_deep_agent(...)`이며, 기본 인자로 모델, 도구, 시스템 프롬프트를 받고 LangGraph `create_agent` 위에 하네스 계층을 조립한다. 빠른 시작 예제는 `create_deep_agent(model=..., tools=..., system_prompt=...)` 패턴을 제시한다. 근거: `README.md:53-64`, `libs/deepagents/deepagents/graph.py:217-236`.
- 패키지 메타데이터도 저장소의 목적을 "sub-agent spawning, todo list capabilities, and mock file system"이 포함된 범용 deep agent로 설명한다. 근거: `libs/deepagents/pyproject.toml:2-5`.
- 기본 도구 세트는 할 일 목록, 파일 도구, 셸 실행, 하위 에이전트 작업 도구로 구성된다. 코드 주석은 `write_todos`, `ls/read_file/write_file/edit_file/glob/grep`, `execute`, `task`를 기본 도구로 명시한다. 근거: `libs/deepagents/deepagents/graph.py:239-250`.
- 백엔드 추상화는 상태 기반 파일시스템, 로컬 파일시스템, 로컬 셸, 샌드박스, 복합 백엔드로 나뉜다. 기본 파일 백엔드는 `StateBackend()`이며, 대화 스레드 안에서만 파일을 보존한다. 근거: `libs/deepagents/deepagents/graph.py:477-520`, `libs/deepagents/deepagents/backends/state.py:38-48`.
- 컨텍스트 관리는 단순한 메시지 누적이 아니라 DeltaChannel, 요약, 오래된 히스토리 파일 오프로딩, 큰 도구 결과 오프로딩, 오래된 도구 인자 축약을 결합한다. 근거: `libs/deepagents/deepagents/graph.py:63-67`, `libs/deepagents/deepagents/middleware/summarization.py:1-17`, `libs/deepagents/deepagents/middleware/summarization.py:1170-1201`, `libs/deepagents/deepagents/middleware/_message_eviction.py:119-142`.
- 모델별 동작은 provider profile과 harness profile로 분리된다. ProviderProfile은 모델 생성/초기화 인자, HarnessProfile은 프롬프트/도구/미들웨어/기본 하위 에이전트 동작을 담당한다. 근거: `libs/deepagents/deepagents/profiles/provider/provider_profiles.py:9-14`, `libs/deepagents/deepagents/profiles/provider/provider_profiles.py:46-63`, `libs/deepagents/deepagents/profiles/harness/harness_profiles.py:1-18`.
- 별도 예제 `examples/better-harness`는 Deep Agent를 "다른 에이전트 하네스를 개선하는 외부 루프"로 사용한다. 문서는 train/holdout/scorecard 평가, 편집 가능한 surface, 임시 proposer workspace, 후보 수락 기준을 설명한다. 근거: `examples/better-harness/README.md:1-31`, `examples/better-harness/better_harness/core.py:864-968`.

## 구조/아키텍처

### 저장소와 패키지 경계

- 루트 `AGENTS.md`는 모노레포 구조를 명시한다. `libs/deepagents`가 Python SDK, `libs/cli`가 CLI, `libs/acp`가 Agent Client Protocol, `libs/evals`가 eval harness, `libs/partners`가 파트너 통합을 담당한다. 근거: `AGENTS.md:9-23`.
- 개발 도구는 `uv`, `make`, `ruff`, `ty`, `pytest` 중심이다. 루트 개발 지침은 패키지 매니저와 포맷/타입/테스트 도구를 명시한다. 근거: `AGENTS.md:25-31`.
- unit test는 네트워크를 막고, integration test는 네트워크 허용 가능하다는 정책이 있다. 이는 에이전트 하네스가 외부 모델/API와 연결될 수 있으나 단위 동작은 격리해서 검증하려는 구조다. 근거: `AGENTS.md:157-167`, `libs/deepagents/Makefile:18-23`, `libs/deepagents/Makefile:36-38`.

### `create_deep_agent` 조립 흐름

- `DeepAgentState`(구 `_DeepAgentState`, `1906af98`에서 공개 이름으로 변경·export됨)의 `messages`는 LangGraph `DeltaChannel`을 사용한다. 주석은 체크포인트 성장률을 O(N^2)에서 O(N)으로 줄이기 위한 선택이라고 설명한다. 근거: `libs/deepagents/deepagents/graph.py:63-67` (갱신 HEAD에서 line 63-66 @ `1906af98`).
- 기본 에이전트 프롬프트는 "concise and direct", "understand, act, verify", "keep working", "ask the minimum necessary follow-up questions" 같은 작업 방식 규칙을 포함한다. 근거: `libs/deepagents/deepagents/graph.py:69-111`.
- 프롬프트 조립은 `USER -> BASE/CUSTOM -> SUFFIX` 순서를 가진다. 코드 주석은 호출자가 가장 먼저, 하네스/커스텀 본문이 중간, 프로파일 suffix가 마지막이라고 설명한다. `SystemMessage`의 `cache_control` 블록도 보존한다. 근거: `libs/deepagents/deepagents/graph.py:112-141`.
- 기본 모델은 `anthropic:claude-sonnet-4-6`이나, 기본 모델 사용은 0.5.3부터 deprecated이며 1.0.0에서 제거 예정이라고 표시되어 있다. 근거: `libs/deepagents/deepagents/graph.py:145-184`.
- `FilesystemMiddleware`와 `SubAgentMiddleware`는 필수 scaffolding으로 취급된다. 주석은 파일시스템 도구/권한과 task 핸들러가 이 미들웨어에 의존하기 때문에 제외할 수 없다고 설명한다. 근거: `libs/deepagents/deepagents/graph.py:187-202`.
- 미들웨어 순서는 `TodoListMiddleware`, `SkillsMiddleware`, `FilesystemMiddleware`, `SubAgentMiddleware`, `AsyncSubAgentMiddleware`, `SummarizationMiddleware`, `PatchToolCallsMiddleware`, 사용자 미들웨어, 프로파일 추가 미들웨어, 도구 제외, Anthropic prompt caching, memory, HITL 순으로 조립된다. 근거: `libs/deepagents/deepagents/graph.py:308-345`, `libs/deepagents/deepagents/graph.py:671-730`.
- 동기 하위 에이전트가 없더라도 기본 `general-purpose` 하위 에이전트가 자동으로 추가된다. 프로파일이 이를 비활성화하면 명시적 동기 하위 에이전트가 없을 때 `task` 도구가 노출되지 않는다. 근거: `libs/deepagents/deepagents/graph.py:377-382`, `libs/deepagents/tests/unit_tests/test_graph.py:272-348`.
- `create_agent` 호출 시 `SubagentTransformer`가 스트리밍 변환기로 추가되고, `recursion_limit`은 9999로 설정되며 LangSmith 통합 메타데이터가 붙는다. 근거: `libs/deepagents/deepagents/graph.py:757-788`, `libs/deepagents/tests/unit_tests/test_graph.py:59-76`.

### 도구/백엔드/권한 모델

- 파일 도구의 권한 연산은 `ls/read_file/glob/grep`가 read, `write_file/edit_file`가 write로 분류된다. 근거: `libs/deepagents/deepagents/middleware/filesystem.py:73-80`.
- `FilesystemPermission`은 경로가 `/`로 시작해야 하고 `..`, `~`를 금지하며, 첫 번째 매칭 규칙을 적용한다. 근거: `libs/deepagents/deepagents/middleware/filesystem.py:83-116`.
- 권한은 도구 레벨에서 적용되며, 코드 주석은 백엔드를 직접 사용할 경우 권한이 강제되지 않는다고 명시한다. 또한 subagent는 기본적으로 권한을 상속하되 교체할 수 있다. 근거: `libs/deepagents/deepagents/graph.py:397-410`.
- `execute`는 `SandboxBackendProtocol`을 만족하는 백엔드 또는 실행 가능한 `CompositeBackend`일 때만 의미가 있다. 지원하지 않는 백엔드에서는 도구가 필터링되거나 오류가 난다. 근거: `libs/deepagents/deepagents/graph.py:239-250`, `libs/deepagents/deepagents/middleware/filesystem.py:480-499`, `libs/deepagents/deepagents/middleware/filesystem.py:1597-1667`.
- 로컬 파일시스템과 로컬 셸 백엔드는 강한 보안 경고를 포함한다. `FilesystemBackend`는 웹/API 사용 금지, 비밀 유출/영구 수정 위험, HITL/샌드박스 권장을 명시하고, `LocalShellBackend`는 샌드박싱이 없고 `shell=True` 기반 실행을 사용한다. 근거: `libs/deepagents/deepagents/backends/filesystem.py:44-90`, `libs/deepagents/deepagents/backends/local_shell.py:1-6`, `libs/deepagents/deepagents/backends/local_shell.py:221-357`.
- `BaseSandbox`는 파일 조작을 sandbox execute/upload/download 위에서 구현하지만, 클래스 설명은 execute의 신뢰 경계를 줄이지 않는다고 명시한다. 근거: `libs/deepagents/deepagents/backends/sandbox.py:1-12`, `libs/deepagents/deepagents/backends/sandbox.py:394-414`.
- `CompositeBackend`는 경로 prefix별 백엔드 라우팅을 제공하고, route는 longest-prefix 우선으로 정규화된다. 근거: `libs/deepagents/deepagents/backends/composite.py:1-17`, `libs/deepagents/deepagents/backends/composite.py:86-115`.

### 하위 에이전트 구조

- `SubAgent` 스펙은 `name`, `description`, `system_prompt`를 필수로 하고 `tools`, `model`, `middleware`, `interrupt_on`, `skills`, `permissions`를 선택적으로 받는다. 근거: `libs/deepagents/deepagents/middleware/subagents.py:27-69`.
- `task` 도구 설명은 복잡하고 독립적인 작업을 임시 에이전트에 위임하고, 병렬 실행을 활용하며, 하위 에이전트는 최종 결과 하나만 반환하고 상태가 없다는 규칙을 담는다. 근거: `libs/deepagents/deepagents/middleware/subagents.py:273-381`, `libs/deepagents/deepagents/middleware/subagents.py:383-413`.
- 부모 상태 누수를 줄이기 위해 기본 제외 키가 있다. `messages`, `todos`, `structured_response`, `skills_metadata`, `memory_contents` 등이 하위 에이전트 입력에서 제외된다. 근거: `libs/deepagents/deepagents/middleware/subagents.py:228-257`.
- 컴파일된 subagent는 state schema에 `messages`가 있어야 하며, 최종 `AIMessage` 또는 `structured_response`를 반환한다. 근거: `libs/deepagents/deepagents/middleware/subagents.py:155-225`.
- 비동기 subagent는 LangGraph SDK/Agent Protocol 기반 원격 에이전트 서버를 대상으로 하며 task id를 즉시 반환하고, 상태 확인/업데이트/취소/목록 도구를 별도로 제공한다. 근거: `libs/deepagents/deepagents/middleware/async_subagents.py:1-10`, `libs/deepagents/deepagents/middleware/async_subagents.py:164-215`, `libs/deepagents/deepagents/middleware/async_subagents.py:277-371`, `libs/deepagents/deepagents/middleware/async_subagents.py:397-684`.
- 서브에이전트 스트림은 `_subagent_transformer.py`에서 `run.subagents` 타입 핸들로 변환된다. 이 변환기는 부모의 `task` 도구 호출 입력을 캡처해 `graph_name`, `cause`, `task_input`, terminal status가 있는 핸들을 만든다. 근거: `libs/deepagents/deepagents/_subagent_transformer.py:1-24`, `libs/deepagents/deepagents/_subagent_transformer.py:136-246`.

### 컨텍스트, 스킬, 메모리 구조

- `PatchToolCallsMiddleware`는 agent 실행 전 dangling tool call에 대응하는 `ToolMessage`를 추가해 메시지 히스토리를 유효하게 유지한다. 근거: `libs/deepagents/deepagents/middleware/patch_tool_calls.py:1-14`, `libs/deepagents/deepagents/middleware/patch_tool_calls.py:20-44`.
- 자동 요약 미들웨어는 오래된 메시지를 `/conversation_history/{thread_id}.md`에 저장하고 요약 메시지에 해당 경로를 넣어 agent가 `read_file`로 다시 열 수 있게 한다. 근거: `libs/deepagents/deepagents/middleware/summarization.py:42-47`, `libs/deepagents/deepagents/middleware/summarization.py:474-505`, `libs/deepagents/deepagents/middleware/summarization.py:758-830`.
- `create_summarization_middleware` 문서는 LangChain 기본 요약과 달리 backend offload, pre-summarization tool-arg truncation, `ContextOverflowError` fallback, non-mutating message state, model-aware thresholds를 제공한다고 설명한다. 근거: `libs/deepagents/deepagents/middleware/summarization.py:1170-1201`.
- `compact_conversation`은 기본 자동 요약 미들웨어와 별도인 `SummarizationToolMiddleware`가 제공하는 수동 도구다. 문서는 `create_deep_agent`가 자동 요약을 기본 추가하고, `create_summarization_tool_middleware(...)`를 사용자 미들웨어에 넣으면 도구 레이어가 추가된다고 설명한다. 근거: `libs/deepagents/deepagents/middleware/summarization.py:1241-1322`, `libs/deepagents/deepagents/middleware/summarization.py:1325-1420`.
- 스킬은 `SKILL.md` YAML frontmatter를 가진 디렉터리 단위이며, 시스템 프롬프트는 필요할 때 `read_file(..., limit=1000)`로 해당 스킬 설명을 읽도록 지시한다. 이것은 progressive disclosure 구조다. 근거: `libs/deepagents/deepagents/middleware/skills.py:1-15`, `libs/deepagents/deepagents/middleware/skills.py:21-53`, `libs/deepagents/deepagents/middleware/skills.py:783-823`.
- 스킬 로더는 여러 source를 순서대로 로드하고, 뒤 source가 앞 source를 덮어쓴다. 경로는 POSIX 상대 경로이며, ~~`module` 엔트리포인트는 검증만 하고 실행하지 않는다~~ **[수정 @ 1906af98]** `module` 필드가 `SkillMetadata`에서 완전 제거되어 파싱·검증도 수행하지 않는다. 근거: `libs/deepagents/deepagents/middleware/skills.py:232-301`, `libs/deepagents/deepagents/middleware/skills.py:651-708`, `libs/deepagents/deepagents/middleware/skills.py:826-910`, `libs/deepagents/deepagents/graph.py:384-391`.
- 메모리는 스킬과 달리 항상 로드되는 `AGENTS.md`식 지속 컨텍스트다. 시스템 프롬프트는 메모리가 hidden system이 아니라 파일 데이터이며, 충돌 시 검증하고, 자격증명은 저장하지 말라고 지시한다. 근거: `libs/deepagents/deepagents/middleware/memory.py:2-12`, `libs/deepagents/deepagents/middleware/memory.py:104-169`.

### 프로파일 구조

- HarnessProfile은 base prompt, suffix, tool description override, excluded tools/middleware, extra middleware, default general-purpose subagent 설정을 담당한다. 근거: `libs/deepagents/deepagents/profiles/harness/harness_profiles.py:256-320`, `libs/deepagents/deepagents/profiles/harness/harness_profiles.py:483-543`.
- 프로파일 설정 파일용 `HarnessProfileConfig`는 선언 가능한 subset만 포함한다. class path 기반 미들웨어 제외나 runtime-only extra middleware는 설정 파일에서 허용하지 않는다. 근거: `libs/deepagents/deepagents/profiles/harness/harness_profiles.py:191-218`, `libs/deepagents/tests/unit_tests/test_harness_profiles.py:98-115`.
- `excluded_middleware`는 완성된 stack에서 이름/클래스로 필터링하되, scaffolding 미들웨어는 제외할 수 없고 unmatched 제외 항목은 거부된다. 근거: `libs/deepagents/deepagents/profiles/harness/harness_profiles.py:629-688`, `libs/deepagents/deepagents/graph.py:731-747`.
- built-in harness profile에는 OpenAI Codex 계열과 Claude Sonnet 4.6이 있다. Codex profile suffix는 자율적인 senior engineer, 지속 실행, action bias, 병렬 도구 사용, 계획 위생을 강조한다. Claude Sonnet 4.6 profile은 Anthropic 공개 지침을 참조하며 병렬 도구 호출, 답변 전 조사, 도구 후 반영을 suffix로 둔다. 근거: `libs/deepagents/deepagents/profiles/harness/_openai_codex.py:1-15`, `libs/deepagents/deepagents/profiles/harness/_openai_codex.py:22-60`, `libs/deepagents/deepagents/profiles/harness/_anthropic_sonnet_4_6.py:1-20`, `libs/deepagents/deepagents/profiles/harness/_anthropic_sonnet_4_6.py:32-43`.
- provider profile에는 OpenAI와 OpenRouter built-in profile이 있다. OpenAI profile은 Responses API를 기본 활성화하고, OpenRouter profile은 앱 attribution과 특정 upstream 동작 회피를 다룬다. 근거: `libs/deepagents/deepagents/profiles/provider/_openai.py:1-24`, `libs/deepagents/deepagents/profiles/provider/_openrouter.py:1-119`.

## 도구/명령/스크립트/프롬프트 인벤토리

### 패키지와 개발 명령

| 항목 | 정의 위치 | 내용 |
| --- | --- | --- |
| Python 패키지 | `libs/deepagents/pyproject.toml:2-29` | 패키지명 `deepagents`, 버전 `0.6.3`, LangChain/LangGraph 기반 의존성, Anthropic/Google 모델 패키지, `wcmatch` |
| 테스트 의존성 | `libs/deepagents/pyproject.toml:44-61` | `pytest`, `pytest-socket`, `pytest-xdist`, `ruff`, `ty`, `langchain-tests` 등 |
| pytest 기본 옵션 | `libs/deepagents/pyproject.toml:129-154` | benchmark 제외, deprecation warning 필터, `benchmark` marker |
| unit test | `libs/deepagents/Makefile:18-23` | `uv run --group test pytest -n auto -vvv --disable-socket --allow-unix-socket ... --cov=deepagents` |
| integration test | `libs/deepagents/Makefile:36-38` | socket disable 없이 integration test 실행 |
| lint/type | `libs/deepagents/Makefile:70-78` | `ruff check`, `ruff format --diff`, `ty check` |
| monorepo lock/check | `libs/Makefile:24-50` | 패키지별 `uv lock` 확인 |
| monorepo lint/format | `libs/Makefile:52-66` | 여러 패키지에 대한 lint/format |
| benchmark | `libs/Makefile:78-83`, `AGENTS.md:251-276` | `deepagents`, `code` benchmark를 Makefile에서 단일 진입점으로 관리 |

### 기본/내장 도구

| 도구 | 제공 계층 | 주요 동작 | 근거 |
| --- | --- | --- | --- |
| `write_todos` | `TodoListMiddleware` | 장기 작업의 할 일 목록 관리. `create_deep_agent` 기본 도구 목록에 포함된다. | `libs/deepagents/deepagents/graph.py:239-250`, `libs/deepagents/deepagents/graph.py:308-345` |
| `ls` | `FilesystemMiddleware` | 디렉터리 나열. 설명은 파일을 읽거나 편집하기 전에 거의 항상 `ls`를 사용하라고 지시한다. | `libs/deepagents/deepagents/middleware/filesystem.py:336-339`, `libs/deepagents/deepagents/middleware/filesystem.py:751-840` |
| `read_file` | `FilesystemMiddleware` | 페이지네이션/라인 번호/멀티모달 파일 지원. 편집 전 읽기를 요구하고 batch read를 허용한다. | `libs/deepagents/deepagents/middleware/filesystem.py:341-363`, `libs/deepagents/deepagents/middleware/filesystem.py:842-995` |
| `write_file` | `FilesystemMiddleware` | 새 파일 생성 또는 전체 내용 쓰기. 기존 파일 변경은 `edit_file` 선호. | `libs/deepagents/deepagents/middleware/filesystem.py:374-379`, `libs/deepagents/deepagents/middleware/filesystem.py:997-1086` |
| `edit_file` | `FilesystemMiddleware` | 정확한 문자열 교체 기반 편집. 편집 전 읽기, 들여쓰기 보존, 기존 파일에는 write보다 edit 선호. | `libs/deepagents/deepagents/middleware/filesystem.py:365-371`, `libs/deepagents/deepagents/middleware/filesystem.py:1088-1183` |
| `glob` | `FilesystemMiddleware` | glob 패턴 검색, timeout과 결과 truncation 적용. | `libs/deepagents/deepagents/middleware/filesystem.py:381-389`, `libs/deepagents/deepagents/middleware/filesystem.py:1185-1298` |
| `grep` | `FilesystemMiddleware` | literal text 검색. regex가 아니라 literal이라고 설명한다. | `libs/deepagents/deepagents/middleware/filesystem.py:391-400`, `libs/deepagents/deepagents/middleware/filesystem.py:1300-1405` |
| `execute` | `FilesystemMiddleware` + `SandboxBackendProtocol` | 샌드박스 명령 실행. 작업 디렉터리 확인, 경로 quoting, `grep/glob/read_file` 우선, timeout 제한, backend 지원 확인. | `libs/deepagents/deepagents/middleware/filesystem.py:402-445`, `libs/deepagents/deepagents/middleware/filesystem.py:1407-1595` |
| `task` | `SubAgentMiddleware` | 동기 하위 에이전트 실행. 복잡하고 독립적인 작업을 별도 컨텍스트에 위임하고 최종 결과만 반환한다. | `libs/deepagents/deepagents/middleware/subagents.py:273-381`, `libs/deepagents/deepagents/middleware/subagents.py:460-612` |
| async task start/check/update/cancel/list | `AsyncSubAgentMiddleware` | 원격 Agent Protocol subagent 작업 시작, 상태 확인, 업데이트, 취소, 목록. task id를 보존한다. | `libs/deepagents/deepagents/middleware/async_subagents.py:164-215`, `libs/deepagents/deepagents/middleware/async_subagents.py:277-684`, `libs/deepagents/deepagents/middleware/async_subagents.py:687-838` |
| `compact_conversation` | 선택적 `SummarizationToolMiddleware` | 수동 컨텍스트 압축 도구. 자동 요약 미들웨어와 상태를 공유하지만 자동으로 실행되지는 않는다. | `libs/deepagents/deepagents/middleware/summarization.py:1241-1322`, `libs/deepagents/deepagents/middleware/summarization.py:1325-1420` |

### 프롬프트/지시문 인벤토리

| 프롬프트 | 위치 | 핵심 역할 |
| --- | --- | --- |
| `BASE_AGENT_PROMPT` | `libs/deepagents/deepagents/graph.py:69-111` | 간결성, 작업 지속, 이해-실행-검증, 최소 질문, 진행 업데이트 규칙 |
| prompt assembly comments | `libs/deepagents/deepagents/graph.py:112-141` | user/base/suffix 순서와 cache_control 보존 규칙 |
| filesystem system prompt | `libs/deepagents/deepagents/middleware/filesystem.py:447-466` | 절대 경로 규칙, 대형 도구 결과의 `/large_tool_results/<tool_call_id>` 오프로딩 안내 |
| execute system prompt | `libs/deepagents/deepagents/middleware/filesystem.py:472-477` | execute 사용 가능 시 추가되는 명령 실행 지침 |
| task tool description/system prompt | `libs/deepagents/deepagents/middleware/subagents.py:273-413` | 언제 subagent를 쓰고 쓰지 말지, 병렬화, stateless, 상세 프롬프트 작성 규칙 |
| async task prompt | `libs/deepagents/deepagents/middleware/async_subagents.py:164-215` | 장기 원격 작업은 즉시 control 반환, 자동 polling 금지, task id 전체 사용 |
| skills prompt | `libs/deepagents/deepagents/middleware/skills.py:783-823` | 사용 가능한 스킬 목록과 필요 시 `SKILL.md`를 읽는 progressive disclosure |
| memory prompt | `libs/deepagents/deepagents/middleware/memory.py:104-169` | 메모리 충돌 검증, 학습 가능한 정보, 자격증명 저장 금지 |
| summarization prompt/tool | `libs/deepagents/deepagents/middleware/summarization.py:100-107`, `libs/deepagents/deepagents/middleware/summarization.py:1325-1420` | 수동 `compact_conversation`의 발견/사용 안내 |
| Codex harness suffix | `libs/deepagents/deepagents/profiles/harness/_openai_codex.py:35-60` | Codex 모델용 자율 엔지니어링, action bias, 병렬 도구 사용 지침 |
| Claude Sonnet harness suffix | `libs/deepagents/deepagents/profiles/harness/_anthropic_sonnet_4_6.py:32-43` | 병렬 도구 호출, 조사 후 답변, 도구 후 반영 |
| Better Agent prompt | `examples/better-harness/better_harness/agent.py:21-38` | `/current`만 편집, train/history/bookkeeping 직접 수정 금지, 과적합 회피, proposal 작성 |

### better-harness 명령/스크립트

| 항목 | 위치 | 내용 |
| --- | --- | --- |
| 패키지와 CLI | `examples/better-harness/pyproject.toml:1-17` | Python 3.12 이상, `better-harness = better_harness:main` |
| CLI command | `examples/better-harness/better_harness/core.py:1071-1128` | `validate`, `inventory`, `split`, `inspect`, `traces`, 기본 run |
| config loader | `examples/better-harness/better_harness/core.py:543-652` | runner, model, better_agent, surfaces, cases 로드 |
| config validation | `examples/better-harness/better_harness/core.py:653-720` | runner/surface/split/case uniqueness/strata 균형 검증 |
| run loop | `examples/better-harness/better_harness/core.py:864-1002` | baseline train/holdout 평가, candidate 제안, train/holdout 재평가, combined pass 개선 시 수락, 선택적 scorecard |
| proposer workspace | `examples/better-harness/better_harness/agent.py:51-105` | `/current`, manifest, train artifacts, history, task, proposal skeleton 생성 |
| Deep Agent invocation | `examples/better-harness/better_harness/agent.py:176-241` | `FilesystemBackend(root_dir=workspace.root, virtual_mode=True)`로 Deep Agent 실행 |
| pytest runner | `examples/better-harness/better_harness/runners.py:31-64`, `examples/better-harness/better_harness/runners.py:66-225` | nodeid 수집, case별 pytest 실행, variant/sitecustomize/PYTHONPATH 주입 |
| patching | `examples/better-harness/better_harness/patching.py:16-109` | baseline/candidate variant, env 기반 module attr patch, workspace file override 및 복구 |

## 각 도구가 왜 그렇게 작성되어야 했는지에 대한 근거 또는 엄밀한 추론

### `write_todos`

- 근거: `write_todos`는 기본 도구 목록에 포함되고, 미들웨어 순서상 가장 앞의 `TodoListMiddleware`로 배치된다. 근거: `libs/deepagents/deepagents/graph.py:239-250`, `libs/deepagents/deepagents/graph.py:308-345`.
- 엄밀한 추론: 장기 작업에서 계획 상태를 모델 메시지 안에만 보존하면 컨텍스트 압축/오프로딩/하위 에이전트 분기 시 일관성이 떨어진다. 따라서 todo를 별도 미들웨어 상태로 관리하는 설계가 필요하다. 이 추론은 `_DeepAgentState`가 DeltaChannel로 메시지 성장을 제어하고, 요약 미들웨어가 메시지 히스토리를 변형하지 않도록 별도 이벤트를 쓰며, 하위 에이전트에서 `todos`를 제외하는 코드 제약에 근거한다. 근거: `libs/deepagents/deepagents/graph.py:63-67`, `libs/deepagents/deepagents/middleware/summarization.py:1170-1201`, `libs/deepagents/deepagents/middleware/subagents.py:228-257`.

### `ls`

- 근거: 도구 설명은 파일을 읽거나 편집하기 전에 거의 항상 `ls`를 쓰라고 지시한다. 근거: `libs/deepagents/deepagents/middleware/filesystem.py:336-339`.
- 엄밀한 추론: agent가 파일 경로를 추측해 `read_file`/`edit_file`을 호출하면 권한 오류, 존재하지 않는 경로, 잘못된 편집 가능성이 커진다. `ls` 선행 규칙은 경로 확인을 cheap read operation으로 분리해 이후 작업 실패율을 줄이기 위한 설계다. 이 추론은 `FilesystemPermission`의 절대 경로/상위 경로 금지와 read/write permission 검사 구조에 근거한다. 근거: `libs/deepagents/deepagents/middleware/filesystem.py:83-116`, `libs/deepagents/deepagents/middleware/filesystem.py:751-840`.

### `read_file`

- 근거: `read_file`은 pagination, line number, multimodal content block, batch read를 지원하며, 편집 전 읽기를 요구한다. 근거: `libs/deepagents/deepagents/middleware/filesystem.py:341-363`, `libs/deepagents/deepagents/middleware/filesystem.py:842-995`.
- 엄밀한 추론: 하네스가 line-numbered pagination을 제공하는 이유는 큰 파일을 한 번에 모델 컨텍스트에 넣지 않으면서 정확한 편집 위치를 확인하게 하기 위함이다. 이는 대형 read 결과를 자르고 원본 경로로 되돌아가게 하는 overflow clipping, 큰 tool result를 파일로 오프로딩하는 메시지 eviction과 같은 컨텍스트 절약 장치와 맞물린다. 근거: `libs/deepagents/deepagents/middleware/_overflow_clip.py:76-94`, `libs/deepagents/deepagents/middleware/_message_eviction.py:119-142`.

### `edit_file`

- 근거: `edit_file`은 정확한 문자열 교체 기반이며, 먼저 파일을 읽어야 하고, 들여쓰기를 보존하며, 기존 파일 수정에는 `write_file`보다 선호된다. 근거: `libs/deepagents/deepagents/middleware/filesystem.py:365-371`, `libs/deepagents/deepagents/middleware/filesystem.py:1088-1183`.
- 근거: backend protocol도 `edit`을 exact replacement로 정의한다. 근거: `libs/deepagents/deepagents/backends/protocol.py:509-570`.
- 엄밀한 추론: exact replacement 방식은 모델이 패치 문맥을 명시적으로 제시하게 만들고, 대규모 rewrite보다 변경 범위를 줄이며, 실패 시 "string not found" 형태로 안전하게 멈출 수 있다. 이 추론은 unit test가 단일/전체 교체, nonexistent file, string not found를 별도 검증하는 구조에 근거한다. 근거: `libs/deepagents/tests/unit_tests/test_file_system_tools.py:79-198`, `libs/deepagents/tests/unit_tests/test_file_system_tools.py:201-295`.

### `write_file`

- 근거: 도구 설명은 새 파일 생성에 쓰고, 기존 파일에는 `edit_file`을 선호하라고 지시한다. 구현은 write permission을 확인하고 backend write를 호출한다. 근거: `libs/deepagents/deepagents/middleware/filesystem.py:374-379`, `libs/deepagents/deepagents/middleware/filesystem.py:997-1086`.
- 근거: protocol의 `write`는 새 파일을 만들며 이미 존재하면 error를 내도록 정의된다. 근거: `libs/deepagents/deepagents/backends/protocol.py:509-570`.
- 엄밀한 추론: 새 파일 생성과 기존 파일 편집을 분리하면 accidental overwrite 위험을 줄이고 리뷰 가능한 변경 단위를 유지할 수 있다. 이 추론은 `edit_file` 선호 지시와 protocol의 "write must create new file and error if exists" 제약에 근거한다. 근거: `libs/deepagents/deepagents/middleware/filesystem.py:365-379`, `libs/deepagents/deepagents/backends/protocol.py:509-570`.

### `glob`

- 근거: `glob`은 파일 패턴 검색 도구이며 동기 경로에서는 ThreadPool timeout, async 경로에서는 `wait_for`, 결과 truncation을 적용한다. 근거: `libs/deepagents/deepagents/middleware/filesystem.py:381-389`, `libs/deepagents/deepagents/middleware/filesystem.py:1185-1298`.
- 엄밀한 추론: agent가 셸 `find`를 직접 실행하지 않고 구조화된 `glob`를 쓰게 하면 backend와 permission filtering을 일관되게 적용할 수 있고, timeout/truncation으로 컨텍스트와 실행 시간을 통제할 수 있다. 이 추론은 `execute` 설명이 검색에는 `glob`/`grep`을 우선하라고 지시하고, filesystem tool permissions가 read/write를 분류하는 구조에 근거한다. 근거: `libs/deepagents/deepagents/middleware/filesystem.py:73-80`, `libs/deepagents/deepagents/middleware/filesystem.py:402-445`.

### `grep`

- 근거: `grep` 설명은 regex가 아니라 literal text 검색이라고 명시한다. 구현은 output mode와 permission filtering을 처리한다. 근거: `libs/deepagents/deepagents/middleware/filesystem.py:391-400`, `libs/deepagents/deepagents/middleware/filesystem.py:1300-1405`.
- 엄밀한 추론: literal 검색은 LLM이 regex escaping을 잘못해 과소/과대 매칭하는 위험을 줄이려는 선택이다. 이 추론은 도구 설명이 "literal, not regex"를 강조하고, `execute` 설명이 codebase search에는 shell보다 `grep`/`glob`를 쓰라고 지시하는 제약에 근거한다. 근거: `libs/deepagents/deepagents/middleware/filesystem.py:391-445`.

### `execute`

- 근거: `execute`는 sandbox command 도구이며 작업 디렉터리 확인, 경로 quoting, `grep/glob/read_file` 우선, `cd` 회피, timeout 설정을 지시한다. 근거: `libs/deepagents/deepagents/middleware/filesystem.py:402-445`.
- 근거: `execute`는 backend가 실행을 지원하는지 확인하고, timeout non-negative 및 최대값을 검증하며, 실행 미지원 시 예외/오류를 반환한다. 근거: `libs/deepagents/deepagents/middleware/filesystem.py:1407-1595`.
- 근거: backend가 실행을 지원하지 않으면 모델 호출 전 `execute` 도구를 필터링한다. 근거: `libs/deepagents/deepagents/middleware/filesystem.py:1597-1667`.
- 엄밀한 추론: shell은 가장 강력하고 위험한 도구이므로 search/read 같은 정형 작업은 별도 도구로 분리하고, command 실행은 backend capability와 timeout으로 좁히는 설계가 필요하다. 이 추론은 README의 "trust the LLM" 보안 경고와 LocalShellBackend의 비샌드박스 경고에 근거한다. 근거: `README.md:109-111`, `libs/deepagents/deepagents/backends/local_shell.py:1-6`, `libs/deepagents/deepagents/backends/local_shell.py:221-357`.

### `task`

- 근거: `task` 도구 설명은 복잡하고 독립적인 작업에 subagent를 사용하고, 병렬화하며, 하위 에이전트는 stateless이고 단일 결과만 반환한다고 설명한다. 근거: `libs/deepagents/deepagents/middleware/subagents.py:273-381`.
- 근거: 하위 에이전트 호출 시 부모 state에서 특정 키를 제외하고, callbacks/tags/configurable만 전달하며, 결과는 `ToolMessage`와 state update로 반환한다. 근거: `libs/deepagents/deepagents/middleware/subagents.py:228-257`, `libs/deepagents/deepagents/middleware/subagents.py:460-612`.
- 엄밀한 추론: subagent는 장기 컨텍스트를 부모와 공유하지 않고 독립 조사/분석을 수행하기 위한 컨텍스트 격리 장치다. 이 추론은 task prompt의 "separate context", "stateless", "single result" 규칙과 state key exclusion에 근거한다. 근거: `libs/deepagents/deepagents/middleware/subagents.py:228-257`, `libs/deepagents/deepagents/middleware/subagents.py:273-413`.

### async subagent 도구

- 근거: async subagent 도구는 remote Agent Protocol server에서 장기 작업을 시작하고 task id를 즉시 반환하며, 자동 check/poll 금지, 상태 stale 가능성, full task_id 사용을 규칙으로 둔다. 근거: `libs/deepagents/deepagents/middleware/async_subagents.py:1-10`, `libs/deepagents/deepagents/middleware/async_subagents.py:164-215`.
- 근거: start/check/update/cancel/list가 별도 도구로 구현되어 있다. 근거: `libs/deepagents/deepagents/middleware/async_subagents.py:277-684`, `libs/deepagents/deepagents/middleware/async_subagents.py:687-838`.
- 엄밀한 추론: 장기 원격 작업은 동기 `task`처럼 부모 컨텍스트를 붙잡으면 비용과 지연이 커지므로, task id 기반 상태 머신으로 분리해야 한다. 이 추론은 "return control immediately"와 "never auto-check/poll" 지시에 근거한다. 근거: `libs/deepagents/deepagents/middleware/async_subagents.py:164-215`.

### `compact_conversation` 및 자동 요약

- 근거: 자동 요약은 `create_deep_agent` stack에 기본으로 들어가는 `SummarizationMiddleware`가 담당하고, 수동 `compact_conversation`은 별도 `SummarizationToolMiddleware`가 제공한다. 근거: `libs/deepagents/deepagents/graph.py:308-345`, `libs/deepagents/deepagents/middleware/summarization.py:1241-1322`.
- 근거: 자동 요약 미들웨어는 evicted history를 backend 파일에 저장하고, tool args를 사전 축약하며, `ContextOverflowError`에 fallback하고, raw message log를 덮어쓰지 않는다. 근거: `libs/deepagents/deepagents/middleware/summarization.py:1170-1201`.
- 엄밀한 추론: 수동 compact 도구를 기본으로 항상 노출하지 않고 선택적 미들웨어로 분리한 이유는 agent가 이 도구를 남용하면 불필요한 정보 손실과 추가 모델 호출이 발생할 수 있기 때문이다. 이 추론은 `SummarizationToolMiddleware`가 약 50% trigger 이전에는 실행을 gate하고, 자동 압축은 별도 middleware trigger가 담당한다는 설명에 근거한다. 근거: `libs/deepagents/deepagents/middleware/summarization.py:1241-1322`, `libs/deepagents/deepagents/middleware/summarization.py:1325-1420`.

### 스킬과 메모리

- 근거: 스킬은 전체 내용을 즉시 주입하지 않고 metadata 목록만 보여준 뒤 필요 시 `SKILL.md`를 읽게 하는 progressive disclosure 구조다. 근거: `libs/deepagents/deepagents/middleware/skills.py:783-823`.
- 근거: 메모리는 항상 로드되고, 충돌 검증/업데이트 방법/자격증명 금지 지침을 포함한다. 근거: `libs/deepagents/deepagents/middleware/memory.py:104-169`, `libs/deepagents/deepagents/middleware/memory.py:302-440`.
- 엄밀한 추론: 스킬과 메모리를 분리한 이유는 "항상 필요한 지속 맥락"과 "필요할 때만 펼치는 절차 지식"의 컨텍스트 비용이 다르기 때문이다. 이 추론은 memory docstring이 "AGENTS.md memory always loaded, unlike skills on-demand"라고 설명하고, skills prompt가 필요할 때만 파일을 읽으라고 지시하는 구조에 근거한다. 근거: `libs/deepagents/deepagents/middleware/memory.py:2-12`, `libs/deepagents/deepagents/middleware/skills.py:783-823`.

## 장점

- 기본값이 강하다. README와 pyproject가 하위 에이전트, todo, 파일시스템, 컨텍스트 관리가 포함된 하네스를 표방하고, `create_deep_agent`가 실제로 해당 미들웨어를 기본 stack으로 조립한다. 근거: `README.md:24-42`, `libs/deepagents/pyproject.toml:2-5`, `libs/deepagents/deepagents/graph.py:308-345`.
- 확장 지점이 명확하다. 사용자는 `tools`, `middleware`, `subagents`, `skills`, `memory`, `permissions`, `backend`, `interrupt_on`, `response_format`, `context`, `checkpointer`, `store` 등을 `create_deep_agent`에서 지정할 수 있다. 근거: `libs/deepagents/deepagents/graph.py:217-236`.
- 필수 scaffolding을 제외하지 못하게 막는다. `FilesystemMiddleware`와 `SubAgentMiddleware`는 excluded middleware 대상에서 보호되며, unmatched exclusion도 오류 처리한다. 이는 프로파일/사용자 설정이 하네스 핵심 불변식을 깨는 것을 줄인다. 근거: `libs/deepagents/deepagents/graph.py:187-202`, `libs/deepagents/deepagents/graph.py:731-747`.
- 컨텍스트 대책이 다층적이다. DeltaChannel, 자동 요약, 파일 오프로딩, tool arg truncation, overflow clipping, large tool result eviction이 서로 다른 실패 모드를 담당한다. 근거: `libs/deepagents/deepagents/graph.py:63-67`, `libs/deepagents/deepagents/middleware/summarization.py:1170-1201`, `libs/deepagents/deepagents/middleware/_overflow_clip.py:1-14`, `libs/deepagents/deepagents/middleware/_message_eviction.py:119-142`.
- 보안 리스크를 문서와 코드에서 직접 드러낸다. README는 LLM을 신뢰하는 방식이므로 경계는 도구/샌드박스 레벨에서 강제해야 한다고 말하고, unsafe backend들은 명시적 경고를 포함한다. 근거: `README.md:109-111`, `libs/deepagents/deepagents/backends/filesystem.py:44-90`, `libs/deepagents/deepagents/backends/local_shell.py:1-6`.
- model/provider/harness 관심사가 분리되어 있다. provider profile은 모델 생성/환경 체크, harness profile은 행동 프롬프트와 도구/미들웨어 가시성을 담당한다. 근거: `libs/deepagents/deepagents/profiles/provider/provider_profiles.py:46-63`, `libs/deepagents/deepagents/profiles/harness/harness_profiles.py:1-18`.
- 테스트가 위험한 경계에 배치되어 있다. 예를 들어 tool description override가 caller object를 mutation하지 않는지, general-purpose subagent 비활성화가 task tool 노출에 미치는 영향, skill module path validation, file edit 오류 경로, subagent 병렬 호출이 검증된다. 근거: `libs/deepagents/tests/unit_tests/test_graph.py:179-267`, `libs/deepagents/tests/unit_tests/test_graph.py:272-348`, `libs/deepagents/tests/unit_tests/middleware/test_skills_middleware.py:221-315`, `libs/deepagents/tests/unit_tests/test_file_system_tools.py:79-295`, `libs/deepagents/tests/unit_tests/test_subagents.py:211-329`.
- better-harness 예제는 하네스 자체를 eval-driven optimization 대상으로 삼는 구체적 참고 구현이다. train/holdout split, visible/private split, 변경 surface, 후보 수락 기준, scorecard가 구현되어 있다. 근거: `examples/better-harness/README.md:16-31`, `examples/better-harness/better_harness/core.py:18-27`, `examples/better-harness/better_harness/core.py:864-1002`.

## 약한 점/리스크

- 보안 경계는 agent 내부가 아니라 도구/백엔드에 의존한다. README가 "trust the LLM"이라고 설명하고, boundaries는 tool/sandbox level에서 강제해야 한다고 명시한다. 따라서 DITTO가 이 설계를 차용할 때 backend 직접 접근, shell execution, credential exposure를 별도 위협 모델로 다뤄야 한다. 근거: `README.md:109-111`, `libs/deepagents/deepagents/graph.py:397-410`.
- `FilesystemBackend`와 `LocalShellBackend`는 안전한 production sandbox가 아니다. 문서상 로컬 개발/CI 용도이고 웹/API 사용 금지, 비밀 유출, 영구 수정 위험을 경고한다. `LocalShellBackend`는 `shell=True`로 로컬 명령을 실행한다. 근거: `libs/deepagents/deepagents/backends/filesystem.py:44-90`, `libs/deepagents/deepagents/backends/local_shell.py:27-82`, `libs/deepagents/deepagents/backends/local_shell.py:221-357`.
- 권한은 tool-level이다. 코드 주석은 backend를 직접 사용하면 permissions가 enforced되지 않는다고 말한다. 백엔드 API가 외부 extension이나 사용자 미들웨어에 노출될 때 별도 방어가 필요하다. 근거: `libs/deepagents/deepagents/graph.py:397-410`.
- 기본 `StateBackend` 파일은 대화 thread 내에서만 유지되고 thread 간 persistence가 없다. 장기 작업 재개나 multi-thread 작업공간을 기대하면 별도 백엔드가 필요하다. 근거: `libs/deepagents/deepagents/backends/state.py:38-48`.
- 기본 모델 사용은 deprecated다. 기본값이 남아 있지만 1.0.0 제거 예정이므로, 하네스를 그대로 차용하면 모델을 명시하지 않은 사용자가 향후 breaking change를 맞을 수 있다. 근거: `libs/deepagents/deepagents/graph.py:145-184`.
- HarnessProfile은 beta API로 표시되어 있다. 하네스 동작 제어에는 유용하지만, DITTO가 외부 plugin/profile 호환성을 약속하기에는 API 안정성 리스크가 있다. 근거: `libs/deepagents/deepagents/profiles/harness/harness_profiles.py:1-18`.
- profile의 tool description override는 강력하지만, task override는 `{available_agents}` placeholder 요구 같은 형식 제약이 있다. 잘못된 override는 도구 발견성을 망칠 수 있다. 근거: `libs/deepagents/deepagents/profiles/harness/harness_profiles.py:583-614`.
- ~~skills의 `module` entrypoint는 parse/validate만 하고 실행하지 않는다.~~ **[수정 @ 1906af98]** `module` 필드 자체가 `SkillMetadata`에서 완전히 제거되었다. 커밋 `1fe90943`이 "공식 agent skills 명세에 포함되지 않는 top-level module 프로퍼티"를 삭제했다. `_validate_module_path`, `_MODULE_EXTENSIONS` 헬퍼도 함께 제거되었다. skill metadata는 오직 prompt/disclosure 계층이며, JS/TS 런타임 연결은 `langchain-quickjs` 파트너 패키지 등 별도 파트너 통합이 담당하도록 정책이 명확해졌다. DITTO가 스킬 실행을 기대한다면 여전히 별도 런타임 설계가 필요하다. 근거: `libs/deepagents/deepagents/middleware/skills.py:232-301` @ `1906af98` (현재 `SkillMetadata`에 `module` 필드 없음), 커밋 `1fe90943`.
- better-harness의 visible/private split은 "hard sandbox boundary"가 아니라고 문서가 명시한다. 평가 데이터 보안을 위해서는 별도 프로세스/파일시스템/권한 격리가 필요하다. 근거: `examples/better-harness/README.md:108-119`.
- better-harness의 candidate 수락 기준은 train+holdout pass count의 strict improvement다. 이 기준은 단순하고 재현 가능하지만, 품질 점수/회귀 severity/비결정성 평가를 반영하지 못할 수 있다. 근거: `examples/better-harness/better_harness/core.py:935-948`.
- pytest runner는 variant 적용을 `sitecustomize`와 임시 workspace file override로 처리한다. 파일 override는 finally에서 복구되지만, 실행 중 프로세스 실패나 외부 동시 접근이 있으면 isolation 한계가 있다. 근거: `examples/better-harness/better_harness/patching.py:51-109`, `examples/better-harness/better_harness/runners.py:66-225`.

## DITTO에서 차용할 점

- `create_deep_agent`식 조립 함수: DITTO도 단일 entrypoint에서 모델, 도구, 미들웨어, 백엔드, 권한, HITL, 메모리, 하위 에이전트를 조립하되 필수 scaffolding을 보호하는 구조를 차용할 수 있다. 근거: `libs/deepagents/deepagents/graph.py:217-236`, `libs/deepagents/deepagents/graph.py:187-202`, `libs/deepagents/deepagents/graph.py:308-345`.
- 명시적 미들웨어 순서: todo/skills/filesystem/subagent/async/summarization/patch/user/profile/exclusion/cache/memory/HITL 순서를 문서화하고 코드로 고정한 점은 DITTO에서도 디버깅 가능성을 높인다. 근거: `libs/deepagents/deepagents/graph.py:308-345`, `libs/deepagents/deepagents/graph.py:671-730`.
- 파일 도구 UX: `ls` 선행, line-numbered `read_file`, exact `edit_file`, literal `grep`, shell보다 structured search 우선 지시는 에이전트가 코드베이스를 안전하게 다루는 데 유용하다. 근거: `libs/deepagents/deepagents/middleware/filesystem.py:336-445`.
- backend 추상화와 permission 규칙: DITTO는 State/Filesystem/Sandbox/Composite 같은 backend boundary와 prefix-based routing을 참고할 수 있다. 다만 permissions가 tool-level이라는 한계를 backend-level guard로 보완해야 한다. 근거: `libs/deepagents/deepagents/backends/protocol.py:318-340`, `libs/deepagents/deepagents/backends/composite.py:86-115`, `libs/deepagents/deepagents/graph.py:397-410`.
- 하위 에이전트 task 설계: 복잡하고 독립적인 작업을 stateless subagent로 보내고, 부모 state leakage를 제한하며, 스트리밍에서 typed subagent handle을 제공하는 방식은 DITTO의 병렬 분석/분해 실행에 적합하다. 근거: `libs/deepagents/deepagents/middleware/subagents.py:228-257`, `libs/deepagents/deepagents/middleware/subagents.py:273-413`, `libs/deepagents/deepagents/_subagent_transformer.py:136-246`.
- 컨텍스트 오프로딩: 요약 전 원문 히스토리를 backend 파일에 남기고 summary에 경로를 삽입하는 구조는 장기 세션에서 재검증 가능성을 높인다. 근거: `libs/deepagents/deepagents/middleware/summarization.py:42-47`, `libs/deepagents/deepagents/middleware/summarization.py:474-505`, `libs/deepagents/deepagents/middleware/summarization.py:758-830`.
- 스킬 progressive disclosure: 스킬 metadata만 노출하고 필요할 때 `SKILL.md`를 읽게 하는 방식은 DITTO의 도메인별 절차/도구 설명을 컨텍스트 효율적으로 제공하는 데 적합하다. 근거: `libs/deepagents/deepagents/middleware/skills.py:783-823`, `libs/deepagents/deepagents/middleware/skills.py:826-910`.
- model별 harness profile: provider/model exact lookup과 provider-prefix lookup, additive merge 규칙은 DITTO가 모델별 프롬프트/도구 가시성을 관리할 때 참고할 만하다. 근거: `libs/deepagents/deepagents/profiles/harness/harness_profiles.py:935-949`, `libs/deepagents/deepagents/profiles/harness/harness_profiles.py:1045-1098`, `libs/deepagents/deepagents/profiles/harness/harness_profiles.py:1188-1243`.
- better-harness 외부 루프: DITTO 하네스 자체를 평가 기반으로 개선하려면 editable surface, train/holdout/scorecard, proposer workspace, strict acceptance, run artifacts를 차용할 수 있다. 근거: `examples/better-harness/README.md:16-31`, `examples/better-harness/better_harness/core.py:864-1002`, `examples/better-harness/better_harness/agent.py:51-105`.

## 보완 계획

1. DITTO 하네스 entrypoint를 정의한다. `create_deep_agent`처럼 모델/도구/미들웨어/백엔드/권한/메모리/하위 에이전트를 한 함수에서 조립하되, DITTO의 필수 scaffolding 목록을 먼저 정하고 제외 불가 규칙을 둔다. 참고 근거: `libs/deepagents/deepagents/graph.py:187-202`, `libs/deepagents/deepagents/graph.py:217-236`.
2. 파일 도구 스펙을 DITTO 표준으로 분리한다. 최소 스펙은 `ls`, `read_file`, `edit_file`, `write_file`, `glob`, `grep`, 선택적 `execute`이며, line-numbering, pagination, exact replacement, literal search, timeout/truncation을 명시한다. 참고 근거: `libs/deepagents/deepagents/middleware/filesystem.py:336-445`, `libs/deepagents/deepagents/middleware/filesystem.py:842-1405`.
3. 권한 모델을 tool-level과 backend-level 모두에 둔다. deepagents는 tool-level permission 한계를 문서화하므로, DITTO는 backend 직접 접근에도 동일한 정책을 강제하거나 backend handle을 사용자 미들웨어에 넘기지 않는 정책을 세워야 한다. 참고 근거: `libs/deepagents/deepagents/graph.py:397-410`.
4. 샌드박스 실행은 기본 off로 두고, 실행 가능 backend가 명시될 때만 `execute`를 노출한다. LocalShellBackend 같은 개발용 backend를 운영 경로에서 차단하는 guard를 둔다. 참고 근거: `libs/deepagents/deepagents/middleware/filesystem.py:480-499`, `libs/deepagents/deepagents/middleware/filesystem.py:1597-1667`, `libs/deepagents/deepagents/backends/local_shell.py:1-6`.
5. 하위 에이전트 표준 prompt와 state handoff 규칙을 작성한다. 부모 state 중 무엇을 숨길지, 어떤 config/callback/tag만 전달할지, 결과를 어떤 구조로 반환할지 테스트로 고정한다. 참고 근거: `libs/deepagents/deepagents/middleware/subagents.py:228-257`, `libs/deepagents/deepagents/middleware/subagents.py:460-612`.
6. 컨텍스트 오프로딩을 파일 도구와 연결한다. 요약 원문, 큰 도구 결과, 오래된 read 결과를 파일로 저장하고, summary/tool message에는 재접근 경로와 preview만 남긴다. 참고 근거: `libs/deepagents/deepagents/middleware/summarization.py:758-830`, `libs/deepagents/deepagents/middleware/_message_eviction.py:25-63`, `libs/deepagents/deepagents/middleware/_message_eviction.py:119-142`.
7. DITTO skill/memory를 분리한다. memory는 항상 로드되는 프로젝트 지식, skill은 필요 시 펼치는 절차 지식으로 나누고, skill metadata validation과 경로 traversal 방지를 구현한다. 참고 근거: `libs/deepagents/deepagents/middleware/memory.py:2-12`, `libs/deepagents/deepagents/middleware/skills.py:324-532`.
8. eval-driven harness improvement 루프를 별도 실험 패키지로 만든다. `better-harness`처럼 surface, train/holdout/scorecard split, proposer workspace, proposal artifact, acceptance decision을 저장하되, private split을 진짜 sandbox boundary로 보호한다. 참고 근거: `examples/better-harness/README.md:108-119`, `examples/better-harness/better_harness/core.py:653-720`, `examples/better-harness/better_harness/core.py:864-1002`.
9. 테스트를 위험 경계 중심으로 작성한다. tool override immutability, profile exclusion, file edit errors, skill path validation, subagent parallel execution, execute unsupported backend filtering을 우선 고정한다. 참고 근거: `libs/deepagents/tests/unit_tests/test_graph.py:179-348`, `libs/deepagents/tests/unit_tests/test_file_system_tools.py:79-295`, `libs/deepagents/tests/unit_tests/middleware/test_skills_middleware.py:221-315`, `libs/deepagents/tests/unit_tests/test_subagents.py:211-329`.

## 기준 커밋 이후 변경 (2026-06-01 갱신)

갱신 범위: `84daa1a..1906af98`. libs/deepagents/ 기준 22개 SDK 관련 커밋. 아래 항목은 이 분석 문서가 다루는 테마(skills, graph, subagent/tool 아키텍처)와 직접 관련된 변경이다.

### 1. `_DeepAgentState` → `DeepAgentState` 공개 export (커밋 `14a90475`)

`_DeepAgentState`가 `DeepAgentState`로 이름이 바뀌고 패키지 `__init__.py`에 export되었다. 기존 분석이 `_DeepAgentState`라고 표기했던 모든 부분은 이제 `DeepAgentState`가 맞다.

- 근거: `libs/deepagents/deepagents/graph.py:63` @ `1906af98` — `class DeepAgentState(AgentState):`
- 근거: `libs/deepagents/deepagents/__init__.py:31` @ `1906af98` — `"DeepAgentState"` export 목록 포함.

**DITTO 함의**: DITTO가 이 타입을 참조하거나 subclass할 때 공개 이름 `DeepAgentState`를 써야 한다. semver-stable 이름으로 바뀐 것이므로 외부 확장이 더 안전해졌다.

### 2. `create_deep_agent`에 `state_schema` 파라미터 추가 (커밋 `37839bd7`)

`create_deep_agent(..., state_schema: type[DeepAgentState] | None = None, ...)`가 추가되었다. 호출자가 `DeepAgentState`의 subclass를 넘겨 그래프 상태를 커스텀 필드로 확장할 수 있다. 기본값은 `DeepAgentState` 그대로이므로 기존 동작 변화 없음.

- 근거: `libs/deepagents/deepagents/graph.py:230` @ `1906af98` — `state_schema: type[DeepAgentState] | None = None`
- 근거: `libs/deepagents/deepagents/graph.py:818` @ `1906af98` — `state_schema=state_schema if state_schema is not None else DeepAgentState`
- 설계 제약: `TypedDict`는 `issubclass` 검사를 허용하지 않으므로 subclass 제약은 런타임이 아니라 타입 시스템으로만 강제된다고 코드 주석이 명시한다. 근거: `libs/deepagents/deepagents/graph.py:513-514` @ `1906af98`.
- `SubAgentMiddleware`도 `state_schema`를 받고, 선언형 `SubAgent` 스펙을 컴파일할 때 이 스키마를 전달한다. 단, `CompiledSubAgent` 런어블은 이미 컴파일된 상태이므로 상속되지 않는다. 근거: `libs/deepagents/deepagents/middleware/subagents.py:683` @ `1906af98`.

**DITTO 함의**: DITTO가 page_url, file_url, work-item ID 같은 런 스코프 필드를 그래프 상태에 넣으려 할 때 커스텀 `state_schema`로 선언할 수 있다. `context_schema`(불변 런 스코프)와 목적이 다르므로 용도에 따라 선택해야 한다.

### 3. `RubricMiddleware` 신규 추가 (커밋 `5b8d44d6`)

`libs/deepagents/deepagents/middleware/rubric.py`(813 LOC)가 신규 추가되어 `deepagents` 패키지에 export되었다. self-evaluated 반복 실행을 위한 미들웨어다.

동작 요약:
- 호출자가 invocation state에 `rubric` 문자열을 넘기면 미들웨어가 활성화된다. `rubric`이 없으면 완전히 no-op이므로 스택에 무조건 포함해도 안전하다.
- 에이전트가 한 차례 응답(도구 호출 없는 AIMessage)을 완료하면, 별도 grader sub-agent가 트랜스크립트를 평가해 `GraderVerdict`(`satisfied`/`needs_revision`/`failed`)를 반환한다.
- `needs_revision`이면 grader의 피드백을 `HumanMessage(name="rubric_grader")`로 주입하고 에이전트를 다시 실행한다. `satisfied`/`failed`/`max_iterations` 도달/`grader_error`면 종료한다.
- `max_iterations`는 기본 3, 하드 상한 20. `on_evaluation` 콜백으로 각 평가 결과를 수신할 수 있다.

- 근거: `libs/deepagents/deepagents/middleware/rubric.py:1-10` @ `1906af98` — 모듈 docstring.
- 근거: `libs/deepagents/deepagents/middleware/rubric.py:56-83` @ `1906af98` — `GraderVerdict`, `RubricResult` 타입.
- 근거: `libs/deepagents/deepagents/middleware/rubric.py:297-370` @ `1906af98` — `RubricMiddleware` 클래스 정의와 `__init__` 시그니처.

**DITTO 함의**: DITTO의 검증 루프(특히 ditto:verify 역할)에 직접 대응한다. main agent가 완료를 선언하면 grader가 acceptance criteria 충족 여부를 평가하고 부족하면 재실행하는 구조를 하네스 계층에서 구현한다. 단, grader도 별도 모델 호출이므로 토큰 비용과 `max_iterations` 설정에 주의가 필요하다.

### 4. `SkillMetadata.module` 필드 완전 제거 (커밋 `1fe90943`)

`SkillMetadata`의 `module` NotRequired 필드, `_validate_module_path` 함수, `_MODULE_EXTENSIONS` 상수가 모두 제거되었다. 이유는 "공식 agent skills 명세에 포함되지 않는 프로퍼티"이기 때문이다. `allowed-tools` 파싱도 `_parse_allowed_tools` 헬퍼로 분리·리팩터링되었다.

- 근거: `libs/deepagents/deepagents/middleware/skills.py:232` @ `1906af98` — `SkillMetadata`에 `module` 필드 없음.
- 근거: `libs/deepagents/deepagents/middleware/skills.py:353-366` @ `1906af98` — `_parse_allowed_tools` 신규 헬퍼.

기존 분석 중 "module entrypoint는 parse/validate만 하고 실행하지 않는다"(약한 점/리스크 섹션) 및 "module 엔트리포인트는 검증만 하고 실행하지 않는다"(구조/스킬 로더 섹션) 두 곳을 이 갱신에서 수정했다.

### 5. `read_file` 버그 수정 — pagination/base64 처리 (커밋 `390551d6`, `9857a08b`, `97946ee0`)

- `read_file` 페이지네이션에서 긴 줄이 continuation row로 분할될 때 실제 소스 라인이 잘리는 버그 수정(`390551d6`). `limit`은 이제 소스 라인 기준이고 continuation row는 한도를 소비하지 않는다. 근거: `libs/deepagents/deepagents/middleware/filesystem.py:353` @ `1906af98`.
- 알 수 없는 확장자의 base64 파일을 텍스트로 처리하려다 실패하던 버그 수정(`9857a08b`). 인코딩 힌트를 확장자보다 먼저 검사해 binary 파일을 `"file"` 블록으로 올바르게 처리한다.
- `read_file` 도구 설명 예시가 `path` → `file_path` 키워드 인자로 업데이트되었다(`97946ee0`). 근거: `libs/deepagents/deepagents/middleware/filesystem.py:348-351` @ `1906af98`.

**DITTO 함의**: `read_file` 도구 설명 및 내부 동작이 변경되었으므로 DITTO가 이 도구 계약을 참조할 때 `file_path` 키워드를 써야 한다.

### 6. `Command.goto`/`graph` 전파 수정 (커밋 `d92aef68`)

tool이 반환하는 `Command` 객체에 `goto`와 `graph` 필드가 있을 때 `FilesystemMiddleware`가 이를 버리던 버그를 수정했다. 이제 `Command(goto=..., graph=..., update=...)` 형태로 전파된다.

- 근거: `libs/deepagents/deepagents/middleware/filesystem.py` diff @ `d92aef68`.

**DITTO 함의**: LangGraph 라우팅 명령을 tool에서 반환할 때 상위 그래프로 올바르게 전파되는 것이 보장된다. 기존 분석에서 다루지 않은 동작이었지만, DITTO가 graph routing을 tool에서 제어하려 할 때 직접 관련된다.

## 근거 목록

- `README.md:12`, `README.md:24-42`, `README.md:53-64`, `README.md:76-90`, `README.md:109-111`: 저장소의 자기 정의, 기능 목록, 빠른 시작, LangGraph/LangChain과의 관계, 보안 경계.
- `libs/deepagents/README.md:21-39`: 패키지 README의 what-is/features 설명.
- `libs/deepagents/pyproject.toml:2-29`, `libs/deepagents/pyproject.toml:44-61`, `libs/deepagents/pyproject.toml:129-154`: 패키지 메타데이터, 런타임/테스트 의존성, pytest 설정.
- `libs/deepagents/Makefile:18-23`, `libs/deepagents/Makefile:36-38`, `libs/deepagents/Makefile:70-78`: unit/integration/lint 명령.
- `libs/Makefile:24-83`: 모노레포 lock/lint/format/benchmark 명령.
- `AGENTS.md:9-31`, `AGENTS.md:157-181`, `AGENTS.md:251-276`: 저장소 구조, 개발 도구, 테스트/보안/benchmark 정책.
- `libs/deepagents/deepagents/graph.py:63-788`: 상태, 기본 프롬프트, 모델 해석, 필수 미들웨어, 공개 API, 기본 도구, 미들웨어 조립, 프로파일, 권한, subagent 조립, 최종 `create_agent` 호출.
- `libs/deepagents/deepagents/_tools.py:29-65`: 도구 description override가 caller 도구 객체를 mutation하지 않도록 복사하는 로직.
- `libs/deepagents/deepagents/middleware/filesystem.py:73-1906`: 파일 도구 스키마/설명/권한/실행/오프로딩/모델 호출 래핑.
- `libs/deepagents/deepagents/backends/protocol.py:22-829`: backend protocol, 파일 포맷, 표준 오류, write/edit semantics, execute protocol.
- `libs/deepagents/deepagents/backends/state.py:38-327`: StateBackend의 thread-local persistence와 파일 연산.
- `libs/deepagents/deepagents/backends/filesystem.py:44-194`: 로컬 파일시스템 백엔드 보안 경고와 virtual mode.
- `libs/deepagents/deepagents/backends/local_shell.py:1-357`: 로컬 셸 실행 백엔드의 비샌드박스 경고와 subprocess 실행.
- `libs/deepagents/deepagents/backends/sandbox.py:1-744`: SandboxBackendProtocol 구현 보조, 서버측 read/write/edit/glob와 execute 한계.
- `libs/deepagents/deepagents/backends/composite.py:1-320`: prefix routing 기반 composite backend.
- `libs/deepagents/deepagents/middleware/subagents.py:27-760`: 동기 subagent 스펙, task 도구 설명, state handoff, runnable 생성.
- `libs/deepagents/deepagents/middleware/async_subagents.py:1-954`: 원격 비동기 subagent 도구와 task 상태 관리.
- `libs/deepagents/deepagents/_subagent_transformer.py:1-246`: subagent stream handle 변환.
- `libs/deepagents/deepagents/middleware/patch_tool_calls.py:1-44`: dangling tool call 보정.
- `libs/deepagents/deepagents/middleware/summarization.py:1-17`, `libs/deepagents/deepagents/middleware/summarization.py:42-47`, `libs/deepagents/deepagents/middleware/summarization.py:100-107`, `libs/deepagents/deepagents/middleware/summarization.py:1170-1420`: 자동/수동 요약, 오프로딩, compact tool.
- `libs/deepagents/deepagents/middleware/_overflow_clip.py:1-206`: context overflow fallback clipping.
- `libs/deepagents/deepagents/middleware/_message_eviction.py:25-142`: 대형 ToolMessage preview와 파일 오프로딩.
- `libs/deepagents/deepagents/middleware/skills.py:1-15`, `libs/deepagents/deepagents/middleware/skills.py:21-80`, `libs/deepagents/deepagents/middleware/skills.py:139-532`, `libs/deepagents/deepagents/middleware/skills.py:651-1143`: 스킬 메타데이터, 검증, 소스 로딩, prompt injection.
- `libs/deepagents/deepagents/middleware/memory.py:2-12`, `libs/deepagents/deepagents/middleware/memory.py:35-52`, `libs/deepagents/deepagents/middleware/memory.py:104-440`: 메모리 소스 로딩과 시스템 프롬프트.
- `libs/deepagents/deepagents/profiles/harness/harness_profiles.py:1-18`, `libs/deepagents/deepagents/profiles/harness/harness_profiles.py:191-337`, `libs/deepagents/deepagents/profiles/harness/harness_profiles.py:483-796`, `libs/deepagents/deepagents/profiles/harness/harness_profiles.py:935-1316`: harness profile API, config, merge/lookup/exclusion 규칙.
- `libs/deepagents/deepagents/profiles/harness/_openai_codex.py:1-68`, `libs/deepagents/deepagents/profiles/harness/_anthropic_sonnet_4_6.py:1-43`: built-in model-specific harness profiles.
- `libs/deepagents/deepagents/profiles/provider/provider_profiles.py:9-314`, `libs/deepagents/deepagents/profiles/provider/_openai.py:1-24`, `libs/deepagents/deepagents/profiles/provider/_openrouter.py:1-119`, `libs/deepagents/deepagents/profiles/_builtin_profiles.py:1-220`: provider profile와 built-in/plugin bootstrap.
- `libs/deepagents/tests/unit_tests/test_graph.py:59-348`: graph metadata, tool override, profile/subagent 동작 테스트.
- `libs/deepagents/tests/unit_tests/test_file_system_tools.py:18-360`: 파일 도구 상태/편집/오류/검색 테스트.
- `libs/deepagents/tests/unit_tests/test_subagents.py:94-329`: sync/async subagent routing, 결과 반환, 병렬 호출 테스트.
- `libs/deepagents/tests/unit_tests/middleware/test_skills_middleware.py:94-315`: 스킬 이름, metadata, module path validation 테스트.
- `libs/deepagents/tests/unit_tests/test_harness_profiles.py:57-381`: harness profile serde, validation, prompt application 테스트.
- `examples/better-harness/README.md:1-204`: better-harness 목적, 루프, public/private split, config, runner, artifact 설명.
- `examples/better-harness/pyproject.toml:1-31`: better-harness 패키지/CLI/ruff exclude.
- `examples/better-harness/better_harness/core.py:18-75`, `examples/better-harness/better_harness/core.py:251-342`, `examples/better-harness/better_harness/core.py:543-720`, `examples/better-harness/better_harness/core.py:864-1128`: split/surface/run report/config validation/run loop/CLI.
- `examples/better-harness/better_harness/agent.py:21-38`, `examples/better-harness/better_harness/agent.py:51-173`, `examples/better-harness/better_harness/agent.py:176-360`: Better Agent prompt, proposer workspace, candidate loading, Deep Agent invocation, task/failure artifacts.
- `examples/better-harness/better_harness/runners.py:31-225`: pytest runner, variant env, case별 실행, artifacts/trace refs.
- `examples/better-harness/better_harness/patching.py:16-109`: baseline/candidate variant, env patching, workspace override.

## ditto 적용 정리

ditto에는 deepagents를 통째로 복제하기보다, PURPOSE.md의 목적에 직접 닿는 하네스 장치만 선별해 적용한다. 기준은 범용 coding agent harness, 사용자 인지 비용 절감, 할루시네이션 방지, 임의 작업 제한, Context Rot 해결, 장기 작업 완수, 토큰 절약, 감사 기록/핸드오프, 서브 에이전트 활용, 정규화된 오케스트레이션이다. 근거: `PURPOSE.md:4-35`, `PURPOSE.md:37-52`.

| 적용할 기능/가치 | 어떻게 적용할지 | 적용 이후 제공 가치 | 주의할 리스크나 선행 조건 | 근거 |
| --- | --- | --- | --- | --- |
| 단일 하네스 조립 entrypoint와 필수 scaffolding 보호 | ditto도 모델, 도구, 미들웨어, 백엔드, 권한, 메모리, 하위 에이전트를 한 entrypoint에서 조립한다. 파일시스템, 하위 에이전트, 컨텍스트 관리, 감사 기록/핸드오프 계층은 excluded 설정으로 제거할 수 없는 필수 scaffolding으로 둔다. | 단계별 진입/출력 계약을 고정해 오케스트레이션을 추적 가능하게 만들고, 사용자가 하네스 내부 조립 순서를 매번 판단하지 않아도 된다. 사용자의 의도에서 벗어난 임의 작업도 필수 경계 계층을 통해 제한된다. | entrypoint가 넓어지면 얕은 추상화가 될 수 있다. PURPOSE.md의 Deep Module 방향에 맞게 외부 interface는 좁게 두고, 미들웨어 순서와 제외 불가 규칙을 테스트로 고정해야 한다. | PURPOSE.md는 정규화된 interface 기반 오케스트레이션과 Deep Module 사고를 요구한다. deepagents는 `create_deep_agent(...)`에서 주요 계층을 조립하고 필수 `FilesystemMiddleware`/`SubAgentMiddleware`를 제외 불가로 다룬다. 근거: `PURPOSE.md:29-35`, `libs/deepagents/deepagents/graph.py:187-202`, `libs/deepagents/deepagents/graph.py:217-236`, `libs/deepagents/deepagents/graph.py:308-345`, `libs/deepagents/deepagents/graph.py:731-747`. |
| 구조화된 파일 도구와 권한 경계 | ditto의 코드베이스 작업 도구는 `ls`, line-numbered `read_file`, exact replacement `edit_file`, 새 파일용 `write_file`, timeout/truncation이 있는 `glob`, literal `grep`를 기본으로 한다. `execute`는 실행 가능한 sandbox backend가 명시될 때만 노출하고, 권한은 tool-level뿐 아니라 backend-level에서도 강제한다. | 경로 추측, 과대 검색, 전체 파일 overwrite, 셸 남용을 줄여 할루시네이션과 사용자 의도 이탈을 구조적으로 낮춘다. 각 액션을 감사 기록으로 남기기도 쉬워진다. | deepagents의 권한은 tool-level이라 backend 직접 접근에는 적용되지 않는다. `LocalShellBackend`는 비샌드박스 경고가 있으므로 ditto의 기본 실행 경로로 두면 안 된다. | PURPOSE.md는 확실한 근거 없는 추론 금지, 임의 작업 제한, 모든 액션 감사 기록을 요구한다. deepagents 파일 도구 설명은 읽기 전 `ls`, 편집 전 `read_file`, exact edit, literal grep, structured search 우선을 명시하고, 권한 한계와 로컬 셸 위험도 드러낸다. 근거: `PURPOSE.md:7-8`, `PURPOSE.md:15-16`, `PURPOSE.md:18-27`, `libs/deepagents/deepagents/middleware/filesystem.py:336-445`, `libs/deepagents/deepagents/middleware/filesystem.py:842-1405`, `libs/deepagents/deepagents/graph.py:397-410`, `libs/deepagents/deepagents/backends/local_shell.py:1-6`. |
| 컨텍스트 오프로딩과 memory/skill 분리 | 메시지는 DeltaChannel 같은 누적 비용 완화 구조를 쓰고, 오래된 원문 히스토리와 큰 도구 결과는 backend 파일로 오프로딩한 뒤 요약에는 재접근 경로와 preview를 남긴다. 프로젝트 지식과 결정은 항상 로드되는 memory로, 절차 지식은 metadata만 먼저 보이는 skill로 분리한다. | 장기 세션에서도 원문 근거로 되돌아갈 수 있어 Context Rot과 자기 확신 문제를 줄인다. 항상 필요한 지식과 필요할 때만 펼칠 지식을 나눠 토큰 비용도 낮춘다. | 기본 `StateBackend`식 thread-local 저장만으로는 새 세션/다른 기기 이어서 작업을 충족하지 못한다. ditto에는 세션을 넘는 persistent backend와 오프로딩 파일의 수명/삭제 정책이 선행되어야 한다. | PURPOSE.md는 Context Rot 해결, 장기 작업 완수, 토큰 절약, 세션 핸드오프, 주요 결정 영속화를 요구한다. deepagents는 DeltaChannel, 요약 전 원문 히스토리 파일 저장, 큰 도구 결과 오프로딩, skill progressive disclosure, 항상 로드되는 memory를 제공한다. 근거: `PURPOSE.md:10-17`, `PURPOSE.md:37-41`, `PURPOSE.md:51-52`, `libs/deepagents/deepagents/graph.py:63-67`, `libs/deepagents/deepagents/middleware/summarization.py:42-47`, `libs/deepagents/deepagents/middleware/summarization.py:474-505`, `libs/deepagents/deepagents/middleware/summarization.py:1170-1201`, `libs/deepagents/deepagents/middleware/_message_eviction.py:25-142`, `libs/deepagents/deepagents/middleware/skills.py:783-823`, `libs/deepagents/deepagents/middleware/memory.py:2-12`. |
| stateless subagent와 비동기 장기 작업 핸들 | 복잡하고 독립적인 조사/검증은 stateless subagent에 맡기고, 부모 state의 `messages`, `todos`, memory류 키는 기본 제외한다. 결과는 단일 요약과 근거로 반환하게 하고, 긴 작업은 task id 기반 async handle로 관리하되 자동 polling은 하지 않는다. | 부모 컨텍스트를 불필요하게 키우지 않고 병렬 조사와 적대적 검토를 수행할 수 있다. 장기 작업도 상태 핸들을 통해 이어받을 수 있어 처음 의도한 목표를 유지하기 쉽다. | subagent가 감사 기록 없이 독립 실행되면 원인 추적이 어려워진다. ditto는 subagent별 입력, 제외된 state, 출력, task id, 취소/갱신 이벤트를 세션 감사 기록에 연결해야 한다. | PURPOSE.md는 Context Rot 해결을 위한 서브 에이전트 적극 사용, 장기 작업 완수, 멀티 모델 정반합 기반 검토를 요구한다. deepagents의 `task`는 separate context, stateless, single result, 병렬화를 전제로 하고 부모 state 누수를 제한하며, async subagent는 task id와 명시적 check/update/cancel 도구를 둔다. 근거: `PURPOSE.md:11`, `PURPOSE.md:17`, `PURPOSE.md:29-33`, `libs/deepagents/deepagents/middleware/subagents.py:228-257`, `libs/deepagents/deepagents/middleware/subagents.py:273-413`, `libs/deepagents/deepagents/_subagent_transformer.py:136-246`, `libs/deepagents/deepagents/middleware/async_subagents.py:164-215`, `libs/deepagents/deepagents/middleware/async_subagents.py:277-684`. |
| 평가 기반 하네스 개선 루프 | ditto 하네스 자체의 prompt/profile/tool 변경은 better-harness처럼 editable surface, train/holdout split, proposer workspace, proposal artifact, scorecard, strict acceptance decision을 가진 별도 실험 루프로 다룬다. 사용자 시나리오/E2E journey와 멀티 모델 검토 결과를 scorecard에 넣는다. | 하네스 변경을 "느낌상 개선"이 아니라 fresh evidence 위에서 수락할 수 있다. 모델의 자기 확신을 깨고, 회귀를 드러내며, 사용자에게는 핵심 결과와 근거만 제공해 인지 비용을 줄인다. | better-harness의 visible/private split은 hard sandbox boundary가 아니며, 단순 pass count strict improvement만으로 품질/회귀 severity를 모두 설명하지 못한다. ditto는 평가 데이터 격리, 비결정성 대응, E2E 실패 재현 산출물 저장이 선행되어야 한다. | PURPOSE.md는 할루시네이션 방지, 자기 확신 교정, 자동 회고와 행동 교정, 멀티 모델 적대적 검토, E2E 테스트 도구를 요구한다. deepagents의 better-harness는 train/holdout/scorecard, proposer workspace, strict acceptance, run artifacts를 구현하지만 private split 한계도 문서화한다. 근거: `PURPOSE.md:7`, `PURPOSE.md:9`, `PURPOSE.md:29-34`, `examples/better-harness/README.md:16-31`, `examples/better-harness/README.md:108-119`, `examples/better-harness/better_harness/core.py:864-1002`, `examples/better-harness/better_harness/core.py:935-948`, `examples/better-harness/better_harness/agent.py:51-105`. |

## ditto 적용 요소 후보 (skills/agents/commands/hooks)

| 우선순위 | 종류 | 요소 | DITTO 적용안 | 효과/주의 |
| --- | --- | --- | --- | --- |
| 바로 적용 | tool | `write_todos` | 장기 작업 목표를 세션 내부 todo가 아니라 감사 가능한 task record와 연결한다. 작은 작업은 생략하고, 다단계 작업에서만 자동 생성한다. | "끝까지 완수"와 handoff 품질에 바로 기여한다. todo가 계획을 대체하지 않도록 acceptance criteria와 연결해야 한다. |
| 바로 적용 | tool | `ls`/`read_file`/`edit_file`/`glob`/`grep` | 파일 작업 도구의 계약을 DITTO tool layer 기준으로 삼는다. 편집 전 read, line-numbered read, exact replacement, literal grep, timeout/truncation을 기본값으로 둔다. | 할루시네이션과 overwrite 위험을 줄인다. 기존 Codex shell/apply_patch 표면을 감싸는 wrapper로 시작할 수 있다. |
| 바로 적용 | agent/tool | stateless `task` subagent | 조사, 리뷰, 검증처럼 독립 가능한 작업을 부모 context와 분리해 실행한다. 입력에는 목표, 허용 파일, 금지 작업, 출력 형식을 넣고 결과는 요약+근거만 반환한다. | Context Rot 완화 효과가 크다. subagent 입력/출력은 세션 감사 기록에 반드시 연결해야 한다. |
| 수정 적용 | agent/tool | async task start/check/update/cancel/list | 장시간 실행되는 외부 worker나 원격 model 작업에 task id 기반 handle을 둔다. 자동 polling은 하지 않고 명시 check/update/cancel만 허용한다. | 장기 작업 재개성이 좋아진다. 상태 backend와 lock/crash recovery가 없으면 먼저 구현하면 안 된다. |
| 수정 적용 | hook/middleware | `compact_conversation`과 large tool result offload | 대형 출력은 원문 파일로 저장하고 대화에는 preview, path, hash, 재조회 방법만 남긴다. 수동 compact 도구는 "요약 요청"이 아니라 "근거 보존형 압축"으로 정의한다. | token 비용과 context rot을 줄인다. 파일 수명, 민감정보 마스킹, 삭제 정책이 필요하다. |
| 수정 적용 | skill/memory | progressive disclosure skill과 always-loaded memory | skill은 metadata만 먼저 보여주고 필요할 때 `SKILL.md`를 읽는다. 프로젝트 결정/용어는 memory로 분리해 항상 접근 가능하게 한다. | skill catalog가 커져도 token 비용을 제어할 수 있다. memory는 오래된 결정을 강화할 수 있으므로 freshness와 충돌 검증이 필요하다. |
| 수정 적용 | command/eval | better-harness `validate`/`inventory`/`split`/run loop | DITTO prompt, tool contract, agent profile 변경을 train/holdout 평가와 scorecard로 승인한다. E2E journey 실패 재현 artifact를 scorecard에 포함한다. | 하네스 개선을 감이 아니라 증거로 판단한다. 평가 데이터 격리와 비결정성 대응이 선행되어야 한다. |
