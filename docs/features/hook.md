# hook — 호스트가 발화하는 훅 이벤트를 이름으로 받아 해당 핸들러로 디스패치하는 단일 진입점

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋 `c2d2e16`, 작성일 2026-07-19.

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto hook <event>`는 호스트(Claude Code / Codex)의 훅 시스템이 세션 생애주기의 특정 순간에 호출하는 **단일 자기완결 진입점**이다. 호스트가 "어떤 훅이 언제 발화할지"를 결정하고, 플러그인 매니페스트(`hooks/hooks.json`)가 각 이벤트를 `bun "${CLAUDE_PLUGIN_ROOT}/bin/ditto" hook <event>`에 매핑한다. 이 커맨드는 stdin으로 받은 이벤트 JSON을 읽어 이름에 맞는 핸들러를 실행할 뿐이다(`src/cli/commands/hook.ts:11-23`).

핵심 설계 이유는 배포 이식성이다. `bin/ditto`는 `bun build --target=bun`으로 만든 단일 JS 번들(소스+의존성 한 파일)이라, 대상 프로젝트는 `src/`도 `node_modules`도 없이 PATH의 `bun` 하나와 이 번들만 있으면 훅이 돈다(`hook.ts:16-22`). 과거의 `bun run hooks/<event>.ts`(소스 트리 의존)를 대체한다.

DITTO 4축(의도/오케스트레이션/E2E/지식) 자체는 아니고, 그 축들을 **런타임에 집행·주입·기록하는 거버넌스 기층**이다. 훅은 세 가지 서로 다른 일을 한다:

- **가드(집행)** — PreToolUse가 파괴적·범위위반·비밀노출 도구 호출을 차단(exit 2)한다.
- **주입(조향)** — UserPromptSubmit이 charter(prime directive)를, SessionStart가 모드 배너를 매 턴/세션 컨텍스트에 주입한다.
- **기록/게이트** — PostToolUse가 증거를 수집하고, Stop이 완료 게이트를 집행하며, PreCompact가 핸드오프를 영속화한다.

## 2. 코드 위치와 진입점

핵심 파일:

| 경로 | 역할 |
|---|---|
| `src/cli/commands/hook.ts` | CLI 진입. event 이름 → 핸들러 디스패치 |
| `src/hooks/io.ts` | stdin 읽기, repoRoot 해석, 핸들러 실행 후 exit |
| `src/hooks/runtime.ts` | fail-open 래퍼 + kill-switch, `HookInput`/`HookOutput` 계약 |
| `src/hooks/pre-tool-use.ts` | PreToolUse 가드(파괴/비밀/scope-out/forbidden_scope/lease) |
| `src/hooks/user-prompt-submit.ts` | charter 주입 + 활성 work item 해석 + 자문 |
| `src/hooks/session-start.ts` | 모드 배너 + worktree 세션 자동 바인딩 |
| `src/hooks/post-tool-use.ts` | Bash/편집 도구 증거 수집(관측 전용) |
| `src/hooks/pre-compact.ts` | compaction 직전 핸드오프 영속화 |
| `src/hooks/stop.ts` | 완료·수렴·landed 게이트, 결정충돌 fail-closed |
| `src/hooks/semantic-nudge.ts` | Stop 시점 의미검사 자문(비차단) |
| `src/hooks/envelope.ts` | 호스트별 편집 도구 shape 정규화(Claude Write/Edit vs Codex apply_patch) |
| `src/core/charter.ts` | `PRIME_DIRECTIVE` 텍스트 + `charterProjection()` |

CLI 인자(`hook.ts:47-58`):

| 인자 | 형태 | 기본값 | 설명 |
|---|---|---|---|
| `event` | positional (필수) | — | `session-start`\|`user-prompt-submit`\|`pre-tool-use`\|`post-tool-use`\|`pre-compact`\|`stop` |
| `--host` | string | `claude-code` | stdin/env 봉투를 만든 호스트: `claude-code`\|`codex` |

알 수 없는 event는 stderr 후 `process.exit(2)`, 잘못된 `--host`도 exit 2 (`hook.ts:60-73`). `HANDLERS` 레코드가 6개 이벤트를 매핑하고 `HOOK_EVENTS`로 노출한다(`hook.ts:24-33`).

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

```
호스트가 이벤트 발화
  → hooks.json 매핑 → bun bin/ditto hook <event> [--host]
  → hook.ts: HANDLERS[event] 조회 (없으면 exit 2)
  → executeHook(handler, host)  [io.ts:42]
      → readStdinJson()          : stdin JSON 파싱 (빈/오류 → null)   [io.ts:5]
      → resolveRepoRoot(host,raw): 세션 rooting root 해석             [io.ts:28]
      → runHook(handler, input)  : kill-switch + try/catch fail-open [runtime.ts:37]
      → out.stdout/stderr 출력 → process.exit(out.exitCode)          [io.ts:53-56]
