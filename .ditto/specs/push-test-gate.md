# Push-time Test Gate — 기획 (wi_260629skv)

상태: 기획(draft). 구현 미착수. 본 문서는 의도·현황·설계 후보·미해결 결정을 담는다.

## 1. 원래 요청

> ditto로 개발 시 push 전 **모든 테스트가 통과해야만** push 가능하도록 강제하고 싶다.
> ditto repo만이 아니라 **모든 사용자 프로젝트**(boxwood처럼 멀티레포 포함).
> 특히 **main/master**는 ditto·에이전트가 **우회 못 하게** — 테스트 통과 못 하면 무조건 push 불가.

## 2. 핵심 결론 (TL;DR)

**"에이전트가 우회 못 하는 강제력"은 도구가 만들어 줄 수 없다. 강제력은 _에이전트의 권한_ 과 _게이트 소유자의 권한_ 사이의 격차에서만 나온다.**

- 로컬 게이트(git pre-push hook)는 **전부 우회 가능**하다 — 에이전트는 셸이 있어 `--no-verify`, `core.hooksPath` 해제, hook 파일 삭제, API 직접 push가 모두 가능.
- 우회 불가능한 유일한 계층은 **원격(GitHub) 서버측 강제**(branch protection / ruleset + required status check)다. 단 이건 두 전제가 동시에 충족돼야 성립한다:
  1. 해당 기능이 **플랜에서 사용 가능**해야 한다 — private repo의 protection은 **GitHub Pro/Team(유료)** 필요.
  2. 에이전트의 push 토큰이 **protection을 끌 수 없어야** 한다 — write 전용(`Contents:write`, `Administration` 없음). owner/admin 자격이면 자기가 끄므로 강제 불가.
- **현재 boxwood 환경은 두 전제 다 깨져 있다**(§3). 즉 지금은 어떤 설정으로도 "우회 불가"를 만들 수 없다 — 플랜 업그레이드 + 토큰 분리라는 **ditto 밖 결정**이 선행돼야 한다.
- 따라서 ditto가 정직하게 제공할 수 있는 것은 *보장*이 아니라 **(a) 가용한 최강 게이트 scaffold + (b) 실제 우회가능성을 `doctor`가 드러내는 disclosure**다(§5).

## 3. 현황 실측 (boxwood-workspace, 2026-06-29)

활성 자격증명: `gh auth status` → 활성 토큰 `GITHUB_TOKEN` = **classic PAT (`ghp_`), scope `repo`** (= owner admin 전권). 신원 `ecoletree`(owner). 즉 **에이전트가 현재 모든 repo의 protection을 켜고 끌 수 있다 = 완전 우회 가능 상태.**

| repo (디렉터리) | GitHub slug | 기본 브랜치 | 내 권한 | visibility | branch protection | 테스트 CI |
|---|---|---|---|---|---|---|
| boxwood-workspace | ecoletree/boxwood-workspace | main | admin | private | **불가**(Pro 필요) | 없음 |
| frontend | ecoletree/boxwood-portal-svelte | main | admin | private | **불가** | automation-ci.yml (일부) |
| portal-backend | ecoletree/boxwood-portal-kotlin | main | admin | private | **불가** | 없음(deploy.yml만) |
| automation-engine | ecoletree/boxwood-automation-engine | master | admin | private | **불가** | 없음(deploy.yml만) |
| external-client | ecoletree/boxwood-automation-external-client | main | admin | private | **불가** | 없음(deploy.yml만) |
| boxwood-packages | ecoletree/boxwood-packages | main | admin | private | **불가** | ci.yml |
| boxwood-knowledge | ecoletree/boxwood-knowledge | main | admin | private | **불가** | 없음 |

근거: `gh api repos/.../branches/<br>/protection` 및 `.../rulesets` 모두 **HTTP 403 "Upgrade to GitHub Pro or make this repository public to enable this feature."** → 무료 플랜 private repo는 protection/ruleset 자체가 불가.

테스트 러너 이질성: frontend = `turbo run test`(npm), portal-backend·automation-engine·external-client·boxwood-packages = **JVM gradle**, boxwood-knowledge = 테스트 없음. 단일 명령으로 못 묶음 → repo별 명령 필요.

추가: 기존 워크플로는 대부분 `deploy.yml`/`*-cd.yml`(배포)이지 테스트 게이트가 아니다 — required check로 쓸 **테스트 CI를 새로 만들어야** 한다.

## 4. 강제 계층 사다리 (강 → 약)

