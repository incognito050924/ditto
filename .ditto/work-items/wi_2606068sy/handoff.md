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
- ⬜ **increment 5**: playwright/chromium 설치 — 플랫폼별 캐시(`~/Library/Caches/ms-playwright` 등). graceful. `src/core/e2e/browser.ts`(자동 다운로드 금지 hard constraint는 런타임용; 설치 스크립트는 별도로 설치).
- ⬜ **increment 6**: 최종 검증(`ditto doctor`) + **clean 타겟에서 설치→autopilot e2e**(self-host 함정 회피; boxwood 레포 1개 권장).

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

## 5. 다음 명령 (새 세션 첫 프롬프트로)
> "이 핸드오프(`.ditto/work-items/wi_2606068sy/handoff.md`) 읽고, DITTO 설치 스크립트(wi_2606068sy) **increment 5(playwright/chromium 설치)** 부터 이어서 진행해. 검증은 self-host 말고 임시 clean 타겟에서."

increment 5 메모: install-plugin.mjs에 `installPlaywright` step을 inc4(CodeQL)와 동일 패턴으로 추가 — detect(이미 캐시 있으면 reuse) → 없으면 설치 시도 → graceful 안내. `src/core/e2e/browser.ts` 확인 필수: 런타임의 "자동 다운로드 금지" hard constraint는 e2e 실행용이고, **설치 스크립트는 별도로 미리 설치**하는 것(충돌 아님). chromium 캐시 위치 플랫폼별(`~/Library/Caches/ms-playwright` 등). `--no-playwright` 플래그·status 노출·uninstall 미관여(host 공유). 검증도 inc4처럼 reuse/graceful 우선(대용량 브라우저 다운로드 비실행).
그다음 inc6: 최종 검증(`ditto doctor`) + 클린 타겟 install→autopilot e2e(boxwood 레포 1개 권장).
