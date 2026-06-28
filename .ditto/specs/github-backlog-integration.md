# GitHub 연계 (백로그·진척 통합) — 테크스펙

> **소비자**: DITTO(design → implement → verify) + 사람(증분 리뷰).
> **소스**: 사용자 요청(다음 세션 tech-spec 시작) · 메모리 `project_github_integration` · `backlog.md` 설계 초안 · 조사(work-item.ts·gh CLI·ADR 정책).
> **수명**: §3·§5·§6·§7·§10 = 장수명(빌드 후 ADR 승격) · §8·§11 = 단수명(빌드 후 폐기).
> **모드**: stepwise · **리뷰 커버리지**: finalize 산출물에 섹션별 reviewed/skipped 기록.
> **work item**: wi_260628sx5

---

## 1. 기능

- **이름**: GitHub 연계 (백로그·진척 통합) — wi_260628sx5
- **층위**: ditto work item 서브시스템(스키마 `src/schemas/work-item.ts` + CLI `ditto work`)과 외부 GitHub(Issues/Projects)을 잇는 신규 연계 표면. 호출은 `gh` CLI 경유(octokit 의존 없음).

## 2. 요약

**3층 모델**로 GitHub과 ditto를 잇는다: **Projects v2 보드** = 백로그 SoT(우선순위·상태), **Issue** = 작업 항목(title/body/계층), **ditto work item** = 로컬 증거 기반 실행 단위(완료 SoT). 셋을 **수동 링크(v1)** 로 묶는다. 개발자가 GitHub 보드에서 우선순위·상태를 관리하고, 이슈를 ditto로 끌어와 증거 기반으로 실행하며, 완료 결과(커밋·verdict·evidence)를 이슈 코멘트와 보드 상태에 반영한다. 목적은 이중 입력 제거와 협업↔실행 단절 해소 — GitHub의 협업·가시성과 ditto의 증거 게이트를 각자의 강점대로 합친다. 백로그가 Project(org/user 레벨)에 있으므로 cross-repo는 자연히 포함되고, 실행은 각 이슈의 repo에서 일어난다(per-repo rooting, ADR-0011).

## 3. 배경 [장]

**문제**: 현재 ditto work item은 로컬 `.ditto/local/work-items/`에만 존재하며 GitHub과 단절돼 있다. 팀이 GitHub Issues/Projects로 백로그·우선순위를 관리한다면, 같은 작업을 GitHub과 ditto 양쪽에 이중 입력해야 하고 ditto의 실행 결과(증거·verdict)는 GitHub에 보이지 않는다.

**이미 있는 인프라 (재사용 가능, 신규 계층 발명 불필요)** — `src/schemas/work-item.ts`:
- `parent_id`(:188) / `child_ids`(:189) = 작업 계층 트리(부모↔자식). 백로그 분해를 미러할 그릇.
- `follows`(:231–235) = 체인 lineage(순차), parent_id 트리와 별개.
- `materialized_wi`(:140–142) / `discovered_by`(:223–225) = follow-up bug 물질화의 양방향 provenance.
- `github_issue` 등 GitHub 연계 필드는 **없음**(`src/` grep 0건) → 옵셔널 필드 신규 추가 필요(기존 계약 불변).

**환경 사실 (조사 확정)**:
- 기존 GitHub 연계 코드 없음 — clean slate (`github` 매치는 CodeQL 다운로드 URL·marketplace 주석뿐).
- `gh` CLI 2.90.0 설치·인증됨. 단 **sub-issue 네이티브 명령 없음** — `gh sub-issue`는 unknown command. 이슈 계층은 `gh api graphql`의 `addSubIssue`(preview) 또는 task-list(`- [ ] #123`) fallback으로만 가능.
- gh 인증 계정(`hskim-ecoletree`)은 origin owner(`incognito050924`)와 다르나 **collaborator로 WRITE 권한 확인됨**(`viewerPermission=WRITE`, push·triage) — issue 코멘트·close 권한 OK. Projects v2 보드 소유 권한만 보드 생성 시 확인.
- **ditto 종료 신호 (구조화 enum, D7 매핑의 소스 키)**: work item status `draft/in_progress/blocked/partial/unverified/done/abandoned`(`common.ts`) · completion `final_verdict`(`pass`는 전 AC pass 강제, `completion-contract.ts`) · per-AC `verdict` `pass/partial/fail/unverified`. ditto는 이 enum으로 완료를 인지·처리한다(GitHub status가 아니라).

