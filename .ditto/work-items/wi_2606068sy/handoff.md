# Handoff — DITTO 설치 스크립트 (wi_2606068sy) + 이 세션 전체 맥락

> 새 세션 인계용. 기준 HEAD = `4f2f1ff`. 이 세션 커밋 10개는 **전부 로컬(push 안 됨)**.

## 0. 셋업 (새 세션 첫 단계 — 순서대로)
```bash
cd /Users/incognito/dev/projects/ditto
git log --oneline -10          # 4f2f1ff가 HEAD인지 확인
bun --version                  # 1.3.14 여야 함 (이 세션에서 1.0.2→1.3.14 업그레이드)
bun install
bun run build && bun run build:bin   # bin/ditto = hook 바이너리. bin/은 gitignore라 새 세션서 반드시 빌드
bun test                       # 1212 pass / 9 skip / 0 fail 기대
bun run lint && bun run adr:guard    # green 기대
```
- **bin/ gitignore**: 새 세션/clone에서 hook(`ditto hook`)이 동작하려면 `bun run build:bin` 필수.
- **bun 1.3.14 필요**: Windows cross-compile(`build:bin:win`)이 1.1+ 필요. 1.0.2면 InvalidTarget.
- **push 안 됨**: 같은 머신이면 그대로 이어가면 됨. **다른 PC면 먼저 이 머신에서 `git push` 필요**.

## 1. 이 세션이 한 일 (긴 여정 — 맥락)
### A. "성능 의문점" 7트랙 — 전부 done (각 work item pass + 커밋)
사용자가 던진 7개 의문을 코드 사실로 검증 후 강화:
- ⑥ handoff 독립화·자동읽기·자동정리 `720c5f8` — `.ditto/handoff/`로 통일, UserPromptSubmit이 파일명 명시 없이 본문 자동 주입 후 archive
- ② 공통 유틸 중복 통일 `8e0d461` (pathExists 3중→hosts/shared.fileExists)
- ③ e2e planner 트리거 규칙 `8a6efc9`
- ⑦ ADR 집행 가드 `4344385` — `scripts/adr-guard.ts` + `bun run adr:guard`, pre-commit·CI 연결
- ⑤ mutating 노드 pass에 changed_files 증거 강제 `5ddbba6`
- ① ACG-autopilot 연계 명문화 `49f6e0a`
- ④ dialectic 다회차 수렴 `5bb0d6b` (revise + round<max_rounds → 재심의)
- **메타 결론**: 공통 뿌리 = "설계–집행 갭"(계약/skill/ADR이 문서로만, 런타임 집행 없음). 메모리 `project-perf-questions-tracks` 참조.

### B. autopilot end-to-end 실증 `ed075a1` (wi_260606jo1)
- 실제로 deep-interview(start→record-turn→finalize)→bootstrap→autopilot 루프 구동. **planner/implementer/verifier 서브에이전트를 Task로 실제 spawn**해서 코드 변경+검증까지 완주. → **autopilot/서브에이전트는 실제로 동작한다**(그동안 안 보인 건 main이 직접 처리해서 = 미사용).
- 발견 갭(후속 후보): next-node packet 1회성·디스크 미저장(놓치면 복구 불가), autopilot complete가 work item status 안 닫음, completion verdict↔work-item AC 동기화 안 됨.
- **단 self-host(ditto repo)에서 한 것** — 아래 C가 핵심 한계.

### C. boxwood 발견 (중대 — 다음 작업의 이유)
- DITTO는 "임의 코드베이스 거버넌스 도구"를 표방하지만, **실제 타겟에 설치·구동된 적이 한 번도 없다**(전부 self-host). 
- boxwood 레포 11개 실재: `/Users/incognito/dev/projects/{java,javascript,js}/workspace/boxwood-*` (대부분 Java/Kotlin JVM + JS/TS). **ditto 플러그인 설치 0** (`~/.claude.json` 확인).
- 진짜 검증 = boxwood 한 레포에 DITTO 설치 후 autopilot 구동. (미수행 — increment 6의 목표)

