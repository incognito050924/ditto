# HANDOFF — 다른 PC 이어받기 (2026-06-22)

호스트 메모리(`~/.claude/.../memory/`)와 work-items(`.ditto/local/`, gitignored)는 **git으로 전파되지 않는다.** 다른 PC에 필요한 비전파 컨텍스트를 여기 싣는다. 코드·테스트·git이 권위다(헌장 §4-11) — 이 문서는 "어디서 이어받나 + 안 넘어가는 것"이지 사실의 원본이 아니다.

## 0. 전파 주의 (먼저 읽기)

- **이어받을 위치**: repo `main`. 이번 세션 배포작업 4커밋은 **origin/main에 push 완료** (`fc744ae`).
- **이 핸드오프 커밋은 push 안 함**(사용자 지시). → 다른 PC가 받으려면 **이 PC에서 `git push` 먼저** 해야 한다. push 전엔 origin/main = `fc744ae`(핸드오프 커밋 없음).
- ⚠ **로컬 main에는 미푸시 커밋이 16개**다 = 이 핸드오프(1) + **동시 far-field 세션이 머지한 `wi_260622vjo` 작업(15커밋 + 머지 `3191090`)**. 후자는 내 작업이 아니라 다른 스레드 산출물. **push하면 far-field 머지도 같이 올라간다** — far-field가 push 준비됐는지 그쪽 핸드오프/메모리로 확인 후 push할 것. 둘을 분리하려면 핸드오프 커밋만 따로 cherry-pick/브랜치.
- **안 넘어가는 것**: ① work-item `.json`(`.ditto/local/work-items/` gitignored — 다른 PC는 자기 로컬 상태) ② 호스트 메모리 ③ 아래 §3 미커밋 WIP.
- **넘어가는 것**: 소스·테스트·`bin/ditto`(커밋된 배포 산출물)·`DEVELOPMENT.md`(배포 기준 표)·ADR·이 문서.

## 1. 이번 세션 (2026-06-22) — ditto 배포 vehicle 완성 (3 WI close, 4커밋 push)

`npx github:incognito050924/ditto install|update|uninstall` 한 줄 설치를 완성. origin/main=`fc744ae`.

| 커밋 | 내용 |
|---|---|
| `7421565` | **npx 부트스트랩**(`scripts/npx-bootstrap.mjs` ← `package.json bin.ditto`). `dist/`는 gitignored라 npx 클론에 bin 없음 → 커밋된 `bin/ditto`가 배포 산출물 SoT. plugin=`claude plugin` 셸아웃, CLI=번들을 `~/.local/share/ditto/bin` 복사 후 `~/.local/bin/ditto` 심링크. |
| `2473bea` | **`ditto mode`** 명령(`src/cli/commands/mode.ts` + `formatModeHuman` TDD). session(dev/installed/unknown)·신선도·drift·배포액션 human/json. |
| `f8468f1` | **DEVELOPMENT.md "배포 기준" 표** — rebuild/push/reinstall/update/모드확인을 각 SoT(release.mjs·npx-bootstrap.mjs·mode-doctor·ADR-0022)로 포인팅. |
| `fc744ae` | **npx 설치기 footgun 수정** — placeCli가 남의 `~/.local/bin/ditto` 심링크(dev dogfood 심링크 등) 안 덮고 거부+경고(SKIPPED), 플러그인은 설치·exit 0. |

- **닫은 work item 3**: `wi_260622njt`(npx, WI-B) · `wi_2606225jt`(mode·배포기준, WI-A) · `wi_260608j2p`(github 소스경로). 셋 다 `ditto work done` final_verdict=pass.
- 전체 `bun test` 2657 pass / 0 fail. lint·adr-guard·CI(3커밋) green.

## 2. 남은 작업 / follow-up (이 스레드)

