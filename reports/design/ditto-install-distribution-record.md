---
title: "DITTO 설치·배포 작업 기록 (wi_2606068sy) + boxwood 실증"
kind: record
last_updated: 2026-06-06 KST
status: done
scope: "설치 스크립트 work item(wi_2606068sy) increment 1~6의 구현·검증 기록과, 최초 실타겟(boxwood) autopilot 실증·되돌리기"
inputs:
  - .ditto/work-items/wi_2606068sy/handoff.md
  - scripts/install-plugin.mjs
  - scripts/install.sh
  - scripts/install.ps1
  - src/core/init-scaffold.ts
  - src/cli/commands/init.ts
---

# DITTO 설치·배포 작업 기록 (wi_2606068sy)

> **이 문서의 성격.** 구현 계약이 아니라 **작업 기록**이다. "무엇을 만들었고, 어떻게 검증했고, 무엇을 검증하지 못했는가"를 증거와 함께 남긴다. 완료 주장은 전부 fresh evidence(테스트·실행 로그·diff)에 묶는다. 미검증 항목은 숨기지 않고 §6에 모은다.

## 0. 한 줄 결론

**설치 스크립트 1회 실행으로 임의 타겟 프로젝트에서 DITTO가 완전 동작**(플러그인 등록 + self-contained 바이너리 빌드·PATH 배치 + CodeQL/Playwright 준비 + 타겟 `.ditto/` scaffold + 권한 allowlist)하도록 만들었고, **최초로 실제 foreign 레포(boxwood)에 설치해 autopilot을 end-to-end 완주**(evidence-gated `final_verdict: pass`)시켜 "DITTO가 self-host에서만 돌던" 함정을 닫았다. 검증 후 발자국은 사용자 요청으로 전부 되돌렸다.

## 1. 배경 — 왜 이 작업이 필요했나

DITTO는 "임의 코드베이스용 변경 거버넌스 도구"를 표방하지만, 이 작업 전까지 **실제 타겟에 설치·구동된 적이 한 번도 없었다**(전부 self-host = ditto 레포 자기 자신을 대상으로 구동). 플러그인 배포 경로(`/plugin install`)는 디렉토리 전체를 캐시로 복사하지만 `node_modules`·`bun` 런타임 보장이 불확실해, 훅과 CLI가 타겟에서 깨질 수 있었다. 그래서 "설치"를 1급 산출물로 끌어올렸다.

## 2. increment별 구현·검증

### increment 1 — hook self-contained 바이너리 (선행)
- `ditto hook <event>` 단일 커맨드(`src/cli/commands/hook.ts`, `HANDLERS` 맵). `hooks/hooks.json`이 `"${CLAUDE_PLUGIN_ROOT}/bin/ditto" hook <event>`로 호출.
- `bun build --compile`로 src+deps를 단일 실행파일에 번들 → 타겟에 **bun·src·node_modules 불필요**. 고아 `hooks/*.ts` 래퍼 5개 삭제.
- bun 1.3.14 재검증: `build:bin:win` → `bin/ditto.exe`(PE32+) 생성 확인.

### increment 2 — `ditto init` (커밋 `802fe95`)
- `src/core/init-scaffold.ts`(테스트 가능한 core) + `src/cli/commands/init.ts`(thin: `--dir`, `--output`).
- 타겟 루트에 `.ditto/` 골격을 **멱등** 생성: 런타임 디렉토리(`work-items/ runs/ handoff/ sessions/ logs/ cache/ agents/ knowledge/ knowledge/adr/`) + 빈 knowledge 시드(스키마 유효 `glossary.json`, `CONTEXT.md`) + `.ditto/.gitignore`(휘발성 상태 제외). 기존 파일 미덮어씀(`alreadyInitialized` 마커 = `knowledge/glossary.json`).
- **설계 컷**: `surfaces.json`은 의도적으로 미시드. 그것은 설치된 DITTO 플러그인 자신의 표면 카탈로그라 `repoRoot==플러그인`인 self-host에서만 의미가 있고, 타겟에 시드하면 로컬 표면이 비어 전부 `missing_file` 드리프트가 된다.
- **검증**: 유닛 4 pass(`tests/core/init-scaffold.test.ts`: 골격·findRepoRoot 결정성·스키마 유효 시드·surfaces.json 미생성·멱등). 클린 `/tmp` git 타겟에서 init→`work start`까지 구동, `repo_root`가 타겟으로 해석되고 ditto repo 누출 0 확인.

