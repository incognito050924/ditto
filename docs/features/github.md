# github — GitHub Projects v2 백로그를 ditto work item과 연결하는 연계 표면

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16` (2026-07-19).

---

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto github`은 **GitHub Projects v2 보드/이슈와 ditto work item을 연결**하는 표면이다. 정확히는 CLI 커맨드 `ditto github`이 노출하는 서브커맨드는 `setup` **하나뿐**이고(`src/core`가 아니라 `src/cli/commands/github.ts:571-574`), 나머지 연계 동작(claim·완료 반영·진행 게시)은 `ditto work`/`ditto autopilot`/`ditto doctor` 명령이 `src/core/github-*.ts` 모듈을 호출해 일어난다. 그래서 이 문서는 커맨드 `github`을 진입점으로 삼되 **"GitHub 연계 feature 전체"**를 다룬다.

풀려는 문제: 같은 작업을 GitHub Projects 보드·GitHub Issue·ditto work item이 동시에 가리킬 때, 우선순위·상태·완료 판정의 **권위(SoT, source of truth)가 흩어지면** 양방향 동기화 지옥과 완료 판정 오염(GitHub의 이슈 close 상태가 ditto 완료를 끌어옴)이 생긴다(ADR-20260628-github-backlog-sot §컨텍스트).

이를 **SoT 3층 분리**라는 개념으로 푼다(ADR-20260628 D3, `.ditto/knowledge/adr/ADR-20260628-github-backlog-sot.md:16-22`):

- **GitHub Projects v2 보드 = 백로그 SoT** (우선순위·상태) — ditto는 **읽기만**.
- **GitHub Issue = 작업 항목** (title·body·계층) — ditto는 **읽기만**.
- **ditto work item = 실행/완료 SoT** — 증거 게이트로만 완료 판정, ditto가 **쓰기**.

핵심 비대칭: **완료축은 ditto write SoT, 우선순위축은 GitHub read-only.** GitHub → ditto 방향으로 상태를 끌어오지 않고, ditto → GitHub 방향의 **단방향 미러**(완료 시 결정적 게시)만 예외로 둔다.

**4축 분류상 위치:** DITTO 4축(의도/오케스트레이션/E2E/지식) 중 어느 기능 기둥도 아니다. 이것은 **거버넌스·연계(외부 백로그와의 접합)** 표면이다 — work item 실행 결과를 외부 협업 도구(GitHub)에 미러링하고, 외부 백로그를 실행 단위로 끌어오는 접착 계층. ADR도 "신규 연계 표면(supersede 없음)"으로 규정한다(ADR-20260628:6).

---

## 2. 코드 위치와 진입점

### 핵심 파일

| 경로 | 역할 |
|---|---|
| `src/cli/commands/github.ts` | 커맨드 `github` 정의 + `setup` 서브커맨드. config 빌더(`buildGithubConfig`)·재동기화(`syncStatusMaps`)·플래그 파서. |
| `src/schemas/ditto-config.ts` | `dittoConfigGithub` zod 스키마 — 연계 config의 계약(SoT, ADR-0002). `status_map`/`claim_status_map`/`auto_reflect`. |
| `src/schemas/work-item.ts:208-236` | `githubIssueLink` — work item ↔ 이슈 연결 상태(repo·number·project_item_id·claim/게시 idempotency 마커). |
| `src/core/gh-client.ts` | `gh` CLI를 감싼 주입 가능 클라이언트. 모든 실패를 typed `GhDegradation`으로 반환(never throw). |
| `src/core/github-claim.ts` | claim/occupancy 로직 — @me assignee 쓰기(remote-first) + read-back + 보드 In progress 이동. |
| `src/core/github-reflection.ts` | 종료(done/abandoned) 시 결과 미러 — 결과 요약 코멘트 + 보드 status + assignee 해제 + (수동 시)이슈 close. |
| `src/core/github-progress.ts` | autopilot 결정 로그(decisive)를 이슈에 게시(`work sync-issue` + autopilot 직접 게시 공유 경로). |
| `src/core/github-status-match.ts` | 보드 Status 옵션명 → ditto 키 자동탐지(exact-set 정규화). |
| `src/core/github-coord.ts` | owner/repo 좌표·보드 아이템 매칭 순수 술어(멀티-repo 보드에서 카드 정체 확인). |
| `src/core/github-redaction.ts` | 외부 쓰기 전 **allow-list 리댁션**(비밀·내부 경로·wi_ id 스크럽). |
| `src/core/github-config-doctor.ts` | `ditto doctor`용 로컬-only 점검 — 구버전 config의 `claim_status_map.in_progress` 누락 탐지. |