**사용자 초기 요구 그림 (`backlog.md`)** — 다음 5개를 주요 기능으로 그렸다:
1. 이슈 동기화 (title·description·assignee 등 GitHub Issue ↔ work item)
2. ADR 관리
3. Sub-Tasks 관리 — GitHub Issue의 sub-task를 work item 하위 작업으로 **자동 생성**
4. 상태 업데이트 — Backlog(ditto)에서 상태 변경 시 GitHub Issue에 **자동 반영**
5. 코멘트 연동 — GitHub Issue 코멘트가 work item에도 표시 (양방향)

**해소된 결정 (사용자 확정)**:
- **D1 자동화 = 수동 링크 v1 (+ decisive 직접 게시 예외)** — pull·link·comment·close는 명시 명령. routine 자동 동기화·양방향 미러·polling/webhook 데몬 없음. **예외**: autopilot이 *사람이 알아야 할 결정*(decisive class·follow-up)을 발생 시 이슈에 직접 코멘트로 게시한다(ditto→GitHub **단방향**, routine 진행 로그는 제외). 가시성을 위한 최소 완화이며 양방향 동기화가 아니다.
- **D2 ADR 관리 = v1 제외** — ditto ADR은 `.ditto/knowledge/adr/` 코드 곁 SoT 유지(charter §4-11, 이중화=drift 회피).
- **D3 SoT 3층** — **Project 보드(백로그: 우선순위·상태)=GitHub Projects v2**, **작업 항목(title·body·계층)=Issue**, **실행/완료(증거·verdict·완료 게이트)=ditto work item**. 정의·우선순위·상태는 GitHub이 SoT, 완료는 ditto가 evidence로만. GitHub 이슈/보드 상태를 ditto 완료 판정으로 끌어오지 않는다.
- **D4 repo 범위** — 백로그(Project)는 org/user 레벨이라 **cross-repo 자연 포함**, 실행은 각 이슈 repo에서(per-repo rooting, ADR-0011). self/cross를 따로 분기하지 않고 "이슈의 repo 좌표(owner/repo#n)"로 일원화.
- **D5 draft item** — Project 보드의 draft item(이슈 없는 초안)은 연계 대상 아님. ditto는 **Issue로 승격된 항목만** pull(Issue 단위). draft를 위해 ditto가 이슈를 자동 생성하지 않는다.
- **D6 진행 게시 대상 해소 + 멱등(G8)** — 게시 대상: ① child WI 자체 sub-issue 링크가 있으면 거기, ② 없으면 **부모 WI 이슈에 child 식별 prefix**(`[<child>] …`)로, ③ 부모도 링크 없으면 skip+안내. 게시 필터 = decisive 술어(decision log 실제 필드: `failure_class==='user_decision_needed'` ∨ `decision==='escalate'` ∨ `disposition==='blocked'`) + follow-up(`batch_escalate`/work item `follow_ups`)만(routine 제외, "마일스톤" 개념은 모호해 제거). 멱등: 게시한 decision id를 work item `posted_decision_ids`에 마킹 → 직접 게시는 재방문 시 skip, `sync-issue`는 미게시분만 롤업(없으면 no-op). 중복 코멘트는 달리지 않는다.
- **D7 Project status 매핑 = ditto 종료 신호 결박** — GitHub Project v2 status를 임의 이름 매칭이 아니라 **ditto의 구조화된 종료 enum에 결박된 프로젝트별 사용자 config 매핑**으로 정한다. 소스 키 = ditto enum(work item status `draft/in_progress/blocked/partial/unverified/done/abandoned` · completion `final_verdict` · per-AC `verdict`) → ditto가 인지·완료 처리 가능. GitHub status는 ditto→GitHub **단방향 미러**(완료 판정은 여전히 ditto evidence로만, D3 불변). 매핑 안 된 status·옵션은 skip+안내(우아한 강등).
- **D8 Project 연결 표면 = wizard + 비대화형(G9, 사용자 요청)** — `ditto github setup`이 대상 Project 지정→검증→status 매핑(D7)→권한 확인→config 저장을 **단계별로 안내**한다. D7 매핑을 사람이 손으로 config 작성하는 대신 wizard가 옵션 조회·질문으로 세팅. 비대화형 플래그로 자동화 지원. UI/UX는 설계 위임.

## 4. 목표

수동 링크 v1로 GitHub(Issues + Projects v2)과 ditto work item을 잇는다. 달성할 결과:

