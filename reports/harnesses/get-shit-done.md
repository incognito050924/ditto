# get-shit-done 참고 하네스 분석 보고서

## 분석 대상 및 기준 커밋

- 대상 저장소: `https://github.com/open-gsd/gsd-core`
- 추적 브랜치: `next` (활성 개발 브랜치; `main`은 npm `@latest` 기준)
- 로컬 분석 경로: `/private/tmp/ditto-harness-refresh/gsd-core`
- 기준 커밋: `9b5ee37364b5bf204f920850a0f3c57e1394b47d` (2026-05-31, `chore(#556): retire orphaned CJS↔SDK hand-sync tooling`)
- 이 문서의 모든 `repo-relative/path:line` 근거는 위 기준 커밋을 기준으로 한다.
- **추적 이력**: 이전 추적: `gsd-build/get-shit-done @ bdcaab2c` (2026-06-01 아카이브됨) → 신규 추적: `open-gsd/gsd-core @ 9b5ee373` (브랜치 `next`, 2026-06-01 기준)

> **[저장소 추적 전환 완료]**  
> `gsd-build/get-shit-done`은 2026-05-22 공식 아카이브 처리되어 README가 `open-gsd/gsd-core`로 리디렉션되었다. 이 문서는 2026-06-01부터 `open-gsd/gsd-core`를 신규 분석 기준으로 삼는다. 이전 저장소의 분석 이력은 이 문서 하단 “기준 커밋 이후 변경” 섹션에 보존된다.

분석 대상은 일반 애플리케이션이 아니라 Claude Code, OpenCode, Gemini, Codex 등 여러 에이전트 런타임에 설치되는 메타 프롬프팅/컨텍스트 엔지니어링/스펙 기반 개발 하네스다. 패키지 메타데이터는 이름을 `@opengsd/gsd-core`(구 `get-shit-done-cc`에서 개명), 설명을 “GSD Core is a meta-prompting, context engineering, and spec-driven development system for AI coding agents”로 두고, 실행 파일을 `gsd-core`(설치기)와 `gsd-tools`로 노출한다(`package.json:2`, `package.json:6-9` @ `9b5ee373`). README도 동일하게 다중 런타임용 경량 메타 프롬프팅/컨텍스트 엔지니어링 시스템이라고 설명한다(`README.md:9-11` @ `9b5ee373`). npm 게시 패키지명은 `@opengsd/get-shit-done-redux`가 아니라 `@opengsd/gsd-core`로 확정되었다(`package.json:2` @ `9b5ee373`).

## 조사 방법

- `gh repo clone open-gsd/gsd-core /private/tmp/ditto-harness-refresh/gsd-core`로 클론 후 `git rev-parse HEAD`로 기준 커밋을 확정했다.
- README, ARCHITECTURE.md, COMMANDS.md, AGENTS.md, CLI-TOOLS.md, CONFIGURATION.md, INVENTORY.md, package.json, 런타임 명령 파일, 워크플로 파일, 에이전트 프롬프트, CLI 구현, 설치기, 후크, 템플릿, ADR, 린트/보안 스크립트를 정적 분석했다. 구 저장소에서 참조하던 `sdk/package.json`과 `sdk/src/`는 ADR-0174에 의해 삭제되었으므로 분석 대상에서 제외했다.
- 전체 테스트는 실행하지 않았다. 이 보고서의 목적이 하네스 구조 분석이고, 저장소 자체는 테스트 실행보다 문서/설정/프롬프트/도구 정의의 설계 근거를 수집하는 것이 핵심이기 때문이다.
- 핵심 수량은 사람이 작성한 설명보다 `docs/INVENTORY.md`를 우선했다. 해당 문서는 “authoritative roster”라고 명시하고, drift-control 테스트가 선적 파일 누락을 검증한다고 설명한다(`docs/INVENTORY.md:3-9` @ `9b5ee373`). 구 저장소 기준 앵커(`docs/INVENTORY.md:473`)는 신규 저장소에서 같은 파일 내 동일 위치에서 유효함을 확인했다.

## 핵심 특징

1. **여섯 단계 중심의 스펙 기반 루프**  
   사용자 흐름은 `/gsd-new-project`, `/gsd-discuss-phase`, `/gsd-plan-phase`, `/gsd-execute-phase`, `/gsd-verify-work`, `/gsd-ship` 또는 `/gsd-complete-milestone`로 구성된다. README는 이 루프를 순서대로 제시하고, 실행 단계에서 병렬 wave, 새 200k 토큰 컨텍스트, atomic commit, 메인 컨텍스트 30-40% 유지를 핵심 효과로 설명한다(`README.md:71-127`, `README.md:107-109`).

2. **얇은 오케스트레이터와 새 컨텍스트 에이전트**  
   아키텍처 문서는 워크플로가 컨텍스트 로드, 에이전트 spawn, 결과 수집, 상태 갱신만 담당하고, 전문 에이전트가 fresh context를 받는 구조라고 설명한다(`docs/ARCHITECTURE.md:72-83`, `docs/ARCHITECTURE.md:133-143`). 에이전트 문서도 얇은 오케스트레이터가 fresh context window, 제한된 도구, 명확한 산출물을 가진 전문 에이전트를 spawn한다고 설명한다(`docs/AGENTS.md:9`).

3. **파일 기반 상태와 명시적 산출물**  
   시스템 상태는 `.planning/` 파일에 저장된다. 아키텍처 문서는 `.planning/PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`, phase plan, summary, verification artifact가 명령 사이의 장기 기억 역할을 한다고 설명한다(`docs/ARCHITECTURE.md:85-96`, `docs/ARCHITECTURE.md:481-569`). 설정 문서도 `.planning/config.json`을 프로젝트 설정 위치로 둔다(`docs/CONFIGURATION.md:7-10`).

4. **런타임별 설치 표면과 토큰 예산 관리**  
   Claude, Codex, Gemini 등은 명령/스킬/후크 설치 위치와 호출 문법이 다르다. 명령 문서는 Claude/OpenCode/Kilo/Copilot은 `/gsd-command`, Gemini는 `/gsd:command`, Codex는 `$gsd-command`를 쓴다고 정리한다(`docs/COMMANDS.md:7-13`). 런타임 artifact layout 구현은 허용 런타임과 각 런타임의 명령/스킬/에이전트 설치 표면을 코드로 정의한다(`get-shit-done/bin/lib/runtime-artifact-layout.cjs:147-151`, `get-shit-done/bin/lib/runtime-artifact-layout.cjs:214-299`). 네임스페이스 라우터는 eager listing 비용을 약 2150 토큰에서 약 120 토큰으로 줄이기 위해 존재한다(`docs/ARCHITECTURE.md:123-128`).

5. **CJS 도구가 상태 조작과 검증을 중앙화**  
   워크플로는 `gsd_run query init.*`, `state.*`, `phase.*`, `verify.*` 같은 구조화된 명령을 `gsd-tools.cjs`를 통해 호출한다. 구 저장소에서 `gsd-sdk query`를 우선하던 dual-runtime 패턴은 ADR-0174에 의해 단일 CJS 경로로 통합되었다. CLI 도구 문서는 `gsd-tools.cjs`를 단일 primary runtime surface로 설명한다(`docs/CLI-TOOLS.md:1-20` @ `9b5ee373`). `CommandRoutingHub`가 unknown command를 fail-fast 처리하는 closed errorKind enum을 유지한다(`get-shit-done/bin/lib/command-routing-hub.cjs:39-47` @ `9b5ee373`).

6. **검증과 보안이 단계별로 중첩된다**  
   방어선은 plan verification, atomic commit, post-execution verification, UAT로 구성된다(`docs/ARCHITECTURE.md:97-105`). plan 단계에는 패키지 legitimacy gate가 포함되고(`docs/COMMANDS.md:167-175`), 아키텍처 문서는 slopsquatting 위협을 연구/계획/실행 레이어에서 다룬다고 설명한다(`docs/ARCHITECTURE.md:682-703`). prompt injection/read guard/secret scan도 별도 스크립트와 후크로 존재한다(`hooks/gsd-prompt-guard.js:3-12`, `hooks/gsd-read-injection-scanner.js:3-17`, `scripts/secret-scan.sh:1-13`).

## 구조/아키텍처

### 레이어 구조

GSD의 명시적 레이어는 `Command Layer -> Workflow Layer -> Agent Layer -> CLI Tools -> .planning/`이다. 아키텍처 문서가 이 흐름을 직접 제시하고, commands가 intent capture와 routing을 담당하며, workflows가 orchestration을 담당하고, agents가 전문 작업을 수행하며, CLI tools가 파일/상태 조작을 맡고, `.planning/`이 persistent state라고 설명한다(`docs/ARCHITECTURE.md:38-65`).

- **Command layer**: 각 런타임에서 호출되는 짧은 entrypoint다. 예를 들어 `commands/gsd/plan-phase.md`는 frontmatter에 이름, description, allowed tools, required skill을 두고, 본문은 objective와 `execution_context` 참조를 제공한다(`commands/gsd/plan-phase.md:1-16`, `commands/gsd/plan-phase.md:17-35`). `execute-phase`도 비슷하게 얇은 orchestration role과 context budget만 선언한다(`commands/gsd/execute-phase.md:1-15`, `commands/gsd/execute-phase.md:17-31`).
- **Workflow layer**: 실제 절차와 gate가 들어 있다. `plan-phase` workflow는 research -> plan -> verify, 최대 3회 revision loop를 수행한다고 선언한다(`get-shit-done/workflows/plan-phase.md:2`). `execute-phase` workflow는 wave 기반 병렬 실행과 verification을 수행한다고 선언한다(`get-shit-done/workflows/execute-phase.md:2-6`).
- **Agent layer**: 전문 역할별 프롬프트다. 인벤토리는 33개 agent가 선적된다고 기록한다(`docs/INVENTORY.md:13`). planner, executor, plan-checker, verifier, codebase-mapper는 각각 다른 도구 권한과 산출물 책임을 갖는다(`docs/AGENTS.md:154-162`, `docs/AGENTS.md:198-206`, `docs/AGENTS.md:221-229`, `docs/AGENTS.md:276-284`, `docs/AGENTS.md:340-348`).
- **CJS 도구 layer**: `gsd-tools.cjs`와 `CommandRoutingHub`가 상태/검증/템플릿/commit/graphify 등 반복 조작을 구현한다. CLI 문서는 `gsd-tools.cjs`를 단일 primary runtime surface로 설명한다(`docs/CLI-TOOLS.md:1-20` @ `9b5ee373`). 구 저장소의 `gsd-sdk query` 우선 경로와 legacy CJS/SDK 이중 레이어는 ADR-0174에 의해 CJS 단일 경로로 통합되었다.
- **State/template layer**: `.planning` 문서와 template이 계약이다. `project.md`, `requirements.md`, `roadmap.md`, `state.md`, `phase-prompt.md` 템플릿은 프로젝트 개요, 요구사항, 로드맵, 상태, 실행 계획 형식을 규정한다(`get-shit-done/templates/project.md:1-4`, `get-shit-done/templates/requirements.md:1-4`, `get-shit-done/templates/roadmap.md:14-20`, `get-shit-done/templates/state.md:1-4`, `get-shit-done/templates/phase-prompt.md:1-8`).
- **Install/hook layer**: 설치기는 런타임별 config dir, artifact copy, settings/hook 등록, rollback을 처리한다. Codex 설치는 pre-install snapshot과 rollback plan을 만들고(`bin/install.js:8809-8844`), Codex hook config 실패를 fatal로 처리해 snapshot restore를 수행한다(`bin/install.js:9121-9145`).

