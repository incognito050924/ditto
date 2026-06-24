# Codex ditto surface risk report

작성일: 2026-06-25

범위: 현재 저장소의 ditto Codex 표면(`skills`, `.codex/agents`, `hooks`, `doctor`)을 읽고, Codex에서 의도대로 잘 동작하지 않을 가능성이 큰 항목만 정리했다. 코드와 설정은 수정하지 않았다.

## 결론

현재 Codex 세션에서 ditto 기능은 보이지만, 그대로 오래 안정적으로 운용하기에는 몇 군데가 약하다. 가장 큰 위험은 세 가지다.

1. Codex 커스텀 에이전트가 Claude식 도구 허용 목록을 보존하지 못한다.
2. 여러 skill이 "반드시 subagent를 spawn"하는 절차를 전제로 하는데, 현재 Codex 런타임의 subagent 도구 정책과 충돌할 수 있다.
3. Codex 플러그인 활성 상태와 표면 목록을 판단하는 진단/설치 상태가 실제 세션 상태와 어긋난다.

## 위험 항목

### 1. Codex agent TOML은 per-tool allowlist를 보존하지 못한다

근거:

- `.codex/agents/implementer.toml:1-9`
- `.codex/agents/knowledge-curator.toml:1-9`
- `.codex/agents/playwright-e2e.toml:1-9`

모든 Codex agent TOML 상단에 같은 주석이 들어 있다.

- Claude 쪽 `tools` 목록은 Codex에서 per-tool allowlist로 보존되지 않는다.
- `sandbox_mode="read-only"`는 파일 쓰기를 막지만 Bash 실행 자체는 가능하다.
- 런타임 override가 기본 sandbox를 바꿀 수 있어 도구 제한의 충실도가 보존되지 않는다.

영향:

- `knowledge-curator`는 본문에서 "NO Bash", "docs-write-only"를 요구하지만 `.codex/agents/knowledge-curator.toml:27-31`, Codex TOML 수준에서는 그 정도의 도구 제한을 강제하지 못한다.
- `playwright-e2e`는 `sandbox_mode="read-only"`인데, 본문은 `.ditto/runs/<id>/`에 스크린샷/trace/요약 산출물을 만들라고 한다(`.codex/agents/playwright-e2e.toml:25-34`). read-only 기본값과 산출물 생성 계약이 긴장 관계에 있다.
- `implementer`/`refactorer`처럼 쓰기 권한이 필요한 agent와, reviewer/verifier처럼 읽기 중심인 agent의 권한 경계가 Claude만큼 엄격하게 분리되지 않는다.

판정: Codex에서 "역할별 도구 권한"이 보안/품질 게이트의 핵심이면 현재 작성만으로는 충분하지 않다. 프롬프트 지시에는 들어 있지만, 런타임 강제력은 약하다.

### 2. Autopilot과 일부 skill은 subagent spawn을 강하게 요구하지만 Codex 도구 정책과 충돌할 수 있다

근거:

- `skills/autopilot/SKILL.md:24-41`
- `skills/classify/SKILL.md:44-50`
- `skills/tech-spec/SKILL.md:73-93`

Autopilot은 `spawn`/`spawn_wave` 액션에서 owner stage subagent를 반드시 띄우라고 한다. 특히 `skills/autopilot/SKILL.md:34`는 "not optional"이라고 못박는다. `classify`도 후보 문서마다 fresh subagent를 fan-out하라고 하고, `tech-spec`도 question-generator N개와 question-gate를 fan-out/fan-in 구조로 쓰라고 한다.

현재 Codex 세션의 다중 에이전트 도구 설명은 "사용자가 subagent/delegation/parallel agent work를 명시적으로 요청하지 않으면 subagent를 spawn하지 말라"는 정책을 포함한다. 이 정책은 저장소 파일에 있는 규칙이 아니라 현재 런타임 도구 계약이므로 파일 라인으로 고정할 수는 없지만, 이번 세션에서 `tool_search`로 노출된 `multi_agent_v1.spawn_agent` 설명에서 확인했다.

영향:

- 사용자가 "autopilot 돌려줘"처럼 명시적으로 요청한 경우에는 의도상 spawn이 가능하다.
- 그러나 ditto hook이나 skill이 내부적으로 "계속 진행"을 요구하는 상황에서도, Codex 런타임 정책상 사용자의 명시 요청이 약하면 main agent가 spawn을 주저하거나 생략할 수 있다.
- Autopilot은 spawn 생략 자체를 런타임이 직접 관찰할 수 없다고 적고 있다(`skills/autopilot/SKILL.md:34`). 즉, 잘못 운용되면 "분리 컨텍스트에서 검증했다"는 설계 의도가 약해진다.

