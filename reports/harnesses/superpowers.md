# superpowers 하네스 분석 보고서

## 분석 대상 및 기준 커밋

- 담당 저장소: `https://github.com/obra/superpowers`
- 로컬 분석 경로: `/private/tmp/ditto-harness-analysis/superpowers`
- 기준 커밋: `f2cbfbefebbfef77321e4c9abc9e949826bea9d7` (`Release v5.1.0 (#1468)`, 2026-05-04)
- 패키지/플러그인 버전: `5.1.0`. 루트 `package.json`은 `name=superpowers`, `version=5.1.0`, `type=module`, OpenCode 엔트리포인트 `.opencode/plugins/superpowers.js`를 선언한다. [f2cbfbe, `package.json:1-5`]
- 이 보고서의 모든 `path:line` 근거는 위 기준 커밋 `f2cbfbefebbfef77321e4c9abc9e949826bea9d7` 기준이다.

## 조사 방법

- `gh repo clone obra/superpowers /private/tmp/ditto-harness-analysis/superpowers`로 지정 경로에 클론하고 `git rev-parse HEAD`로 기준 커밋을 확인했다.
- `README.md`, `CLAUDE.md`, 플러그인 메타데이터, 훅, OpenCode 플러그인 소스, 스킬 본문, 프롬프트 템플릿, 브레인스토밍 서버 소스, 스크립트, 테스트, 설계 문서, 릴리스 노트를 정적 분석했다.
- 자동 테스트는 실행하지 않았다. 이유는 이 작업의 목적이 참고 하네스 분석 보고서 작성이고, 주요 통합 테스트가 Claude Code/OpenCode 등 외부 하네스 설치와 긴 실행 시간을 요구하기 때문이다. 예: `docs/testing.md`는 실제 Claude Code 세션 기반 통합 테스트가 10-30분 걸릴 수 있다고 설명한다. [f2cbfbe, `docs/testing.md:20-39`]

## 핵심 특징

1. **제품 정체성은 "앱"보다 에이전트 작업 방법론/스킬 라이브러리다.** README는 Superpowers를 "coding agents"를 위한 완전한 소프트웨어 개발 방법론이며, 합성 가능한 스킬과 초기 지시 위에 구축된다고 설명한다. [f2cbfbe, `README.md:1-4`]

2. **하네스별 설치를 전제로 한다.** README는 Claude Code, Codex CLI/App, Factory Droid, Gemini CLI, OpenCode, Cursor, GitHub Copilot CLI 설치 경로를 별도로 안내하고, "harness마다 별도 설치"가 필요하다고 말한다. [f2cbfbe, `README.md:31-33`, `README.md:35-152`]

3. **워크플로우는 설계-계획-실행-검증 게이트로 이어진다.** 기본 워크플로우는 `brainstorming`으로 요구를 정제하고, `using-git-worktrees`로 격리 작업공간을 만들거나 확인하고, `writing-plans`로 구현 계획을 만들며, `subagent-driven-development` 또는 `executing-plans`로 실행하고, TDD/코드리뷰/마무리 스킬을 통과한다. [f2cbfbe, `README.md:154-170`]

4. **부트스트랩 스킬 사용을 강제한다.** `using-superpowers`는 "1%라도 스킬이 적용될 가능성이 있으면 반드시 invoke"해야 한다고 하고, 응답/행동/질문 전에 관련 스킬을 invoke하라고 지시한다. [f2cbfbe, `skills/using-superpowers/SKILL.md:10-16`, `skills/using-superpowers/SKILL.md:44-47`]

5. **기본 원칙은 TDD, 체계적 디버깅, 복잡도 축소, 증거 우선이다.** README의 철학 섹션은 "Test-Driven Development", "Systematic over ad-hoc", "Complexity reduction", "Evidence over claims"를 명시한다. [f2cbfbe, `README.md:198-204`]

6. **하네스 통합의 실제 기준은 "부트스트랩이 세션 시작 시 로드되어 자동 트리거가 일어나는가"다.** `CLAUDE.md`와 PR 템플릿 모두 새 하네스 통합은 `using-superpowers` 부트스트랩을 세션 시작에 로드해야 하며, "Let's make a react todo list" 입력에서 `brainstorming`이 자동 트리거되어야 한다고 규정한다. [f2cbfbe, `CLAUDE.md:67-87`, `.github/PULL_REQUEST_TEMPLATE.md:53-80`]

## 구조/아키텍처

### 최상위 구조