| # | 계층 | 에이전트 우회 | 가용 조건 | 비고 |
|---|---|---|---|---|
| L0 | 서버측 branch protection/ruleset + required 테스트 체크 + **write-scoped 토큰** | **우회 불가** | GitHub Pro/Team(또는 public) **AND** 에이전트 토큰 non-admin | 요청 의도("무조건")를 충족하는 **유일** 계층 |
| L1 | 서버측 protection + required 체크, 단 **admin 토큰** | **우회 가능** | Pro/Team | admin이 protection을 끌 수 있음. 게으른/실수성 push는 막지만 작정하면 뚫림 |
| L2 | 로컬 `pre-push` git hook(repo별 테스트 실행) | **우회 가능** | 무료, 즉시 | `--no-verify`/hook 삭제로 우회. 모든 push(터미널 포함) 커버. 정직한 실수 방지 |
| L2.5 | **PreToolUse 하네스 훅** — 에이전트의 `git push`(특히 main/master)를 테스트 red면 exit 2로 차단 + 사유 프롬프트 반환 | **우회 가능하나 더 어려움** | 무료, 즉시 — **ditto 훅에 선례 있음**(force-push 차단, `src/hooks/pre-tool-use.ts:469-480`) | `--no-verify` **무력**(git-level 아닌 harness-level). 단 `DITTO_SKIP_HOOKS=1` 킬스위치·명령 난독화로 우회 가능. 에이전트의 *게으른* 우회를 막는 최강 무료 수단. 하네스 안 도구호출만 커버(터미널 직접 push는 L2 담당) |
| L3 | CI가 PR에서 테스트 실행하되 **차단력 없음**(protection 부재) | **우회 가능** | 무료, 즉시 | red여도 merge 가능. 신호/가시성만 제공 |
| L4 | 행동 규칙(CLAUDE.md/AGENTS.md managed block: "push 전 테스트, red면 금지") | **우회 가능** | 무료, 즉시 | ditto-aware 에이전트에게만, 사람엔 무구속. 규율이지 강제 아님 |

**현재 boxwood에서 즉시 가능한 최강은 L2+L3**(둘 다 우회 가능). L0(진짜 우회불가)는 §6의 ditto 밖 결정이 선행돼야 도달.

## 5. ditto 범위 (도구가 정직하게 할 수 있는 것)

ditto는 사용자의 플랜·자격증명을 통제하지 못하므로 *보장*을 팔지 않는다. 대신:

1. **scaffold** — 대상 repo(들)에 가용한 최강 게이트를 깐다:
   - repo별 테스트 명령 **탐지 또는 선언**(현재 ditto에 `test_command` 설정 필드 **없음** — 신설 필요).
   - 테스트를 돌리는 **CI workflow** 생성(`.github/workflows/`), required check 후보로.
   - 플랜이 허용하면 `gh api`로 **branch protection + required check** 설정.
   - **PreToolUse 하네스 훅 규칙(L2.5, 에이전트 우회방어의 무료 최강)** — 에이전트의 `git push`(특히 main/master)를 테스트 미통과 시 exit 2로 차단 + 사유 반환. ditto 기존 force-push 차단(`src/hooks/pre-tool-use.ts:469-480`)을 확장. `--no-verify`에 무력하다는 게 git hook 대비 강점.
   - (옵션) 로컬 `pre-push` git hook 설치(터미널 push까지 커버, L2).
2. **disclose (핵심)** — `ditto doctor`가 게이트의 **실제 강제력**을 점검·표시:
   - 에이전트 토큰이 `Administration`/admin 권한이면 → "이 게이트는 우회 가능(L1↓)" 경고.
   - repo가 private + 무료 플랜이면 → "서버측 protection 불가 — L2/L3만 가능" 명시.
   - protection 없음/required check 미설정 → 경고.
   - **L2.5의 우회 경로(`DITTO_SKIP_HOOKS=1` 킬스위치·명령 난독화·fail-open)를 숨기지 않고 명시** — "이 훅은 게으른 우회는 막지만 절대 차단은 아니다".
   - 즉 §4 사다리에서 **현재 어느 칸에 있는지**를 매 진단마다 드러낸다(헌장 §4-10 disclose 정렬).

확인된 현재 ditto 사실(설계 출발점):
- `ditto setup`은 대상 repo의 **git을 안 건드린다**(host 이벤트 훅만; git hook/protection 미설치). `src/core/hosts/*.ts`의 hook 언급은 전부 SessionStart/Stop 류.
- `test_command` 류 **설정 필드 0건**.
- `ditto work push`의 push-readiness(`src/core/work-item-store.ts:120`)는 **work-item 완료 의미**(AC verdict·command 증거·follow-up·stem)지 **테스트 실행이 아님**.
- `ditto hook`은 호스트 이벤트 훅 디스패처(`src/cli/commands/hook.ts`)지 git hook 아님.