### 서브커맨드·CLI 인자

커맨드 `github`의 서브커맨드는 `setup` 하나(`github.ts:573`). `setup`의 인자(`github.ts:416-462`):

| 인자 | 타입 | 역할 |
|---|---|---|
| `--dir` | string | 대상 프로젝트 루트(기본: 가까운 repo 루트). |
| `--project` | string | 대상 Project — `"owner/number"` 또는 Project URL. |
| `--status-map` | string | 종료 매핑 `"done=<optid>,abandoned=<optid>"` (키=done\|abandoned만). |
| `--claim-status-map` | string | 비종료 보드 매핑 `"in_progress=<optid>,blocked=<optid>"`. |
| `--auto-reflect` | boolean | 완료 시 Project status 자동 반영(기본 OFF). |
| `--resync-status` | boolean | 보드 Status를 다시 읽어 known 키를 **덮어쓰기**(미래/미매칭 키 보존). |
| `--autodetect-status` | boolean | 보드 Status에서 미설정 키만 **백필**(기존 값 보존). |
| `--yes` | boolean | 비대화형(플래그만, CI). |

> **연계 동작을 촉발하는 다른 명령들**(이 커맨드의 서브커맨드는 아님):
> - `ditto work start` → `claim()` (assignee + 보드 In progress) — `src/cli/commands/work.ts:645`
> - `ditto work done` / `work abandon` → `reflectTermination()` — `work.ts:551`
> - `ditto autopilot complete` → `reflectAutopilotTermination()` — `src/cli/commands/autopilot.ts:609`
> - `ditto work sync-issue` + autopilot 루프 → `postUnpostedDecisions()` — `work.ts:3411`, `src/core/autopilot-loop.ts:2667`
> - `ditto doctor` → `collectGithubConfigReport()` — `src/cli/commands/doctor.ts:841`

---

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

### 저장 상태 두 곳

1. **연계 config** — `.ditto/local/config.json`의 `github` 블록. tier③ 개인 구획(gitignored, ADR-0012). 스키마 `dittoConfigGithub`(`ditto-config.ts:54-75`). `ditto github setup`이 **유일한 writer**(외 recipe seed 경로, §4 참고).
2. **연결 마커** — work item의 `github_issue` 필드(`githubIssueLink`, `work-item.ts:208-236`). 이슈 좌표(repo·number·node_id·project_item_id)와 **idempotency 마커**(`posted_decision_ids`·`claimed_branch`·`posted_claim_markers`)를 담는다. 이것은 GitHub assignee의 캐시가 **아니다** — read-back이 SoT이고 여기엔 idempotency·branch-grain에 필요한 것만 저장한다(`work-item.ts:221-225`).

### `ditto github setup` 흐름 (`buildGithubConfig`, `github.ts:148-281`)

```
--project "owner/n" 또는 URL
  → parseProjectRef (github.ts:69-87)                 [파싱, 실패 시 invalid_project]
  → gh.projectFieldList(owner, n) (github.ts:167)     [접근·존재 검증 + status 옵션 조회, 한 호출]
  → extractStatusOptions → selectStatusField          [Status single-select 필드 선택]
  → autodetectStatusMaps(options) (github.ts:185)     [보드 컬럼명 → 키 자동탐지, 대화형 기본값 제안]
  → gh.projectView(owner, n) (github.ts:191)          [Project node_id(PVT_…) best-effort 캡처]
  → status_map/claim_status_map 매핑 확정              [대화형 select 또는 플래그 파싱]
  → auto_reflect 토글 (기본 OFF)
  → dittoConfigGithub.safeParse (github.ts:276)       [스키마 결박 검증]
  → writeGithubConfig(repoRoot, config) (github.ts:541)  [.ditto/local/config.json에 저장]
```

### 종료 반영 흐름 (`reflectTermination`, `github-reflection.ts:223-274`)