### 상태 모델

`.planning/config.json`은 absent-as-enabled 설정 모델을 사용한다. 아키텍처 문서는 설정 항목이 없으면 enabled라고 설명하고(`docs/ARCHITECTURE.md:85-96` @ `9b5ee373`), 설정 문서는 workflow toggles도 absent=enabled라고 설명한다(검증 완료 2026-06-01: `docs/CONFIGURATION.md:217` "## Workflow Toggles", `:219` "All workflow toggles follow the **absent = enabled** pattern" @ `9b5ee373`). canonical schema와 defaults는 manifest로 관리된다. 구 저장소의 `sdk/shared/config-schema.manifest.json`, `sdk/shared/config-defaults.manifest.json`은 `get-shit-done/bin/shared/`로 이동되었다(`get-shit-done/bin/shared/config-schema.manifest.json:1-3` @ `9b5ee373`, `get-shit-done/bin/shared/config-defaults.manifest.json:1-2` @ `9b5ee373`). 기본값에는 `model_profile`, `context_window`, workflow toggles, hook toggles, graphify 기본값이 포함된다(`get-shit-done/bin/shared/config-defaults.manifest.json` @ `9b5ee373`).

### 병렬 실행 모델

`execute-phase`는 계획 파일의 wave/dependency/frontmatter를 읽어 병렬 실행한다. workflow는 orchestrator가 구현자가 아니라 coordinator라고 명시하고(`get-shit-done/workflows/execute-phase.md:2-6`), 같은 wave에서 `files_modified`가 겹치면 serialize하라고 지시한다(`get-shit-done/workflows/execute-phase.md:440-472`). Agent 호출은 `.git/config.lock` 충돌을 피하기 위해 한 번에 하나씩 dispatch하되 background로 실행하라고 되어 있다(`get-shit-done/workflows/execute-phase.md:531-533`). 작업 후에는 manifest 기반 정리와 단일 writer 상태 갱신을 수행한다(`get-shit-done/workflows/execute-phase.md:739-763`, `get-shit-done/workflows/execute-phase.md:918-948`).

## 도구/명령/스크립트/프롬프트 인벤토리

### 패키지 및 실행 파일

- 루트 패키지는 `@opengsd/gsd-core`(구 `get-shit-done-cc`에서 개명)이며 Node `>=22`를 요구하고, 런타임 의존성으로 `@anthropic-ai/claude-agent-sdk`와 `ws`를 사용한다(`package.json:2`, `package.json:43-50` @ `9b5ee373`).
- 실행 파일은 `gsd-core`(설치기, `bin/install.js`)와 `gsd-tools`(`get-shit-done/bin/gsd-tools.cjs`) 두 개다. 구 저장소의 `get-shit-done-cc`, `gsd-sdk` bin은 없어졌다(`package.json:6-9` @ `9b5ee373`).
- 배포 파일에는 `bin`, `commands`, `get-shit-done`, `assets`, `agents`, `hooks`, `scripts`가 포함된다. 구 저장소의 `sdk/src`, `sdk/shared`, `sdk/prompts`, `sdk/dist`는 ADR-0174(SDK 패키지 경계 폐기)에 따라 삭제되었다(`package.json:10-17` @ `9b5ee373`, `docs/adr/0174-retire-gsd-sdk-package-boundary.md` @ `9b5ee373`).
- NPM script는 hook build, lib build(`tsc`), identity/alias/integrity drift check, 린트/테스트 suite를 포함한다. SDK build 스크립트는 단일 `tsc`로 통합되었다(`package.json:scripts` @ `9b5ee373`).
- `@gsd-build/sdk` 분리 패키지는 ADR-0174에 의해 폐기되었다. `src/`가 TypeScript 단일 소스가 되고 `tsc prepublishOnly`로 `dist/` CJS를 생성한다. 별도 `sdk/package.json`은 존재하지 않는다.

### 명령

- 인벤토리는 67개 command가 선적된다고 기록한다(`docs/INVENTORY.md:57` @ `9b5ee373`). 수량은 구 저장소 `bdcaab2c` 기준과 동일하다.
- 네임스페이스 router는 6개이며 workflow, project, quality, context, manage, ideate surface로 나뉜다. 구 저장소의 "analysis, operations, hooks/help" 분류에서 명칭이 바뀌었다(`docs/INVENTORY.md:67-72` @ `9b5ee373`). v1.40 이후 네임스페이스 router는 `gsd-workflow`, `gsd-project`, `gsd-quality`, `gsd-context`, `gsd-manage`, `gsd-ideate`로 확정되었다(`docs/ARCHITECTURE.md:123-135` @ `9b5ee373`).
- core workflow command는 `new-project`, `discuss-phase`, `plan-phase`, `execute-phase`, `verify-work`, `ship`, `complete-milestone` 계열이 유지된다. 신규 추가된 명령으로는 `mvp-phase`(수직 MVP 슬라이스), `spec-phase`(소크라테스식 스펙 정제), `ui-phase`, `ai-integration-phase`, `plan-review-convergence`, `ultraplan-phase`(BETA), `spike`, `sketch` 등이 있다(`docs/INVENTORY.md:81-89` @ `9b5ee373`).
- `map-codebase`는 전체 모드에서 4개 parallel mapper를 쓰고, `--fast`에서는 mapper 1개만 spawn하는 경량 스캔 모드를 사용한다(sequential이 아님). mapper agent가 `.planning/codebase`에 직접 쓰고 orchestrator는 확인만 받는다는 구조는 유지된다. 검증 완료 2026-06-01(`9b5ee373`): objective(직접 쓰기/확인만) `commands/gsd/map-codebase.md:15-21`, `--fast` 경량 모드 `:28`, 4 parallel mapper + 확인 수집 `:66-71`.
- `surface`는 reinstall 없이 runtime skill surface를 관리하며, token usage와 budget cap을 표시한다. 검증 완료 2026-06-01(`9b5ee373`): reinstall 없는 surface 관리 `commands/gsd/surface.md:12-18`, budget cap(~500 tokens) `:51`.
- `code-review`(depth/fix 옵션), `review`(cross-AI 외부 CLI 리뷰, `--agy`/`--antigravity` 포함 신규), `secure-phase`, `docs-update`, `fast`, `quick` 같은 보조 명령이 존재한다. 구 `cross-ai-review` 명령은 `review`로 통합되었고, Antigravity peer reviewer(`--agy`) 플래그가 추가되었다(`commands/gsd/review.md:4,36` @ `9b5ee373`, `docs/COMMANDS.md:1204` @ `9b5ee373`).

### 워크플로 프롬프트

- 인벤토리는 88개 workflow가 선적된다고 기록한다(`docs/INVENTORY.md:167`).
- `new-project` workflow는 config 초기화, optional commit, 4개 project researcher, synthesizer, roadmapper, roadmap commit을 수행한다(`get-shit-done/workflows/new-project.md:60-67`, `get-shit-done/workflows/new-project.md:262-275`, `get-shit-done/workflows/new-project.md:793-803`, `get-shit-done/workflows/new-project.md:966-988`, `get-shit-done/workflows/new-project.md:1209-1240`, `get-shit-done/workflows/new-project.md:1343-1346`).
- `discuss-phase` workflow는 mode별 본문, template, advisor를 lazy-load하고 CONTEXT/DISCUSSION-LOG를 작성한다(`get-shit-done/workflows/discuss-phase.md:14-31`, `get-shit-done/workflows/discuss-phase.md:128-148`, `get-shit-done/workflows/discuss-phase.md:370-390`).
- `plan-phase` workflow는 `gsd_run query init.plan-phase`(=`gsd-tools.cjs query init.plan-phase`)로 context를 로드하고, researcher/planner/plan-checker를 spawn하며, revision loop와 requirement/context coverage gate를 실행한다. 구 `gsd-sdk query` 호출은 `gsd_run query`로 통합되었다(검증 완료 2026-06-01: `get-shit-done/workflows/plan-phase.md:35` "gsd_run query init.plan-phase" @ `9b5ee373`; 파일은 1810줄). 구 저장소(아카이브된 `gsd-build/get-shit-done`)의 라인 앵커 482-529 등은 신규 저장소에 적용되지 않으므로 폐기한다.
- `execute-phase` workflow는 runtime/worktree config, partial commit resume gate, checkpoint heartbeat, post-wave test failure gate, verification spawn, phase completion commit을 포함한다(`get-shit-done/workflows/execute-phase.md:80-111`, `get-shit-done/workflows/execute-phase.md:161-172`, `get-shit-done/workflows/execute-phase.md:415-435`, `get-shit-done/workflows/execute-phase.md:955-981`, `get-shit-done/workflows/execute-phase.md:1450-1485`, `get-shit-done/workflows/execute-phase.md:1588-1611`).
- `verify-work` workflow는 UAT 파일을 만들고, checkpoint를 렌더링하고, 문제 진단용 parallel debug agent와 gap closure planner/checker를 사용한다(`get-shit-done/workflows/verify-work.md:206-259`, `get-shit-done/workflows/verify-work.md:267-274`, `get-shit-done/workflows/verify-work.md:524-539`, `get-shit-done/workflows/verify-work.md:554-639`).

### 에이전트