판정: Codex에서 autopilot/classify/tech-spec의 핵심 가치인 fresh context fan-out을 안정적으로 보장하려면, skill 문구만으로는 부족하다. Codex 도구 정책과 충돌하지 않도록 진입 조건이나 driver 지침이 더 명확해야 한다.

### 3. Hook 원본과 Codex 설치 산출물의 의미가 다르다

근거:

- 원본 `hooks/hooks.json:8-62`에는 `--host codex`가 없다.
- 설치 산출물 `.agents/plugins/ditto/hooks/hooks.json:8-62`에는 모든 hook command 끝에 `--host codex`가 붙어 있다.
- `scripts/build-codex-plugin.mjs:51-69`가 Codex build artifact에만 `--host codex`를 주입한다.
- `src/cli/commands/hook.ts:35-56`에서 `--host` 기본값은 `claude-code`다.

현재 설치 산출물은 Codex용으로 잘 변환되어 있다. 하지만 원본 `hooks/hooks.json`만 보면 Codex에서 hook handler가 `claude-code` 기본값으로 실행될 수 있다. build script 주석도 이 지점을 "deployment seam"이라고 부른다(`scripts/build-codex-plugin.mjs:51-56`).

영향:

- Codex가 반드시 `.agents/plugins/ditto/hooks/hooks.json` 또는 빌드된 Codex plugin 산출물을 읽으면 안전하다.
- 반대로 repo root의 원본 `hooks/hooks.json`이 Codex plugin manifest에 직접 연결되면 host envelope이 잘못 잡혀 Codex 전용 safety gate가 빠질 수 있다.

판정: 설치 산출물 기준으로는 통과하지만, 원본과 산출물의 의미 차이가 크다. Codex 표면 검증은 반드시 build/install artifact 기준으로 해야 한다.

### 4. `doctor capability`의 plugin-enabled 판정이 실제 Codex 설정과 어긋난다

근거:

- `src/core/capability-inventory.ts:32-43`은 `.ditto/local/codex-plugin-status.json`의 `status === "needs_user_action"`만 보고 `codex_plugin_needs_user_action`을 낸다.
- `.ditto/local/codex-plugin-status.json:1-10`은 현재도 `needs_user_action`이다.
- 실제 user config에는 `[plugins."ditto@ditto-local"] enabled = true`가 있다(`/Users/incognito/.codex/config.toml:126-132`).
- 실제 실행 결과: `ditto doctor capability --host codex --output json`은 `status: "drift"`와 `codex_plugin_needs_user_action`을 출력했다.

영향:

- 사용자는 이미 Codex에 plugin을 enabled로 등록했는데도 doctor는 계속 후속 등록 명령을 요구한다.
- "설정이 잘 됐는가"를 판단하는 명령이 false positive를 내므로, 운영자가 실제 문제와 stale 상태 파일을 구분해야 한다.

판정: Codex에서 사용할 수 있는지에 대한 자동 진단으로는 현재 `doctor capability`를 그대로 신뢰하기 어렵다.

### 5. Codex surface inventory가 중복 root를 동시에 스캔한다

근거:

- `src/core/hosts/codex.ts:78-84`는 `.agents/plugins/ditto`와 repo root 둘 다 plugin root로 취급한다.
- `ditto doctor surface --host codex --output json` 결과에 같은 plugin/skill/hook이 `.agents/plugins/ditto/...`와 repo root `skills/...`, `hooks/...` 양쪽에서 반복되어 나온다.
- `ditto doctor capability --host codex --output json`의 `hook_events`도 6개 hook이 두 번씩 들어 있었다.

영향:

- 현재는 set 비교 때문에 hook drift로 이어지지 않았지만, 보고서가 실제 "Codex가 읽는 하나의 표면"이 아니라 "설치 산출물 + repo 원본"을 합친 목록이 된다.
- 원본과 설치 산출물의 내용이 다를 때, 어떤 것이 실제 런타임 표면인지 판단이 흐려진다. 특히 hook의 `--host codex` 여부처럼 원본/산출물 차이가 중요한 경우 문제가 된다.

판정: surface inventory는 디버깅에는 유용하지만, Codex 런타임의 단일 진실원으로 보기 어렵다.

### 6. 활성 marketplace 복사본과 프로젝트/캐시 표면이 일부 다르다

근거:

- 현재 user config의 marketplace source는 `/Users/incognito/.codex/ditto-marketplace`다(`/Users/incognito/.codex/config.toml:126-129`).
- 그 marketplace 복사본의 skill 목록에는 `classify`, `cleanup`이 없었다.
- 프로젝트 repo의 `skills/`와 `.agents/plugins/ditto/skills/`에는 `classify`, `cleanup`이 있다.
- 프로젝트 `.codex/agents/`에는 `question-gate.toml`, `question-generator.toml`이 있지만, `/Users/incognito/.codex/ditto-marketplace/plugins/ditto/.codex/agents/`에는 두 파일이 없었다.