```
work done/abandon (또는 autopilot 종료 flip)
  → github_issue 링크 없으면 skip + notice
  → buildResultSummary → buildPublicSafeSummary       [allow-list로 공개안전 코멘트 구성]
  → gh.issueComment (결과 요약 게시, ac-4)
  → applyBoardStatus → status_map[trigger] → applyBoardStatusOption  [보드 status 이동, ac-5]
  → gh.issueRemoveAssignee(@me)                       [terminal claim 해제, ac-7]
  → (closeIssue일 때만) gh.issueClose                 [수동 --close-issue 경로만]
```

각 효과는 **독립적으로 degradable** — 하나 실패해도 나머지는 진행, 전부 notice로만 표면(never throw/block).

---

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### (1) 완료축은 ditto write SoT, 우선순위축은 GitHub read-only (ADR-20260628 D3)

완료를 GitHub 상태에 결박하면 ditto의 prime directive("완료는 증거로만", 헌장 §4-5)가 무너진다. GitHub 이슈 close를 완료 신호로 받으면 검증되지 않은 완료가 새어든다(ADR-20260628:29). 그래서 완료축은 ditto가 단독 write SoT로 쥐고, GitHub 방향은 **단방향 미러**만. 코드에서 이 불변식은 `reflectTermination`이 GitHub 상태를 **읽어서 verdict에 넣는 경로가 없다**는 것으로 강제된다 — 오직 게시(write)만 한다.

**기각된 대안**(ADR-20260628:33-38): Issues=백로그 SoT(→보드가 우선순위 1급 개념이라 기각), 자동 양방향 동기화 데몬/webhook(→증거 게이트 충돌 + 운영 복잡도로 기각, v1은 수동 링크 + 단방향 게시만), octokit/SDK 직접 의존(→gh CLI에 설치·인증·버전 위임).

### (2) claim은 lock이 아니라 remote-first advisory (github-claim.ts:12-29)

GitHub에는 compare-and-set이 없으므로 claim은 **원자적 잠금이 될 수 없다.** 유일한 durable occupancy 기록은 GitHub의 `@me` assignee이고, 로컬 `claimed_branch`/`posted_claim_markers`는 branch-grain idempotency 감시자일 뿐 SoT가 아니다. 순서가 load-bearing: **@me assignee를 먼저 쓰고**, read-back으로 확인 + 충돌 스캔한 **뒤에만** 로컬 마커를 계산한다. remote 실패나 확인된 partial에서는 로컬 claim을 **쓰지 않아** 두 번째 머신이 "로컬 소유인데 보드 free" 상태를 보지 않게 한다.

### (3) 우아한 강등 — 모든 gh 실패는 notice, never block (ADR-0018)

`gh-client.ts`의 모든 메서드는 예외를 던지지 않고 typed `GhDegradation`을 반환한다(`gh-client.ts:12-16`). gh 부재/미인증/권한부족/구버전/타임아웃/파싱불가/rate-limit이 전부 degradable 조건으로 분류된다(`GhDegradeReason`, `gh-client.ts:31-39`). 이유: 외부 도구 부재가 실행/완료 경로를 막지 못한다는 불변식(ADR-0018).

### (4) 외부 쓰기는 allow-list 리댁션 (github-redaction.ts:3-20)

공개/cross-repo 이슈에 나가는 모든 코멘트는 **positive allow-list로 구성**한다 — "나쁜 것 제거" 블랙리스트가 아니다. 블랙리스트는 열거되지 않은 필드를 새게 하므로, 공개안전 본문을 열거된 안전 필드(commit SHA·per-AC verdict·1줄 요약)만으로 **재구성**한다(`buildPublicSafeSummary`, `github-redaction.ts:110-124`). 함께 실려가는 free-text는 `sanitizeFragment`로 추가 경화(절대경로 상대화·첫 줄만·wi_ id 제거·토큰 스크럽).

### (5) recipe.backlog → 개인 config bootstrap-once seed (ADR-20260630)

이 커맨드가 아니라 `ditto setup` 경로의 seam이지만 연계 config를 채우는 **두 번째 경로**다. 팀 공유 recipe(tier②)에 백로그 좌표를 한 번 적어두면 개발자의 개인 config(tier③)에 setup 시점 자동 seed된다. 4개 불변식: bootstrap-once, personal-wins(개인 값 절대 override 안 함), sibling-preserving(형제 블록 보존), malformed fail-closed(`src/core/ditto-config.ts:158-192`, `seedGithubConfigIfAbsent`; ADR-20260630).