- **G1 Pull (이슈→work item)**: GitHub Issue를 끌어와 work item을 생성한다 — gh로 title·body fetch → `source_request` 시드 + 이슈 좌표(`owner/repo#n`) 링크 저장. Issue로 승격된 항목만(draft item 제외, D5).
- **G2 Link (기존 work item↔이슈)**: 이미 만든 work item을 이슈 좌표로 멱등하게(여러 번 실행해도 같은 결과) 링크한다.
- **G3 계층 미러**: GitHub에서 *사람이* 분해한 sub-issue 구조를 work item `parent_id`/`child_ids`로 미러한다. ditto가 자동 분해하지 않는다(분해 주체=GitHub). gh sub-issue 미지원이므로 `gh api graphql`(addSubIssue 조회) 또는 task-list 파싱으로 읽는다.
- **G4 완료 반영 (work item→이슈+보드)**: work item이 종료될 때 결과(커밋·verdict·evidence 요약)를 이슈 코멘트로 쓰고 Project status를 반영한다(D7). **종단 경로 둘 다에서 발화**해야 한다 — `ditto work done`(경량 경로)과 `ditto autopilot complete`(정본 경로; pass 시 거기서 직접 done flip하므로 `work done`을 거치지 않음). 둘이 공유하는 completion 지점(`src/core/completion-store`)에 배선해 한 경로만 켜지는 일을 막는다. 코멘트·보드 반영은 명시 옵션(설정/플래그), 이슈 close는 `--close-issue`로만.
- **G5 Projects v2 = 백로그 보드 연계**: work item을 보드 아이템과 링크하고, 보드의 우선순위·상태를 읽어 `work status`에 보이며(읽기), 종료 시 status field를 **ditto 종료 신호에 결박된 매핑(D7)** 으로 쓴다. 우선순위 결정은 사람 몫(ditto는 읽기만). 호출은 `gh project` + `gh api graphql`.
- **G6 우아한 강등 (ADR-0018)**: gh 부재/미인증/권한부족 시 링크는 수동 입력으로 받고 코멘트·보드 반영은 skip+안내한다. 실행·증거 본질은 막히지 않는다.
- **G7 상태 가시화**: `ditto work status`에 링크된 이슈 좌표·보드 위치(우선순위·status)를 표시한다.
- **G8 진행 가시화 (autopilot 작업 중 결정→이슈, 2경로)**: 소스 = autopilot decision log(`AutopilotDecision`, `autopilot-store.ts:15-77`). **범위 한정(OBJ-5)**: autopilot 루프 결정만 — deep-interview/tech-spec 단계의 [DECIDED] 의도 결정은 decision log에 없어 G8 대상이 아니다(그건 §5 비목표 또는 별도 단계). ① **수동 롤업** — `ditto work sync-issue`로 미게시 decisive 결정·follow-up을 1코멘트로. ② **직접 자동** — 발생 시 직접 게시. **decisive 술어는 decision log 실제 필드로 정의**(그래프 레벨 `stopCondition` enum이 아니라, OBJ-2): `failure_class==='user_decision_needed'` ∨ `decision==='escalate'` ∨ `disposition==='blocked'`(loop_terminated 미수렴). **follow-up 소스는 둘**: out-of-scope 배치 신호(`decision==='batch_escalate'`)=decision log, materialize된 bug=work item `follow_ups` 필드. **routine(retry/auto_fix/surface/passed 등)은 제외**(노이즈 경계). 게시 멱등 = `posted_decision_ids` 마킹.
- **G9 Project 연결 설정 표면 (사용자 command)**: GitHub Project(백로그 SoT)를 지정·연결하는 사용자 표면 — `ditto github setup`(가칭). **단계별 interactive wizard**: ① 대상 Project 지정(owner/number 또는 URL) → ② 접근·존재 검증 → ③ status field·옵션 조회(`gh project field-list`) 후 **ditto 종료 enum ↔ project status 옵션 매핑(D7)** 을 단계별 질문으로 확정 → ④ item-edit 권한 확인 → ⑤ `.ditto/local/config`에 저장. **비대화형 플래그**(`--project`·`--status-map` 등)로도 동일 config(자동화·CI, 멱등). 권한·접근 실패는 우아한 강등으로 사유 안내(ADR-0018). UI/UX 상세(wizard 흐름·프롬프트 문구)는 설계 단계 산출물.

## 5. 비목표 (변경 경계) [장]