- 33개 에이전트가 있으며, 문서는 21 primary + 12 advanced로 설명한다(`docs/AGENTS.md:3`).
- `gsd-planner`는 PLAN을 executor가 해석 없이 구현할 수 있는 프롬프트로 만들고 dependency graph/wave를 정의한다(`agents/gsd-planner.md:23-30`, `agents/gsd-planner.md:355-366`). plan frontmatter에는 wave, depends, files, autonomous, requirements, must_haves가 포함된다(`agents/gsd-planner.md:421-439`, `agents/gsd-planner.md:503-518`).
- `gsd-plan-checker`는 read-only 도구로 계획을 execution 전 검증하고, requirement coverage, dependency correctness, context compliance, Nyquist automated verification을 검사한다(`agents/gsd-plan-checker.md:1-5`, `agents/gsd-plan-checker.md:9-30`, `agents/gsd-plan-checker.md:111-122`, `agents/gsd-plan-checker.md:177-184`, `agents/gsd-plan-checker.md:300-368`, `agents/gsd-plan-checker.md:438-494`).
- `gsd-executor`는 PLAN을 atomic하게 실행하고 per-task commit, SUMMARY, 상태 갱신을 수행한다(`agents/gsd-executor.md:15-19`). 이 에이전트는 `git add .` 금지, sub-repo routing, deletion/untracked check, `git clean` 금지를 명시한다(`agents/gsd-executor.md:409-528`, `agents/gsd-executor.md:532-552`).
- `gsd-verifier`는 SUMMARY를 신뢰하지 말고 codebase evidence를 검증하라고 명시하며, observable truth, artifact, data-flow, wiring, debt marker/probe를 검사한다(`agents/gsd-verifier.md:15-26`, `agents/gsd-verifier.md:165-181`, `agents/gsd-verifier.md:217-263`, `agents/gsd-verifier.md:264-321`, `agents/gsd-verifier.md:321-376`, `agents/gsd-verifier.md:442-520`).
- `gsd-phase-researcher`는 claim provenance tag, package provenance, WebSearch 검증, package legitimacy gate를 포함한다(`agents/gsd-phase-researcher.md:28-35`, `agents/gsd-phase-researcher.md:147-159`, `agents/gsd-phase-researcher.md:202-226`, `agents/gsd-phase-researcher.md:267-293`).
- `gsd-codebase-mapper`는 구조화 문서를 직접 쓰고 confirmation만 반환하며, secret 파일을 읽거나 quote하지 말라고 지시한다(`agents/gsd-codebase-mapper.md:18-23`, `agents/gsd-codebase-mapper.md:809-827`).

### CJS 도구, 설치기

- CLI 인벤토리는 79개 module이 선적된다고 기록한다(`docs/INVENTORY.md:365` @ `9b5ee373`). 구 저장소 bdcaab2c 기준 74개에서 증가했다. 실제 `get-shit-done/bin/lib/` 파일 수는 80개로 INVENTORY.md 수량(79)과 1개 차이가 있다(subdirectory `installer-migrations/`, `observability/` 계산 방식 차이 추정; drift-guard 테스트가 확인 기준).
- `query-runtime-bridge.ts`와 `sdk/src/query/registry.ts`는 ADR-0174에 의해 삭제되었다. SDK 패키지 경계가 폐기되어 별도의 TypeScript SDK runtime이 없다. `gsd-sdk query` 호출 패턴은 `gsd-tools.cjs query`(또는 `gsd_run query`) 단일 경로로 통합되었다(`docs/adr/0174-retire-gsd-sdk-package-boundary.md` @ `9b5ee373`).
- `gsd-tools.cjs`는 단일 CJS 진입점으로, SDK bridge loader나 dual-runtime fallback 없이 `get-shit-done/bin/lib/` domain module을 직접 require한다(`get-shit-done/bin/gsd-tools.cjs:1-20` @ `9b5ee373`).
- `runtime-artifact-layout.cjs`는 런타임별 artifact layout의 source of truth로, unknown runtime을 loudly fail한다는 설계는 유지된다. 허용 런타임에 Antigravity, Windsurf, Augment, Trae, Qwen, Hermes, CodeBuddy, Cline, OpenCode, Kilo 등이 추가되었다(`get-shit-done/bin/lib/runtime-artifact-layout.cjs:147-155` @ `9b5ee373`).
- `install-profiles.cjs`는 66 skills + 33 agents가 예산의 약 60%를 소비한다고 설명하고, core/standard/full profile 및 transitive closure staging을 구현한다. 구조는 유지된다(`get-shit-done/bin/lib/install-profiles.cjs:1-30` @ `9b5ee373`).
- 설치기는 `--claude`, `--codex`, `--gemini`, `--antigravity`, `--all`, `--profile`류 플래그를 제공한다. Antigravity 런타임 지원이 명시적으로 추가되었다(`docs/ARCHITECTURE.md:594` @ `9b5ee373`).
- SDK query registry(`sdk/src/query/registry.ts`)와 query-runtime-bridge의 strictSdk/fallback policy 설계는 단일 CJS runtime으로 단순화되면서 사라졌다. 대신 `CommandRoutingHub`가 단일 오류 분류 계약을 유지한다(아래 `기준 커밋 이후 변경` 섹션 참조).

### 후크와 보안 스크립트

- 인벤토리는 13개 hook이 선적된다고 기록한다(`docs/INVENTORY.md:455` @ `9b5ee373`). ARCHITECTURE.md는 "11-hook roster"라고 참조하지만(`docs/ARCHITECTURE.md:267`), 이는 알려진 drift다. 파일시스템 실제 수는 13개이며, `docs/INVENTORY.md`가 authoritative다.
- `gsd-context-monitor.js`는 statusline bridge metrics를 읽어 context remaining 35/25 기준으로 경고하고, session id path traversal을 거부하며, critical 상태에서 detached `gsd-tools`로 session을 기록한다(`hooks/gsd-context-monitor.js:1-19`, `hooks/gsd-context-monitor.js:49-54`, `hooks/gsd-context-monitor.js:129-155`).
- `gsd-prompt-guard.js`는 `.planning` Write/Edit에 대한 prompt injection advisory scanner이며, 3초 timeout과 silent failure를 갖는다(`hooks/gsd-prompt-guard.js:3-12`, `hooks/gsd-prompt-guard.js:35-37`, `hooks/gsd-prompt-guard.js:80-95`).
- `gsd-read-guard.js`는 non-Claude runtime의 read-before-edit advisory hook이고, Claude Code에서는 session/env signal로 skip한다(`hooks/gsd-read-guard.js:3-19`, `hooks/gsd-read-guard.js:39-61`, `hooks/gsd-read-guard.js:84-99`).
- `gsd-read-injection-scanner.js`는 read-time prompt injection scanner이며, summarization hijack pattern과 제외 경로, severity output, silent failure를 갖는다(`hooks/gsd-read-injection-scanner.js:3-17`, `hooks/gsd-read-injection-scanner.js:21-48`, `hooks/gsd-read-injection-scanner.js:50-61`, `hooks/gsd-read-injection-scanner.js:130-150`).
- `gsd-statusline.js`는 `.planning/config.json`과 `STATE.md`를 읽고 `/tmp/claude-ctx-{session}.json` bridge를 쓴다(`hooks/gsd-statusline.js:12-33`, `hooks/gsd-statusline.js:98-119`, `hooks/gsd-statusline.js:321-340`).
- `prompt-injection-scan.sh`와 `secret-scan.sh`는 각각 prompt injection과 secret pattern을 검사하는 스크립트이며 usage/exit code와 pattern/allowlist/skip rule을 명시한다(`scripts/prompt-injection-scan.sh:1-13`, `scripts/prompt-injection-scan.sh:18-83`, `scripts/secret-scan.sh:1-13`, `scripts/secret-scan.sh:19-57`, `scripts/secret-scan.sh:91-114`).

### 린트와 drift control

- `scripts/run-tests.cjs`는 suite filter, test discovery, concurrency, Windows command line chunking, first-failure reporting을 처리한다(`scripts/run-tests.cjs:1-18`, `scripts/run-tests.cjs:97-110`, `scripts/run-tests.cjs:129-141`, `scripts/run-tests.cjs:158-175`).
- `lint-command-contract.cjs`는 command frontmatter name/tools/execution_context 참조를 검증한다(`scripts/lint-command-contract.cjs:3-13`, `scripts/lint-command-contract.cjs:39-74`).
- `lint-descriptions.cjs`는 command description 100자 제한을 강제한다(`scripts/lint-descriptions.cjs:3-11`, `scripts/lint-descriptions.cjs:61-82`).
- `lint-skill-deps.cjs`는 frontmatter/body에서 `gsd-*` 참조를 추출하고 requires consistency와 profile closure를 검사한다(`scripts/lint-skill-deps.cjs:3-16`, `scripts/lint-skill-deps.cjs:49-57`, `scripts/lint-skill-deps.cjs:69-107`, `scripts/lint-skill-deps.cjs:113-139`).

## 각 도구가 왜 그렇게 작성되어야 했는지에 대한 근거 또는 엄밀한 추론

### 명령은 얇은 라우터여야 한다

근거: 명령 파일은 frontmatter, objective, execution_context 참조 중심으로 작다(`commands/gsd/plan-phase.md:1-35`, `commands/gsd/execute-phase.md:1-31`). 아키텍처 문서는 네임스페이스 라우터가 eager listing 비용을 약 2150 토큰에서 약 120 토큰으로 줄인다고 설명한다(`docs/ARCHITECTURE.md:123-128`). description 길이도 100자 이하로 lint된다(`docs/COMMANDS.md:1424-1435`, `scripts/lint-descriptions.cjs:3-11`).

엄밀한 추론: 런타임이 명령 목록과 설명을 prompt surface에 올리는 구조에서는 command 파일이 커질수록 상시 토큰 비용이 증가한다. 따라서 GSD 명령은 실제 절차를 workflow skill로 미루고, entrypoint에는 라우팅과 최소 계약만 남겨야 한다. 이 추론은 command 파일의 `execution_context` 참조 방식과 라우터 토큰 절감 설명에서 나온다(`commands/gsd/ns-workflow.md:16-28`, `docs/ARCHITECTURE.md:123-128`).

### 워크플로는 오케스트레이션 문서여야 한다