- `skills/`: 14개 핵심 스킬. `find skills -name SKILL.md` 기준으로 `brainstorming`, `using-superpowers`, `writing-plans`, `subagent-driven-development`, `executing-plans`, `test-driven-development`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`, `receiving-code-review`, `dispatching-parallel-agents`, `using-git-worktrees`, `finishing-a-development-branch`, `writing-skills`가 있다. [f2cbfbe, `skills/using-superpowers/SKILL.md:1-4`, `skills/brainstorming/SKILL.md:1-4`, `skills/subagent-driven-development/SKILL.md:1-4`]
- `.claude-plugin/`, `.codex-plugin/`, `.cursor-plugin/`, `gemini-extension.json`, `.opencode/`: 각 하네스의 패키징/로딩 메타데이터. [f2cbfbe, `.claude-plugin/plugin.json:1-20`, `.codex-plugin/plugin.json:1-47`, `.cursor-plugin/plugin.json:1-25`, `gemini-extension.json:1-6`, `.opencode/plugins/superpowers.js:1-6`]
- `hooks/`: Claude/Cursor/Copilot류 세션 시작 컨텍스트 삽입 훅과 Windows 호환 래퍼. [f2cbfbe, `hooks/hooks.json:1-16`, `hooks/hooks-cursor.json:1-10`, `hooks/run-hook.cmd:1-46`, `hooks/session-start:37-55`]
- `docs/`: 설계/계획 기록과 하네스 문서. 예: OpenCode 문서, Codex App 호환성, worktree 재설계, zero-dependency 브레인스토밍 서버. [f2cbfbe, `docs/README.opencode.md:98-113`, `docs/superpowers/specs/2026-03-23-codex-app-compatibility-design.md:1-12`, `docs/superpowers/specs/2026-04-06-worktree-rototill-design.md:37-50`]
- `tests/`: Claude Code, OpenCode, 명시적 스킬 요청, 스킬 트리거링, 브레인스토밍 서버, Codex 플러그인 동기화 테스트. [f2cbfbe, `docs/testing.md:9-18`, `tests/opencode/run-tests.sh:60-75`, `tests/brainstorm-server/server.test.js:1-9`]

### 런타임 흐름

1. **세션 시작 부트스트랩**
   - Claude/Cursor/Copilot 계열은 `hooks/session-start`가 `skills/using-superpowers/SKILL.md`를 읽어 `<EXTREMELY_IMPORTANT>` 컨텍스트로 감싸고, 플랫폼별 JSON 필드로 출력한다. [f2cbfbe, `hooks/session-start:17-35`, `hooks/session-start:37-55`]
   - OpenCode는 `.opencode/plugins/superpowers.js`에서 `using-superpowers` 본문을 읽어 첫 사용자 메시지 앞에 삽입하고, `config` 훅으로 `skills` 경로를 등록한다. [f2cbfbe, `.opencode/plugins/superpowers.js:55-83`, `.opencode/plugins/superpowers.js:98-133`]
   - Gemini CLI는 `GEMINI.md`에서 `using-superpowers`와 Gemini tool mapping을 참조한다. [f2cbfbe, `GEMINI.md:1-2`, `gemini-extension.json:1-6`]

2. **스킬 발견/호출**
   - Codex/Copilot/Gemini/OpenCode 등은 각자 도구명을 매핑한다. 예: Codex `Task`는 `spawn_agent`, `TodoWrite`는 `update_plan`, `Skill`은 "native load"로 매핑된다. [f2cbfbe, `skills/using-superpowers/references/codex-tools.md:1-15`]
   - OpenCode는 자체 `skill` 도구를 사용해 `superpowers/brainstorming` 같은 스킬을 로드한다고 문서화한다. [f2cbfbe, `docs/README.opencode.md:40-54`, `docs/README.opencode.md:105-113`]

3. **개발 워크플로우**
   - `brainstorming`은 구현 전 디자인 승인 게이트를 둔다. 코드 작성/스캐폴딩/구현 스킬 호출을 금지하고, 디자인 승인 뒤 스펙을 저장하고 사용자 검토를 기다린다. [f2cbfbe, `skills/brainstorming/SKILL.md:12-14`, `skills/brainstorming/SKILL.md:20-33`, `skills/brainstorming/SKILL.md:107-136`]
   - `writing-plans`는 정확한 파일 경로, 완전한 코드, 검증 명령, 잦은 커밋을 포함한 작은 단계 계획을 요구한다. [f2cbfbe, `skills/writing-plans/SKILL.md:8-20`, `skills/writing-plans/SKILL.md:36-44`, `skills/writing-plans/SKILL.md:63-120`]
   - `subagent-driven-development`는 태스크마다 새 구현 서브에이전트를 보내고, 스펙 준수 리뷰 뒤 코드 품질 리뷰를 진행한다. [f2cbfbe, `skills/subagent-driven-development/SKILL.md:6-14`, `skills/subagent-driven-development/SKILL.md:42-87`]
   - `finishing-a-development-branch`는 테스트 검증, 환경 감지, 병합/PR/유지/폐기 선택지, worktree 정리를 순서화한다. [f2cbfbe, `skills/finishing-a-development-branch/SKILL.md:16-39`, `skills/finishing-a-development-branch/SKILL.md:40-56`, `skills/finishing-a-development-branch/SKILL.md:66-94`]

### 브레인스토밍 시각 보조 도구

- `skills/brainstorming/scripts/server.cjs`는 Node 내장 `http`, `crypto`, `fs`, `path`로 HTTP/WebSocket 서버를 직접 구현한다. [f2cbfbe, `skills/brainstorming/scripts/server.cjs:1-5`, `skills/brainstorming/scripts/server.cjs:6-72`]
- 서버는 `content/`의 최신 HTML을 제공하고, `state/events`에 선택 이벤트를 JSONL로 기록한다. [f2cbfbe, `skills/brainstorming/scripts/server.cjs:127-161`, `skills/brainstorming/scripts/server.cjs:224-238`, `skills/brainstorming/scripts/server.cjs:287-296`]
- 시각 보조 도구는 브라우저를 "interactive display", 터미널을 "conversation channel"로 분리하는 비차단 모델이다. 이 설계는 Claude Code가 한 턴에서 두 입력 채널을 동시에 listen할 수 없다는 제약에서 나온다. [f2cbfbe, `docs/superpowers/specs/2026-02-19-visual-brainstorming-refactor-design.md:7-12`, `docs/superpowers/specs/2026-02-19-visual-brainstorming-refactor-design.md:15-31`]

## 도구/명령/스크립트/프롬프트 인벤토리

### 하네스 패키징/부트스트랩

| 항목 | 역할 | 근거 |
|---|---|---|
| `.claude-plugin/plugin.json` | Claude Code 플러그인 메타데이터. TDD/디버깅/협업 패턴 설명과 MIT 라이선스 선언. | [f2cbfbe, `.claude-plugin/plugin.json:1-20`] |
| `.claude-plugin/marketplace.json` | 개발 marketplace용 플러그인 목록과 버전. | [f2cbfbe, `.claude-plugin/marketplace.json:1-20`] |
| `.codex-plugin/plugin.json` | Codex 플러그인 메타데이터, `skills: ./skills/`, UI 설명, defaultPrompt, 아이콘/로고. | [f2cbfbe, `.codex-plugin/plugin.json:1-47`] |
| `.cursor-plugin/plugin.json` | Cursor 플러그인 메타데이터, skills/agents/commands/hooks 경로. 현재 repo에는 `agents/`와 `commands/` 디렉터리가 없으므로 이 두 필드는 잔존 메타데이터일 가능성이 있다. 엄밀한 추론: release notes가 named agent와 legacy slash commands 제거를 말하기 때문에 잔존 포인터일 가능성이 높다. [f2cbfbe, `.cursor-plugin/plugin.json:21-25`, `RELEASE-NOTES.md:5-10`] |
| `gemini-extension.json` + `GEMINI.md` | Gemini 확장 메타데이터와 시작 컨텍스트 파일. `GEMINI.md`는 `using-superpowers`와 Gemini tool mapping을 로드한다. | [f2cbfbe, `gemini-extension.json:1-6`, `GEMINI.md:1-2`] |
| `.opencode/plugins/superpowers.js` | OpenCode 플러그인. bootstrap 메시지 삽입, skills path 등록, bootstrap 캐싱 담당. | [f2cbfbe, `.opencode/plugins/superpowers.js:49-64`, `.opencode/plugins/superpowers.js:98-133`] |
| `hooks/session-start` | Claude/Cursor/Copilot 계열 SessionStart 컨텍스트 주입. 플랫폼별 JSON 필드를 분기한다. | [f2cbfbe, `hooks/session-start:37-55`] |
| `hooks/run-hook.cmd` | Windows/Unix polyglot hook wrapper. Windows에서 Git Bash를 찾고, Unix에서는 extensionless hook을 bash로 exec한다. | [f2cbfbe, `hooks/run-hook.cmd:1-46`] |

### 핵심 스킬

| 스킬 | 트리거/역할 | 근거 |
|---|---|---|
| `using-superpowers` | 모든 대화 시작 시 스킬 사용 규칙을 세움. | [f2cbfbe, `skills/using-superpowers/SKILL.md:1-4`, `skills/using-superpowers/SKILL.md:10-16`] |
| `brainstorming` | 창의적/기능/동작 변경 작업 전 요구와 설계를 정제. | [f2cbfbe, `skills/brainstorming/SKILL.md:1-14`] |
| `using-git-worktrees` | 구현 시작 전 격리 작업공간을 확인/생성. native tool 우선, git worktree fallback. | [f2cbfbe, `skills/using-git-worktrees/SKILL.md:1-14`, `skills/using-git-worktrees/SKILL.md:16-61`] |
| `writing-plans` | 스펙/요구가 있는 다단계 작업 전에 구현 계획 작성. | [f2cbfbe, `skills/writing-plans/SKILL.md:1-20`] |
| `subagent-driven-development` | 독립 태스크 계획 실행 시 fresh subagent + 2단계 리뷰. | [f2cbfbe, `skills/subagent-driven-development/SKILL.md:1-14`] |
| `executing-plans` | 서브에이전트가 없거나 별도 세션에서 계획을 순차 실행. | [f2cbfbe, `skills/executing-plans/SKILL.md:1-15`] |
| `test-driven-development` | 기능/버그/리팩터링 전 TDD를 강제. | [f2cbfbe, `skills/test-driven-development/SKILL.md:1-15`, `skills/test-driven-development/SKILL.md:31-45`] |
| `systematic-debugging` | 버그/테스트 실패/예상 밖 동작 전에 근본 원인 조사. | [f2cbfbe, `skills/systematic-debugging/SKILL.md:1-23`, `skills/systematic-debugging/SKILL.md:46-121`] |
| `verification-before-completion` | 완료/통과/수정 주장 전 신선한 검증 증거 요구. | [f2cbfbe, `skills/verification-before-completion/SKILL.md:1-23`, `skills/verification-before-completion/SKILL.md:24-38`] |
| `requesting-code-review` | 태스크 완료/주요 기능/머지 전 코드 리뷰 서브에이전트 dispatch. | [f2cbfbe, `skills/requesting-code-review/SKILL.md:1-18`, `skills/requesting-code-review/SKILL.md:24-47`] |
| `receiving-code-review` | 리뷰 피드백 수신 후 맹목 수용 대신 검증/평가. | [f2cbfbe, `skills/receiving-code-review/SKILL.md:1-25`] |
| `dispatching-parallel-agents` | 독립 문제 2개 이상에서 병렬 에이전트 dispatch. | [f2cbfbe, `skills/dispatching-parallel-agents/SKILL.md:1-15`, `skills/dispatching-parallel-agents/SKILL.md:36-46`] |
| `finishing-a-development-branch` | 구현 완료 후 테스트 확인, merge/PR/keep/discard 선택, cleanup. | [f2cbfbe, `skills/finishing-a-development-branch/SKILL.md:1-15`, `skills/finishing-a-development-branch/SKILL.md:66-94`] |
| `writing-skills` | 새 스킬/스킬 수정/배포 전 검증. 문서 작성에도 TDD 적용. | [f2cbfbe, `skills/writing-skills/SKILL.md:1-20`, `skills/writing-skills/SKILL.md:30-45`] |

### 프롬프트 템플릿과 보조 문서

- `skills/subagent-driven-development/implementer-prompt.md`: 구현 서브에이전트에게 전체 태스크 본문, 컨텍스트, 질문/에스컬레이션 규칙, self-review와 보고 형식을 제공한다. [f2cbfbe, `skills/subagent-driven-development/implementer-prompt.md:11-43`, `skills/subagent-driven-development/implementer-prompt.md:74-112`]
- `skills/subagent-driven-development/spec-reviewer-prompt.md`: 구현자 보고를 믿지 말고 실제 코드를 읽어 요구사항과 비교하라고 지시한다. [f2cbfbe, `skills/subagent-driven-development/spec-reviewer-prompt.md:21-36`, `skills/subagent-driven-development/spec-reviewer-prompt.md:56-61`]
- `skills/subagent-driven-development/code-quality-reviewer-prompt.md`: 스펙 준수 리뷰 통과 뒤에만 코드 품질 리뷰를 dispatch하라고 명시한다. [f2cbfbe, `skills/subagent-driven-development/code-quality-reviewer-prompt.md:5-17`]
- `skills/requesting-code-review/code-reviewer.md`: diff 범위, 요구사항, 품질/아키텍처/테스트/production readiness 기준, severity별 출력 형식. [f2cbfbe, `skills/requesting-code-review/code-reviewer.md:23-64`, `skills/requesting-code-review/code-reviewer.md:76-130`]
- `skills/brainstorming/visual-companion.md`: 브라우저 시각 보조 도구 사용 시점, 서버 시작, HTML fragment 작성, 이벤트 읽기, cleanup 가이드. [f2cbfbe, `skills/brainstorming/visual-companion.md:5-31`, `skills/brainstorming/visual-companion.md:33-49`, `skills/brainstorming/visual-companion.md:94-127`]
- `skills/writing-plans/plan-document-reviewer-prompt.md`와 `skills/brainstorming/spec-document-reviewer-prompt.md`: 문서 리뷰용 prompt template이 남아 있다. 현재 `brainstorming`/`writing-plans` 본문은 inline self-review를 사용하므로, 이 파일들은 역사적/보조 템플릿으로 보는 것이 안전하다. 엄밀한 추론: 현행 스킬은 spec/plan subagent review loop 대신 inline self-review를 지시하고, release notes도 같은 변경을 설명한다. [f2cbfbe, `skills/brainstorming/SKILL.md:116-124`, `skills/writing-plans/SKILL.md:122-132`, `RELEASE-NOTES.md:100-109`]
- `skills/using-superpowers/references/*-tools.md`: Codex/Gemini/Copilot 도구 매핑. [f2cbfbe, `skills/using-superpowers/references/codex-tools.md:1-15`, `skills/using-superpowers/references/gemini-tools.md:1-18`, `skills/using-superpowers/references/copilot-tools.md:1-20`]
- `skills/systematic-debugging/root-cause-tracing.md`, `defense-in-depth.md`, `condition-based-waiting.md`, `find-polluter.sh`: 디버깅 보조 기법과 테스트 오염 탐색 스크립트. [f2cbfbe, `skills/systematic-debugging/SKILL.md:278-289`, `skills/systematic-debugging/find-polluter.sh:1-15`]
- `skills/writing-skills/render-graphs.js`: `SKILL.md`의 DOT 블록을 Graphviz SVG로 렌더링한다. Graphviz `dot` 외부 의존성이 필요하다. [f2cbfbe, `skills/writing-skills/render-graphs.js:1-14`, `skills/writing-skills/render-graphs.js:84-118`]

### 실행 스크립트/서버

- `skills/brainstorming/scripts/start-server.sh`: random high port, project-local `.superpowers/brainstorm/<session>/content|state` 디렉터리, Codex/Windows foreground fallback, owner PID 전달, startup JSON 대기. [f2cbfbe, `skills/brainstorming/scripts/start-server.sh:1-16`, `skills/brainstorming/scripts/start-server.sh:62-84`, `skills/brainstorming/scripts/start-server.sh:102-147`]
- `skills/brainstorming/scripts/server.cjs`: zero-dependency HTTP/WebSocket 서버, 최신 HTML 제공, `/files/` 정적 파일, 이벤트 기록, reload broadcast, idle/owner lifecycle shutdown. [f2cbfbe, `skills/brainstorming/scripts/server.cjs:74-103`, `skills/brainstorming/scripts/server.cjs:127-161`, `skills/brainstorming/scripts/server.cjs:247-323`, `skills/brainstorming/scripts/server.cjs:339-347`]
- `skills/brainstorming/scripts/helper.js`: 브라우저 WebSocket 연결, reload 처리, 선택 이벤트 전송, 선택 UI 상태 관리. [f2cbfbe, `skills/brainstorming/scripts/helper.js:1-33`, `skills/brainstorming/scripts/helper.js:35-87`]
- `skills/brainstorming/scripts/stop-server.sh`: PID 기반 graceful stop, SIGKILL fallback, `/tmp` 세션만 삭제. [f2cbfbe, `skills/brainstorming/scripts/stop-server.sh:1-8`, `skills/brainstorming/scripts/stop-server.sh:19-55`]
- `scripts/sync-to-codex-plugin.sh`: `prime-radiant-inc/openai-codex-plugins`로 Codex marketplace 플러그인 sync PR 생성. rsync exclude, Codex manifest/asset 포함, destination-owned OpenAI metadata 보존. [f2cbfbe, `scripts/sync-to-codex-plugin.sh:1-28`, `scripts/sync-to-codex-plugin.sh:35-77`, `scripts/sync-to-codex-plugin.sh:321-347`, `scripts/sync-to-codex-plugin.sh:416-462`]
- `scripts/bump-version.sh`: `.version-bump.json` 선언 파일들의 JSON version drift 점검/갱신/audit. [f2cbfbe, `scripts/bump-version.sh:1-20`, `scripts/bump-version.sh:56-92`, `scripts/bump-version.sh:166-194`, `.version-bump.json:1-20`]

### 테스트

- Claude Code 테스트는 실제 `claude -p` 세션과 JSONL transcript를 사용한다. [f2cbfbe, `docs/testing.md:20-39`, `docs/testing.md:53-65`]
- OpenCode 테스트는 isolated HOME/config를 만들고 plugin symlink, skills dir, bootstrap caching, native skill tool, priority behavior를 검증한다. [f2cbfbe, `tests/opencode/setup.sh:9-37`, `tests/opencode/test-bootstrap-caching.sh:1-31`, `tests/opencode/test-tools.sh:69-94`, `tests/opencode/test-priority.sh:149-170`]
- 브레인스토밍 서버 테스트는 test-only `ws` dependency로 HTTP/WebSocket/file watching을 검증한다. [f2cbfbe, `tests/brainstorm-server/package.json:1-9`, `tests/brainstorm-server/server.test.js:1-9`, `tests/brainstorm-server/ws-protocol.test.js:1-12`]
- Codex sync 테스트는 fixture repos/fake gh를 만들어 dry-run/apply/no-op/dirty/missing manifest 동작을 검증한다. [f2cbfbe, `tests/codex-plugin-sync/test-sync-to-codex-plugin.sh:422-613`]

## 각 도구가 왜 그렇게 작성되어야 했는지에 대한 근거 또는 엄밀한 추론

### 부트스트랩은 세션 시작 컨텍스트로 들어가야 한다

- 근거: 새 하네스 통합 규칙은 "real integration"이 세션 시작에 `using-superpowers` bootstrap을 로드해야 하며, 없으면 스킬은 디스크에 있어도 호출되지 않는 "dead weight"라고 말한다. [f2cbfbe, `CLAUDE.md:67-87`, `.github/PULL_REQUEST_TEMPLATE.md:53-80`]
- Claude/Cursor/Copilot 훅이 `using-superpowers` 전체 본문을 감싸서 추가 컨텍스트로 반환하는 이유도 이 기준 때문이다. [f2cbfbe, `hooks/session-start:17-35`, `hooks/session-start:37-55`]
- OpenCode가 `experimental.chat.messages.transform`에서 첫 user message에 bootstrap을 prepend하는 것도 같은 목적이다. [f2cbfbe, `.opencode/plugins/superpowers.js:85-93`, `.opencode/plugins/superpowers.js:111-133`]

### OpenCode bootstrap은 system message가 아니라 user message로 들어간다

- 근거: OpenCode 플러그인 주석은 user message 사용 이유를 system message token bloat와 Qwen 등 모델의 multiple system message 문제 회피라고 적고 있다. [f2cbfbe, `.opencode/plugins/superpowers.js:111-119`]
- release notes도 같은 변경을 설명한다. [f2cbfbe, `RELEASE-NOTES.md:95-99`]
- bootstrap content 캐시는 OpenCode hook이 매 agent step마다 실행되기 때문에 필요하다. 플러그인 주석과 테스트가 `existsSync/readFileSync` 반복을 줄이려는 목적을 직접 설명한다. [f2cbfbe, `.opencode/plugins/superpowers.js:49-64`, `tests/opencode/test-bootstrap-caching.mjs:31-51`, `tests/opencode/test-bootstrap-caching.mjs:86-123`]

### worktree 로직은 플랫폼 감지가 아니라 Git 상태 감지를 택한다

- 근거: worktree rototill 설계 문서는 "Detect state, not platform"을 원칙으로 두고 `GIT_DIR != GIT_COMMON`을 stable git primitive로 사용한다고 말한다. [f2cbfbe, `docs/superpowers/specs/2026-04-06-worktree-rototill-design.md:37-50`]
- 현재 `using-git-worktrees`도 Step 0에서 `git rev-parse --git-dir`, `--git-common-dir`, branch를 읽고 이미 linked worktree이면 생성하지 않는다. [f2cbfbe, `skills/using-git-worktrees/SKILL.md:16-45`]
- `finishing-a-development-branch`는 worktree 상태에 따라 메뉴와 cleanup을 바꾸고, harness가 만든 worktree는 제거하지 않는다. [f2cbfbe, `skills/finishing-a-development-branch/SKILL.md:40-56`, `skills/finishing-a-development-branch/SKILL.md:171-192`]

### 서브에이전트는 fresh context와 명시적 prompt template을 받는다

- 근거: `subagent-driven-development`는 subagent가 세션 history를 상속해서는 안 되며 controller가 필요한 context만 구성해야 한다고 말한다. [f2cbfbe, `skills/subagent-driven-development/SKILL.md:8-14`]
- implementer prompt는 "FULL TEXT of task from plan - paste it here, don't make subagent read file"을 요구한다. [f2cbfbe, `skills/subagent-driven-development/implementer-prompt.md:11-18`]
- red flags도 "Make subagent read plan file"을 금지한다. [f2cbfbe, `skills/subagent-driven-development/SKILL.md:236-245`]
- 엄밀한 추론: 이 설계는 subagent의 context window 오염, plan 파일 재해석, 숨은 세션 history 영향을 줄이기 위한 것이다. 직접 근거는 context isolation 설명과 prompt template의 full text 요구다. [f2cbfbe, `skills/subagent-driven-development/SKILL.md:8-14`, `skills/subagent-driven-development/implementer-prompt.md:11-18`]

### 스펙 준수 리뷰가 코드 품질 리뷰보다 먼저 와야 한다

- 근거: SDD core principle은 "spec compliance review first, then code quality review"이며 flowchart도 이 순서를 고정한다. [f2cbfbe, `skills/subagent-driven-development/SKILL.md:6-12`, `skills/subagent-driven-development/SKILL.md:42-87`]
- code-quality reviewer prompt는 "Only dispatch after spec compliance review passes"라고 말한다. [f2cbfbe, `skills/subagent-driven-development/code-quality-reviewer-prompt.md:5-8`]
- spec reviewer prompt는 구현자 보고를 믿지 말고 실제 코드를 읽어 missing/extra/misunderstanding을 확인하라고 한다. [f2cbfbe, `skills/subagent-driven-development/spec-reviewer-prompt.md:21-36`, `skills/subagent-driven-development/spec-reviewer-prompt.md:41-56`]
- 엄밀한 추론: 이 순서는 "잘 만든 잘못된 기능"을 방지하기 위한 것이다. 코드 품질보다 요구 적합성을 먼저 닫아야 over/under-building이 다음 태스크로 전파되지 않는다. 이는 SDD 장점 설명의 "Spec compliance prevents over/under-building"과 일치한다. [f2cbfbe, `skills/subagent-driven-development/SKILL.md:223-229`]

### TDD/디버깅/검증 스킬은 강한 금지 문구와 rationalization 표를 쓴다

- 근거: TDD 스킬은 "NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST"와 코드 선작성 시 삭제를 지시한다. [f2cbfbe, `skills/test-driven-development/SKILL.md:31-45`]
- systematic-debugging은 "NO FIXES WITHOUT ROOT CAUSE INVESTIGATION FIRST"와 4단계 절차를 요구한다. [f2cbfbe, `skills/systematic-debugging/SKILL.md:16-23`, `skills/systematic-debugging/SKILL.md:46-121`]
- verification-before-completion은 fresh verification evidence 없이는 완료/통과 주장을 못 한다고 한다. [f2cbfbe, `skills/verification-before-completion/SKILL.md:16-38`]
- writing-skills는 discipline-enforcing skills가 agent rationalization을 막아야 하며, explicit loophole closure/red flags/rationalization table을 권장한다. [f2cbfbe, `skills/writing-skills/SKILL.md:459-523`]

### 스킬 description은 "언제 쓰는가"만 담아야 한다

- 근거: `writing-skills`는 description이 workflow를 요약하면 Claude가 본문을 읽지 않고 description만 따라 shortcut을 택할 수 있다고 설명한다. 실제 예로 "code review between tasks" 요약이 2단계 리뷰를 누락하게 만들었다고 기록한다. [f2cbfbe, `skills/writing-skills/SKILL.md:140-158`]
- 따라서 `subagent-driven-development`의 description은 "independent tasks in the current session"이라는 triggering condition만 담고 있다. [f2cbfbe, `skills/subagent-driven-development/SKILL.md:1-4`]
- 엄밀한 추론: DITTO가 스킬 검색/자동선택을 구현한다면 description은 routing metadata로 취급하고, 절차 요약은 본문에만 두어야 한다. 근거는 위 CSO 테스트 결과 설명이다. [f2cbfbe, `skills/writing-skills/SKILL.md:150-158`]

### 브레인스토밍 서버는 zero-dependency로 작성됐다

- 근거: zero-dependency 설계 문서는 vendored `node_modules`가 supply chain risk와 audit burden을 만든다고 보고, Node built-ins만 쓰는 단일 서버로 대체하자고 한다. [f2cbfbe, `docs/superpowers/specs/2026-03-11-zero-dep-brainstorm-server-design.md:1-15`]
- 실제 `server.cjs`는 `crypto`, `http`, `fs`, `path`만 import한다. [f2cbfbe, `skills/brainstorming/scripts/server.cjs:1-5`]
- test-only dependency인 `ws`는 `tests/brainstorm-server/package.json`에만 있다. [f2cbfbe, `tests/brainstorm-server/package.json:1-9`]

### Codex marketplace sync는 source repo의 canonical plugin 파일과 destination metadata 보존을 분리한다

- 근거: sync script 주석은 upstream plugin content를 rsync하되 destination plugin의 OpenAI-owned marketplace metadata를 보존한다고 설명한다. [f2cbfbe, `scripts/sync-to-codex-plugin.sh:1-13`]
- 구현은 `skills/*/agents/openai.yaml`을 destination에서 source overlay로 복사해 보존한다. [f2cbfbe, `scripts/sync-to-codex-plugin.sh:321-347`]
- 테스트도 OpenAI agent metadata 삭제가 preview에 나타나지 않아야 한다고 검증한다. [f2cbfbe, `tests/codex-plugin-sync/test-sync-to-codex-plugin.sh:534-549`]

## 장점

- **하네스 독립성:** 같은 `skills/` 컨텐츠를 Claude Code, Codex, Gemini, OpenCode, Cursor, Copilot CLI에 맞게 로딩/도구 매핑한다. [f2cbfbe, `README.md:63-152`, `skills/using-superpowers/SKILL.md:28-40`]
- **행동 게이트가 명확하다:** 디자인 승인 전 구현 금지, plan self-review, TDD red/green, root-cause-first, evidence-before-claim 등 실패하기 쉬운 지점을 명시적 게이트로 만든다. [f2cbfbe, `skills/brainstorming/SKILL.md:12-14`, `skills/writing-plans/SKILL.md:122-144`, `skills/test-driven-development/SKILL.md:31-45`, `skills/verification-before-completion/SKILL.md:24-38`]
- **서브에이전트 분업이 구체적이다:** 구현자/스펙 리뷰어/품질 리뷰어 역할, 입력, 출력, 재검토 loop가 prompt template으로 분리되어 있다. [f2cbfbe, `skills/subagent-driven-development/SKILL.md:122-127`, `skills/subagent-driven-development/implementer-prompt.md:100-112`, `skills/subagent-driven-development/spec-reviewer-prompt.md:58-61`]
- **스킬 자체를 테스트 가능한 행동 코드로 취급한다:** `writing-skills`는 baseline pressure scenario, red-green-refactor, rationalization 수집을 요구한다. [f2cbfbe, `skills/writing-skills/SKILL.md:10-18`, `skills/writing-skills/SKILL.md:533-560`, `skills/writing-skills/SKILL.md:596-634`]
- **실제 하네스 transcript 기반 테스트 전략이 있다:** SDD와 code review는 실제 Claude Code 세션/서브에이전트/커밋/테스트 결과를 확인한다. [f2cbfbe, `docs/testing.md:40-65`, `tests/claude-code/test-subagent-driven-development-integration.sh:118-187`, `tests/claude-code/test-requesting-code-review.sh:95-149`]
- **런타임 의존성을 줄이는 방향이 일관된다:** OpenCode 플러그인은 Node built-in 기반으로 bootstrap을 읽고, 브레인스토밍 서버도 built-in만 사용한다. [f2cbfbe, `.opencode/plugins/superpowers.js:8-11`, `skills/brainstorming/scripts/server.cjs:1-5`, `docs/superpowers/specs/2026-03-11-zero-dep-brainstorm-server-design.md:1-8`]
- **기여 기준이 엄격하다:** AI agent PR에 대해 PR 템플릿, 중복 PR 검색, 실제 문제 확인, core 적합성, 인간 diff 리뷰를 요구한다. [f2cbfbe, `CLAUDE.md:11-19`, `.github/PULL_REQUEST_TEMPLATE.md:1-13`, `.github/PULL_REQUEST_TEMPLATE.md:92-115`]

## 약한 점/리스크

1. **잔존/드리프트된 문서와 테스트가 있다.**
   - `windows-lifecycle.test.sh`는 `skills/brainstorming/scripts/server.js`와 `.server-info`를 참조하지만, 실제 서버는 `server.cjs`이고 현재 서버는 `state/server-info`를 쓴다. [f2cbfbe, `tests/brainstorm-server/windows-lifecycle.test.sh:19-24`, `tests/brainstorm-server/windows-lifecycle.test.sh:64-79`, `skills/brainstorming/scripts/server.cjs:339-347`]
   - 문서 리뷰 prompt 파일과 테스트가 남아 있지만, 현재 `brainstorming`/`writing-plans`는 inline self-review 중심이다. 엄밀한 추론: 이 파일/테스트는 historical artifact 또는 보조 실험으로 보이며, 메인 runner에도 포함되지 않는다. [f2cbfbe, `tests/claude-code/run-skill-tests.sh:74-83`, `tests/claude-code/test-document-review-system.sh:1-18`, `skills/brainstorming/SKILL.md:116-124`, `skills/writing-plans/SKILL.md:122-132`]

2. **일부 품질 검증은 외부 유료/설치 하네스에 강하게 의존한다.**
   - Claude Code 테스트는 `claude` CLI와 local plugin 설정을 요구하고, 통합 테스트는 10-30분이 걸릴 수 있다. [f2cbfbe, `docs/testing.md:20-39`]
   - OpenCode integration tests는 OpenCode가 없으면 skip한다. [f2cbfbe, `tests/opencode/test-tools.sh:19-24`, `tests/opencode/test-priority.sh:92-100`]
   - 엄밀한 추론: 일반 CI에서 항상 실행되는 결정적 테스트 커버리지는 제한될 수 있다. 근거는 runner가 integration flag를 별도로 요구하고, 외부 CLI 미설치 시 skip하는 구조다. [f2cbfbe, `tests/opencode/run-tests.sh:60-75`, `tests/claude-code/run-skill-tests.sh:74-88`]

3. **OpenCode duplicate skill priority는 알려진 불확실성이 있다.**
   - 문서상 priority는 Project > Personal > Superpowers라고 설명하지만, priority test는 bundled superpowers skill이 local skill을 shadow할 수 있는 현행 OpenCode 동작을 "known bug"로 기록한다. [f2cbfbe, `docs/README.opencode.md:77-82`, `tests/opencode/test-priority.sh:149-170`]

4. **OpenCode 플러그인은 experimental hook API에 의존한다.**
   - bootstrap not appearing troubleshooting에서 `experimental.chat.system.transform` hook 지원 여부를 확인하라고 쓰여 있고, 실제 구현은 `experimental.chat.messages.transform`을 사용한다. [f2cbfbe, `docs/README.opencode.md:148-151`, `.opencode/plugins/superpowers.js:120-133`]
   - 엄밀한 추론: OpenCode API 변경 시 bootstrap 삽입이 깨질 수 있다. 근거는 hook 이름이 experimental namespace에 있고 문서도 hook 지원을 troubleshooting 포인트로 둔다는 점이다.

5. **강한 행동 지시는 user priority와 충돌할 수 있다.**
   - `using-superpowers`는 "MUST invoke"를 매우 강하게 말하지만, 바로 뒤에서 user instruction이 skills보다 우선한다고 명시한다. [f2cbfbe, `skills/using-superpowers/SKILL.md:10-16`, `skills/using-superpowers/SKILL.md:18-27`]
   - 엄밀한 추론: DITTO에 차용할 때는 "mandatory workflow"와 "사용자 명시 지시 우선"의 conflict resolution을 제품 레벨에서 명확히 해야 한다.

6. **worktree cleanup ownership은 heuristic이다.**
   - 설계 문서는 `.worktrees/` 또는 `~/.config/superpowers/worktrees/`이면 Superpowers 소유로 판단하고, 그 외는 harness 소유로 본다고 한다. 미래 harness가 `.worktrees/`를 쓰면 false positive 가능성이 있다고 스스로 리스크를 기록한다. [f2cbfbe, `docs/superpowers/specs/2026-04-06-worktree-rototill-design.md:319-322`]

7. **OpenCode bootstrap frontmatter 파서는 단순 구현이다.**
   - `extractAndStripFrontmatter`는 `key: value` 한 줄 형태만 처리하고 따옴표 제거 정도만 수행한다. 현재 용도는 `using-superpowers` bootstrap strip이라 충분하지만, full YAML frontmatter parser는 아니다. [f2cbfbe, `.opencode/plugins/superpowers.js:15-34`]

8. **release notes와 현재 코드 사이에 일부 표현 충돌이 보인다.**
   - v5.1.0 release notes의 Codex sync 항목은 `assets/` excluded라고 쓰지만, 현재 sync script는 `assets/`를 exclude하지 않고 주석도 assets 포함을 말하며 테스트도 assets 포함을 assert한다. [f2cbfbe, `RELEASE-NOTES.md:30-39`, `scripts/sync-to-codex-plugin.sh:1-9`, `scripts/sync-to-codex-plugin.sh:45-77`, `tests/codex-plugin-sync/test-sync-to-codex-plugin.sh:539-541`]

## DITTO에서 차용할 점

1. **하네스 통합 acceptance test를 명시하라.** 새 하네스는 "부트스트랩이 세션 시작에 로드되고, 자연어 작업 요청에서 적절한 스킬이 자동 트리거된다"는 transcript 기준으로 검증해야 한다. Superpowers의 "Let's make a react todo list" acceptance test가 좋은 모델이다. [f2cbfbe, `CLAUDE.md:67-87`, `.github/PULL_REQUEST_TEMPLATE.md:53-80`]

2. **스킬 description을 routing metadata로 제한하라.** 절차 요약은 본문에 두고 description은 triggering condition만 써야 한다. [f2cbfbe, `skills/writing-skills/SKILL.md:140-158`]

3. **계획 문서는 "에이전트 실행 가능성" 기준으로 작성하라.** 파일 경로, 완전한 코드, 명령, 예상 결과, 커밋 단위를 계획에 넣는 방식은 DITTO 태스크 실행률을 높일 수 있다. [f2cbfbe, `skills/writing-plans/SKILL.md:45-120`]

4. **서브에이전트 prompt template을 산출물 옆에 둬라.** implementer/spec-reviewer/code-reviewer 템플릿이 각 스킬 디렉터리에 있어 역할과 검증 기준이 drift하기 어렵다. [f2cbfbe, `skills/subagent-driven-development/SKILL.md:122-127`, `skills/requesting-code-review/SKILL.md:103-103`]

5. **state detection을 platform sniffing보다 우선하라.** Worktree처럼 플랫폼별로 lifecycle이 다른 기능은 `GIT_DIR != GIT_COMMON` 같은 상태 기반 감지가 더 유지보수성이 좋다. [f2cbfbe, `docs/superpowers/specs/2026-04-06-worktree-rototill-design.md:37-50`]

6. **"증거 전 주장 금지"를 공통 완료 게이트로 쓰라.** 완료/통과/수정 주장을 fresh command output과 요구사항 체크리스트에 묶는 방식은 에이전트 허위 완료를 줄일 수 있다. [f2cbfbe, `skills/verification-before-completion/SKILL.md:16-38`, `skills/verification-before-completion/SKILL.md:76-106`]

7. **브라우저 보조 도구는 비차단 채널로 설계하라.** 브라우저를 시각/선택 이벤트 채널로 쓰고 실제 대화는 터미널에 남기는 구조는 turn-based 에이전트 환경에 맞다. [f2cbfbe, `docs/superpowers/specs/2026-02-19-visual-brainstorming-refactor-design.md:15-31`, `skills/brainstorming/visual-companion.md:94-127`]

8. **플러그인 marketplace sync는 보존해야 할 외부 메타데이터와 source-owned 파일을 명시적으로 나누라.** Codex sync script의 `EXCLUDES`와 metadata overlay 보존 방식은 DITTO의 다중 marketplace 배포에도 적용 가능하다. [f2cbfbe, `scripts/sync-to-codex-plugin.sh:39-77`, `scripts/sync-to-codex-plugin.sh:321-347`]

## 보완 계획

1. **현재/역사 문서 구분**
   - 잔존 prompt template, old design plans, release note 불일치를 "current contract"와 "historical design"으로 분류한다.
   - DITTO에서는 `docs/archive/` 또는 `Status: Superseded` frontmatter를 강제하고, current docs만 링크하는 index를 둔다.

2. **정적 무결성 검사 추가**
   - 모든 plugin manifest 경로가 실제 존재하는지 검사한다. 예: `.cursor-plugin/plugin.json`의 `agents`/`commands` 포인터 같은 잔존 경로를 CI에서 잡는다. [f2cbfbe, `.cursor-plugin/plugin.json:21-25`, `RELEASE-NOTES.md:5-10`]
   - 테스트 스크립트가 존재하지 않는 파일(`server.js`)이나 이전 metadata 경로(`.server-info`)를 참조하지 않는지 검사한다. [f2cbfbe, `tests/brainstorm-server/windows-lifecycle.test.sh:19-24`, `skills/brainstorming/scripts/server.cjs:339-347`]

3. **하네스 adapter contract tests**
   - 외부 CLI가 없어도 실행 가능한 pure adapter tests를 만들고, 실제 하네스 테스트는 nightly/manual로 분리한다.
   - OpenCode bootstrap caching test처럼 fake config/fixture 기반 테스트를 늘리는 방향이 적합하다. [f2cbfbe, `tests/opencode/test-bootstrap-caching.mjs:31-65`]

4. **스킬 frontmatter validation**
   - `name`, `description`, description length, workflow summary 금지 규칙을 자동 검사한다.
   - DITTO에서는 YAML parser 또는 엄격한 schema validator를 사용해 단순 regex parser 리스크를 줄인다. [f2cbfbe, `skills/writing-skills/SKILL.md:93-104`, `.opencode/plugins/superpowers.js:15-34`]

5. **부트스트랩 drift 방지**
   - 각 하네스 bootstrap이 동일한 `using-superpowers` source를 로드하는지 snapshot/contract test를 둔다.
   - 하네스별 tool mapping 문서가 실제 현재 tool name과 맞는지 버전별 테스트 케이스를 둔다. Codex `wait`가 `wait_agent`로 바뀐 사례가 drift 가능성을 보여준다. [f2cbfbe, `skills/using-superpowers/references/codex-tools.md:27-30`, `RELEASE-NOTES.md:72-78`]

6. **시각 보조 서버 security hardening**
   - `content/`와 `state/` 분리는 유지하고, `/files/`가 `path.basename`으로 directory traversal을 줄이는 현재 방식을 명시 테스트한다. [f2cbfbe, `skills/brainstorming/scripts/server.cjs:145-156`]
   - DITTO에서는 localhost 기본, optional bind host, served file allowlist, state non-serving invariant를 테스트 계약으로 둔다.

## 근거 목록

- README/제품 개요: `README.md:1-4`, `README.md:154-204`
- AI agent 기여/하네스 acceptance: `CLAUDE.md:3-19`, `CLAUDE.md:67-87`, `.github/PULL_REQUEST_TEMPLATE.md:53-80`
- 패키징 메타데이터: `.claude-plugin/plugin.json:1-20`, `.codex-plugin/plugin.json:1-47`, `.cursor-plugin/plugin.json:1-25`, `gemini-extension.json:1-6`, `GEMINI.md:1-2`, `package.json:1-5`
- 부트스트랩/훅: `hooks/hooks.json:1-16`, `hooks/hooks-cursor.json:1-10`, `hooks/session-start:17-55`, `hooks/run-hook.cmd:1-46`, `.opencode/plugins/superpowers.js:49-133`
- 핵심 스킬: `skills/using-superpowers/SKILL.md`, `skills/brainstorming/SKILL.md`, `skills/writing-plans/SKILL.md`, `skills/subagent-driven-development/SKILL.md`, `skills/test-driven-development/SKILL.md`, `skills/systematic-debugging/SKILL.md`, `skills/verification-before-completion/SKILL.md`, `skills/using-git-worktrees/SKILL.md`, `skills/finishing-a-development-branch/SKILL.md`
- 서브에이전트/리뷰 템플릿: `skills/subagent-driven-development/implementer-prompt.md`, `skills/subagent-driven-development/spec-reviewer-prompt.md`, `skills/subagent-driven-development/code-quality-reviewer-prompt.md`, `skills/requesting-code-review/code-reviewer.md`
- 브레인스토밍 시각 도구: `skills/brainstorming/visual-companion.md`, `skills/brainstorming/scripts/start-server.sh`, `skills/brainstorming/scripts/server.cjs`, `skills/brainstorming/scripts/helper.js`, `skills/brainstorming/scripts/frame-template.html`, `skills/brainstorming/scripts/stop-server.sh`
- 설계 문서: `docs/superpowers/specs/2026-02-19-visual-brainstorming-refactor-design.md`, `docs/superpowers/specs/2026-03-11-zero-dep-brainstorm-server-design.md`, `docs/superpowers/specs/2026-03-23-codex-app-compatibility-design.md`, `docs/superpowers/specs/2026-04-06-worktree-rototill-design.md`, `docs/README.opencode.md`
- 릴리스/동기화/버전: `RELEASE-NOTES.md`, `scripts/sync-to-codex-plugin.sh`, `tests/codex-plugin-sync/test-sync-to-codex-plugin.sh`, `scripts/bump-version.sh`, `.version-bump.json`
- 테스트: `docs/testing.md`, `tests/claude-code/run-skill-tests.sh`, `tests/claude-code/test-subagent-driven-development-integration.sh`, `tests/claude-code/test-requesting-code-review.sh`, `tests/opencode/run-tests.sh`, `tests/opencode/setup.sh`, `tests/opencode/test-bootstrap-caching.mjs`, `tests/opencode/test-priority.sh`, `tests/brainstorm-server/server.test.js`, `tests/brainstorm-server/ws-protocol.test.js`, `tests/brainstorm-server/windows-lifecycle.test.sh`

## ditto 적용 정리

### 적용할 기능/가치

- **세션 시작 부트스트랩과 자동 트리거 검증:** DITTO는 coding agent harness로서 사용자의 인지 비용을 줄이고, LLM이 사용자 의도 밖으로 멋대로 작업하는 것을 구조적으로 제한해야 한다. Superpowers의 핵심 기준처럼 세션 시작 시 작업 규칙이 로드되고 자연어 작업에서 적절한 스킬/단계가 자동 트리거되는지를 하네스 통합의 acceptance test로 삼는다.
- **스킬/단계 description을 routing metadata로 제한:** DITTO의 오케스트레이션 단계는 정규화된 interface 또는 문서 양식으로 상태 전이를 해야 한다. Superpowers의 `writing-skills`가 지적한 것처럼 description에 절차 요약을 넣으면 본문을 읽지 않고 shortcut이 발생할 수 있으므로, DITTO의 단계 설명은 "언제 쓰는가"만 담고 실제 절차는 본문 contract에 둔다.
- **서브에이전트 실행과 2단계 검토:** DITTO는 Context Rot 해결을 위해 서브 에이전트를 적극 사용하고, 장기간 작업을 처음 의도대로 완수해야 한다. Superpowers의 fresh subagent 실행, 구현자/스펙 리뷰어/품질 리뷰어 prompt template, 스펙 준수 우선 검토 구조를 DITTO의 subagent contract로 적용한다.
- **증거 기반 완료 게이트:** DITTO의 핵심 가치는 할루시네이션 방지와 "근거 부족"의 명시다. Superpowers의 `verification-before-completion`처럼 완료/통과/수정 주장은 fresh command output, 요구사항 체크리스트, 실행 로그 같은 감사 가능한 증거가 있을 때만 허용한다.
- **상태 기반 worktree/lifecycle 감지:** DITTO는 git worktree와 팀 개발 프로세스를 적극 지원해야 한다. Superpowers의 worktree 설계처럼 플랫폼 감지보다 Git 상태 감지를 우선해, harness가 만든 작업공간과 사용자가 관리하는 작업공간의 소유권을 구분한다.

### 적용 방식

- 하네스 adapter마다 "부트스트랩 로드됨"과 "대표 자연어 요청에서 의도한 단계가 자동 트리거됨"을 transcript 기준 테스트로 둔다. Superpowers의 "Let's make a react todo list" 통합 기준을 DITTO의 대표 사용자 시나리오로 치환해 사용한다. [f2cbfbe, `CLAUDE.md:67-87`, `.github/PULL_REQUEST_TEMPLATE.md:53-80`]
- DITTO의 오케스트레이션 단계 문서에는 `trigger`, `input contract`, `output contract`, `verification evidence`, `handoff/audit record`를 분리한다. description은 trigger만 포함하고, 절차 요약은 본문에 둔다. [f2cbfbe, `skills/writing-skills/SKILL.md:140-158`]
- subagent에게는 plan 파일을 읽게 하지 않고 controller가 필요한 task 본문과 context를 prompt template으로 전달한다. 구현 후에는 스펙 준수 리뷰를 먼저 통과시키고, 그 다음 코드 품질 리뷰를 수행한다. [f2cbfbe, `skills/subagent-driven-development/SKILL.md:8-14`, `skills/subagent-driven-development/implementer-prompt.md:11-18`, `skills/subagent-driven-development/code-quality-reviewer-prompt.md:5-8`]
- DITTO의 완료 응답 형식에는 "수행한 변경", "검증 명령/결과", "미검증 항목", "남은 리스크"를 필수 필드로 둔다. 검증하지 못한 경우 완료가 아니라 미검증으로 보고한다. [f2cbfbe, `skills/verification-before-completion/SKILL.md:16-38`, `skills/verification-before-completion/SKILL.md:76-106`]
- git/worktree 지원은 `GIT_DIR != GIT_COMMON` 같은 상태 기반 판별을 우선하고, cleanup은 DITTO가 생성한 작업공간에만 적용한다. [f2cbfbe, `docs/superpowers/specs/2026-04-06-worktree-rototill-design.md:37-50`, `skills/finishing-a-development-branch/SKILL.md:40-56`]

### 적용 이후 제공 가치

- 사용자는 매번 절차를 지시하지 않아도 DITTO가 의도 파악, 현황 조사, 계획, 실행, 검증을 같은 contract로 진행하므로 인지 비용이 줄어든다.
- 부트스트랩/스킬/완료 게이트가 transcript와 감사 기록으로 남아, DITTO의 모든 액션 감사 기록과 새 세션 핸드오프 요구에 맞는다.
- fresh subagent와 스펙 우선 리뷰는 긴 작업에서 Context Rot, 과잉 구현, 요구 누락을 줄이고, DITTO가 처음 의도한 목적대로 끈질기게 완수하는 능력을 강화한다.
- 증거 기반 완료 게이트는 할루시네이션과 자기 확신 문제를 줄이고, "수정했다"가 아니라 "어떤 근거로 통과했는가"를 사용자에게 제공한다.
- 상태 기반 worktree 처리는 팀 개발과 여러 저장소/작업공간 사용을 지원하면서 사용자 변경을 되돌리거나 잘못 정리할 위험을 줄인다.

### 리스크와 선행 조건

- Superpowers식 강한 `MUST invoke` 지시는 사용자 명시 지시와 충돌할 수 있다. DITTO는 PURPOSE.md의 "사용자 의도 밖 작업 제한"에 맞게 사용자 지시 우선순위와 자동 단계 트리거의 충돌 해결 규칙을 제품 contract에 명시해야 한다. [f2cbfbe, `skills/using-superpowers/SKILL.md:10-16`, `skills/using-superpowers/SKILL.md:18-27`]
- 하네스 통합 테스트가 외부 CLI와 긴 실행 시간에 의존하면 항상 실행되는 검증이 약해진다. DITTO는 pure adapter contract tests와 실제 하네스 transcript tests를 분리해야 한다. [f2cbfbe, `docs/testing.md:20-39`, `tests/opencode/run-tests.sh:60-75`]
- description/frontmatter를 단순 파서로 처리하면 routing contract가 drift할 수 있다. DITTO는 엄격한 schema validation을 선행해야 한다. [f2cbfbe, `skills/writing-skills/SKILL.md:93-104`, `.opencode/plugins/superpowers.js:15-34`]
- worktree cleanup 소유권은 heuristic이면 false positive가 생길 수 있다. DITTO는 생성 시점의 감사 기록이나 metadata를 남겨 cleanup 판단 근거를 보강해야 한다. [f2cbfbe, `docs/superpowers/specs/2026-04-06-worktree-rototill-design.md:319-322`]
- 문서/테스트 drift는 하네스 신뢰도를 낮춘다. DITTO는 current contract와 historical design을 구분하고, manifest 경로와 테스트 참조의 정적 무결성 검사를 선행해야 한다. [f2cbfbe, `.cursor-plugin/plugin.json:21-25`, `tests/brainstorm-server/windows-lifecycle.test.sh:19-24`, `skills/brainstorming/scripts/server.cjs:339-347`]

### 근거

- PURPOSE.md는 DITTO를 범용 개발 작업을 돕는 coding agent harness로 정의하고, 사용자 인지 비용 최소화, 할루시네이션 방지, 사용자 의도 밖 추론/작업 제한, Context Rot 해결, 장기 작업 완수, 토큰 비용 절감을 핵심 가치로 둔다.
- PURPOSE.md의 핵심 기능은 세션 단위 감사 기록과 핸드오프, 주요 결정/변경사항 영속화, 서브 에이전트 활용, 정제된 출력, 사용자 인터뷰, 정규화된 오케스트레이션 interface, 멀티 모델 검토, E2E 테스트, git worktree와 팀 개발 지원을 포함한다.
- Superpowers 보고서 본문은 세션 시작 부트스트랩, 하네스별 스킬 로딩, 설계-계획-실행-검증 게이트, TDD/체계적 디버깅/증거 우선 원칙, fresh subagent와 스펙 준수 우선 리뷰, 상태 기반 worktree 감지, zero-dependency 보조 서버, marketplace sync의 source-owned/metadata 보존 분리를 확인했다. [f2cbfbe, `README.md:154-170`, `README.md:198-204`, `CLAUDE.md:67-87`, `skills/subagent-driven-development/SKILL.md:6-14`, `skills/verification-before-completion/SKILL.md:16-38`, `docs/superpowers/specs/2026-04-06-worktree-rototill-design.md:37-50`]

## ditto 적용 요소 후보 (skills/agents/commands/hooks)

| 우선순위 | 종류 | 요소 | DITTO 적용안 | 효과/주의 |
| --- | --- | --- | --- | --- |
| 바로 적용 | skill | `verification-before-completion` | DITTO의 모든 완료 응답 gate로 둔다. 변경 내용, 검증 명령/결과, 미검증 항목, 남은 리스크를 분리하고 fresh evidence 없이 완료라고 말하지 못하게 한다. | 가장 즉시 효과가 크다. 검증 불가 상태를 실패가 아니라 미검증으로 보고하는 표현 규칙이 필요하다. |
| 바로 적용 | skill | `systematic-debugging` | 버그/테스트 실패/예상 밖 동작에서 원인 추적 전 수정 금지, 가설 검증, 방어적 수정, 회귀 확인을 기본 절차로 둔다. | 잘못된 가설을 깨는 데 유용하다. 간단한 오타 수정까지 과도하게 느려지지 않도록 scope gate가 필요하다. |
| 바로 적용 | skill + prompt template | `subagent-driven-development`, implementer/spec-reviewer/code-quality reviewer prompts | 독립 task 실행 시 fresh subagent를 쓰고, 구현 후 스펙 준수 리뷰를 먼저 통과한 뒤 코드 품질 리뷰를 돌린다. | Context Rot과 요구 누락을 줄인다. subagent에게 plan 전체 파일을 넘기지 않고 필요한 task/context만 전달해야 한다. |
| 바로 적용 | skill | `requesting-code-review`, `receiving-code-review` | 완료 전 code review dispatch와 리뷰 수신 후 검증 절차를 DITTO review skill로 둔다. 리뷰는 severity와 재현 근거를 요구하고, agent는 피드백을 맹목 수용하지 않는다. | 리뷰 품질과 적용 안정성이 좋아진다. 리뷰가 의견인지 버그인지 구분하는 출력 schema가 필요하다. |
| 바로 적용 | skill | `using-git-worktrees` | 구현 시작 전 작업공간 격리와 소유권 확인을 DITTO git workflow에 넣는다. cleanup은 DITTO가 만든 worktree에만 적용한다. | 사용자 변경을 보호한다. worktree 생성/정리는 metadata와 감사 기록 없이는 자동화하지 않는다. |
| 수정 적용 | skill/script | `brainstorming` + visual companion server | 요구/디자인 정제 skill은 텍스트 contract로 먼저 적용하고, 시각 보조 서버는 UI/UX 의사결정이 필요한 작업의 opt-in 도구로 둔다. | 창의적 요구 정리에 효과적이다. 서버 lifecycle, 포트, cleanup, 보안 경계가 필요하다. |
| 수정 적용 | skill | `writing-plans`, `executing-plans` | 다단계 작업에서 plan artifact와 execution artifact를 분리한다. executing agent는 plan을 임의 수정하지 않고 완료/차단/검증 상태만 갱신한다. | 오케스트레이션 상태 전이가 명확해진다. 계획 문서가 과도해지지 않도록 작업 크기 gate가 필요하다. |
| 수정 적용 | hook/test | session-start bootstrap, OpenCode/Codex/Gemini plugin bootstrap tests | 하네스 adapter마다 "부트스트랩 로드됨"과 "대표 자연어 요청에서 의도한 skill이 trigger됨"을 transcript 테스트로 둔다. | 실제 host에서 지침이 적용되는지 확인할 수 있다. 외부 CLI 기반 slow test와 pure contract test를 분리해야 한다. |
| 수정 적용 | skill/script | `writing-skills`, `sync-to-codex-plugin.sh`, `bump-version.sh` | skill 작성/수정 시 description discipline, reference/script split, graph rendering, plugin marketplace sync, version drift 검증을 DITTO 개발 도구로 차용한다. | skill/manifest drift를 줄인다. sync script는 destination-owned metadata 보존 규칙이 필요하다. |