- **routine 자동 동기화·양방향 미러 안 한다** — polling·webhook·백그라운드 데몬 없음. routine 진행 로그(running/passed)는 이슈에 자동 게시하지 않는다. *예외*: decisive 결정·follow-up의 **단방향** 직접 게시는 G8에서 허용(양방향 아님, D1).
- **ditto가 이슈를 자동 생성·자동 분해 안 한다** — 백로그 분해는 GitHub에서 사람이 한다(prime directive). ditto는 미러만(G3). draft item을 위한 이슈 자동 생성도 안 한다(D5).
- **cross-repo 실행을 ditto가 대행하지 않는다** — 다른 repo 이슈를 링크·표시(백로그)는 하되, 그 repo의 코드 변경 실행은 해당 repo에 rooting된 세션에서 한다(ADR-0011 session-rooting). 백로그=cross-repo, 실행=per-repo.
- **GitHub 이슈 상태를 ditto 완료 판정으로 쓰지 않는다** — 완료는 evidence 게이트로만(D4). 이슈가 닫혀 있어도 work item은 증거 없이 done 되지 않는다.
- **ADR을 GitHub과 연계 안 한다** — ditto ADR은 코드 곁 SoT 유지(D2).
- **assignee 양방향 동기화 안 한다** — work item은 `.ditto/local`(개인·단일 실행자) 구획이라 GitHub assignee를 미러할 의미가 약하다. (pull 시 참고 표시 정도는 G1에서 가능, 동기화는 아님.)
- **GitHub→work item 인바운드 표시 안 한다** — 이슈 코멘트·본문 변경을 work item으로 끌어와 보여주지 않는다(backlog.md "코멘트 양방향" 중 인바운드 절반은 v1 제외 — §4-6 명시 축소, 이유=`.ditto/local` 단일 실행자, OBJ-7). pull은 **1회 스냅샷** — 이후 GitHub의 title/body 변경을 다시 끌어오는 refresh/재pull도 v1 제외.
- **octokit 등 SDK 의존 추가 안 한다** — 호출은 `gh` CLI 경유만(설치·인증을 gh에 위임).

## 6. 완료 조건 (Acceptance Criteria)

> 관찰 가능한 술어 + evidence 종류(`test|diff|doc|browser|log`). 목표(포부)의 복붙 금지 — AC는 목표 충족을 증명하는 관문이다.

| id | 완료 조건 (관찰가능 술어) | evidence |
|---|---|---|
| ac-1 | `ditto work start --issue <owner/repo#n>`가 gh로 이슈 title·body를 fetch해 work item을 생성하고 `github_issue` 좌표를 저장한다. 이미 그 이슈로 링크된 work item이 있으면 중복 생성 대신 기존 id를 반환/경고(멱등). | test |
| ac-2 | 기존 work item에 이슈 좌표를 거는 링크 명령이 멱등하다 — 같은 좌표로 2회 실행 시 상태가 동일하다. | test |
| ac-3 | GitHub의 sub-issue/task-list 계층을 work item `parent_id`/`child_ids`로 미러한다 — graphql `addSubIssue` 조회 우선, 실패 시 task-list(`- [ ] #n`) 파싱 fallback, 둘 다 불가면 수동 입력 강등. ditto는 새 이슈를 만들지 않는다(미러만). | test |
| ac-4 | **두 종단 경로(`work done` 및 `autopilot complete` pass-분기, OBJ-1)** 가 결과 요약(커밋·verdict·evidence)을 링크된 이슈 코멘트로 게시한다 — 주입된 fake gh-client에 comment 1회 호출로 검증. close는 `--close-issue`가 있을 때만(없으면 코멘트만). | test + 실호출 smoke(log) |
| ac-5 | 두 종단 경로가 링크된 Project v2 아이템 status를 **ditto 종료 신호 결박 config 매핑(D7)** 으로 갱신한다(fake client 호출로 검증). 매핑 없는 status/옵션은 skip+안내(완료 판정은 ditto evidence로만, GitHub status로 끌어오지 않음). | test + 실호출 smoke(log) |
| ac-6 | `ditto work status`가 링크된 이슈 좌표·보드 위치(status·우선순위)를 표시하고, **보드 status와 work item 상태가 어긋나면 divergence를 드러낸다**(예: "보드=Done이나 WI=in_progress[증거 미충족]"). 완료축=ditto가 SoT(write), 우선순위축=GitHub이 SoT(read-only) — 비대칭 명문화(D3/D7, OBJ-4). | test |
| ac-7 | gh 부재/미인증/권한부족 시: 링크는 수동 입력 fallback을 제공하고, 코멘트·보드 반영은 skip하며 사유를 안내한다. work item 실행·완료(증거) 경로는 막히지 않는다(ADR-0018). | test |
| ac-8 | `github_issue` 옵셔널 필드 추가가 기존 `work-item.json` 계약을 깨지 않는다 — 필드 없는 기존 work item이 그대로 로드·동작한다. | test |
| ac-9 | `ditto work sync-issue`가 **마지막 게시 이후 미게시분만** 선별(decisive·verdict·follow-up)해 링크된 이슈에 게시한다 — 주입 fake gh-client에 정확히 1회 호출(새 결정 없으면 0회=no-op). routine 로그는 포함하지 않는다. | test |
| ac-10 | decisive 술어(`failure_class==='user_decision_needed'` ∨ `decision∈{escalate,batch_escalate}` ∨ `disposition==='blocked'`)에 맞는 decision log 항목 발생 시 직접 코멘트하고, routine(retry/auto_fix/surface/passed)은 게시하지 않는다. 같은 decision id 재방문 시 중복 게시하지 않는다(`posted_decision_ids` 멱등). 주입된 fake gh-client 호출 횟수로 검증. | test |
| ac-11 | work item에 `github_issue` 링크가 없으면 진행 게시(G8)는 skip하고 사유를 안내한다(에러 아님). work item 실행·완료(증거 게이트)는 영향받지 않는다. | test |
| ac-12 | child work item(sub-task)의 진행 게시 대상은 ① 자체 sub-issue 링크 우선, ② 없으면 부모 WI 이슈에 child 식별 prefix로, ③ 부모도 링크 없으면 skip — 순으로 해소된다. | test |
| ac-13 | pull/start가 이슈 repo 좌표 ≠ 세션 rooting root면 변경 실행을 **fail-closed로 막고** link·표시만 허용한다(백로그=cross-repo, 실행=per-repo; ADR-0011, OBJ-6). | test |
| ac-14 | `ditto github setup`(Project 연결 wizard, G9)가 대상 Project·status 매핑·권한 확인을 거쳐 config를 기록한다 — 비대화형 플래그로도 동일 config가 나온다(멱등). 권한·접근 실패는 명확한 사유로 안내(우아한 강등). | test |