근거: 아키텍처 문서는 workflow가 context loading, agent spawning, result collection, state update, error handling을 수행한다고 설명한다(`docs/ARCHITECTURE.md:133-143`). `plan-phase`는 context init, researcher/planner/checker spawn, revision loop, coverage gate, roadmap/state commit을 갖는다(`get-shit-done/workflows/plan-phase.md:31-40`, `get-shit-done/workflows/plan-phase.md:482-529`, `get-shit-done/workflows/plan-phase.md:1307-1366`, `get-shit-done/workflows/plan-phase.md:1447-1555`, `get-shit-done/workflows/plan-phase.md:1562-1594`). `execute-phase`는 wave scheduling, checkpoint, manifest cleanup, post-wave tests, verifier spawn을 갖는다(`get-shit-done/workflows/execute-phase.md:415-435`, `get-shit-done/workflows/execute-phase.md:739-763`, `get-shit-done/workflows/execute-phase.md:955-981`, `get-shit-done/workflows/execute-phase.md:1450-1485`).

엄밀한 추론: agent에게 전역 lifecycle 제어까지 맡기면 plan revision, state mutation, commit boundary, verification gate가 agent별로 분산된다. GSD는 workflow를 절차의 source of truth로 두고 agent는 산출물 생산에 집중시켜, 재시작과 검증 지점을 파일/명령 기준으로 고정한다. 이 추론은 `.planning` 파일 상태 모델과 workflow gate 구조에서 나온다(`docs/ARCHITECTURE.md:85-96`, `get-shit-done/workflows/execute-phase.md:161-172`).

### 에이전트는 역할별 prompt와 제한 도구를 가져야 한다

근거: 에이전트 문서는 thin orchestrator가 focused role, limited tools, artifact를 가진 specialized agent를 spawn한다고 설명한다(`docs/AGENTS.md:9`). plan-checker는 read-only 도구만 갖고(`agents/gsd-plan-checker.md:1-5`), verifier는 SUMMARY를 불신하고 codebase evidence를 검증한다(`agents/gsd-verifier.md:15-26`), executor는 PLAN 실행과 commit/SUMMARY/state update를 맡는다(`agents/gsd-executor.md:15-19`).

엄밀한 추론: 계획 작성, 계획 검증, 코드 실행, 결과 검증은 실패 모드가 다르다. 같은 프롬프트가 모두 맡으면 도구 권한과 판단 기준을 좁히기 어렵다. GSD는 agent별 권한과 산출물을 분리해 “작성자와 검증자 분리”를 구현한다. 이 추론은 plan-checker의 read-only 권한과 verifier의 불신 규칙에서 나온다(`agents/gsd-plan-checker.md:1-5`, `agents/gsd-verifier.md:15-26`).

### PLAN frontmatter와 wave는 병렬 실행의 안전장치다

근거: planner는 PLAN을 executor가 해석 없이 구현할 수 있게 작성해야 하며 dependency graph/waves를 포함한다(`agents/gsd-planner.md:23-30`, `agents/gsd-planner.md:355-366`). PLAN frontmatter에는 wave, depends_on, files_touched/files_modified, autonomous, requirements, must_haves가 들어간다(`agents/gsd-planner.md:421-439`, `agents/gsd-planner.md:503-518`). execute workflow는 same-wave file overlap을 검사하고 충돌 시 serialize한다(`get-shit-done/workflows/execute-phase.md:440-472`).

엄밀한 추론: 병렬 에이전트가 같은 파일을 수정하면 merge conflict나 semantic conflict가 생긴다. GSD는 dependency와 파일 touch set을 PLAN frontmatter에 기입하게 하고, 실행 workflow가 이를 검사해 병렬성을 안전한 경우로 제한한다. 이 추론은 planner frontmatter 요구와 execute overlap gate에서 나온다(`agents/gsd-planner.md:1024-1048`, `get-shit-done/workflows/execute-phase.md:440-472`).

### gsd-tools query registry는 prompt 내 임의 shell 조작을 줄이기 위한 도구다

근거: `gsd-tools.cjs query <command>` 패턴이 워크플로 전반에서 상태 조작의 단일 경로다. `CommandRoutingHub`는 unknown command를 `UnknownCommand` errorKind로 fail-fast 처리하고, handler 예외를 `HandlerFailure`로 변환해 no-throw 계약을 유지한다(`get-shit-done/bin/lib/command-routing-hub.cjs:39-47` @ `9b5ee373`, `docs/ARCHITECTURE.md:271` @ `9b5ee373`).

엄밀한 추론: 여러 workflow가 `.planning` 파일과 git commit, validation artifact를 직접 shell로 조작하면 런타임별 quoting/path/JSON 차이가 누적된다. GSD는 반복 상태 조작을 `gsd_run query` 명령으로 중앙화하고, unknown command를 즉시 실패시켜 prompt drift를 줄인다. SDK 경계 폐기 후에도 이 추론의 근거는 유효하다. 단지 구현 경로가 TypeScript SDK registry에서 CJS hub로 단순화되었다(`docs/CLI-TOOLS.md:1-20` @ `9b5ee373`, `get-shit-done/bin/lib/command-routing-hub.cjs:39-47` @ `9b5ee373`).

### 설치 profile과 surface 명령은 skill budget 때문에 필요하다

근거: install profile 모듈은 66 skills + 33 agents가 skill budget의 약 60%를 소비한다고 설명하고, core/standard/full profile을 제공한다(`get-shit-done/bin/lib/install-profiles.cjs:1-30`, `get-shit-done/bin/lib/install-profiles.cjs:58-89`). `surface` command는 runtime skill surface를 reinstall 없이 관리하고 token usage와 budget cap을 보여준다(`commands/gsd/surface.md:12-18`, `commands/gsd/surface.md:39-52`).

엄밀한 추론: 모든 명령/스킬을 한 번에 설치하면 런타임 prompt surface와 사용자의 발견성 모두가 악화된다. 그래서 GSD는 dependency closure 기반 profile을 만들고, 사용자가 필요한 cluster만 enable/disable하게 한다. 이 추론은 profile closure 구현과 surface token budget 출력에서 나온다(`get-shit-done/bin/lib/install-profiles.cjs:179-257`, `commands/gsd/surface.md:63-104`).

### 후크는 advisory/silent-fail로 작성되어야 한다

근거: prompt guard는 `.planning` Write/Edit에 대한 advisory-only scanner이고, timeout과 silent failure를 둔다(`hooks/gsd-prompt-guard.js:3-12`, `hooks/gsd-prompt-guard.js:35-37`, `hooks/gsd-prompt-guard.js:80-95`). read injection scanner도 severity output과 silent failure를 둔다(`hooks/gsd-read-injection-scanner.js:130-150`). context monitor도 advisory message와 silent fail 성격을 갖는다(`hooks/gsd-context-monitor.js:158-190`).

엄밀한 추론: 후크가 기본적으로 blocking이면 정상 작업과 런타임 호환성을 깨뜨릴 수 있다. GSD는 보안/품질 신호를 제공하되 기본 작업 흐름을 멈추지 않는 방향으로 설계했다. 이 추론은 advisory-only 문구와 timeout/silent failure 구현에서 나온다(`hooks/gsd-prompt-guard.js:3-12`, `hooks/gsd-read-injection-scanner.js:63-65`).

### package legitimacy gate는 에이전트 의존성 추가 위험 때문에 필요하다

근거: command 문서는 plan 단계에 package gate가 있다고 설명한다(`docs/COMMANDS.md:167-175`). 아키텍처 문서는 slopsquatting threat와 research/planning/execution layers, graceful degradation을 설명한다(`docs/ARCHITECTURE.md:682-703`). phase researcher는 package provenance와 legitimacy gate를 수행한다(`agents/gsd-phase-researcher.md:267-293`), planner는 package `[ASSUMED]`/`[SUS]` checkpoint를 요구한다(`agents/gsd-planner.md:619-629`).

엄밀한 추론: AI executor가 새 패키지를 제안/설치할 수 있는 하네스에서는 typo-squatting, slopsquatting, 유지보수 중단 패키지 위험이 일반 코드 변경보다 더 크다. GSD는 research, plan, execute에 같은 위험 신호를 반복 삽입해 한 단계에서 놓친 의존성 위험을 다음 단계에서 재확인하게 만든다. 이 추론은 여러 레이어에 같은 package gate가 배치된 구조에서 나온다(`docs/ARCHITECTURE.md:682-703`, `agents/gsd-executor.md:283-315`).

### map-codebase는 agent가 직접 문서를 쓰게 해야 한다

근거: `map-codebase` command는 mapper agent가 `.planning/codebase`에 직접 쓰고 orchestrator는 확인만 받는다고 설명한다(`commands/gsd/map-codebase.md:15-21`). workflow도 dedicated mapper agents를 쓰는 이유가 orchestrator context load를 줄이기 위해서라고 설명한다(`get-shit-done/workflows/map-codebase.md:15-23`). mapper는 confirmation만 반환하고 secret 파일은 읽거나 quote하지 말라고 지시한다(`agents/gsd-codebase-mapper.md:18-23`, `agents/gsd-codebase-mapper.md:809-827`).

엄밀한 추론: 코드베이스 지도 문서는 길고 반복적이어서 orchestrator가 모든 내용을 받아 합성하면 context가 빠르게 소모된다. GSD는 mapper가 파일에 직접 쓰고 orchestrator는 존재/품질만 확인하게 하여 context cost를 artifact store로 넘긴다. 이 추론은 direct-write 지시와 context load 감소 설명에서 나온다(`get-shit-done/workflows/map-codebase.md:267-283`, `get-shit-done/workflows/map-codebase.md:343-370`).

## 장점

1. **컨텍스트 예산을 구조적으로 다룬다**  
   네임스페이스 라우팅, lazy-loaded workflow, fresh-context agents, surface profile이 모두 같은 목표를 향한다. 토큰 절감 수치와 lazy loading 규칙은 문서화되어 있고(`docs/ARCHITECTURE.md:123-128`, `docs/ARCHITECTURE.md:145-170`), install profile은 예산 소비를 명시한다(`get-shit-done/bin/lib/install-profiles.cjs:1-30`).

2. **작업 산출물이 파일로 남아 재개와 검증이 쉽다**  
   `.planning` 상태 모델과 template이 명확하고, execute workflow는 partial commit resume gate와 phase completion state update를 갖는다(`docs/ARCHITECTURE.md:85-96`, `get-shit-done/workflows/execute-phase.md:161-172`, `get-shit-done/workflows/execute-phase.md:1588-1611`). STATE template도 읽는 위치와 생명주기를 명시한다(`get-shit-done/templates/state.md:84-121`).