## 2. 현재 트랙: DITTO 설치 스크립트 (wi_2606068sy) — 진행 상황
목표: **설치 스크립트 1회 실행으로 타겟 프로젝트(macOS/Linux/Windows)에서 DITTO 완전 동작**.
- ✅ **increment 1**: hook self-contained `b5596d7` — `ditto hook <event>` 커맨드(`src/cli/commands/hook.ts`, HANDLERS 맵). hooks.json이 `"${CLAUDE_PLUGIN_ROOT}/bin/ditto" hook <event>` 호출. **bun·src·node_modules 불필요**. 고아 hooks/*.ts 래퍼 5개 삭제.
- ✅ **bun 1.3.14 재검증** `4f2f1ff` — `build:bin:win` → `bin/ditto.exe`(PE32+) 생성 확인. 회귀 1건은 bun-in-bun 테스트 하네스 문제(바이너리 호출로 수정).
- ✅ **increment 2**: `ditto init` 커맨드 `802fe95` — `src/core/init-scaffold.ts`(core, 테스트 가능) + `src/cli/commands/init.ts`(thin: `--dir`, `--output`). 타겟에 `.ditto/` 골격 멱등 생성: 런타임 디렉토리(work-items/runs/handoff/sessions/logs/cache/agents/knowledge/adr) + 빈 knowledge 시드(스키마 유효 glossary.json, CONTEXT.md) + `.ditto/.gitignore`(휘발성 상태 제외). 기존 파일 미덮어씀(alreadyInitialized 마커=glossary.json). **surfaces.json은 의도적으로 미시드**(설치된 플러그인 자신의 표면 카탈로그라 repoRoot==플러그인인 self-host에서만 의미; 타겟 시드 시 전부 missing_file 드리프트). 검증: 클린 `/tmp` git 타겟에서 init→`work start`까지 구동, repo_root가 타겟으로 해석·ditto repo 누출 0 확인. 유닛 4 pass(`tests/core/init-scaffold.test.ts`).
- ✅ **increment 3**: 설치 오케스트레이터 `f4ea316` — `scripts/install-plugin.mjs`를 5단계로 확장(install 모드): ①register(글로벌 settings plugin 등록) ②build(`bun run build:bin`→bin/ditto) ③place(바이너리를 `~/.local/bin/ditto` 심링크로 PATH 배치 — **스킬이 bare `ditto …` 호출하므로 PATH 해석 필수**; foreign ditto 미덮어씀) ④init(`ditto init --dir <target>` 호출=inc2 재사용) ⑤allowlist(타겟 `.claude/settings.json` `permissions.allow`에 `Bash(ditto:*)`). `--target`(기본 cwd)·`--no-build`. **target==repo면 self-host로 판정→init/allowlist skip**(자기 자신 관리타겟 함정 차단). 멱등(already-linked/allowlisted, 중복0). uninstall=①③⑤ 역행, 타겟 `.ditto/` 데이터 보존. status=5개 상태 플래그. 모든 경로 `homedir()` 기반→`HOME` 오버라이드로 dry-run 샌드박싱. install.sh/ps1은 mode 뒤 인자(--target/--no-build) 포워딩. **검증**: 샌드박스 HOME+클린 `/tmp` git 타겟에서 install(5단계 ok)→배치 심링크로 bare `ditto` 실행→멱등 재설치→status 전부 true→uninstall(역행, .ditto 보존)→self-host 가드→foreign 미덮어씀→.sh 포워딩 전부 실증.
  - **gotcha(커밋)**: 커밋 메시지에 `<target>/.claude/...`처럼 `>`+경로가 있으면 PreToolUse가 scope-out 리다이렉트로 오인 차단. 메시지에서 `<...>/` 패턴 회피.
- ✅ **increment 4**: CodeQL 자동 설치 `1280f21` — install-plugin.mjs에 `installCodeql` step(build/place와 동일 패턴). `detectCodeql`=CODEQL_BIN→PATH(which)→gh-ext→ditto-managed(`~/.local/share/ditto/codeql/codeql/codeql`), `doctor.ts:227` 탐지와 정렬. 없으면 플랫폼 번들(`codeql-{osx64,linux64,win64}.zip`, latest 릴리스, 현재 v2.25.6) 다운로드→unzip(tar fallback)→추출→POSIX는 `~/.local/bin/codeql` 심링크 배치, Win은 PATH 안내. **graceful**: curl/unzip 부재·실패 시 정확한 URL+절차 안내하고 install 계속(non-fatal). `--no-codeql`, status에 codeql 노출. uninstall 미관여(host 공유 도구). **검증**: reuse·graceful(PATH 비움)·ditto-managed 탐지 실증, 릴리스 URL HEAD 도달성 확인. **미실증**: 실제 번들 다운로드(대용량 의도적 비실행).
- ✅ **increment 5**: Playwright/Chromium 설치 `abfc41f` — install-plugin.mjs에 `installPlaywright` step(inc4 동일 패턴). `detectPlaywright`=playwright-core in bun 캐시(`~/.bun/install/cache`, `browser.ts resolvePlaywrightCore`와 정렬) + Chromium in 플랫폼별 ms-playwright 캐시(macOS `~/Library/Caches`, linux `~/.cache`, win `AppData\Local`). 둘 다 있어야 available. 없으면 `bun x playwright install chromium`(playwright-core+Chromium 동시 충족) 후 재탐지. **graceful**: bun 부재·실패 시 `bunx playwright install chromium`+캐시경로 안내하고 install 계속. `--no-playwright`, status 노출, uninstall 미관여. 런타임 hard constraint(auto-download 금지)는 e2e 실행용이라 설치와 무충돌. **검증**: status reuse 탐지·install흐름 reuse(심링크)·graceful(PATH 비움) 실증. **미실증**: 실제 Chromium 다운로드(대용량 의도적 비실행).
- ✅ **increment 6**: 통합 실증 (커밋 대기 — boxwood는 사용자 레포라 ditto repo에 코드 변경 없음, 이 핸드오프만 갱신) — **클린 boxwood 레포(`java/workspace/boxwood-domain-model-java`, Kotlin/Gradle)에 `scripts/install.sh install --target <boxwood>` 실제 실행**: register(실글로벌 settings, 백업됨)·build·place(`~/.local/bin/ditto`, `which -a ditto` 첫 항목=우리것)·codeql reuse·playwright reuse·init·allowlist 전부 ok. `ditto doctor`(capability/permissions) 타겟에서 동작. **autopilot e2e 완주**: work start(repo_root=boxwood)→deep-interview(threshold0)+finalize(3노드 부트스트랩 N1 design/N2 implement/N3 verify)→next-node 디스패치→record-result(N1 plan, N2 docs/DITTO-SMOKE.md 생성+file 증거, N3 독립검증 command+file 증거)→complete=**evidence-gated `final_verdict: pass`**(ac-1 verdict=pass, 증거 3개). §1-C의 "DITTO가 실타겟에 구동된 적 없음" 해소. **데모 throwaway(docs/)는 정리**, boxwood엔 `.ditto`/`.claude`(실제 설치)만 잔존. **한계**: 이 세션이 ditto repo에 루트돼 있어 boxwood로 spawn한 subagent는 scope-out 훅에 막힘 → 충실한 subagent 루프는 boxwood-루트 세션 필요(엔진/CLI 루프 자체는 실증됨; subagent spawn은 self-host ed075a1에서 기실증).

**→ work item wi_2606068sy: 6/6 increment 완료. 설치 스크립트 1회 실행으로 타겟에서 DITTO 완전 동작(register/build/place/codeql/playwright/init/allowlist + autopilot e2e) 달성.**

## 3. 설계 결정 (DECIDED — 사용자 합의)
- hook = self-contained 컴파일 바이너리 호출 (완료). "트리거는 Claude Code가 이벤트로 결정, hooks.json이 `ditto hook <event>` 매핑, 바이너리는 받은 이름대로 디스패치(추측 분기 없음)."
- 배포: **플랫폼별 prebuilt 바이너리**(darwin-arm64/x64, linux-x64, win-x64) — bun 1.3.14 cross-compile. `bin/` gitignore, 설치 시 빌드/배치.
- CodeQL/playwright: 자동 다운로드·설치 **시도** + 실패 시 정확한 수동 명령 안내(graceful).
- 검증: 임시 clean 디렉토리(또는 boxwood)에서 — **self-host 금지**(이 세션 내내 self-host 함정에 빠졌던 게 교훈).

## 4. gotcha
- DITTO 플러그인 = `.claude-plugin/{plugin.json, marketplace.json}`(ditto-local, source ./), `agents/`(13개: planner/implementer/verifier 등), `skills/`, `hooks/hooks.json`. **commands/ 디렉토리는 없음**(사용자가 "commands"라 했으나 skills가 그 역할).
- 플러그인 설치: `/plugin marketplace add /Users/incognito/dev/projects/ditto` → `/plugin install ditto@ditto-local`. 설치 시 디렉토리 전체(src 포함)가 `~/.claude/plugins/cache/`로 복사되나 **node_modules는 불확실** → 그래서 hook을 self-contained 바이너리로 만든 것.
- autopilot 수동 구동 순서(실증에서 확인): `ditto work start` → `ditto deep-interview start/record-turn/finalize`(intent+bootstrap) → `ditto autopilot next-node`(1회 호출=dispatch+packet, **packet 놓치지 말 것**) → 해당 owner를 `ditto:<owner>` subagent로 Task spawn → `ditto autopilot record-result` → 반복 → `ditto autopilot complete`. work item 마감은 `ditto work handoff`로 별도.
- DITTO_SKIP_HOOKS=1 로 hook 우회 가능.

## 5. work item 상태 — 완료 (6/6)
설치 스크립트 work item(wi_2606068sy)의 6개 increment 전부 done. 다음 세션은 새 요청을 받거나, 아래 후속 백로그를 처리.

### 잔여 상태 (사용자 환경에 남은 실제 변경 — 되돌리려면)
inc6 실제 설치가 글로벌/타겟을 건드림:
- 글로벌 `~/.claude/settings.json`: `ditto-local` 마켓플레이스 + `ditto@ditto-local` enabled (백업 `.bak.2026-06-06T06-26-31*`).
- `~/.local/bin/ditto` 심링크 → `<repo>/bin/ditto`.
- `boxwood-domain-model-java/{.ditto,.claude}` (실제 설치; git untracked).
- **전체 되돌리기**: `DITTO_HOME=<repo> bash scripts/install.sh uninstall --target <boxwood>` (register/place/allowlist 역행, `.ditto` 데이터는 보존 — 수동 `rm -rf` 필요).

### 후속 백로그 (이 work item 범위 밖, 별도 요청 시)
- **push 대기**: 이 세션 inc2~inc6 커밋(802fe95~) + 이전 세션 커밋 전부 로컬. 다른 PC/공유 전 `git push` 필요.
- Windows 경로(build:bin:win, ditto.exe, PATH 안내) 코드만 작성, macOS에서 미실증.
- 실제 CodeQL/Chromium 대용량 다운로드 경로 미실행(reuse/graceful/ URL·레이아웃은 입증).
- boxwood-루트 세션에서 subagent autopilot 루프 충실 실증(이 세션은 cross-repo scope-out 제약).