영향:

- 현재 세션에는 `classify`/`cleanup` skill과 question agent가 보였지만, 어떤 Codex 세션이 어떤 plugin source/cache를 읽는지에 따라 사용 가능한 표면이 달라질 수 있다.
- `tech-spec`은 question-generator/question-gate를 전제로 한다(`skills/tech-spec/SKILL.md:77-93`). 이 agent들이 없는 표면에서 시작되면 해당 workflow가 온전히 동작하지 않는다.

판정: 지금 세션은 충분히 풍부한 표면을 갖고 있지만, enabled marketplace source와 프로젝트-local 설치 산출물 사이의 차이는 재현성 위험이다.

### 7. 일부 skill은 Codex에서 자동 진행하기 어려운 사용자 대화/권한 모델을 전제로 한다

근거:

- `skills/autopilot/SKILL.md:27-32`는 approval pending, rollback, blocked, main_session 등에서 멈추거나 사용자 결정을 받아야 한다고 한다.
- `skills/tech-spec/SKILL.md:36-55`는 stepwise review와 사용자 확인을 전제로 한다.
- `skills/tech-spec/SKILL.md:93-95`는 selected question을 사용자에게 묻는 main-session 단계를 포함한다.

영향:

- 이 자체는 설계상 맞다. 다만 "without user intervention"처럼 보이는 autopilot 설명과 실제 사용자 결정 게이트가 섞여 있어, Codex에서 완전 자동 루프로 오해하기 쉽다.
- Codex hook이 계속 진행을 유도하더라도, 사용자 결정을 기다리는 지점에서는 멈춰야 한다. 이 구분이 약하면 불필요한 continuation이나 잘못된 자동 판단으로 흐를 수 있다.

판정: 기능이 깨진다는 뜻은 아니지만, Codex에서 "자동"과 "사용자 결정 대기"의 경계가 더 선명해야 안정적이다.

### 8. 현재 작업트리 기준으로는 설치본이 stale 상태다

근거:

- `ditto mode`를 새로 실행했을 때 `installed: present v0.2.0, STALE`, `drift: src=yes surface=yes`가 출력됐다.
- `ditto doctor distribution --host codex`를 새로 실행했을 때 `Hooks DRIFT ... (missing: binary_fresh)`가 출력됐다.
- `git status --short`에는 이 보고서 외에도 기존 수정/미추적 파일이 있었다.

영향:

- 현재 Codex 세션은 이미 로드된 표면을 쓰고 있으므로 당장 보이는 기능과는 별개다.
- 하지만 새 세션/재설치/배포 기준으로는 working tree, `.agents/plugins/ditto`, Codex plugin cache가 같은 내용을 가리킨다고 단정할 수 없다.
- 특히 위 3번, 6번처럼 원본과 설치 산출물의 차이가 중요한 항목에서는 stale 상태가 재현성을 더 낮춘다.

판정: "현재 세션에서 보인다"와 "다음 Codex 세션에서도 같은 표면이 뜬다"는 별개다. 지금 상태에서는 후자를 강하게 보장하기 어렵다.

## 이번 검토에서 문제로 보지 않은 것

- CLI 자체는 실행된다. `ditto --help`, `ditto mode`, `ditto doctor ...` 명령은 실행됐다.
- 설치된 hook artifact에는 `--host codex`가 붙어 있었다. 따라서 현재 설치 산출물만 보면 hook host 선택은 맞다.
- Codex custom agent 역할은 현재 세션의 `multi_agent_v1.spawn_agent` 선택지로 노출됐다. 문제는 "보이는가"가 아니라 "역할별 권한/절차가 의도대로 강제되는가"다.

## 검증한 명령

- `/Users/incognito/dev/projects/ditto/.agents/plugins/ditto/bin/ditto work start ... --output json`
- `/Users/incognito/dev/projects/ditto/.agents/plugins/ditto/bin/ditto --help`
- `/Users/incognito/dev/projects/ditto/.agents/plugins/ditto/bin/ditto mode`
- `/Users/incognito/dev/projects/ditto/.agents/plugins/ditto/bin/ditto doctor capability --host codex --output json`
- `/Users/incognito/dev/projects/ditto/.agents/plugins/ditto/bin/ditto doctor surface --host codex --output json`
- `/Users/incognito/dev/projects/ditto/.agents/plugins/ditto/bin/ditto doctor distribution --host codex`
- `/Users/incognito/dev/projects/ditto/.agents/plugins/ditto/bin/ditto doctor instructions --host codex`
- `find`, `rg`, `nl`, `sed`로 `skills/`, `.codex/agents/`, `hooks/`, `src/core/hosts/codex.ts`, `src/core/capability-inventory.ts`, `scripts/build-codex-plugin.mjs`, `src/core/setup.ts`를 확인했다.