3. **작성자와 검증자가 분리된다**  
   planner, plan-checker, executor, verifier가 분리되어 있고, plan-checker는 read-only이며 verifier는 SUMMARY를 신뢰하지 않는다(`agents/gsd-plan-checker.md:1-5`, `agents/gsd-verifier.md:15-26`). 방어선도 plan verification, atomic commits, post-execution verification, UAT로 문서화되어 있다(`docs/ARCHITECTURE.md:97-105`).

4. **다중 런타임 지원이 문서와 코드에 같이 반영되어 있다**  
   호출 문법, 설치 위치, runtime artifact layout, Codex minimum, model resolution 정책이 별도 문서/코드로 관리된다(`docs/COMMANDS.md:7-13`, `docs/ARCHITECTURE.md:724-777`, `get-shit-done/bin/lib/runtime-artifact-layout.cjs:214-299`, `docs/CONFIGURATION.md:975-981`, `docs/CONFIGURATION.md:1070-1080`).

5. **drift control이 단순 문서가 아니라 테스트/린트 대상이다**  
   인벤토리는 선적 파일 누락을 drift-guard test가 잡는다고 설명하고(`docs/INVENTORY.md:473`), command contract, description length, skill dependency closure lint가 존재한다(`scripts/lint-command-contract.cjs:39-74`, `scripts/lint-descriptions.cjs:61-82`, `scripts/lint-skill-deps.cjs:69-139`).

6. **보안/공급망 위험을 하네스 레벨에서 다룬다**  
   package legitimacy gate, prompt injection scanner, read injection scanner, secret scan이 존재한다(`docs/ARCHITECTURE.md:682-703`, `scripts/prompt-injection-scan.sh:18-83`, `hooks/gsd-read-injection-scanner.js:21-48`, `scripts/secret-scan.sh:19-57`). 이는 단순 “좋은 프롬프트”가 아니라 작업 시스템의 guardrail로 구현되어 있다.

## 약한 점/리스크

1. **표면적이 매우 크다**  
   현재 선적 수량은 67 commands, 88 workflows, 33 agents, 79 CLI modules, 13 hooks다(`docs/INVENTORY.md:57`, `docs/INVENTORY.md:167`, `docs/INVENTORY.md:13`, `docs/INVENTORY.md:365`, `docs/INVENTORY.md:455` @ `9b5ee373`). 엄밀한 추론: 이 규모는 기능 발견성, 설치 profile closure, runtime별 회귀 테스트 비용을 키운다. profile/surface 기능 자체가 이 리스크를 줄이기 위한 장치로 보인다(`get-shit-done/bin/lib/install-profiles.cjs:1-30` @ `9b5ee373`, `commands/gsd/surface.md` @ `9b5ee373`).

2. **문서 수량 drift가 일부 보인다**  
   인벤토리는 13 hooks를 authoritative로 기록하지만(`docs/INVENTORY.md:448`), 아키텍처 문서의 hook section은 “11 hooks”라고 쓰고 표를 제시한다(`docs/ARCHITECTURE.md:249-267`). command contract lint 파일의 주석도 “65 command files”라고 쓰지만 현재 인벤토리는 67 commands다(`scripts/lint-command-contract.cjs:5`, `docs/INVENTORY.md:57`). 엄밀한 추론: 자동 인벤토리 검사가 있더라도 설명 문서의 사람이 쓴 수량은 별도 drift 관리가 필요하다.

3. **런타임 parity가 완전히 동일하지 않다**  
   `execute-phase`는 Codex worktree isolation unsupported 상태를 fail-closed로 처리한다(`get-shit-done/workflows/execute-phase.md:80-111`). `map-codebase`는 Agent tool이 없으면 sequential fallback으로 간다고 명시한다(`get-shit-done/workflows/map-codebase.md:130-139`). docs도 Codex 설치를 `$gsd-*` skill 방식으로 설명하고, non-Claude runtime은 model ID resolution을 omit한다고 설명한다(`docs/CONFIGURATION.md:975-981`, `bin/install.js:9701-9718`). 엄밀한 추론: 같은 GSD 명령이라도 runtime별 concurrency, model routing, hook behavior가 달라 결과 품질과 실패 모드가 달라질 수 있다.

4. **후크 다수가 advisory/silent-fail이라 강제 보안 장치로는 부족하다**  
   prompt guard, read injection scanner, context monitor는 경고와 silent fail 중심이다(`hooks/gsd-prompt-guard.js:80-95`, `hooks/gsd-read-injection-scanner.js:130-150`, `hooks/gsd-context-monitor.js:158-190`). 엄밀한 추론: UX와 호환성을 위해 맞는 선택이지만, DITTO가 보안 강제 정책을 요구한다면 이 후크만으로는 충분하지 않고 CI/blocking scan을 별도로 둬야 한다.

5. **git 자동화가 강력한 만큼 정책 사고 여지가 있다**  
   executor는 `git add .` 금지와 삭제/미추적 파일 확인을 갖지만(`agents/gsd-executor.md:409-528`), CLI 문서는 commit helper가 `--no-verify`를 사용하는 이유와 staged respect 정책을 설명한다(`docs/CLI-TOOLS.md:386-431`). 엄밀한 추론: 자동 commit을 신뢰하려면 hook bypass와 partial staged 상태에 대한 팀 정책을 명확히 해야 한다.

6. **계획 품질에 대한 의존도가 높다**  
   executor는 PLAN을 atomic하게 실행하고, planner는 plans as prompts라는 강한 책임을 가진다(`agents/gsd-executor.md:15-19`, `agents/gsd-planner.md:23-30`). plan-checker가 coverage/context/Nyquist를 검증하지만(`agents/gsd-plan-checker.md:111-122`, `agents/gsd-plan-checker.md:300-368`, `agents/gsd-plan-checker.md:438-494`), 엄밀한 추론: 잘못된 requirement나 잘못된 CONTEXT가 plan-checker를 통과하면 execute 단계가 그 오류를 빠르게 구현할 수 있다. 따라서 초기 `new-project`와 `discuss-phase` 산출물 품질이 전체 품질의 상한을 정한다.

## DITTO에서 차용할 점

1. **얇은 command + lazy workflow 구조**  
   DITTO도 prompt surface를 줄이려면 runtime entrypoint에는 routing과 계약만 두고, 긴 절차는 lazy-loaded workflow로 분리하는 구조를 차용할 수 있다. 근거는 GSD의 execution_context 참조와 라우터 토큰 절감 설계다(`commands/gsd/plan-phase.md:32-35`, `docs/ARCHITECTURE.md:123-170`).

2. **파일 기반 프로젝트 기억과 manifest 기반 schema/defaults**  
   `.planning`처럼 프로젝트 기억을 파일로 고정하고, config schema/default를 manifest로 둔 점은 DITTO의 재개성과 감사 가능성에 유리하다(`docs/ARCHITECTURE.md:85-96` @ `9b5ee373`, `get-shit-done/bin/shared/config-schema.manifest.json` @ `9b5ee373`, `get-shit-done/bin/shared/config-defaults.manifest.json` @ `9b5ee373`).

3. **planner/checker/executor/verifier 역할 분리**  
   작성, 검증, 실행, 사후 검증을 다른 agent contract로 나누는 패턴은 DITTO의 병렬 하네스에도 적합하다. GSD는 plan-checker read-only, verifier evidence-first, executor commit protocol을 명확히 분리한다(`agents/gsd-plan-checker.md:1-5`, `agents/gsd-verifier.md:15-26`, `agents/gsd-executor.md:409-528`).

4. **PLAN frontmatter 기반 병렬 wave 스케줄링**  
   DITTO가 여러 subagent를 병렬로 돌린다면 wave, dependency, files_modified, must_haves를 계획 파일에 넣고 실행 전 overlap gate를 두는 방식이 재사용 가능하다(`agents/gsd-planner.md:421-439`, `agents/gsd-planner.md:1024-1048`, `get-shit-done/workflows/execute-phase.md:440-472`).

5. **gsd-tools query로 상태 조작 중앙화**  
   prompt 안의 adhoc shell을 줄이고, state/phase/verify/config/commit 조작을 `gsd_run query` command로 모으면 runtime 차이와 prompt drift를 줄일 수 있다. SDK 분리 경계는 불필요함이 실증되었다. `CommandRoutingHub`의 no-throw pure-result 계약과 closed errorKind enum을 참고한다(`docs/CLI-TOOLS.md:1-20` @ `9b5ee373`, `get-shit-done/bin/lib/command-routing-hub.cjs:39-47` @ `9b5ee373`).

6. **인벤토리와 lint를 하네스 자체의 품질 게이트로 사용**  
   DITTO도 commands/agents/workflows/hooks 수량과 참조 관계를 inventory로 만들고 CI에서 검증해야 한다. GSD는 authoritative inventory와 command contract, skill dependency, description budget lint를 둔다(`docs/INVENTORY.md:3-9`, `docs/INVENTORY.md:473`, `scripts/lint-command-contract.cjs:39-74`, `scripts/lint-skill-deps.cjs:69-139`).

7. **공급망/프롬프트 인젝션 guardrail을 workflow와 hook 양쪽에 둔다**  
   package legitimacy는 research/plan/execute에, prompt/read injection은 hook/script에 있다(`docs/ARCHITECTURE.md:682-703`, `agents/gsd-phase-researcher.md:267-293`, `scripts/prompt-injection-scan.sh:18-83`, `hooks/gsd-read-injection-scanner.js:21-48`). DITTO도 단일 스캐너보다 단계별 반복 확인을 차용하는 편이 안전하다.

8. **map-codebase direct-write 패턴**  
   대형 코드베이스 분석은 subagent가 파일을 직접 쓰고 orchestrator에는 confirmation만 반환하는 방식이 context cost를 크게 줄인다(`commands/gsd/map-codebase.md:15-21`, `get-shit-done/workflows/map-codebase.md:15-23`, `agents/gsd-codebase-mapper.md:18-23`).

## 보완 계획

1. **DITTO용 최소 표면부터 정의한다**  
   GSD 전체를 복제하지 말고 `new/discuss/plan/execute/verify`에 해당하는 최소 core loop와 4개 agent contract부터 만든다. GSD의 현재 규모가 67 commands와 88 workflows이므로 초기부터 전체 표면을 가져오면 profile과 drift 비용이 커진다(`docs/INVENTORY.md:57`, `docs/INVENTORY.md:167`).