---

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### `parseProjectRef` (github.ts:69-87)

`"owner/number"` 또는 Project URL(`/users/…/projects/n`, `/orgs/…/projects/n`)을 `{owner, number}`로 파싱. number ≤ 0이나 형식 불일치는 `null` → `invalid_project`로 종료. **효과:** 잘못된 Project 지정이 gh 호출 전에 걸린다.

### `buildGithubConfig` — 대화형·비대화형 동일 config (github.ts:148-281)

한 함수가 `PromptIO`(대화형)와 플래그(비대화형)에서 **동일 config를 산출**(멱등, ac-14). `projectFieldList` 한 호출이 read 접근 권한 + status 필드 조회를 함께 게이트한다 — write(item-edit) 권한은 파괴적 probe를 피해 실제 반영 시점에 같은 강등 경로로 검증된다(`github.ts:164-166`). **숨은 결정:** 대화형 경로는 `autodetectStatusMaps` 결과를 기본값으로 **제안**하지만(`github.ts:185`, `select`의 default 인자), 플래그/비대화형 경로는 **explicit-only**로 유지해 결정성을 보존한다(자동탐지 기본값을 소비하지 않음, `github.ts:183-184` 주석).

### `status_map`과 `claim_status_map`의 분리 (ditto-config.ts:61-72)

종료 매핑(`status_map`)은 키가 `done`|`abandoned` **닫힌 enum**. 비종료 claim 매핑(`claim_status_map`)은 **별도 optional 필드 + OPEN string 키**. 이 분리는 미묘한 pre-mortem 결정이다: 비종료 키를 닫힌 enum에 추가하면 구버전 reader가 **github config 전체를 거부**(zod)하고, fail-open reader가 github 블록 + 형제 prism/deep_interview 기본값까지 오염시킨다. 별도 open-key 필드면 구버전 reader가 미지의 키만 **strip**하고 나머지는 보존한다 — per-key 강등, whole-config drop 방지(`ditto-config.ts:62-71`).

### `claim` (github-claim.ts:90-213)

입력: work item + 이 세션이 claim하는 branch. 하는 일:
1. **Idempotency**: 이 branch의 로컬 마커가 이미 있으면 zero-gh no-op(`github-claim.ts:106-108`).
2. **@me assignee 먼저** 쓰기; 실패 시 로컬 claim 안 씀(remote-first, `github-claim.ts:112-120`).
3. **read-back**: assignee 목록을 다시 읽어 확인 + 충돌 스캔(advisory). degraded read → occupancy `unknown`; write는 ok인데 @me 미반영 → **확인된 partial**(로컬 claim 안 씀, `github-claim.ts:141-146`); foreign assignee → duplicate-claim 경고. **제3자 login은 transient 경고에만 실리고 `localClaim`으로 반환되지 않아** 커밋된 메모리/핸드오프에 안 남는다(`github-claim.ts:26-28`).
4. **보드 In progress 이동**: 단, **terminal WI status면 skip**(비종료 claim이 terminal 보드 status를 덮으면 안 됨, `github-claim.ts:167-186`). 이유(gate)는 WI status에서 온다(ditto-side terminal SoT).
5. read-back·확인 **뒤에만** 로컬 마커 계산(`github-claim.ts:197-201`).

산출 효과: 원격이 진짜 landing된 경우에만 `localClaim`을 반환해 n6(work start)이 work item에 persist한다.

### `unclaim` (github-claim.ts:239-283)

`@me`만 제거(`issueRemoveAssignee @me` — 다른 세션 assignee 절대 안 지움, ac-7), 감사 가능한 release/takeover 타임라인 코멘트 게시, 선택적 보드 이동(blocked → Blocked). 모든 gh 실패는 notice.

### `applyBoardStatusOption` — 공유 해석 체인 (github-reflection.ts:131-194)

