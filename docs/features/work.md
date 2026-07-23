# work — work item(작업 항목) 생명주기 CLI

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋 `c2d2e16`, 기준일 2026-07-19. 핸드오프 관련 절은 숨은-ref 재설계(wi_260722g7h, ADR-20260722-handoff-hidden-ref-baton, 기준 커밋 `5f94ffe`)를 반영해 갱신됨 — 핸드오프는 더 이상 `ditto work`의 표면이 아니다(`docs/features/handoff.md` 참조).

---

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto work`는 **하나의 작업(work item)이 생성부터 종료까지 거치는 생명주기 전체를 관리하는 진입점**이다. work item은 "관측 가능한 목표(goal) + 검증 가능한 인수기준(acceptance criteria) + 상태(status) + 증거(evidence)"를 담은 권위 있는 상태 객체다(`src/schemas/work-item.ts:249` `workItem`).

이 커맨드가 존재하는 이유는 두 극단 사이의 공백을 메우는 것이다. ditto는 원래 "풀 세리머니(deep-interview → pre-mortem → autopilot) 아니면 무절차"만 있었고, 그 사이가 비어 있어 작고 가역적인 작업에서도 에이전트가 표준 경로를 우회해 ad-hoc TDD로 빠졌다 — 추적·종결·묶음·정결한 배포가 안 되는 작업이 됐다(ADR-20260626-work-lifecycle-lightweight-path §컨텍스트).

`work`는 DITTO 4축 중 **① 의도(intent) 축**에 속한다. 의도를 검증 가능한 단위로 고정하고, 그 단위가 증거와 함께 종료되도록 게이트를 거는 것이 핵심이다. 배포(push)는 사용자의 비가역 결정이므로 `work`는 push-readiness를 *계산해서 보여주기만* 하고 능동적으로 push하지 않는다(헌장 §4-8).

두 경로를 지원한다:

- **경량 경로(lightweight)**: `set-criteria → verify → done`. deep-interview도 autopilot도 없이, 자가 작성한 관측 가능 기준을 `ditto verify`로 채점해 닫는다. 작고 가역적인 작업용.
- **무거운 경로(heavy)**: `deep-interview(intent.json 생성) → autopilot bootstrap → 노드 그래프 구동`. 복잡·비가역 작업용. `work`는 이 경로의 시작점(work item 생성)과 종료점(done)을 소유하고, 중간 구동은 autopilot이 소유한다.

---

## 2. 코드 위치와 진입점

### 핵심 파일

| 경로 | 역할 |
|---|---|
| `src/cli/commands/work.ts` | 모든 `work` 서브커맨드 정의(citty `defineCommand`)와 GitHub 연계·claim 배선. 최상위 `workCommand`는 `:3555`. |
| `src/core/work-item-store.ts` | `WorkItemStore` — Record(record.json)+events/ 를 읽어 fold(`reduceWorkItem`)하는 저장/전이 엔진. stem·push-readiness·archive 로직 포함. |
| `src/core/work-item-project.ts` | 백로그 projection — dual-base 로딩 + 파생 필드(follow-up 수·push-ready·lineage) 계산. `work status`(무-id) 리스트가 소비. |
| `src/core/work-item-handoff.ts` | `pickBaseRef`·`collectChangedFiles`·`sanitizeDeclaredPaths` — `work done`이 소비하는 결정적 changed_files 수집. (과거 이 파일에 있던 핸드오프 생성기 `writeWorkItemHandoff`는 제거됨 — wi_260722g7h, `work-item-handoff.ts:5-15` 주석) |
| `src/core/run-store.ts` | `RunStore` — Run tier의 provider 실행 기록(manifest.json). work item당 여러 run. |
| `src/schemas/work-item.ts` | work item·acceptance criterion·follow-up·declared_risk·github link·이벤트 로그의 zod 스키마(SoT, ADR-0002). |
| `src/schemas/run-manifest.ts` | run manifest 스키마. |

### 서브커맨드 (등록: `src/cli/commands/work.ts:3560`)

| 서브커맨드 | 한 줄 역할 | 주요 인자 |
|---|---|---|
| `start <goal>` | work item 생성. `--issue`로 GitHub 이슈 pull. | `--request` `--issue` `--criteria` `--risk` `--follows` `--profile` `--worktree` `--claim`/`--no-claim` |
| `set-criteria <wi>` | placeholder를 관측 가능 기준으로 교체(경량 경로 진입). | `--criteria` `--supersede` `--reason` `--risk` |
| `status [wi]` | id 있으면 단일 상세, 없으면 백로그 리스트. | `--status` `--has-followups` `--orphan-drafts` `--wide` `--all` |
| `done <wi>` | 종료. 증거 게이트(completion final_verdict=pass) 통과 시 done; `--status`로 partial/blocked park. | `--status` `--re-entry-command` `--needs` `--override-heavy` `--reason` `--changed` `--noop-justification` `--comment-issue` `--close-issue` |
| `abandon <wi>` | 포기로 종료(증거 불필요). | `--comment-issue` `--close-issue` |
| `reopen <wi>` | terminal(done/abandoned) → in_progress 재진입. | — |
| `promote <wi>` | 경량 WI를 제자리에서 무거운 경로로 승격(기준·id 보존). | — |
| `follow-up <wi>` | 발굴 항목 포착(bug=추적 WI 물질화, idea=candidate), `--resolve`로 해제, `--batch`로 일괄 물질화. | `--kind` `--note` `--severity` `--self-caused` `--priority` `--resolve` `--batch` |
| `stem <wi>` | `follows` 체인(줄기) 뷰/설정/롤업. | `--follows` `--close` |
| `chain drive <wi>` | 줄기를 root→tip 순차 구동(각 멤버의 autopilot). | `--push` `--max-depth` |
| `push-ready <wi>` | 강한 push-readiness 신호 보고(PULL-ONLY). | — |
| `archive <label>` | terminal 항목을 아카이브로 이동. | `--dry-run` |
| `claim <wi>` | 명시적 이슈 claim(@me 배정 + 보드 이동 + WI in_progress). | — |
| `unclaim <wi>` | claim 해제(@me만 드롭). | `--reason` |
| `link-issue` / `mirror-hierarchy` / `sync-issue` | GitHub 이슈 링크·계층 미러·양방향 동기화. | — |

> 주의: 힌트에 있던 `list`는 별도 서브커맨드로 존재하지 않는다 — 백로그 리스트는 `work status`(workId 생략)가 담당한다(`:1665`). 코드 주석·에러 문구는 이를 "`ditto work list`"로 부르지만 등록된 이름은 `status`다.
>
> 핸드오프 서브커맨드는 없다(wi_260722g7h에서 제거, `work.ts:3376-3393` 등록 목록 확인). 채점·상태 전이는 오직 `work done`의 소관이며, **비-pass 종료도 핸드오프를 자동 발행하지 않는다** — `--status partial|blocked` park는 re_entry(`--re-entry-command`/`--needs`)만 기록한다(`work.ts:1949-1969`). 인계가 필요하면 사용자가 `ditto handoff write`로 명시 작성한다(핸드오프 모델 — `docs/features/handoff.md`).

---

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

### 상태 저장 위치와 tier (ADR-20260706)

work item 상태는 **2-tier로 물리 분리**된다:

- **Record (커밋·공유·git-tracked)**: `.ditto/work-items/<id>/`
  - `record.json` — 저작 필드(title·goal·AC 멤버십·scope·evidence_required 등)
  - `events/<seq>.<actor>.<eid>.json` — 전이당 불변 이벤트 파일(status/verdict/github_post/claim/claim_release)
- **Run (개인·폐기가능·gitignored)**: `.ditto/local/work-items/<id>/`
  - `work-item.json` — reduced view 미러(레거시 리더 호환용, SoT 아님)
  - `completion.json`·`language-ledger.json`·`evidence/`·`metrics.jsonl` 등 실행 트레일
  - `intent.json`(무거운 경로)·autopilot 그래프 등

`get(id)`는 `record.json`을 읽고 `events/`를 fold해서 한 개의 schema-valid WorkItem을 만든다(`work-item-store.ts:732`). Record가 없으면 레거시 `.ditto/local/.../work-item.json`로 폴백한다.

### 흐름도 (경량 경로 예)

```
work start <goal> --request ...
  └─ WorkItemStore.create()                          → record.json (status=draft) + `created` status event
                                                       + languageLedger, Run 미러