2. **상태 schema와 template을 먼저 고정한다**  
   `.planning`에 대응하는 DITTO 상태 디렉터리, `PROJECT/REQUIREMENTS/ROADMAP/STATE/PLAN/SUMMARY/VERIFICATION` 템플릿을 먼저 정의하고, schema/default manifest를 만든다. GSD는 templates와 canonical config manifest를 상태 계약으로 사용한다(검증 완료 2026-06-01, `9b5ee373`: `get-shit-done/templates/state.md:84-121`(STATE 상태 계약, 파일 195줄), `get-shit-done/templates/phase-prompt.md:15-31`(PLAN frontmatter — wave/depends_on/files_modified/must_haves, 파일 610줄), `get-shit-done/bin/shared/config-schema.manifest.json`).

3. **query registry를 shell wrapper보다 먼저 만든다**  
   DITTO도 `state.*`, `phase.*`, `verify.*`, `config.*`, `commit.*` 같은 query registry를 만들고 unknown command fail-fast를 넣는다. GSD는 `CommandRoutingHub`가 unknown command를 `UnknownCommand` errorKind로 즉시 실패시킨다. SDK 분리 경계가 불필요했다는 것이 gsd-core의 실증이다(`docs/CLI-TOOLS.md:1-20` @ `9b5ee373`, `get-shit-done/bin/lib/command-routing-hub.cjs:39-47` @ `9b5ee373`).

4. **계획 frontmatter와 overlap gate를 실행 전에 검증한다**  
   DITTO planner가 만든 plan에는 wave, dependency, 파일 touch set, test/must-have를 넣고, execute orchestrator가 병렬 실행 전 same-wave overlap을 거부하거나 직렬화하게 한다. GSD는 이 계약을 planner와 execute workflow 양쪽에 둔다(`agents/gsd-planner.md:421-439`, `get-shit-done/workflows/execute-phase.md:440-472`).

5. **검증자 agent는 작성자 산출물을 불신하도록 설계한다**  
   verifier prompt에 “SUMMARY를 신뢰하지 말고 evidence를 확인”하는 규칙을 넣고, artifact/data-flow/wiring/debt marker/probe 항목을 체크리스트화한다. GSD verifier가 이 구조를 갖는다(`agents/gsd-verifier.md:15-26`, `agents/gsd-verifier.md:217-321`, `agents/gsd-verifier.md:442-520`).

6. **후크는 advisory와 blocking을 분리한다**  
   GSD 후크는 호환성을 위해 advisory/silent-fail 성격이 강하다(`hooks/gsd-prompt-guard.js:80-95`, `hooks/gsd-read-injection-scanner.js:130-150`). DITTO가 더 강한 보안 보장을 원하면 local advisory hook과 CI blocking scanner를 별도 계층으로 나눠야 한다.

7. **문서 수량은 생성형 inventory에서만 노출한다**  
   GSD는 authoritative inventory가 있지만 일부 설명 문서에는 hook/command 수량 drift가 보인다(`docs/INVENTORY.md:448`, `docs/ARCHITECTURE.md:249-267`, `scripts/lint-command-contract.cjs:5`, `docs/INVENTORY.md:57`). DITTO는 README/ARCHITECTURE에 숫자를 직접 쓰기보다 inventory 생성 결과를 include하거나 테스트로 검증해야 한다.

8. **런타임 parity matrix를 초기에 만든다**  
   GSD는 runtime artifact layout과 config dir resolution을 코드로 관리한다(`get-shit-done/bin/lib/runtime-artifact-layout.cjs:214-299`, `bin/install.js:396-552`). DITTO도 Codex/Claude/Gemini 등 지원 범위를 명확히 하고, 병렬 agent, worktree isolation, hook support의 차이를 matrix로 관리해야 한다.

## 구 저장소 → 신규 저장소 전환 기록 (2026-06-01)

이 섹션은 구 저장소(`gsd-build/get-shit-done @ bdcaab2c`)에서 신규 저장소(`open-gsd/gsd-core @ 9b5ee373`)로 추적을 전환하면서 발견한 주요 변경 사항을 기록한다.

### 1. 저장소 이전 이력 (보존)

`gsd-build/get-shit-done`은 2026-05-22 공식 아카이브 처리되었다. 커밋 `da024a02`에서 README를 "GSD Has Moved" 리디렉션으로 교체했고 활성 저장소를 `https://github.com/open-gsd/gsd-core`로 안내했다. 이 문서의 모든 이후 분석은 `open-gsd/gsd-core`를 기준으로 한다.

### 2. CommandRoutingHub — gsd-core에서의 현재 상태

CommandRoutingHub(`get-shit-done/bin/lib/command-routing-hub.cjs`)는 구 저장소 `bdcaab2c` 시점에 초기 도입되었고, gsd-core에서 ADR-0174에 의해 단순화되었다.

**현재 설계 계약** (`command-routing-hub.cjs:1-47` @ `9b5ee373`):
- `createHub({ cjsRegistry, manifest }) → hub` — `mode`, `sdkLoader`가 제거되었다. CJS 단일 경로만 있다.
- `hub.dispatch({ family, subcommand, args, cwd, raw }) → Result`
- `Result = { ok: true, data } | { ok: false, kind: 'UnknownCommand', command } | { ok: false, kind: 'InvalidArgs', arg, reason } | { ok: false, kind: 'HandlerRefusal', reason } | { ok: false, kind: 'HandlerFailure', message, cause? }`
- hub는 절대 throw하지 않는다. 모든 예외는 `{ ok: false, kind: 'HandlerFailure' }`로 변환한다.
- `ERROR_KINDS` 4-값 closed enum: `UnknownCommand`, `InvalidArgs`, `HandlerRefusal`, `HandlerFailure`. 구 저장소의 `SdkLoadFailed`, `SdkDispatchFailed`는 ADR-0174 #175에 의해 삭제되었다. field명도 `errorKind` → `kind`로 변경되었다(ADR-0174 #176).

**DITTO 함의**: no-throw pure-result 계약과 closed errorKind enum은 여전히 DITTO의 subagent result 표준화에 참고할 만하다. SDK 이중 경로는 불필요하다는 것이 gsd-core의 실증이다.

### 3. SDK 패키지 폐기 (ADR-0174, 최대 구조적 변경)

`@opengsd/gsd-sdk`(구 `@gsd-build/sdk`) 분리 패키지가 ADR-0174(accepted 2026-05-23)에 의해 완전 폐기되었다. 이에 따른 변경:

- `sdk/` 디렉터리 전체 삭제 (`sdk/src/`, `sdk/shared/`, `sdk/package.json`, `sdk/dist/`)
- `query-runtime-bridge.ts`, `sdk/src/query/registry.ts` 삭제
- config manifests는 `sdk/shared/` → `get-shit-done/bin/shared/`로 이동(`config-schema.manifest.json`, `config-defaults.manifest.json`)
- `gsd-sdk query` 호출 패턴은 `gsd_run query`(=`gsd-tools.cjs query`)로 일원화
- CommandRoutingHub에서 `mode`, `sdkLoader`, `SdkLoadFailed`, `SdkDispatchFailed` 삭제
- CLI modules 수량: 74(bdcaab2c) → 79(9b5ee373)로 증가

### 4. 패키지명 최종 확정

구 저장소 `bdcaab2c` 시점의 문서에는 `@opengsd/get-shit-done-redux`로 변경 예정이라고 기록했으나, gsd-core의 실제 패키지명은 `@opengsd/gsd-core`로 확정되었다(`package.json:2` @ `9b5ee373`). `@opengsd/get-shit-done-redux`는 중간 과도기 이름이었다.

### 5. 신규 추가된 주요 표면

gsd-core에서 새로 추가된 주요 명령/기능:
- `mvp-phase`, `spec-phase`, `ui-phase`, `ai-integration-phase`: 특화된 계획 단계 지원
- `plan-review-convergence`: cross-AI 계획 수렴 루프
- `ultraplan-phase` (BETA): Claude Code ultraplan cloud 오프로드
- `spike`, `sketch`: 탐색 작업과 UI 스케치
- `review` 명령의 `--agy`/`--antigravity` 플래그: Antigravity peer reviewer 통합
- `quick`, `gsd-do`: 경량 실행 경로
- Antigravity, Windsurf, Augment, Trae, Qwen, Hermes, CodeBuddy, Cline 런타임 지원 추가

## 근거 목록

### README 및 상위 문서

- `README.md:7-9`: 프로젝트 성격과 다중 런타임 대상.
- `README.md:61-63`: context engineering, XML prompt formatting, subagent orchestration, state management.
- `README.md:71-127`: core six-command loop.
- `README.md:107-109`: execute 단계의 parallel waves, fresh 200k context, atomic commits, main context budget.
- `README.md:137-145`: installer, runtime prompt, global/local, profile 설명.
- `README.md:151-168`: command table과 surface.
- `README.md:176-180`: context bloat, file memory, verification.
- `README.md:186-203`: `.planning/config.json`, knobs, fallow, package legitimacy.
- `README.md:221-225`: runtime install roots와 Codex minimum.
- `docs/ARCHITECTURE.md:38-65`: 전체 레이어 구조.
- `docs/ARCHITECTURE.md:72-83`: fresh context agent와 thin workflow.
- `docs/ARCHITECTURE.md:85-96`: `.planning` file state와 absent=enabled.
- `docs/ARCHITECTURE.md:97-105`: defense-in-depth.
- `docs/ARCHITECTURE.md:123-128`: namespace routing token savings.
- `docs/ARCHITECTURE.md:145-170`: progressive disclosure와 workflow file budget.
- `docs/ARCHITECTURE.md:481-569`: install files와 `.planning` layout.
- `docs/ARCHITECTURE.md:682-703`: package legitimacy/slopsquatting gate.
- `docs/ARCHITECTURE.md:724-777`: runtime abstraction matrix.

### 인벤토리와 명령 문서