## 7. 위험

> 위험을 적고, 각 위험을 AC 승격(§6) / 비목표(§5) / unknown(여기 잔류) 중 하나로 처리한다. 비가역(데이터 손실·스키마 마이그레이션·공개 API)이면 플래그한다.

| 위험 | 처리 | 플래그 |
|---|---|---|
| gh 인증 계정(`hskim-ecoletree`) ≠ origin owner(`incognito050924`) — sub-issue/project 쓰기 권한 미검증 | 구현 시 실제 호출 1회로 실증(log) + 권한부족은 우아한 강등(ac-7) | irreversible=false |
| GraphQL `sub_issues`가 preview 헤더 — API 변경 가능 | addSubIssue 실패 시 task-list(`- [ ] #n`) 파싱 fallback(G3); 잔여 불확실은 unknown | — |
| 같은 이슈를 중복 pull → work item 중복 생성 | 멱등 가드(ac-1): 이미 링크된 이슈면 기존 반환 | — |
| cross-repo 이슈 링크 후 그 repo 코드를 ditto가 직접 변경 시도 → rooting 위반 | 백로그 링크·표시만 허용, 실행은 per-repo rooting(§5 비목표·ADR-0011) | — |
| `github_issue` 필드 추가 = 스키마 변경 | 옵셔널 필드 → 비가역 아님, 기존 로드 안전(ac-8) | irreversible=false |
| Projects v2 GraphQL의 node id·field option id 처리 복잡도 | `gh project` 명령 우선, 부족분만 `gh api graphql`; 구현 난이도이지 비가역 아님 | — |
| Project status 옵션이 프로젝트마다 커스텀 | **D7로 해소** — ditto 종료 enum에 결박된 프로젝트별 config 매핑, 매핑 없으면 skip+안내(ac-5) | — |
| 직접 게시(G8)가 중복·과다 코멘트 유발 | 게시한 decision id 마킹으로 멱등(ac-10·12), routine 제외로 빈도 제한, decisive class만 필터 | — |
| child WI 게시를 부모 이슈로 올릴 때 부모 이슈가 자식 로그로 덮임(노이즈) | child 식별 prefix(`[<child>]`) + decisive-only + 멱등으로 식별·빈도 확보(D6·ac-12) | — |
| 링크 없는 work item에 게시 시도 → 크래시 | skip+안내로 강등, 실행 무영향(ac-11) | — |
| G8 직접 게시 secondary rate limit(짧은 시간 다수 쓰기) | 게시 실패 시 `posted_decision_ids` 마킹 **보류** → 다음 `sync-issue`가 롤업(§8 core, OBJ-9). 마킹과 실게시를 분리해 재시도 보존 | — |
| 종료 반영(G4/G5)이 한 종단 경로(work done)에만 걸려 autopilot 경로 미발화 | 두 경로 공유 completion 지점(`completion-store`)에 배선(ac-4·5, OBJ-1) | — |