## 6. ditto 밖(사용자/플랜) 결정 — 강제의 전제

이건 도구가 못 정한다. L0(우회불가)에 도달하려면:

1. **플랜**: 대상 private repo를 **GitHub Pro/Team으로 업그레이드**(유료) — 또는 public 전환(비즈니스 코드엔 비현실적). 안 하면 서버측 protection 자체가 없음.
2. **자격증명 분리**: 에이전트에게 owner/admin 토큰(`ghp_` `repo`-scope 등) 대신 **write 전용 fine-grained PAT**(`Contents:write`, `Administration` 없음) 부여. protection 소유는 사람(admin)이 유지.

이 둘이 충족되어야 §4의 L0가 성립한다. 둘 다 사용자/조직의 정책·비용 결정.

## 7. 설계 후보 — ditto 기능(만들기로 한다면)

> heavy path. 멀티서피스(schema + CLI + gh 연동 + doctor). 구현은 별도 승인 후.

- **schema**: work item/profile/repo 설정에 `test_command`(repo별), `push_gate`(enforce 수준) 필드 추가 — additive-optional(기존 패턴, [[work-lifecycle-improvement-thread]] 참조).
- **CLI**: `ditto guard push install --dir <repo>` (가칭) — 테스트 명령 탐지/선언 → CI workflow 생성 → 가능 시 protection 설정 → 옵션 로컬 hook. 멀티레포는 sub-repo 순회(ADR-0011 session-rooting 준수, cross-repo 실행 위임은 비지원이므로 repo별 명시 호출).
- **doctor**: `ditto doctor`에 push-gate 렌즈 — §5.2 disclosure. 토큰 권한은 `gh api repos/{r} -q .permissions.admin` + 토큰 scope로 판정.
- **호스트 비대칭**: claude/codex 양쪽 동일 — git/GitHub 계층이라 호스트 무관(이 점은 오히려 단순).

## 8. 결정 (2026-06-29 확정) + 잔여 설계 결정

**확정 (사용자):**
1. **강제 수준 = L2/L3 (무료·마찰만).** GitHub Pro 업그레이드·write-scoped 토큰은 **하지 않는다.** "우회 가능"을 수용하되, 도구는 그 우회가능성을 **숨기지 않고 doctor로 드러낸다.** → L0(진짜 우회불가)는 비목표. 단 §6의 경로는 "원하면 나중에"로 문서에 남겨 둔다.
2. **착수 = ditto 기능부터** (boxwood 수동 1회성 아님). 재사용 가능한 ditto 명령으로 성문화.

**잔여(미해결 결정) 설계 사항 (구현 단계에서, 대부분 에이전트가 합리적 기본값으로):**
- **테스트 범위**: push되는 **repo 단위**(기본). 워크스페이스 전체 묶기는 비목표.
- **로컬 hook 비용**: JVM gradle 전체 테스트는 수 분 → 매 push 차단은 가혹. 기본은 **repo별 테스트 명령을 선언**(없으면 hook이 graceful skip + doctor가 "게이트 미설정" 경고). 무거운 suite는 CI(L3)로 밀고 로컬은 빠른 부분집합 허용 — 명령 선택은 사용자 선언에 위임.
- **대상 범위**: ditto setup이 돈 repo **opt-in**(명시 설치) 기본 — 전체 자동 적용은 보류.

## 9. 다음 단계 (구현 — 별도 승인 단위)

이 WI는 **기획 산출**까지다. 구현은 heavy path 신규 작업 단위로, 착수 전 별도 승인.
- 권장 진입: ditto feature를 deep-interview로 스코프 → schema(`test_command`/`push_gate` additive) → guard CLI → doctor disclosure 렌즈 → TDD.
- 핵심 무결성 기준: **doctor가 "현재 게이트가 §4 사다리 어느 칸인지 + 우회가능 여부"를 항상 드러낼 것**(L2/L3를 골랐기에 disclosure가 이 기능의 정직성을 떠받친다).

## 10. 기획 산출물 검증 (이 WI의 AC)

- ac-1: §4 강제 계층 표(L0~L4, 5행 ≥3) 각 행에 "우회 불가"/"우회 가능" 라벨 포함 ✓
- ac-2: §3에 boxwood 7개 repo 전부 + private/protection/CI 표 포함 ✓
- ac-3: §5 'ditto 범위' + §6 'ditto 밖 결정' 섹션 둘 다 존재 ✓
- ac-4: §8 '미해결 결정' 섹션 + 잔여 항목 포함 ✓