- `docs/INVENTORY.md:3-9`: authoritative roster와 drift-control tests.
- `docs/INVENTORY.md:13`: agents count.
- `docs/INVENTORY.md:57`: commands count.
- `docs/INVENTORY.md:167`: workflows count.
- `docs/INVENTORY.md:265`: references count.
- `docs/INVENTORY.md:364`: CLI modules count.
- `docs/INVENTORY.md:448`: hooks count.
- `docs/INVENTORY.md:473`: shipped files enumeration test.
- `docs/COMMANDS.md:7-13`: runtime별 invocation syntax.
- `docs/COMMANDS.md:17-30`: namespace meta-skills.
- `docs/COMMANDS.md:34-252`: core workflow commands.
- `docs/COMMANDS.md:999-1043`: map-codebase와 graphify.
- `docs/COMMANDS.md:1097-1125`: code-review.
- `docs/COMMANDS.md:1171-1209`: cross-AI review.
- `docs/COMMANDS.md:1230-1272`: secure/docs-update.
- `docs/COMMANDS.md:1424-1435`: command description budget.

### 대표 명령 및 워크플로

- `commands/gsd/plan-phase.md:1-35`: plan-phase command frontmatter와 workflow 참조.
- `commands/gsd/execute-phase.md:1-31`: execute-phase command frontmatter와 context budget.
- `commands/gsd/new-project.md:1-33`: new-project command 산출물.
- `commands/gsd/ns-workflow.md:16-28`: namespace routing table.
- `commands/gsd/map-codebase.md:15-75`: mapper direct-write와 4개 mapper flow.
- `commands/gsd/surface.md:12-139`: surface command와 runtime config resolution.
- `get-shit-done/workflows/new-project.md:60-67`: init context.
- `get-shit-done/workflows/new-project.md:793-988`: researcher와 synthesizer.
- `get-shit-done/workflows/new-project.md:1209-1346`: roadmapper와 commit.
- `get-shit-done/workflows/discuss-phase.md:14-31`: lazy-loaded mode bodies/templates/advisor.
- `get-shit-done/workflows/discuss-phase.md:370-464`: CONTEXT/DISCUSSION-LOG 작성과 commit.
- `get-shit-done/workflows/plan-phase.md:31-40`: `init.plan-phase`.
- `get-shit-done/workflows/plan-phase.md:482-529`: researcher spawn.
- `get-shit-done/workflows/plan-phase.md:859-993`: planner spawn.
- `get-shit-done/workflows/plan-phase.md:1200-1249`: plan-checker spawn.
- `get-shit-done/workflows/plan-phase.md:1307-1594`: revision, coverage, state/roadmap record.
- `get-shit-done/workflows/execute-phase.md:80-111`: runtime/worktree config.
- `get-shit-done/workflows/execute-phase.md:415-472`: checkpoint와 same-wave overlap.
- `get-shit-done/workflows/execute-phase.md:531-610`: Agent dispatch와 worktree prompt.
- `get-shit-done/workflows/execute-phase.md:739-763`: manifest cleanup.
- `get-shit-done/workflows/execute-phase.md:918-981`: single-writer state update와 post-wave tests.
- `get-shit-done/workflows/execute-phase.md:1450-1611`: verifier와 phase completion.
- `get-shit-done/workflows/verify-work.md:206-259`: UAT 파일 생성.
- `get-shit-done/workflows/verify-work.md:524-639`: debug/gap closure agents.
- `get-shit-done/workflows/map-codebase.md:15-23`: mapper agent 사용 이유.
- `get-shit-done/workflows/map-codebase.md:130-249`: mapper Agent calls.
- `get-shit-done/workflows/map-codebase.md:343-381`: secret scan과 commit.

### 에이전트 프롬프트

- `docs/AGENTS.md:3-9`: 에이전트 수량과 thin orchestrator 원칙.
- `docs/AGENTS.md:154-162`: planner.
- `docs/AGENTS.md:198-206`: executor.
- `docs/AGENTS.md:221-229`: plan-checker.
- `docs/AGENTS.md:276-284`: verifier.
- `docs/AGENTS.md:340-348`: codebase mapper.
- `docs/AGENTS.md:723-755`: tool permission summary.
- `agents/gsd-planner.md:23-30`: plans as prompts.
- `agents/gsd-planner.md:355-366`: dependency graph와 waves.
- `agents/gsd-planner.md:421-439`: PLAN frontmatter.
- `agents/gsd-planner.md:619-629`: requirement/package/security coverage.
- `agents/gsd-plan-checker.md:1-30`: read-only checker와 stance.
- `agents/gsd-plan-checker.md:111-122`: requirement coverage.
- `agents/gsd-plan-checker.md:300-494`: context/Nyquist checks.
- `agents/gsd-executor.md:15-19`: executor responsibilities.
- `agents/gsd-executor.md:283-315`: checkpoint protocol과 package exception.
- `agents/gsd-executor.md:409-552`: commit safety와 destructive command prohibition.
- `agents/gsd-verifier.md:15-26`: evidence-first verification.
- `agents/gsd-verifier.md:217-321`: artifact/data-flow verification.
- `agents/gsd-phase-researcher.md:267-293`: package legitimacy gate.
- `agents/gsd-codebase-mapper.md:18-23`: direct-write/confirmation-only.

### SDK, 설치기, 후크, 스크립트, 템플릿

- `docs/CLI-TOOLS.md:1-20`: gsd-tools.cjs primary surface (`9b5ee373`).
- `docs/CLI-TOOLS.md:291-319` (검증 완료 2026-06-01, `9b5ee373`; 구 저장소 325-354에서 이동): init compound context loading.
- `docs/CLI-TOOLS.md:411-416` (검증 완료 2026-06-01, `9b5ee373`; 구 저장소 386-431에서 이동): git commit helper와 `--no-verify`.
- `sdk/src/query/registry.ts`: ADR-0174에 의해 삭제됨. gsd-core에 없음.
- `sdk/src/query-runtime-bridge.ts`: ADR-0174에 의해 삭제됨. gsd-core에 없음.
- `get-shit-done/bin/lib/command-routing-hub.cjs:39-47`: 4-값 closed errorKind enum (`9b5ee373`).
- `get-shit-done/bin/gsd-tools.cjs:1-20`: CJS 단일 진입점 (`9b5ee373`).
- `get-shit-done/bin/lib/runtime-artifact-layout.cjs:1-9`: runtime artifact layout source of truth (`9b5ee373`).
- `get-shit-done/bin/lib/install-profiles.cjs:1-30`: skill budget (`9b5ee373`).
- `get-shit-done/bin/lib/install-profiles.cjs:58-89`: core/standard/full profiles (`9b5ee373`).
- `get-shit-done/bin/shared/config-schema.manifest.json`: 구 `sdk/shared/config-schema.manifest.json`에서 이동됨 (`9b5ee373`).
- `get-shit-done/bin/shared/config-defaults.manifest.json`: 구 `sdk/shared/config-defaults.manifest.json`에서 이동됨 (`9b5ee373`).
- `bin/install.js:180-240`: runtime/profile flags.
- `bin/install.js:396-552`: config dir resolution.
- `bin/install.js:8809-8844`: Codex snapshot/rollback.
- `bin/install.js:9121-9145`: Codex hook config fatal restore.
- `hooks/gsd-context-monitor.js:1-19`: context monitor 목적.
- `hooks/gsd-prompt-guard.js:3-12`: prompt guard 목적.
- `hooks/gsd-read-guard.js:3-19`: read guard 목적.
- `hooks/gsd-read-injection-scanner.js:3-17`: read injection scanner 목적.
- `hooks/gsd-statusline.js:321-340`: statusline bridge.
- `scripts/run-tests.cjs:1-18`: test runner 목적.
- `scripts/lint-command-contract.cjs:39-74`: command contract lint.
- `scripts/lint-skill-deps.cjs:69-139`: skill dependency/profile closure lint.
- `scripts/prompt-injection-scan.sh:18-83`: prompt injection patterns와 allowlist.
- `scripts/secret-scan.sh:19-57`: secret patterns.
- `get-shit-done/templates/project.md:1-4`: project template.
- `get-shit-done/templates/requirements.md:77-110`: requirement traceability.
- `get-shit-done/templates/roadmap.md:27-38`: phase detail format.
- `get-shit-done/templates/state.md:84-121`: STATE lifecycle.
- `get-shit-done/templates/phase-prompt.md:15-31`: PLAN frontmatter.

## ditto 적용 정리

### ditto에 적용할 기능/가치

1. **얇은 명령 표면과 lazy workflow**
   ditto는 범용 개발 작업을 돕는 coding agent harness이고, 사용자 인지 비용과 token 비용을 줄이는 것이 핵심 가치다. 이 문서의 GSD처럼 런타임 entrypoint는 짧은 command/skill 계약만 두고, 긴 절차는 workflow 문서로 지연 로드하는 구조를 적용한다(`commands/gsd/plan-phase.md:1-35`, `commands/gsd/execute-phase.md:1-31`, `docs/ARCHITECTURE.md:123-170`).

2. **파일 기반 상태, 감사 기록, 재개 가능한 산출물**
   PURPOSE.md는 모든 액션의 감사 기록, 주요 결정/변경사항 영속화, 새 세션에서 이어받기, 장기 실행 작업 완수를 요구한다. GSD의 `.planning/PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`, phase plan, summary, verification artifact 모델을 ditto의 세션/작업 상태 계약으로 축소 적용한다(`docs/ARCHITECTURE.md:85-96`, `docs/ARCHITECTURE.md:481-569`, `get-shit-done/templates/state.md:84-121`).

3. **planner/checker/executor/verifier 역할 분리**
   PURPOSE.md의 “할루시네이션 방지”, “LLM의 자기 확신을 깨기”, “서브 에이전트를 통한 Context Rot 해결”에는 작성자와 검증자를 분리하는 구조가 직접 맞는다. GSD의 planner, read-only plan-checker, executor, evidence-first verifier 분리를 ditto의 기본 오케스트레이션 단계로 적용한다(`docs/AGENTS.md:3-9`, `agents/gsd-plan-checker.md:1-30`, `agents/gsd-executor.md:15-19`, `agents/gsd-verifier.md:15-26`).

4. **PLAN frontmatter 기반 병렬 실행 통제**
   ditto가 subagent를 적극 사용하는 경우 병렬성 자체보다 충돌 방지가 먼저다. GSD의 wave, dependency, files, must_haves frontmatter와 same-wave file overlap gate를 사용해 병렬 작업자의 수정 범위와 검증 조건을 실행 전에 고정한다(`agents/gsd-planner.md:421-439`, `agents/gsd-planner.md:1024-1048`, `get-shit-done/workflows/execute-phase.md:440-472`).