- **j2p ac-3 잔여(저위험)**: `/plugins` UI 에러카운트=0을 화면으로 못 봄 → root-cause(file:// 소멸)로만 검증. 새 `claude` 세션에서 `/plugins` 한 번 눈확인하면 완전 종결.
- **스모크-게이트 자동화**(ADR-0022 §5, 별도 WI): 이번엔 throwaway 격리로 **수동** 검증. 자동 게이트는 미구현.
- **njt Windows 미검증**: `npx-bootstrap.mjs` Windows 분기(심링크 대신 PATH 안내 + `ditto.cmd`) 미실행. mac만 검증. cf. memory `windows-install-thin-launcher`.
- **njt bun 부재**: bun 없으면 install은 exit 0이나 `ditto` CLI(bun 셔뱅)는 실행 불가(soft 경고만). 플러그인 절반은 동작. 미테스트.
- **`wi_260608pcw`**: `ditto setup`이 `~/.claude` 글로벌 managed 블록을 교체 않고 이중 래핑하는 멱등성 버그(미수정).

## 3. 미커밋 WIP — 안 넘어감, 별도 커밋 필요 (`wi_26062240y`)

dogfood 권한 프롬프트 제거. memory상 "done·미커밋". **git으로 전파 안 되니 다른 PC에서 이어 쓰려면 이 PC에서 별도 커밋해야 한다.** 내용:

- `scripts/dogfood.mjs` (+18): `--skip-permissions` opt-in 플래그. claude=`--dangerously-skip-permissions`, codex=`--dangerously-bypass-approvals-and-sandbox`. 기본은 sandboxed.
- `.claude/settings.json` (+20): `allow`=[Bash,Read,Edit,Write,Glob,Grep,WebSearch,WebFetch], `deny`=[sudo,mkfs,dd,shutdown,reboot,git push --force/-f/--force-with-lease]. (기존 `["Bash(ditto:*)"]`에서 관대화 — **프로젝트 .claude/settings.json 권한 포스처 변경**이라 커밋 여부는 가치 판단.)

> 이 둘은 내(이번 세션) 작업이 아니라 건드리지 않고 둠. 커밋하면 다른 PC로 전파됨.

## 4. 비전파 운영 컨텍스트 (memory → 여기 복제)

- **격리 검증 하네스**: `HOME=<throwaway> CLAUDE_CONFIG_DIR=<throwaway>/.claude` 로 npx install/uninstall을 라이브 `~/.claude`·`~/.local` 안 건드리고 검증. `claude plugin`은 user-global이라 디렉터리로는 격리 안 됨 — config-dir 분리가 핵심. (ADR-0022 §5 스모크-게이트가 이 패턴.)
- **GOTCHA — stale completion.json**: `ditto work done`은 work-item 디렉터리에 completion.json이 **이미 있으면** 그걸 읽고(ac verdict 재합성 안 함, `src/cli/commands/work.ts:356` `!exists`일 때만 합성), 없으면 work-item ACs에서 합성. j2p는 2026-06-08 partial completion이 남아 막혀서, 그 파일을 옆으로 치우고 재합성해 닫았다.
- **dogfood 진입**: `bun run dogfood [--host claude|codex]` = `build:bin` + `claude --plugin-dir <repoRoot>`(워킹트리 로드). SessionStart 배너가 dev/stale-installed 구분(`✓ ditto dogfood mode`). stale 잡으면 `bun run dogfood` 재시작.
- **다른 PC의 work-item 상태는 이 PC와 다르다**(per-PC local). 위 WI ID는 참조용. 전체 백로그는 각 PC의 `ditto work status`.

## 5. 핵심 파일

- `scripts/npx-bootstrap.mjs` — npx install/update/uninstall (package.json `bin.ditto`).
- `src/cli/commands/mode.ts` + `src/core/mode-doctor.ts`(`collectModeReport`/`formatModeBanner`/`formatModeHuman`) — `ditto mode` + SessionStart 배너.
- `scripts/release.mjs` — 버전 bump + `bin/ditto` 재빌드 + commit/tag(push 안 함).
- `DEVELOPMENT.md` §"배포 / 설치" + "배포 기준" — npx 설치 + 언제 rebuild/push/reinstall/update.
- `.ditto/knowledge/adr/ADR-0022-dogfood-deploy-lifecycle.md` — 배포 생애주기 결정.

## 6. 먼-들판 coverage 검증 인계 (wi_260622vjo) — 다음 핵심 작업 (다른 스레드)

이 PC가 머지한 `wi_260622vjo`(머지 `3191090`, 9슬라이스)의 **남은 검증·실측**을 fresh 세션에서 이어받는다. 코드/엔진은 단위·CLI e2e로 검증됐으나(머지트리 2693 pass), **SKILL 프롬프트 부분(ac-3 anti-SLOP·ac-6 critic·ac-8 sweepAngles)은 실 autopilot 한 바퀴로 검증된 적이 없다.** 상세는 이 PC 호스트 메모리 [[premortem-far-field-redesign]](비전파).

- **⚠ 전제 — push 선행**: 이 검증은 far-field 코드가 그 PC에 있어야 한다 → §0대로 이 PC에서 `git push origin main` 후 그 PC가 pull. push 안 하면 그 PC엔 far-field 없음.
- **⚠ 왜 fresh 세션 필수**: SKILL 정의는 세션 시작에 freeze(ADR-0022). 변경된 SKILL(ac-3/6/8)은 **새 세션 autopilot에서만** 활성 — 이 PC의 작업 세션에선 검증 불가였다.

**A1+A2 (가장 큰 미검증) — 실 autopilot far-field sweep 한 바퀴.** design/planner 노드가 있는 work item을 autopilot으로 plan-stage coverage sweep까지 구동(`coverage-next`→`coverage-round`→dry). 확인:
- **ac-8 sweepAngles**: `coverage-next`가 tier별 `sweepAngles`(light1/std3/full5) 반환하고 그만큼 blind sweep 각도를 띄우나. `--coverageIntensity light|standard|full`로 진입 override 되나.
- **ac-3 anti-SLOP**: Opponent가 refute-by-default로 위험 검증, oracle-linked(`maps_to`) 근거 없는 위험은 `admissibleBranchesAdded`에 안 들어가나. neutrality 축이 resolved close를 게이트하나.
- **ac-6 critic**: floor(19)+config 밖 도메인을 sweep이 만나면 `cov-cat-<id>` discovered_node로 새 카테고리를 시딩하나.
- 산출 확인: `ditto autopilot coverage-report --workItem <wi>` → seeded/resolved/skipped(+reason)/complete (ac-11a). plan-dialog.md.

**B1 (그다음) — 비용 실측.** 기본-ON 19카테고리 sweep은 폭 불변(19 전수)·깊이만 tier 축소 → 사소한 변경도 19×judge. 실제 한 바퀴 토큰/시간을 재서, light tier로도 비싸 끄고 싶어지는지(R3·ac-8 역설) 판단. 비싸면 강도 기본값/예산 재조정.

**검증과 무관한 미결(별건)**: §8-5 memory seam(보류·R1), ac-11b outcome 루프(미착수), 설계 spec `.ditto/specs/premortem-far-field-coverage.md`(untracked), work-item 스토어 AC placeholder. — 다 이 PC 메모리에 상세(비전파).