## 8. 계획 (Plan) [단]

> ⚠ **비구속(non-binding) 설계 힌트.** 구현 시 참고만 하며 더 나은 설계로 대체할 수 있다.

- **스키마** (`src/schemas/work-item.ts`): `github_issue` 옵셔널 필드 추가 — 모양 암시: `{ repo: "owner/name", number: int, node_id?: string, project_item_id?: string, posted_decision_ids?: string[] }`. `posted_decision_ids`가 G8 게시 멱등을 추적(D6). **단수 링크**(1 WI ↔ 1 이슈); 1 WI ↔ N 이슈는 v1 미지원(gap, 필요 시 후속). 기존 계약 불변(ac-8).
- **core** (`src/core`): gh 호출 래퍼 `gh-client` — **주입 가능한 인터페이스**(테스트는 fake gh-client를 주입해 호출 횟수로 검증, 라이브 호출은 별도 smoke로 분리; OBJ-3). issue view/comment/close, `project item-add`/`item-edit`/`field-list`, `api graphql`(addSubIssue 조회). gh 부재·미인증·권한부족 감지 → 우아한 강등(ac-7). **게시 실패 시 `posted_decision_ids` 마킹을 보류**(실패분은 다음 `sync-issue`가 롤업; rate limit 흡수, OBJ-9).
- **CLI** (`src/cli`): `ditto work start --issue`, 링크 명령(`work link-issue` 등), `work done --comment-issue`/`--close-issue`, `work status` 표시 확장.
- **계층 미러**(G3): gh sub-issue 네이티브 미지원 → graphql addSubIssue 조회 또는 부모 이슈 본문 task-list 파싱.
- **코멘트 정책**(G4, [DECIDED]): 링크 단위 — 각 work item 완료 시 그 WI에 링크된 이슈에 코멘트. 이슈 1↔WI N의 부모 롤업은 stem/chain close 시 1회(기존 chain rollup 활용).
- **보드 깊이**(G5, [DECIDED]): v1 최소 — 아이템 추가 + status field 1회 반영(Done). custom field(ditto 링크·verdict 기입)는 비목표(다음 단계).
- **진행 게시**(G8): 소스 = decision log(`autopilot-store` `appendDecision`). 필터 = decisive class·follow-up만(routine running/passed 제외). 직접 자동 게시 훅은 autopilot 루프 측. **게시 대상 해소**(D6): child 자체 sub-issue → 부모 이슈(child prefix) → skip. **멱등**: 게시한 decision id를 work item에 마킹 → 직접 게시 재방문 시 skip(ac-10·12), `sync-issue`는 미게시분만 롤업(ac-9, 없으면 no-op).
- **status 매핑**(G5/D7): config가 `ditto 종료 enum → project status 옵션` 매핑을 정의(예: `final_verdict=pass`/`status=done`→프로젝트의 "Done" 옵션). 옵션 id는 `gh project field-list`로 조회. 매핑 없으면 skip+안내(ac-5).
- **Project 연결 표면**(G9/D8): `ditto github setup` — citty subcommand. interactive 단계(질문 흐름) + non-interactive 플래그. config 모양 암시: `{ project: {owner, number, node_id}, status_map: {<ditto 종료 enum> → <project status option id>} }` → `.ditto/local/config`. 옵션 id는 `gh project field-list --owner`로 조회. wizard가 D7 매핑 세팅의 단일 진입점.
- **미정**: Projects v2 보드 소유 권한 실증(보드 생성 시) · graphql 쿼리 정밀 형태 — 설계/구현 단계 산출물.

## 9. 영향도 · 의존성

- **건드리는 표면**: `src/schemas/work-item.ts`(필드 추가) · `src/cli`(work 명령군 + `sync-issue` + **`github setup` wizard**) · `src/core`(신규 gh 연계 래퍼 + **`completion-store` 공유 게시 훅[G4, OBJ-1]** + autopilot decisive 게시[G8]). 다표면 변경 → **non_local 신호 있음**.
- **외부 의존**: `gh` CLI(런타임, 설치·인증 위임) · GitHub API(Issues REST + GraphQL `sub_issues` preview + Projects v2 GraphQL). octokit/SDK 미추가.
- **정합 결정**: ADR-0011(session-rooting) · ADR-0018(선택적 외부도구 우아한 강등) · prime directive(자동 분해 금지) · charter §4-11(ADR 코드 곁 SoT, D2).
- **공개 표면 변화**: 새 CLI 플래그·새 work item 필드(옵셔널). 파괴적 변경 없음.