```

`HookInput`(`runtime.ts:22-30`)은 `{ raw, repoRoot, env, host }`. `repoRoot`는 단순 cwd가 아니라 **워크스페이스 rooting root**로 해석된다: Claude Code는 `$CLAUDE_PROJECT_DIR`, Codex는 `raw.cwd`에서 출발해 `.ditto`(없으면 `.git`)를 가진 가장 가까운 조상으로 올라간다(`io.ts:28-39`, `resolveRepoRootForCreate`). 그래서 sub-repo에서 세션이 시작돼도 상태는 워크스페이스에 뿌리내린다(ADR-20260626-worktree-subrepo-scope-clarify D2).

읽고 쓰는 상태 파일(work item dir = `.ditto/local/work-items/<wi>/`):

- **읽기**: `completion.json`, `convergence.json`, `autopilot.json`, `intent.json`, `reviews/dialectic-*.json`, `acg-review.json`, `assurance-snapshot.json`, `impact-graph.json`, `semantic-compatibility.json`, `knowledge-gate.json`, `decision-conflict.json`, `direction-fork.json` (전부 Stop 게이트 입력, `stop.ts:739-808`), `.ditto/architecture-spec.json`(scope 매칭, `pre-tool-use.ts:527-536`), ChangeContract·active-node lease·session-pointer 스토어.
- **쓰기**: PostToolUse가 `evidence/commands.jsonl`·`evidence/edits.jsonl`(`post-tool-use.ts`), UserPromptSubmit이 `logs/user-prompt.jsonl`(`user-prompt-submit.ts:263-271`), Stop이 `assurance-snapshot.json`·`metrics.jsonl`·autopilot decision log(`stop.ts:537,595,666`), PreToolUse가 `.ditto/autopilot-bypass.jsonl`(`pre-tool-use.ts:606-614`), PreCompact가 핸드오프(`pre-compact.ts:49`), SessionStart/UserPromptSubmit이 session-pointer.

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 4-1. 두-층 fail-open/fail-closed (D4)

`runtime.ts:1-11`이 규정한 불변식이다:

- 훅이 **크래시**(예상 못한 예외·IO 오류)하면 **fail OPEN(exit 0)** — 망가진 훅이 사용자 세션을 끊으면 안 된다. `runHook`의 try/catch가 여기 담당(`runtime.ts:40-47`).
- 게이트가 정상 실행돼 **비준수를 판정**하면 **fail CLOSED(exit 2)** — 이건 크래시가 아니라 판정(verdict)이다. 핸들러가 스스로 exit 2를 산출하고 **throw하지 않는다**. malformed 아티팩트(completion/convergence/autopilot 등)는 게이트-입력 위반이므로 핸들러 안에서 exit 2(`runtime.ts:8-10`, `stop.ts:810-830`).

이 구분이 왜 중요한가: PreToolUse 가드 본문은 kill-switch를 재확인하지 않고 스스로 try/catch로 감싸지도 않는다(`pre-tool-use.ts:22-24`) — throw는 반드시 fail open이어야 하기 때문. 판정과 사고를 뒤섞으면 "안전 가드가 오히려 세션을 죽이는" 역효과가 난다.

### 4-2. 단일 kill-switch (`DITTO_SKIP_HOOKS`)

`runHook` 진입 즉시 `input.env[KILL_SWITCH]`가 있으면 exit 0으로 모든 DITTO 훅을 무력화한다(`runtime.ts:38-39`). 유일한 공인 탈출구이고, 모든 PreToolUse block 메시지가 이 우회법을 안내한다(`pre-tool-use.ts:38`). autopilot lease 우회는 이것과 **별개**인 `DITTO_AUTOPILOT_BYPASS=1`이다(`pre-tool-use.ts:599-603`) — kill-switch가 전체를 끈다면 이쪽은 lease allow-list만 뚫고 우회 기록을 남긴다.

### 4-3. 기본 ALLOW, 확신할 때만 BLOCK (PreToolUse)

가드는 보수적 화이트리스트가 아니라 "확실히 위험할 때만 차단, 나머지는 통과"다(`pre-tool-use.ts:26-28,42`). 매치 안 되는 도구·없는 필드·비문자열은 절대 차단하지 않는다. 이는 오탐(false block)이 세션 마찰을 키우기 때문 — 실제로 커밋 메시지·heredoc·따옴표 안 텍스트가 오탐을 냈던 이력이 코드 주석에 남아 있다(`pre-tool-use.ts:456-459,918-933`).

### 4-4. 이중 호스트 (ADR-0016)

핸들러는 host-agnostic이고 I/O 봉투만 다르다(`envelope.ts:1-19`). 유일하게 게이트 동작을 바꾸는 차이는 편집 도구 shape다: Claude는 `Write/Edit/MultiEdit` + `file_path`, Codex는 `apply_patch` + patch 텍스트 안 헤더 경로. `mutatedPaths(host, raw)`가 이를 정규화해 양쪽이 동일 정책을 통과하게 한다(`envelope.ts:52-67`, `pre-tool-use.ts:847-853`).

### 4-5. 결정충돌 가드레일 (ADR-0020)

Stop이 `decision-conflict.json` carrier를 읽어 `decisionConflictGate`로 분기한다(`stop.ts:487-507,1023-1029`). intent 충돌은 autopilot에서 fail-closed(block), method 충돌은 자동 정렬하되 **항상 공개(advisory)** — D2 투명성 불변식은 "에이전트가 ADR을 따랐어도 조용히 넘어가지 않는다"를 요구한다. 그래서 auto-align조차 advisory로 출력에 실린다(`stop.ts:500-506`).

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### 훅별 발화 시점·조건 요약

| 훅 이벤트 | 언제 발화 | 무엇을 하는가 | exit 의미 |
|---|---|---|---|
| SessionStart | 세션 열림 | worktree cwd면 세션→work item 자동 바인딩; ditto repo면 모드 배너 주입 | 항상 0 (자문) |
| UserPromptSubmit | 매 사용자 프롬프트 | charter(prime directive) 주입 + 활성 work item 해석 + deep-interview/self-answer 자문 | 항상 0 (자문) |
| PreToolUse | 도구 실행 직전 | 파괴적/비밀/scope-out/forbidden_scope/autopilot-lease 위반 차단 | 위반 시 2, 아니면 0 |
| PostToolUse | 도구 실행 직후 | Bash 명령·편집 파일을 evidence jsonl에 기록 | 항상 0 (관측) |
| PreCompact | 컨텍스트 compaction 직전 | 활성 work item 핸드오프를 디스크에 영속화 | 항상 0 (관측) |
| Stop | 에이전트가 멈추려 할 때 | 완료·수렴·landed·결정충돌 게이트; 미완이면 계속 강제 | 계속 강제 시 2, 완료면 0 |

### PreToolUse — `preToolUseHandler` (`pre-tool-use.ts:767-884`)

도구 종류별 분기:

1. **Codex `write_stdin`**: apply_patch 내용을 담을 수 있어 경로 추출 후 게이트(`:774-782`).
2. **셸(`Bash` / Codex `exec_command`)** (`:785-838`):
   - Codex가 셸로 `apply_patch`를 우회 실행하면 차단(`:789-794`).
   - `checkDestructive`(`:437-520`): 리터럴 wipe(`rm -rf /`), 재귀-force rm의 repo/home 밖 절대경로, fork bomb, `mkfs`, `dd of=/dev/`, sudo+파괴명령, **기본 브랜치 force-push**, **`git push --no-verify`**(pre-push 테스트 게이트 우회 차단), Windows 파괴 명령(`windowsDestructiveReason`, `:409-435`).
   - `bashSecretExposure`(`:217-267`): **default-deny** 비밀 노출 스캔 — 알 수 없는 verb가 비밀 파일을 파일 피연산자/stdin 소스로 쓰면 차단. metadata verb(`ls`/`stat`), grep 검색-패턴 위치, 템플릿 접미사(`.env.example`)만 예외.
   - `bashWriteTargets`(`:914-967`): 정적으로 추출한 리다이렉트/`tee`/`cp`/`mv` 대상이 repo 밖이면 scope-out 차단(Claude 메모리 dir·system tmp는 예외).
   - JVM CodeQL cross_repo 가드(`:824-836`, ADR-0007).
3. **Codex `apply_patch`**(`:847-853`): 패치가 건드리는 **모든 경로**에 `checkMutatedPath` — 하나라도 위반하면 차단.
4. **파일 도구**(`:855-881`): 비밀 파일은 읽기·쓰기 모두 차단(`:860-862`); Write/Edit/MultiEdit이면 scope-out → forbidden_scope → autopilot-lease 순.

**forbidden_scope 집행** `checkForbiddenScope`(`:546-589`): 현재 세션의 work item ChangeContract를 읽어, whitelist 모드(cleanup profile)면 `allowed_scope` 밖 편집을 차단하고, blacklist 모드(기본)면 `forbidden_scope` 히트를 차단. 세션 없음·계약 없음·빈 forbidden은 전부 undefined(ALLOW)로 fail-open.

**autopilot 경로 강제** `checkAutopilotLease`(`:677-765`): 진행 중 노드는 active-node lease(node_id + file_scope)를 쥔다. 편집 경로가 **어떤 활성 lease의 file_scope 안**에 들 때만 허용하는 allow-list. 전제 부재(세션 없음·활성 WI 없음·그래프 없음·비terminal 노드 없음·활성 lease 없음)는 전부 fail-open — lease는 노드가 도는 동안에만 존재하므로, lease 없음 = 아무것도 dispatch 안 됨 = 오탐하면 안 됨(`:670-676`). 미묘한 결정 셋:
   - `scope_source==='derived'` lease가 하나라도 있으면 미집행(`:715`) — derived는 concurrency 휴리스틱이지 의도한 write-set이 아님.
   - read-only 노드의 빈 file_scope는 deny-all을 만들면 안 되므로 제외하되, **mutating 노드의 빈 scope는 제외 안 함**(그건 닫아야 할 우회, `:725-730`).
   - mutating 노드가 활성이면 `tests/**` 동반 편집은 결정적 ALLOW(RED 테스트 파일, `:633,738-746`).
   - `DITTO_AUTOPILOT_BYPASS=1`이면 우회하되 `.ditto/autopilot-bypass.jsonl`에 정확히 한 줄 기록(`:749-758`).

### Stop — `stopHandler` (`stop.ts:710-1102`)

호출 순서와 인과:

1. `stop_hook_active===true`면 exit 0 — 이미 한 번 계속을 강제했으니 무한 루프 방지(`:713-714`).
2. `session_id`/pointer/work item 없으면 exit 0 — 판정할 대상 없음(`:718-734`).
3. `maybeRunFitness`(`:738`)로 fitness snapshot 최신화(입력 fingerprint 일치 시 스킵, `:524-535`).
4. 13개 아티팩트 읽기(`:739-808`). **하나라도 malformed면 exit 2**(게이트-입력 위반, `:810-830`).
5. **yield/force 우선순위 분류기**(`:839-884`, wi_260707loq): direction-fork(P1) → 승인 대기 mutating plan에서 intent-conflict(P2)/high-risk(P3)/oracle-gap(P4)이면 **yield(exit 0)**해 사용자에게 표면화; 아무 것도 아니면 일상적 procedure-punt이므로 **force-continue**하고 signature당 한 번 기록(P6, `:859-884`).
6. 그 뒤 각 아티팩트별 `*ForcesContinuation` 함수가 `reasons[]`에 사유를 쌓는다(`:886-1029`): completion 게이트, non-pass termination, convergence, autopilot 실행가능 노드, plan→autopilot 우회, residual resolvability, risk record, **land 게이트**(done∧pass인데 changed_files가 아직 uncommitted면 차단, `:962-975`), intent drift, dialectic, acg-review, assurance, impact, semantic, knowledge, decision-conflict.
7. `reasons.length>0`이면 exit 2 + 사유 목록; advisory·attestation 블록을 tail로 붙임(`:1066-1071`).
8. **strong-block**(`:1079-1090`): 비terminal work item이 completion/convergence/autopilot **전부 없이** 멈추려 하면 "검증 안 한 채 종료" 갭 → exit 2로 verify 실행 또는 done/abandoned 전환 요구.
9. 아무것도 강제 안 하면 semantic nudge(비차단) 붙여 exit 0(`:1096-1101`).

**terminal 회귀 방지**의 미묘함: done/abandoned work item에 남은 stale completion/convergence/autopilot는 계속-강제를 재발화하면 안 되므로, 완료 계속-검사들은 `NON_TERMINAL_STATUSES` 가드로 감싼다(`:905,925,932-937`, wi_2607083ch/wi_260713w0g).

### UserPromptSubmit — `userPromptSubmitHandler` (`user-prompt-submit.ts:273-343`)

매 프롬프트에 `charterProjection(ctx)`를 `additionalContext`로 주입(exit 0, 절대 차단 안 함, `:341-352`). `session_id` 없어도 charter는 주입(`:280-282`). `resolveActiveWorkItem`(`:147-218`)이 단일 활성 work item을 해석: pointer 있으면 로드, 없고 열린 항목 있으면 **ASK(자동 선택 금지)**, 없으면 GUIDE만. 명시적 resume(프롬프트가 `wi_` id를 선두에 두거나 resume 키워드 동반)만 pointer를 bind(`:119-131,182-186`). deep-interview 지시는 실행 의도 + (placeholder-only AC OR heavy risk signal)일 때 발화(`:326-329`). 핸드오프 본문은 더 이상 자동 주입 안 하고 GC(stale sweep)만 함(`:296-310`).

### charter (`src/core/charter.ts`)

`PRIME_DIRECTIVE`(`:60-89`)는 매 턴 재주입되는 압축된 규칙 anchor: 범위 보존(넓히지/줄이지/쪼개지 말라), 발견된 버그의 단일 예외(분류기-키드 defect-class carve-out), 두-경로 강제(무거운/가벼운 경로 밖 ad-hoc 편집 금지), 무게 라우팅, 증거 완료 게이트, 사용자향 출력 규범, `minimal-increment` self-check. 이 문자열들은 **표시 copy가 아니라 매 턴 에이전트를 조종하는 런타임 지시**라, 리라이트는 operative-cue 충실도로 게이트된다(ADR-20260713).

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위(6개 핸들러 + io/runtime/envelope/charter 소스 읽기, 매니페스트 대조)에서:

- **매니페스트 ↔ 핸들러 일치**: `hooks/hooks.json`의 6개 이벤트가 `HANDLERS`의 6개 키와 정확히 대응(`hook.ts:24-31` vs `hooks.json:3-66`). PreToolUse는 매니페스트에 등록돼 있고 핸들러도 실체가 있음.
- **fail-open/fail-closed 계약**: 모든 핸들러가 정상 판정은 exit 2를, 사고는 throw(→ runHook이 exit 0)를 쓰는 패턴을 지킴. malformed는 핸들러 안 exit 2로 처리(`stop.ts:810`, `io.ts:170-190`).
- **주의: `runtime.ts:34`의 `noOpHandler`는 현재 `HANDLERS`에서 미사용**이다 — PreCompact/PostToolUse가 실제 구현을 갖게 되면서 no-op stub이 남았다. 죽은 export로 보이나, 이 커맨드의 동작에는 영향 없음(미확인: 다른 곳 참조 여부는 확인 안 함).
- **--host codex 경로**: 코드상 apply_patch/exec_command/write_stdin 분기가 존재하나, 실제 Codex 호스트 e2e 동작은 이 문서 조사 범위에서 실행 검증하지 않음(미검증). 소스 로직은 Claude 경로와 대칭(`checkMutatedPath`가 Write/Edit 분기를 미러, `:886-911`).

확인 범위 밖에서 실행(런타임) 검증은 하지 않았다 — 위 판정은 소스 읽기 기반이다.

## 7. 잠재 위험·부작용·재설계 시 고려점

- **PreToolUse는 spawn을 관측 못 한다**(`pre-tool-use.ts:594-597`): lease allow-list는 in-flight 신호일 뿐 서브에이전트 spawn을 막지 못한다. autopilot 경로 강제가 근본적으로 heuristic임을 재설계 시 유지해야 한다(집행 경계 = codified artifact까지, ADR-20260628-delegation-enforcement-boundary).
- **정적 파싱의 한계**: `bashWriteTargets`·`bashSecretExposure`·destructive 검사는 셸 문자열을 정규식으로 파싱한다. 변수 확장·명령 치환·글로브(`$`,`` ` ``,`*`)는 판정 불가로 스킵(ALLOW). 즉 동적으로 조립된 파괴/노출 명령은 통과한다 — 이건 오탐을 줄이려는 의도적 트레이드오프이지 완전한 샌드박스가 아니다. 재설계 시 "확신할 때만 차단" 불변식을 깨면 세션 마찰이 폭증한다.
- **Stop 게이트의 fan-in 복잡도**: 13개 아티팩트 × yield/force 우선순위 × terminal-status 가드가 얽혀 있다. 새 게이트 추가 시 (a) malformed 배열에 포함, (b) `NON_TERMINAL_STATUSES` 가드 필요 여부, (c) `completionWouldClose` 게이팅 여부를 각각 판단해야 한다 — 하나 빠지면 stale 아티팩트가 닫힌 work item을 영원히 nagging하는 회귀(실제 발생 이력 wi_2607083ch/wi_260713w0g)나, 반대로 silent-terminate 갭이 생긴다.
- **repoRoot 오해석 위험**: rooting root가 `.ditto`/`.git` 조상 탐색에 의존한다(`io.ts:38`). 그 마커가 없거나 중첩 sub-repo면 scope/lease 비교가 어긋난다(worktree 상대화 `leaseScopeRelPath`, `:653-668`가 이를 보정하나 non-worktree 중첩은 별도 확인 필요 — 미확인).
- **charter drift**: `PRIME_DIRECTIVE`는 매 턴 주입되는 operative 지시라, 리워드/평문화 시 operative-cue가 조용히 약화되면 모든 미래 세션의 행동이 저하된다(가독성 검사로는 못 잡음). 재설계 시 반드시 보존할 불변식: cue-fidelity 게이트(before→after per-cue 단언, `tests/core/charter.test.ts`), ADR-20260713.
- **kill-switch의 광범위함**: `DITTO_SKIP_HOOKS=1`은 가드·게이트·주입·기록을 전부 끈다. 오탐 우회용이지만 켜둔 채 방치하면 완료 게이트와 증거 수집까지 무력화된다 — 재설계 시 "전체 무력화" vs "특정 가드만" 분리를 고려할 수 있다(현재는 autopilot lease만 별도 bypass 존재).