### increment 3 — 설치 오케스트레이터 (커밋 `f4ea316`)
`scripts/install-plugin.mjs`를 plugin 등록만 하던 것에서 5단계로 확장(+`install.sh`/`install.ps1` 인자 포워딩):

| 단계 | 동작 |
|---|---|
| ① register | 글로벌 `~/.claude/settings.json`에 `ditto-local` 마켓플레이스 + `ditto@ditto-local` enabled |
| ② build | `bun run build:bin` → `bin/ditto` |
| ③ place | 바이너리를 `~/.local/bin/ditto` **심링크로 PATH 배치** (foreign `ditto`는 미덮어씀) |
| ④ init | `ditto init --dir <target>` 호출(inc2 재사용) |
| ⑤ allowlist | 타겟 `.claude/settings.json` `permissions.allow`에 `Bash(ditto:*)` |

- ③ PATH 배치의 근거: **스킬들이 bare `ditto …`를 호출**한다(훅만 `${CLAUDE_PLUGIN_ROOT}/bin/ditto`). 타겟에서 autopilot이 돌려면 `ditto`가 PATH에 있어야 한다.
- ⑤ allowlist의 의미: PreToolUse 훅은 동작 기준으로 막지 "ditto 명령"을 특정해 막지 않는다. 진짜 마찰은 Claude Code 네이티브 권한 프롬프트 — `Bash(ditto:*)`로 해소.
- **self-host 가드**: `target==repo`면 init/allowlist skip(자기 자신을 관리 타겟으로 삼는 함정을 코드로 차단).
- 멱등 + `uninstall`(register/place/allowlist 역행, 타겟 `.ditto/` 데이터 보존) + `status`(5플래그). 모든 경로를 `homedir()` 기반으로 도출 → `HOME` 오버라이드로 dry-run 샌드박싱.
- **검증**: 샌드박스 HOME + 클린 `/tmp` git 타겟에서 install 5단계 ok → 배치 심링크로 bare `ditto` 실행 성공 → 멱등 재설치(중복0) → status 전부 true → uninstall(역행, `.ditto` 보존) → self-host 가드 → foreign 미덮어씀 → `.sh` 포워딩 전부 실증.

### increment 4 — CodeQL 자동 설치 (커밋 `1280f21`)
- `detectCodeql()`: `CODEQL_BIN` → PATH(`which`) → gh-extension → ditto-managed(`~/.local/share/ditto/codeql/codeql/codeql`). `src/core/codeql/doctor.ts`의 `cliAvailable` 탐지와 정렬.
- `installCodeql()`: 있으면 reuse. 없으면 플랫폼 번들(`codeql-{osx64,linux64,win64}.zip`, latest 릴리스) 다운로드 → `unzip`(없으면 `tar`) → 추출 → POSIX는 `~/.local/bin/codeql` 심링크, Windows는 PATH 안내.
- **graceful**: curl/unzip 부재·실패 시 정확한 URL+절차 안내하고 install 계속(non-fatal).
- **검증**: reuse(로컬 codeql 재사용)·graceful(PATH 비움→curl 미발견→osx64 URL 안내, init/allowlist 계속)·ditto-managed 탐지(가짜 추출 레이아웃) 실증. 릴리스 URL HEAD 도달성 확인(현재 v2.25.6, 302→200).

### increment 5 — Playwright/Chromium 자동 설치 (커밋 `abfc41f`)
- 런타임의 "auto-download 금지" hard constraint(`src/core/e2e/browser.ts`)는 **e2e 실행용**(없으면 blocked로 degrade)이고, 설치 스크립트가 미리 두 캐시를 채운다.
- `detectPlaywright()`: `playwright-core` in bun 글로벌 캐시(`~/.bun/install/cache`, `resolvePlaywrightCore`와 정렬) + full Chromium in 플랫폼별 ms-playwright 캐시(macOS `~/Library/Caches`, linux `~/.cache`, win `AppData\Local`). 둘 다 있어야 available.
- `installPlaywright()`: available면 reuse. 아니면 `bun x playwright install chromium`(playwright-core + Chromium 동시 충족) 후 재탐지.
- **검증**: status reuse 탐지(`available:true`)·install 흐름 reuse(fake HOME+실제캐시 심링크, 다운로드 없음)·graceful(PATH 비움→bun 미발견→안내, init/allowlist 계속) 실증.