보드 status 업데이트의 전체 해석 체인(project node id → 보드 아이템 id → field-list → Status 필드 id → `projectItemEdit`)을 **종료 경로(status_map)와 claim 경로(claim_status_map)가 공유**한다. option-id로 파라미터화해 caller는 map→option lookup만 소유. **숨은 가드(wi_260714usn ac-5):** persist된 `project_item_id`가 여전히 이 이슈 카드를 가리키는지 편집 **전에 재검증** — 멀티-repo 보드에서 stale/오염된 id가 **엉뚱한 repo 카드를 flip**할 수 있으므로 `boardItemMatchesRepoNumber`로 좌표 불일치 시 fail-closed skip. 단 보드 read 실패는 정당한 편집을 막지 않게 fall-through(best-effort, `github-reflection.ts:150-168`).

### `selectStatusField` — 단일 필드 선택 규칙 (github-reflection.ts:72-94)

"Status"(대소문자 무시) 우선, 없으면 옵션 가진 첫 single-select 필드. setup 시점 옵션 목록(`extractStatusOptions`)과 apply 시점 필드 id(`extractStatusFieldId`)가 **같은 규칙에서 파생** — 자동탐지/백필된 option id가 claim 시점에 항상 유효(규칙의 3번째 사본 없음).

### `reflectAutopilotTermination` — double-gate (github-reflection.ts:286-323)

autopilot 경로는 **실제 terminal flip일 때만**(`autoClose === 'flipped'`) 반영한다. partial/unverified/blocked complete는 completion.json을 쓰지만 flip은 안 하므로 **아무것도 게시 안 함**(cross-feature 회귀 가드, `github-reflection.ts:301-302`). **미묘한 결정:** config가 malformed면 opt-in한 `auto_reflect`를 조용히 끄지 않고 notice 기록(`github-reflection.ts:303-311`); 부재/false는 조용한 default-OFF. autopilot은 **절대 이슈를 auto-close 안 함**.

### `postUnpostedDecisions` — 진행 게시 idempotency (github-progress.ts:137-199)

autopilot 결정 로그의 **decisive** 결정만(routine churn 아님) 이슈에 **한 코멘트**로 게시. autopilot 직접 게시와 수동 `work sync-issue`가 **하나의 직렬화 경로**를 공유해 동시 실행이 `posted_decision_ids`를 lost-update로 중복 게시하지 못하게 한다. 3개 idempotency 제약(`github-progress.ts:33-47`): (1) 각 결정에 append-위치 인덱스로 판별하는 **synthesized id**, (2) mark 단계가 store mutator **안에서** 최신 work item을 재읽기, (3) external-post→local-mark가 non-atomic — id를 게시 **전에** 계산하고 이미-게시 id는 skip, 게시 실패 시 mark를 **held**(안 씀)해 나중 sync-issue가 roll-up. 게시 실패는 실행/완료 경로에 영향 없음(ac-11).

### `PROJECT_ITEM_LIST_LIMIT` gotcha (gh-client.ts:27-29, 296-304)