5. **gsd-tools query registry와 하네스 품질 게이트**
   PURPOSE.md의 “정규화된 interface”, “단계 간 상태 전이”, “Token 비용 낭비 방지”를 위해 상태/검증/설정/커밋 조작은 prompt 안의 임의 shell이 아니라 `gsd_run query` command로 중앙화한다. GSD의 `CommandRoutingHub` unknown command fail-fast, inventory/lint/drift-control 패턴을 ditto의 harness 자체 검증 대상으로 둔다(`docs/CLI-TOOLS.md:1-20` @ `9b5ee373`, `get-shit-done/bin/lib/command-routing-hub.cjs:39-47` @ `9b5ee373`, `docs/INVENTORY.md:3-9` @ `9b5ee373`, `scripts/lint-command-contract.cjs:39-74` @ `9b5ee373`).

### 적용 방식

- 첫 단계는 GSD 전체 복제가 아니라 ditto의 최소 core loop를 `intent/context -> discuss/clarify -> plan -> plan-check -> execute -> verify -> handoff`로 고정하는 것이다. 각 단계는 PURPOSE.md의 오케스트레이션 요구처럼 입력, 출력, 수정 권한, 산출물 위치를 문서 계약으로 가진다.
- 상태 저장소는 GSD의 `.planning`을 그대로 베끼기보다 ditto 용어에 맞춰 세션 감사 로그, 의도/요구사항, 계획, 실행 summary, 검증 artifact, handoff를 분리한다. 각 파일은 다음 단계가 읽을 수만 있거나 수정할 수 있는 범위를 명확히 둔다.
- subagent 실행 전에는 PLAN frontmatter에 wave, depends_on, files_modified, must_haves, verification을 요구하고, orchestrator가 같은 wave의 파일 겹침을 감지하면 직렬화한다.
- verifier는 executor summary를 신뢰하지 않는다는 규칙을 prompt 계약에 넣고, 실제 파일 diff, 테스트 결과, 실행 로그, artifact 존재 여부를 근거로만 완료를 판정한다.
- command/agent/workflow/hook 목록은 사람이 쓴 문서 숫자에 의존하지 않고 inventory 생성물과 lint로 검증한다. GSD 보고서에서 확인된 수량 drift 리스크를 ditto에서는 초기에 구조적으로 줄인다(`docs/INVENTORY.md:448`, `docs/ARCHITECTURE.md:249-267`, `scripts/lint-command-contract.cjs:5`, `docs/INVENTORY.md:57`).

### 적용 이후 제공 가치

- 사용자는 긴 내부 절차 대신 정제된 상태, 다음 판단에 필요한 근거, 검증 결과만 받게 되어 인지 비용이 줄어든다.
- 장기 작업 중 context가 약해져도 파일 기반 상태와 handoff artifact가 남아 세션을 이어받을 수 있다.
- 작성자와 검증자가 분리되어 “수정했다”는 자기보고보다 테스트, diff, artifact 같은 fresh evidence가 완료 판단의 기준이 된다.
- 병렬 subagent는 PLAN frontmatter와 overlap gate 안에서만 실행되어 다른 작업자의 변경을 되돌리거나 같은 파일을 동시에 수정할 위험이 줄어든다.
- SDK registry와 inventory/lint는 런타임별 prompt drift와 하네스 문서 drift를 줄여, ditto의 정규화된 인터페이스와 token 절감 목표에 맞는다.

### 리스크와 선행 조건

- GSD의 표면적은 67 commands, 88 workflows, 33 agents, 79 CLI modules, 13 hooks로 크다(`docs/INVENTORY.md:57`, `docs/INVENTORY.md:167`, `docs/INVENTORY.md:13`, `docs/INVENTORY.md:365`, `docs/INVENTORY.md:455` @ `9b5ee373`). ditto는 처음부터 이 규모를 가져오면 사용자의 인지 비용과 유지보수 비용을 늘리므로 최소 core loop부터 시작해야 한다.
- 파일 기반 상태는 schema와 lifecycle이 먼저 고정되어야 한다. 그렇지 않으면 PURPOSE.md의 “주요 결정 및 변경사항 영속화”가 산출물 난립으로 바뀐다.
- plan 품질이 낮으면 executor가 잘못된 계획을 빠르게 구현할 수 있다. GSD에서도 plan-checker와 coverage gate가 있는 이유가 이 리스크다(`get-shit-done/workflows/plan-phase.md:1200-1249`, `get-shit-done/workflows/plan-phase.md:1307-1555`).
- advisory/silent-fail hook만으로는 강제 보안 정책이 되지 않는다. ditto가 공급망/프롬프트 인젝션 위험을 강하게 막으려면 local advisory와 CI blocking scan을 분리해야 한다(`hooks/gsd-prompt-guard.js:80-95`, `hooks/gsd-read-injection-scanner.js:130-150`).
- runtime parity는 초기에 matrix로 관리해야 한다. GSD도 Codex worktree isolation 미지원, sequential fallback, runtime별 설치/호출 차이를 갖는다(`get-shit-done/workflows/execute-phase.md:80-111`, `get-shit-done/workflows/map-codebase.md:130-139`, `docs/COMMANDS.md:7-13`).

### 근거

- PURPOSE.md의 목적은 ditto를 범용 개발 작업용 coding agent harness로 정의하고, 사용자 인지 비용 절감, 근거 없는 출력 방지, 의도 이탈 제한, Context Rot 해결, 장기 작업 완수, token 비용 절감을 핵심 가치로 둔다.
- PURPOSE.md의 핵심 기능은 감사 기록, 결정/변경사항 영속화, subagent 활용, 사용자에게 충분한 context를 주는 정제된 출력, 불필요한 질문 금지, 정규화된 단계 interface, 끝까지 완수하는 오케스트레이션을 요구한다.
- 이 보고서의 GSD 분석은 위 가치에 직접 연결되는 구현 근거를 제공한다. 얇은 command와 lazy workflow는 prompt surface와 token 비용을 줄이고(`docs/ARCHITECTURE.md:123-135` @ `9b5ee373`), `.planning` 상태 모델은 재개성과 감사 가능성을 만든다(`docs/ARCHITECTURE.md:85-96` @ `9b5ee373`). 역할 분리와 evidence-first verifier는 할루시네이션과 자기 확신을 견제한다(`agents/gsd-plan-checker.md:1-30` @ `9b5ee373`, `agents/gsd-verifier.md:15-26` @ `9b5ee373`). PLAN frontmatter와 overlap gate는 병렬 subagent 실행을 통제한다(`agents/gsd-planner.md:421-439` @ `9b5ee373`, `get-shit-done/workflows/execute-phase.md:440-472` @ `9b5ee373`). `CommandRoutingHub`와 inventory/lint는 정규화된 interface와 drift control을 하네스 품질 게이트로 만든다(`docs/CLI-TOOLS.md:1-20` @ `9b5ee373`, `get-shit-done/bin/lib/command-routing-hub.cjs:39-47` @ `9b5ee373`, `docs/INVENTORY.md:3-9` @ `9b5ee373`).

## ditto 적용 요소 후보 (skills/agents/commands/hooks)

| 우선순위 | 종류 | 요소 | DITTO 적용안 | 효과/주의 |
| --- | --- | --- | --- | --- |
| 바로 적용 | command + agent | `verify-work` + `gsd-verifier` | DITTO의 완료 직전 검증 command로 축소 이식한다. executor summary를 신뢰하지 않고 diff, test, runtime artifact, acceptance criteria별 상태를 다시 확인한다. | "수정했다"와 "검증했다"를 분리한다. 작은 작업에서는 lightweight verifier로 자동 축소해야 한다. |
| 바로 적용 | agent | `gsd-plan-checker` | 구현 전 계획을 read-only로 검토하는 agent를 둔다. requirement coverage, dependency, 파일 충돌, 검증 가능성을 확인하고 실패 시 계획으로 되돌린다. | 잘못된 계획을 빠르게 구현하는 문제를 줄인다. planner와 같은 context를 공유하지 않는 것이 중요하다. |
| 바로 적용 | command + agent | `map-codebase` + `gsd-codebase-mapper` | 새 repo나 큰 모듈 진입 시 read-only mapper가 repo map을 직접 작성하고 parent는 confirmation만 받는다. DITTO에서는 `reports`가 아니라 작업용 knowledge/cache 위치에 둔다. | 반복 탐색 비용과 context rot을 줄인다. secret 파일과 generated 파일 제외 규칙이 필요하다. |
| 수정 적용 | command | `surface` | 설치된 skill/agent/command 표면과 token budget을 보여주는 DITTO `surface`/`inventory` 명령으로 차용한다. profile별 enabled surface와 이유를 함께 출력한다. | 사용자가 현재 하네스가 무엇을 할 수 있는지 낮은 비용으로 이해한다. 단순 목록이 아니라 실제 로딩 여부와 연결해야 한다. |
| 수정 적용 | hook/script | `gsd-read-injection-scanner`, `prompt-injection-scan.sh`, `secret-scan.sh` | read-time prompt injection advisory와 CI blocking scan을 분리한다. 런타임 hook은 경고/감사 기록 중심, release/CI에서는 실패시키는 방식으로 둔다. | 안전성에 즉시 도움된다. silent-fail hook만으로 보안 정책을 대체하면 안 된다. |
| 수정 적용 | hook | `gsd-context-monitor`, `gsd-statusline` | context remaining, active phase, current state를 statusline/telemetry로 노출한다. critical 구간에서는 자동 handoff artifact 생성을 트리거한다. | 장기 작업 중 context rot을 조기에 드러낸다. host별 context metric 신뢰도가 달라 compatibility layer가 필요하다. |
| 수정 적용 | agent | `gsd-phase-researcher`의 package legitimacy gate | 새 dependency, 외부 패키지, 보안 민감 변경에는 provenance tag와 package legitimacy check를 요구한다. | 공급망 리스크와 hallucinated package 사용을 줄인다. 일반 구현 경로에 항상 강제하면 비용이 크므로 dependency 변경 시에만 켠다. |
| 수정 적용 | command | `review`(`--agy`/`--antigravity` 포함) | 멀티 모델 적대적 검토를 opt-in command로 둔다. 구 `cross-ai-review`는 `review`로 통합되었고 Antigravity peer reviewer 플래그가 추가되었다. 입력 diff, 목표, acceptance criteria, 비용 상한, output artifact 경로를 wrapper가 통제한다(`commands/gsd/review.md:4,36` @ `9b5ee373`). | PURPOSE.md의 멀티 모델 정반합에 직접 연결된다. raw external CLI 호출은 금지하고 provider/version을 기록해야 한다. |