## 10. 기각된 대안 [장]

- **자동 양방향 동기화(데몬·webhook·polling)** — 기각. prime directive와 증거 게이트(완료=evidence)와 충돌, 운영 복잡도 큼. v1은 수동 링크(D1). (단 decisive 결정의 **단방향·선별** 직접 게시(G8)는 별개 — 데몬 없이 결정 발생 시점에 푸시, routine 제외.)
- **Issues = 백로그 SoT** — 기각. 백로그의 본질(우선순위·상태·cross-repo 집계)은 개별 Issue가 아니라 Projects v2 보드. 3층 모델 채택(D3).
- **octokit/Octokit SDK 직접 의존** — 기각. gh CLI가 설치·인증·버전 호환을 위임받아 의존 표면이 작다(§5).
- **ditto가 백로그를 자동 분해해 sub-WI 생성** — 기각. 분해는 사람이 GitHub에서(prime directive); ditto는 미러만(G3, D5).
- **cross-repo 실행까지 ditto가 대행** — 기각. 실행은 rooting된 repo 세션에서; 백로그(링크·표시)와 실행을 분리(D4·ADR-0011).

## 11. 마일스톤 [단]

미정(autopilot planner가 노드로 분해). 대략 순서 힌트: ① 스키마 `github_issue` 필드 + ac-8 → ② gh-client 주입 래퍼 + 우아한 강등(ac-7) → ③ pull/link + cross-repo 가드(ac-1·2·13) → ④ 계층 미러(ac-3) → ⑤ **Project 연결 wizard(ac-14, G9)** → ⑥ 완료 반영 코멘트·close, 두 종단 경로(ac-4, OBJ-1) → ⑦ Projects v2 status 매핑(ac-5) → ⑧ status 표시 + divergence(ac-6) → ⑨ 진행 게시(ac-9 sync-issue, ac-10 decisive). G9를 연계 동작(⑥~)보다 앞에 둬 매핑 config가 먼저 존재하게.

## 12. 인터뷰 기록

<이 문서를 형성한 유도(인터뷰) 과정을 **요약**해 남긴다 — 원문 전사가 아니라 "어떤 좋은 질문/관점이 무엇을 드러냈고, 어떤 결정에 이르렀나". 목적은 독자가 이 문서가 *어떻게* 작성됐는지 이해하게 하는 것. 비대해지지 않게 요약 + 원본 링크. 정식 deep-interview 호출이 없어도 작성 루프의 좋은 질문·비판으로 형성됐으면 채운다. 정말 아무 유도도 없었으면 "없음".>