work set-criteria <wi> --criteria "A; B"
  └─ acceptanceTestable 게이트 통과 → store.update()  → AC 교체(record.json), verdict=unverified
ditto verify <wi> --criterion ac-1 -- <cmd>          → verdict 이벤트 append (별도 커맨드)
work done <wi>
  ├─ collectChangedFiles(base...HEAD ∪ --changed)    → 결정적 changed_files (워킹트리 스캔 아님)
  ├─ assembleCompletionFromWorkItem() + completionGate + completionEvidenceGate
  │                                                    → completion.json (final_verdict)
  ├─ passCloseResidualBlockers / discoveredDefectCloseBlockers  (종료 완전성 게이트)
  ├─ mirrorAcceptanceVerdicts (completion → work item)
  └─ store.close(done)                                → terminal status 이벤트 (first-terminal-wins)
```

무거운 경로에서는 `set-criteria`/`verify` 대신 `intent.json`(deep-interview finalize 산출)과 autopilot 그래프가 verdict를 만들고, `done`은 그래프-기반 completion을 읽는다.

### 입력 → 출력 요약

- **입력**: 사용자 goal/request/criteria, GitHub 이슈 좌표, git 상태(base ref·워킹트리), 기존 completion.json·intent.json·autopilot 그래프.
- **변환**: 게이트(관측성·증거·잔여·리스크) 통과 판정 + 이벤트 fold + changed_files 결정적 수집.
- **저장**: Record(record.json + events/), Run(completion.json·미러 등). (핸드오프는 `work`의 저장 표면이 아니다 — 핸드오프은 숨은 ref `refs/ditto/handoffs`에 산다, `docs/features/handoff.md`.)
- **출력**: `--output human|json`. json은 스크립트-소비 형태, human은 사람용.

---

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 4-1. Record/Run 2-tier 분할 (ADR-20260706, ADR-0012 D1 부분 supersede)

**개념**: durable한 프로젝트 메모리(status·AC verdict·github 멱등키)는 커밋된 Record에, 폐기 가능한 실행 트레일(runs·intent·graph)은 gitignored Run에 둔다. Run을 삭제해도 Record는 살아남는다.

**왜**: 사용자가 "공유되는 커밋된 백로그"(어느 PC·팀원이든 진행 상태를 봄)와 "스키마 수준 tier 분리"를 요구했다. 전부-커밋은 개인 실행 트레일까지 팀에 새게 하고, 전부-로컬(옛 ADR-0012 D1)은 공유 백로그를 불가능하게 한다 — 2-tier가 정확히 그 축이다.

**기각된 대안**: 전부-이벤트-소싱(저작 필드까지 매번 재생 — 비용), 전부-가변-레코드(전이 감사 불가 — 위험). 채택은 하이브리드(record.json 저작 필드 + events/ 전이).

**철회 조건**: 커밋된 Record churn이 머지 충돌 부담이 되면 커밋 경계 재검토; 공유-백로그 요구 철회 시 옛 D1로 복귀 가능.

### 4-2. 경량/무거운 2-경로 + logged-override (ADR-20260626)

**개념**: 무거운 경로는 그대로 두고 그 옆에 경량 경로를 *추가*한다. 두 경로 사이 강제는 "기본 차단 + 기록된 사유로 override"(logged-override) 스펙트럼이다.

**핵심 받침 5개**: (1) 관측성 게이트(`acceptanceTestable`가 비관측 기준 거부), (2) provenance 잠금(채점된 기준 덮어쓰기 = 골대 이동 차단), (3) `work promote`(재시작·손실 없이 제자리 승격), (4) 위험 축(`declared_risk`)이 무거운 경로 필요를 판정 — placeholder-문자열 nudge 대체, (5) `follow-up`·`stem`·`push-ready` 받침.

**왜**: 문제는 능력 부족이 아니라 "구조가 나쁜 행동(ad-hoc TDD)을 합리적 선택으로 만든 것". 가장 싼 올바른 길을 열어 즉흥을 구조적으로 불필요하게 만든다.

**기각**: 새 epic/group 저장 객체(비가역 스키마 commitment) → 체인 엣지(`follows`) + 파생 뷰; 능동 push 제안(§4-8 위반) → pull-only; 경량 패스마다 2차 리뷰어(경량을 다시 무겁게) → 관측성 게이트 + provenance 잠금.

### 4-3. 종료 완전성 게이트 + 하나의 의도=하나의 단위 (ADR-20260710)

**개념**: pass-close(`work done`·`autopilot complete`)는 in-scope agent-owned 잔여(에이전트가 해결 가능한데 미처분으로 남긴 위험·미검증 AC)를 **조용히 떨어뜨릴 수 없다**. work item과 typed node 사이에 "slice/phase" 중간 단위는 없다.

**왜**: terminal flip은 Stop 훅의 잔여 게이트를 우회한다(flip이 Stop의 NON_TERMINAL 가드를 건드림). 그래서 같은 분류기를 close 경로에도 배선한다(재사용, 새 분류기 없음 — R11 단일 라벨공간). `capture≠drive`는 통과 조건: 잡아둔 out-of-scope 후속은 게이트가 건드리지 않는다(조용한 축소만 겨냥, ADR-20260627 no-auto-pick 보존).

### 4-4. changed_files 오염 방지 (wi_260719ayc)

**개념**: changed_files는 **결정적 소스(커밋된 base...HEAD diff ∪ 명시 선언 `--changed`)** 로만 채운다. 워킹트리 전체 스캔은 소스가 아니라 GUARD로만 쓴다(`extraTrackedDirt`).

**왜**: 공유 트리에서 워킹트리 스캔은 외래/미커밋 dirt를 이 작업 편집과 구분하지 못해 완료본을 오염시켰다. 스캔을 소스에서 제거하고, 미커밋·미선언 tracked 편집이 있으면 fail-closed(`--noop-justification`으로만 override).

---

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### 5-1. 상태 fold — `reduceWorkItem` (`work-item-store.ts:407`)

record.json 위에 이벤트를 overlay한다. 순서는 **(seq, actor, event_id)** — `ts`는 clock-skew-unsafe라 정렬 키가 아니다(`:285` `compareWorkItemEvents`). kind별 fold:

- **status**: latest-wins, 단 **terminal(done/abandoned)은 first-terminal-wins** — 이미 terminal이면 경쟁하는 2번째 terminal을 무시하고 비-terminal reopen만 적용(`:422`). 이 한 줄이 "abandoned를 done으로 조용히 덮어쓰기"를 막는다.
- **verdict**: criterion_id별 latest-wins(늦은 fail이 이른 pass를 이김 — 회귀 마스킹 방지).
- **github/claim**: 마커 set-union, claim_release가 제거(`:321` `foldGithubIssue`).

효과: 다중 표면(autopilot·work CLI·github)이 같은 Record에 append해도 조용한 상태 revive가 불가능하다.

`readEvents`(`:540`)는 파싱 실패한 이벤트 파일을 **조용히 버리지 않고 throw**한다(`WorkItemEventCorruptError`, `:475`) — 드롭된 terminal 이벤트가 stale status를 되살릴 수 있기 때문. reconcile(`:1146`)만 예외로, throw 없이 corrupt 경로를 열거해 surface한다.

### 5-2. 생성 — `create` (`work-item-store.ts:693`)

record.json(status=draft) 작성 후 `created` status 이벤트를 append하고, languageLedger·Run 미러를 쓴다. `--criteria` 없이 start하면 AC-1이 `PLACEHOLDER_AC_STATEMENT`로 박힌다(`work.ts:1139`) — 이 정확한 상수를 user-prompt-submit의 placeholder 탐지기가 매칭해 deep-interview 지시를 발화하므로, CLI가 손으로 쓴 형제 문자열을 내면 그 게이트를 조용히 우회한다(주석 `:1135`).

### 5-3. started_at_sha / untracked baseline backfill (`update` `:748`)

- `started_at_sha`(`:768`): status가 in_progress이고 아직 비어 있을 때만 git HEAD sha를 한 번 박는다(멱등). `done`의 changed_files diff 기본 base가 된다.
- `started_untracked_baseline`(`:781`): **TRUE draft→in_progress 엣지에서만** 워킹트리의 untracked(`??`) 외래 dirt를 캡처. 의도적으로 started_at_sha와 다른 술어를 쓴다 — sha backfill 술어를 재사용하면 이미 in_progress인 레거시 항목에서 run 자신의 산출물을 pre-existing dirt로 잘못 잡아 silent under-commit이 된다(주석 `:774`).

### 5-4. done 종료 경로 (`work.ts:2109`)

순서 의존성이 있는 게이트 체인:

1. **park 분기**(`:2125`): `--status partial|blocked`이면 증거 게이트 대신 `store.park`로 재진입 가능 상태로 닫는다(re_entry 필수).
2. **blockingFollowUp**(`:2169`): 미해결 자기-유발 high/critical 버그 follow-up이 있으면 close 거부.
3. **placeholder 검사**(`:2198`): 아직 placeholder AC가 있으면 거부.
4. **declared_risk + intent.json 부재**(`:2213`): 위험 선언 WI가 intent.json 없이 경량 close하려 하면 `--override-heavy --reason` 요구, 사유를 감사 가능 risk note로 영속화.
5. **결정적 changed_files 수집**(`:2266`): `pickBaseRef`(started_at_sha 우선)로 base를 정하고 `collectChangedFiles`로 committed∪declared 집합을 계산. `diffErrored`(shallow clone 등)면 fail-closed(`:2285`). 워킹트리가 dirty(extraTrackedDirt)면 `--noop-justification` 없이는 거부(`:2312`/`:2341`) — 빈 소스 + clean 트리만 무-justification no-op close 허용.
6. **completion 합성 + 게이트**(`:2382`): `assembleCompletionFromWorkItem` → `completionGate` + `completionEvidenceGate`. final_verdict≠pass면 거부. 기존 completion이 pass면 재합성 skip(no churn), non-pass면 재합성해 supersede(`:2194` — 예: 이전 비-pass 종료 시도가 남긴 stale completion.json).
7. **종료 완전성 게이트**(`:2421` `passCloseResidualBlockers`): in-scope agent-owned 잔여가 미처분이면 거부.
8. **discovered-defect 게이트**(`:2444` `discoveredDefectCloseBlockers`): 발굴된 실동작 버그의 grounding wi 포인터를 store에 실제 존재하는지 async 확인 후 순수 게이트에 먹임 — 날조 포인터는 close를 풀지 못한다.
9. **mirrorAcceptanceVerdicts**(`:2468`) → `store.close(done)`(`:2469`, 단일 R1 chokepoint) → 명시 플래그 시 GitHub reflection(`:2474`) → terminal @me claim 해제(`:2479`).

### 5-5. changed_files 수집 — `collectChangedFiles` (`work-item-handoff.ts:107`)

`base...HEAD` diff(`--diff-filter=ACMR`) ∪ declared를 `files`에 넣는다. `head`가 명시되면 워킹트리는 아예 참조 안 함(과거 커밋 범위 정정). `head===null`일 때만 `git status --porcelain`을 GUARD로 읽어, 커밋도 선언도 baseline도 아닌 tracked 편집을 `extraTrackedDirt`에 모은다(`:148-170`). 이 경로들은 **절대 `files`에 fold되지 않는다** — 그게 이 모듈이 고친 오염 버그의 핵심.

`sanitizeDeclaredPaths`(`:69`)는 `--changed` 입력을 `containScopePath`(절대경로·`..`탈출·pathspec-magic 거부)에 leading-`-` 거부(option-injection 방어)를 합쳐 정화한다.

### 5-6. stem(줄기) — 파생 뷰 (`work-item-store.ts:949`, `computeStemViews:153`)

`follows` 엣지의 연결 컴포넌트를 양방향 전이 순회로 구성하고 root→tip으로 정렬(depth → created_at → id)한다. **저장된 stem 객체가 없다** — 매 조회 시 파생. 롤업(`rollUpStem:91`): 비-terminal 멤버 ≥1 → open, 전원 done → done, 그 외(일부 abandoned) → partial. 백로그 projection은 O(n²) 디스크 읽기를 피하려고 스냅샷당 `computeStemViews`를 **한 번**만 돈다.

### 5-7. push-readiness (`work-item-store.ts:239` `pushReadiness`)

`ready`는 4조건 AND: (1) 전 AC verdict=pass, (2) 전 AC가 command-kind 증거 ≥1(단순 note보다 강한 깊이), (3) 미해결 자기-유발 high/critical follow-up 없음, (4) 다중-멤버 stem이면 롤업=done. 순수 함수 — push를 *제안하지 않고* 신호만 계산(`push-ready` 커맨드가 명시 요청 시에만 노출).

### 5-8. 핸드오프 발행 경로 없음 — 종료는 `work done`이 단독 소유 (wi_260722g7h)

과거 이 자리에 있던 work-item 핸드오프 생성기(`writeWorkItemHandoff`: completion 합성 + 상태 전이 + 핸드오프 본문 작성)는 제거됐다(`work-item-handoff.ts:5-15` 주석). 채점·completion 합성·done/partial 전이는 이제 **오직 `work done` 경로**(§5-4)에 있고, 비-pass 종료는 re_entry park만 남긴다 — **핸드오프를 자동 발행하지 않는다**. 인계는 사용자-발의 핸드오프(`ditto handoff write`)으로만 만들어지며 work 생명주기와 무결합이다(ADR-20260722 결정 4).

### 5-9. follow-up 물질화 (`work.ts:2553`)

`--kind bug`은 추적 WI로 물질화(양방향 링크: 자식 `discovered_by`, 부모 `follow_ups[].materialized_wi`), `--kind idea`는 candidate만. `--batch`(`:2625`)는 intent의 `follow_up_candidates`(문자열) ∪ WI의 미물질화 idea follow_ups를 **한 번의 승인**으로 일괄 물질화하고 `intent.follow_up_materialization`에 기록(재실행 멱등). **materialize≠drive**: 생성된 WI는 status=draft로 남고 자동 착수되지 않는다(ADR-20260627 no-auto-pick, `:2622`).

---

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위: `work.ts` 서브커맨드 로직, `work-item-store.ts`, `work-item-project.ts`, `work-item-handoff.ts`, `run-store.ts`, 관련 스키마와 3개 ADR을 읽어 교차 확인. 실행 테스트는 이 조사 범위 밖(미검증).

일치 확인된 지점:

- **경량 종료 게이트가 무거운 경로와 같은 게이트를 공유**: `done`이 `completionGate`+`completionEvidenceGate`를 autopilot 경로와 동일하게 쓰고(`:2386`), 종료 완전성 게이트도 재사용(ADR-20260710 R11 의도대로).
- **push pull-only 불변식**: `pushReadiness`는 순수 계산만, `push-ready`/`chain drive`는 명시 요청/`--push`에서만 push. 능동 제안 경로 없음(확인 범위에서).
- **Record/Run 무손실**: `listCommittedRecords`(`:989`)가 Run tier를 절대 읽지 않아 Run 삭제 후에도 결정적 재생(ADR-20260706 ac-5 의도대로).

불일치/미묘한 지점(파일:라인):

- **`archive`의 문서-코드 편차(코드가 이미 명시)**: 설계 §3.3 스케치("status→archived 이벤트 + Run만 이동")는 landed 스키마에 구현 불가('archived'는 workItemStatus enum에 없고, first-terminal-wins reducer가 2번째 terminal 거부). 코드는 대신 committed Record를 `work-items-archive/`로 relocate한다(`work-item-store.ts:1011` 주석에 편차를 명시 — 헌장 §4-11 준수). **의도된 편차이지 버그 아님.**
- **`re_entry`는 이제 명시 입력으로만 채워진다**: park(`done --status partial|blocked`)가 `--re-entry-command`/`--needs`를 요구하고 그대로 기록한다(`work.ts:1949-1969`). 과거 핸드오프 생성기가 재진입 hint를 자동 합성하던 경로는 생성기 제거와 함께 사라졌다(wi_260722g7h).
- **레거시 dual-base 마이그레이션 창**: `get`/`list`/`exists`가 committed Record와 레거시 `.ditto/local/.../work-item.json`를 둘 다 본다(`:660`, `:1071`). WS0-T4(레거시 tier 마이그레이션)가 끝나기 전까지 유효한 과도기 코드로 표시돼 있음 — 확인 범위에서 죽은 경로 아님.

---

## 7. 잠재 위험·부작용·재설계 시 고려점

### 재설계 시 반드시 보존해야 할 불변식

1. **terminal first-terminal-wins**(`work-item-store.ts:422`, `close:868` R1 가드): terminal 상태의 조용한 덮어쓰기 금지. `reduce` fold와 `store.close` 두 곳이 이걸 함께 집행 — 한쪽만 바꾸면 갭이 생긴다.
2. **changed_files 결정적 소스(워킹트리 스캔 아님)**: `collectChangedFiles`가 커밋된 diff ∪ 선언만 소스로, 워킹트리는 GUARD. 이걸 소스로 되돌리면 공유 트리 오염 버그가 재발한다(wi_260719ayc가 고친 것).
3. **placeholder 상수 단일 SoT**(`PLACEHOLDER_AC_STATEMENT`): CLI가 별도 문자열을 내면 deep-interview 발화 게이트를 우회한다.
4. **push pull-only**: push는 사용자 비가역 결정. 능동 제안 추가 금지(§4-8).
5. **materialize≠drive**: follow-up이 만든 WI는 draft로 남고 자동 착수 안 됨(ADR-20260627). `chain drive`만 예외적으로 intent-locked 멤버를 구동한다.
6. **Record/Run 경계**: durable(status·verdict·github 멱등)은 커밋, 실행 트레일은 Run. Run 삭제 무손실.

### 약점·동시성·drift 위험

- **공유 트리 동시 세션**: `appendEvent`는 `open(wx)` 배타 생성으로 이벤트 원자성을 얻지만(파일 락 없음, ADR-20260628), 여러 세션이 같은 워킹트리를 공유하면 `git status`(collectChangedFiles GUARD)·git checkout이 서로 간섭한다. `--noop-justification`/`--changed`가 이 우회 장치지만, 이 자체가 운영 복잡도(메모리 노트에 반복 등장하는 gotcha).
- **레거시 마이그레이션 미완**: dual-base 코드가 곳곳에 있어 tier 경계 변경 시 committed-only fixture가 회귀를 숨길 수 있다(project 메모 "tier-경계는 양쪽 fixture 필수"). WS0-T4 완료 시 정리 대상.
- **completion.json stale 재합성 의존**: `done`이 stale non-pass completion을 재합성으로 supersede하는 로직(`:2194`)은 work item AC verdict를 SoT로 신뢰한다. AC verdict가 잘못 채워지면(예: verify를 pass+ac_fail로 기록) 그래프가 terminal로 굳어 reopen 불가해질 수 있다(메모리 gotcha).
- **`work.ts` 파일 크기(3581줄)**: GitHub claim·issue 연계·claim 배선이 생명주기 코어와 한 파일에 섞여 있다. 재설계 시 GitHub 연계 표면을 분리하면 코어 생명주기 로직의 가독성이 오른다 — 단, `boardItemMatchesRepoNumber` 등은 core→cli 레이어 역전을 피하려 이미 `core/github-coord`로 옮겨 재-export 중(`:85`)이므로 import 경로 계약을 깨지 않게 주의.

### 재고할 수 있는 결정

- **stem 파생 뷰의 O(n) 비용**: 큰 그래프·잦은 조회 시 `computeStemViews`를 매번 도는 비용이 커지면 materialized 뷰 추가를 검토(ADR-20260626 change_condition — 단 `follows` 엣지가 SoT인 모델은 불변).
- **self-caused 회귀 차단 임계**(high|critical): 실사용에서 과/소 차단이면 튜닝 가능(ADR-20260626).
- **push-ready의 command-kind 증거 요구**: 조건 2가 "모든 AC에 command 증거"를 강제 — soft_judgment/browser 증거만으로 완결되는 정당한 작업에서 과-엄격할 수 있다(확인 범위에서 실측 근거는 없음, 추론).