### increment 6 — boxwood 통합 실증 (핸드오프 기록)
최초로 **실제 클린 foreign 레포**(`java/workspace/boxwood-domain-model-java`, Kotlin/Gradle)에 설치·구동:

1. `scripts/install.sh install --target <boxwood>` 실제 실행 → register(실글로벌 settings, 백업)·build·place(`which -a ditto` 첫 항목=우리것)·codeql reuse·playwright reuse·init·allowlist 전부 ok.
2. `ditto doctor`(capability/permissions) 타겟에서 동작 — 런타임 reachable.
3. **autopilot e2e 완주**: `work start`(repo_root=boxwood) → deep-interview finalize(3노드 부트스트랩 N1 design/N2 implement/N3 verify) → `next-node` 디스패치 → `record-result`(N1 plan / N2 `docs/DITTO-SMOKE.md` 생성+file 증거 / N3 독립검증 command+file 증거) → `complete` = **evidence-gated `final_verdict: pass`**(ac-1 verdict=pass, 증거 3개, changed_files 기록).

→ §1의 "실타겟에 구동된 적 없음"을 해소.

## 3. 최종 상태 — 사용자 환경 발자국: 없음

inc6 검증이 글로벌/타겟을 잠시 건드렸으나 **사용자 요청으로 전부 되돌림**:
- `install.sh uninstall` → 글로벌 register/place/allowlist 역행.
- boxwood `{.ditto,.claude}` 수동 제거, 오늘자 백업 정리.
- **결과(검증 완료)**: 글로벌 `~/.claude/settings.json`이 검증 전과 byte-identical(diff 0), `~/.local/bin/ditto` 제거, boxwood `git status` clean(내 커밋 0건 — 애초에 boxwood엔 커밋 안 함).

## 4. 설계 결정 (DECIDED)

- hook = self-contained 컴파일 바이너리 호출(추측 분기 없이 받은 이벤트명대로 디스패치).
- 배포 = 플랫폼별 prebuilt 바이너리(darwin/linux/win), `bin/` gitignore, 설치 시 빌드·배치.
- CodeQL/Playwright = 자동 설치 **시도** + 실패 시 정확한 수동 명령 안내(graceful, non-fatal).
- 검증 = 임시 clean 디렉토리 또는 실제 boxwood에서. **self-host 금지**.
- uninstall = host 공유 도구(CodeQL/Playwright)·타겟 `.ditto` 데이터는 보존, 등록·배치·allowlist만 역행.

## 5. 커밋

| inc | 커밋 | 유형 |
|---|---|---|
| 2 | `802fe95` | behavioral |
| 3 | `f4ea316` | behavioral |
| 4 | `1280f21` | behavioral |
| 5 | `abfc41f` | behavioral |
| 1·6·핸드오프 | `b5596d7 4f2f1ff 7a92ef7 a4cf4ab eaa078e ad79810 3017ac3 0d31184 206591f` | feat/docs |

전 단계 `bun test` 1207 pass / 9 skip / **0 fail**, `lint`·`adr:guard` green. **전 커밋 로컬, push 대기**.

## 6. 미검증·한계 (숨기지 않음)

- **Windows 경로**: `build:bin:win`·`ditto.exe`·PATH 안내 코드만 작성, 이 macOS 머신에서 미실증(심링크 배치는 POSIX 전용 분기).
- **실제 대용량 다운로드**: CodeQL 번들(~수백 MB)·Chromium 실다운로드는 비용상 의도적 비실행. URL 도달성·추출 레이아웃·심링크 배치·graceful은 각각 입증.
- **subagent cross-repo 제약**: inc6 autopilot 실증은 이 세션이 ditto repo에 루트돼 있어, boxwood로 spawn한 subagent가 PreToolUse scope-out 훅에 막힌다. 그래서 각 노드 owner 역할은 main agent가 수행하고 CLI 루프·엔진·게이트를 실증했다. **충실한 subagent 자동 루프는 boxwood-루트 세션이 필요**(subagent spawn 자체는 self-host `ed075a1`에서 기실증). 이 한계는 §4축 재평가의 핵심 입력이다 → `ditto-four-axis-reassessment.md`.