- 작성 과정 요약: 메모리 합의(GitHub=SoT, 수동 링크 v1)에서 출발 → `backlog.md`가 *자동 동기화·양방향·자동 생성*을 그려 긴장 발생 → 전문가 평가로 **SoT가 두 축**(정의 vs 실행/완료)임을 드러냄(backlog.md "상태 반영"과 "GitHub=SoT"의 표면 모순을 해소) → 사용자가 **"Projects v2를 백로그 SoT로"** 재구성 제안 → **3층 모델**(Project⊃Issue↔work item)로 수렴. 이 재구성이 핵심 맹점 해소: 백로그를 Project에 두니 **cross-repo가 자연 포함**되어 repo 범위 질문이 동시에 닫힘(실행은 per-repo rooting으로 분리). 모호했던 "ADR 관리"는 v1 제외, draft item은 Issue 승격분만으로 확정.
- 추가 라운드(진행 가시화): "작업 중 이벤트·결정을 코멘트로 달 수 없나" → ditto가 decision log(`appendDecision`)·decisive class·verdict·follow-up을 이미 구조적으로 남김을 확인. 노이즈 경계가 쟁점 → 사용자가 "직접 issue에 달아도 되고"로 자동 게시도 허용. **routine(running/passed) 제외, 사람이 알아야 할 결정만 직접 게시 + 수동 sync 롤업**으로 수렴(G8). D1을 "decisive 단방향 직접 게시 예외"로 최소 완화.
- 엣지 라운드(멱등·링크없음·sub-task): "여러 번 코멘트 중복?/링크 없으면?/sub-task면?" 세 엣지를 pre-mortem으로 닫음 — 멱등(decision id 마킹·미게시분만, ac-9·10), 링크 없으면 skip+안내(ac-11), child 게시 대상 해소(자체 sub-issue→부모 이슈 prefix→skip, D6·ac-12). 사용자가 부모 이슈 게시(가시성)를 택해, 노이즈는 child 식별 prefix + decisive-only + 멱등으로 제어.
- 미해결 마감 라운드: spec 미해결 3건을 닫음 — (1) **권한**: gh로 직접 확인해 현재 계정이 origin repo WRITE collaborator임을 실증(질문 불필요, 코드/도구로 답). (2) **status 매핑**: 사용자가 "임의 이름 매칭 말고 ditto가 인지 가능한 *구조화된 종료 조건*에 결박"을 요구 → ditto 종료 enum(work item status·`final_verdict`·per-AC `verdict`)을 조사해 D7로 결박(GitHub status는 단방향 미러, 완료는 ditto evidence). (3) **마일스톤**: 모호해 제거 — decisive class + follow-up만. 결과: 의도 차원 미해결 0, 구현 단계 검증 항목만 잔류.
- 적대적 검증(dialectic-review, Producer/Opponent/Synthesizer): Producer가 구조 토대(스키마 재사용·결박 enum/소스)를 코드로 확인, Opponent가 oracle 결박 반론 9건. **verdict=revise**. must-fix 3건 — OBJ-1(완료 반영 G4/G5가 `work done`에만 걸려 정본 경로 `autopilot complete`에서 미발화 → `completion-store` 공유 지점 배선), OBJ-2(G8 "decisive class"가 실제 decision log 필드가 아니라 별개 `stopCondition` enum → `failure_class`/`decision`/`disposition`로 재정의), OBJ-3(gh AC 테스트 seam 없음 → gh-client 주입 + fake 호출수 검증). should-fix 4(보드 divergence 표시·G8 범위 한정·cross-repo 가드 AC-13·인바운드 코멘트 제외 명시) + acknowledge(rate limit·item-edit·1WI↔N·pull refresh) 전부 spec 반영. scope_creep(G8을 sync-issue로 합치기) 기각 — 사용자가 직접 게시를 명시 요청해 의도 보존.
- G9 라운드(사용자 추가 요구): "연결할 GitHub Project를 지정하는 사용자 표면(command) 필요, 단계별 세팅" → **interactive wizard + 비대화형 플래그**로 설계(D8·G9·ac-14). D7 status 매핑의 단일 진입점. UI/UX 상세는 설계 위임.
- deep-interview: 없음(정식 호출 없음). tech-spec 작성 루프의 good-question·전문가 비판으로 형성.
- 원본: 작성 추적은 work item 트레일 + tech-spec-state.json.

## 13. 빌드 후 처리

- **ADR 승격(잔존)**: §3·§10 → **SoT 3층(D3, Project=백로그 / Issue=항목 / work item=완료) + repo 좌표 일원화(D4)** 를 ADR로 박는다 — 비가역 아키텍처 결정(외부 의존·SoT 방향). 식별자 정책상 파일명 `ADR-20260628-github-backlog-sot.md` 형식(ADR-YYYYMMDD-slug; "ADR-0026"은 폐기된 형식). `ditto:knowledge-update`로.
- **폐기**: §8 계획·§11 마일스톤 → 코드가 SoT가 되면 archived. `backlog.md` 초안도 이 스펙·코드에 흡수 후 정리.
- **링크**: wi_260628sx5 ↔ 이 문서 ↔ 생성 ADR 상호 링크.

---

## 미해결 질문

- ~~권한 실증~~ → **해소**: 현재 계정이 origin repo에 WRITE(collaborator) 확인 — issue 코멘트·close 권한 OK. 잔여: **Projects v2 보드 소유 권한**만 보드 생성 시 확인(구현 단계).
- ~~Project status 매핑~~ → **해소(D7)**: ditto 종료 enum(work item status·`final_verdict`·`verdict`)에 결박된 프로젝트별 config 매핑. GitHub status는 단방향 미러, 완료는 ditto evidence로만.
- ~~"주요 마일스톤" 기준~~ → **해소**: 마일스톤 개념 제거, G8 직접 게시는 decisive class + follow-up만.
- **남은 구현 단계 검증**(의도 차원 결정은 전부 닫힘, D1~D8): **대상 Project의 item-edit 접근 실증**(repo collaborator·project scope ≠ 그 보드 쓰기 권한 — 보드 생성 권한과 분리, OBJ-8) · GraphQL `sub_issues`/Projects v2 쿼리 정밀 형태 · `gh project field-list`로 status 옵션 id 조회.