`gh project item-list`는 `--limit` 기본이 **30**. 명시 limit 없으면 보드 위치 30번 넘는 이슈가 payload에서 누락 → `resolveProjectItemId`가 null 반환 → claim 보드 이동이 **조용히 skip**된다(issue #39). 그래서 현실적 보드 크기보다 훨씬 큰 `1000`으로 bound.

### `classifyGhFailure` — rate-limit을 perm 앞에서 판정 (gh-client.ts:104-121)

rate limit 분기가 403/perm 분기 **앞**에 와야 한다 — GitHub이 secondary/primary rate limit에 HTTP 403(때로 429)을 반환하는데, 순서가 바뀌면 영구 권한 오류로 오분류된다. rate-limit은 transient → retry/wait 안내만(retry 루프 아님 — rate-limited 엔드포인트 재시도는 악화, ADR-0018).

### `github-config-doctor` (github-config-doctor.ts:45-64)

`ditto doctor`용 **로컬-only, read-only** 점검. 연계가 configured인데 `claim_status_map.in_progress`가 미설정이면(구버전 config) finding 하나 + 교정 명령(`ditto github setup`) 표면. **네트워크 probe 없음** — 오프라인에서 hang·false-fail 불가. github 블록 부재는 연계 미사용이므로 finding 없음.

---

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위(정적 읽기 + 스키마/ADR 대조; 테스트 실행은 안 함, **미검증**):

- **완료 단방향 미러**: 의도대로. `reflectTermination`/`reflectAutopilotTermination` 어디에도 GitHub 상태를 verdict로 끌어오는 경로가 없다(github-reflection.ts 전체 read→verdict 경로 부재로 확인). ✔
- **claim이 lock이 아님**: 의도대로. read-back은 warning만 push하고 verdict/block에 안 들어감(`github-claim.ts:122-160`). ✔
- **우아한 강등**: 의도대로. 모든 `GhClient` 메서드가 `GhResult` 반환, `run`/`runJson`이 throw를 흡수(`gh-client.ts:150-165`). ✔
- **claim_status_map open-key 분리**: 스키마가 실제로 `z.record(z.string()…)` optional(`ditto-config.ts:72`) — enum 확장 아님. ✔
- **멀티-repo 카드 오염 가드**: `applyBoardStatusOption`이 `boardItemMatchesRepoNumber`로 재검증(`github-reflection.ts:161`). 단 보드 read 실패 시 fall-through로 편집 진행(`github-reflection.ts:157` `if (board.ok)`) — 이는 의도된 best-effort지만, **stale id + 동시 보드 read 실패가 겹치면 재검증이 건너뛰어져** 이론상 엉뚱 카드 flip 가능. 코드 주석이 이 트레이드오프를 명시(`github-reflection.ts:154-155`). **잔여 위험으로 지목.**

확인 범위에서 **의도와 코드의 명백한 불일치·죽은 경로는 발견하지 못함.** 단 §6·§7의 항목은 정적 분석 결과이며 런타임 검증(테스트/실호출)은 하지 않았다.

---

## 7. 잠재 위험·부작용·재설계 시 고려점

### 재설계 시 반드시 보존해야 할 불변식

1. **완료축 = ditto write SoT, 단방향 미러** (ADR-20260628 D3). GitHub 상태를 ditto verdict로 끌어오는 순간 증거 게이트가 무너진다. 이걸 깨려면 ADR 변경 조건(팀이 백로그 SoT를 옮기거나 완료를 GitHub에 결박하는 제품 요구)에 해당해야 하고 intent 충돌로 사용자 확인이 필요하다.
2. **claim remote-first 순서** — @me 쓰기 성공 + 확인 뒤에만 로컬 마커. 순서를 뒤집으면 "로컬 소유인데 보드 free" 유령 상태.
3. **allow-list 리댁션(positive construction)** — 블랙리스트로 바꾸면 열거 안 된 필드가 공개 이슈로 샌다.
4. **status_map(enum) ↔ claim_status_map(open-key) 분리** — 합치면 구버전 reader가 whole-config를 drop.
5. **모든 gh 실패 = notice, never block** (ADR-0018).

### 동시성·정합성·drift 위험

- **claim은 근본적으로 race 가능** — GitHub에 CAS가 없어 두 세션이 거의 동시에 claim하면 둘 다 @me로 assign되고 read-back이 서로를 foreign으로 경고할 뿐 막지 못한다. 설계상 lock이 아니라 advisory이므로 "정합성 보장"을 기대하면 안 된다.
- **진행 게시 동시성**: `postUnpostedDecisions`는 store mutator 안 재읽기 + set-union fold로 lost-update를 막지만, **직렬화 writer 계약**(autopilot 직접 게시 + sync-issue가 같은 경로)에 의존한다. 세 번째 게시 경로가 추가되면 이 가정이 깨진다.
- **project_item_id stale + 보드 read 실패 동시 발생** 시 카드 오염 재검증 우회(§6). 멀티-repo 보드 재설계 시 재검토 대상.
- **config drift**: `.ditto/local/config.json`은 gitignored 개인 tier라 개발자마다 매핑이 다를 수 있다. `--resync-status`/`--autodetect-status`와 recipe seed(ADR-20260630)가 완화하지만, 보드 컬럼명을 바꾸면(예: "In progress" → "Doing") 자동탐지가 exact-set이라 **매칭 실패**(fuzzy 없음, 사용자 결정 C1) → 수동 재매핑 필요.

### 재고할 수 있는 결정

- **1 WI ↔ 1 issue**(v1, `work-item.ts:236`) — 다중 이슈 연결이 필요하면 `githubIssueLink`를 배열로 확장해야 하고 idempotency 마커 소유권 모델이 복잡해진다.
- **자동탐지 exact-set(no fuzzy/synonym/localization)** — 로컬라이즈된 보드나 변형 컬럼명을 쓰는 팀엔 마찰. 의도적 보수 선택이지만 사용성 재고 여지.
