# WS0-T0 상세설계 v2 — 기록/실행 분리 + 공유 tier 이동 (아키텍처 코어)

- work item: `wi_2607069bk` (heavy, declared_risk: non_local·irreversible)
- SoT 근거: `reports/design/ditto-quality-remediation-backlog.md` §2.5 · §7(Q1·Q2·Q4·Q5·Q11) · §8 · §9(A1·A2·B1·C1·C5·D1·D2)
- 상태: **설계 v2 — pre-mortem 반영 완료.** v1을 3-lens fresh-context pre-mortem(데이터/트랜잭션·마이그레이션/leak·소비자/계약, anti-SLOP file:line)으로 압박한 결과 **verdict=revise**: 방향(Record/Run 컷·committed SoT)은 공격을 견뎠고 **메커니즘을 교체**했다. 아래 §10에 무엇이 뒤집혔는지 결박.
- 소비자: (1) autopilot 구현. **폐기 조건**: 랜딩 후 결정을 코드 주석 + ADR로 흡수하고 은퇴(charter §4-11).
- 착수 근거: Q3 해제(P0 §8+§9 완료). §4 spine-first 임계경로 루트. Q1·Q2·Q4·Q5·Q11 사용자 확정(§7). 본 설계는 그 결정의 **메커니즘** 확정.

---

## 0. 범위 경계

**T0 IN:** work item **코어 상태**의 스키마·물리 분리 + A1·A2·B1·D1(+D2)·E 정합 + `exists/list/archive` 재작성 + 후방호환. **C1은 no-op으로 종결**(§10-R3), **C5는 방향 반전**(§10-R4).

**파일:**
- 5-파일 코어: `src/schemas/work-item.ts`·`autopilot.ts`·`completion-contract.ts`·`src/core/work-item-store.ts`·`.gitignore`.
- 필수 추가: `src/core/ditto-paths.ts`(committed base 헬퍼)·`.gitattributes`(신규, merge 힌트).
- 소비자(검증 필수): `src/core/work-item-handoff.ts`(D1)·`src/core/completion-store.ts`(verdict 이벤트)·`src/core/github-progress.ts`+`src/core/github-claim.ts`+`src/cli/commands/work.ts`+`src/cli/commands/autopilot.ts`(C5 — posted/claim ids를 committed 이벤트로, 7 소비자 전수).
- **stop.ts는 안 건드림**(C1 no-op, §10-R3).

**T0 OUT:** WS0-T1(projection·`work list` 집계)·T2(고아 draft)·T3(GitHub 칸반 투영+ADR D3)·**T4(벌크 마이그레이션 실행)**. seam #4(change-contract tier)·#5(e2e-verdicts tier) 및 ~10 borderline durable 원장(evidence-index·convergence·acg-review·fitness-functions·semantic-compatibility·tidy-classification·dataflow-dod·e2e-lifecycle·e2e-assertion-map)의 committed 승격 = **값 결정 batch(후속)**. T0에서 이들은 개인 tier 유지(leak 0).

**OFF-LIMITS:** `src/core/autopilot-loop.ts`(원격 WS3). B1 게이트가 여기 있으나 T0는 안 건드린다(§4 B1). `lsp-diagnostics.json`·`decision-conflict.json`(여기서만 write)은 개인 tier 유지 — 이동 시도 안 함(§10-R2).

---

## 1. Record / Run 경계

원칙: **Record = "무엇을·왜"(영속·공유·committed). Run = "어떻게"(일회성·개인·폐기 가능).** Run 삭제 무손실.

### 1.1 물리 모델 — 하이브리드 (pre-mortem Finding D 강제)

Record를 **두 committed 산출물**로 나눈다. 하나는 저작·저빈도(mutable), 하나는 기계·고빈도·동시성 민감(append 이벤트). memory 서브시스템의 `sources`(가변 per-entity) + `events`(append) 이원 구조와 정합.

| 산출물 | 경로(committed) | 성격 | 내용 |
|---|---|---|---|
| **`record.json`** | `.ditto/work-items/<id>/record.json` | 가변 단일 파일(full-mutator·git 충돌 드묾) | id·title·source_request·goal·**AC 멤버십**(statement·oracle·superseded·`evidence_required`)·lineage(follows/discovered_by/parent/child)·owner_profile·declared_risk·github **불변 좌표**(repo·number·node_id·project_item_id)·language_overrides |
| **`events/<seq>.<actor>.<eid>.json`** | `.ditto/work-items/<id>/events/` | per-event **immutable** 파일(`open(wx)`) | **status 전이**(to·closed_at)·**AC verdict**(criterion_id·verdict·evidence[])·**github post/claim 멱등 이벤트**(posted_decision_id·posted_claim_marker·claimed_branch·release) |

- **get()** = `record.json` 읽고 **events fold**로 overlay: status(=terminal-first-wins by (seq,actor))·closed_at(=최신 status 이벤트에서 파생)·AC별 최신 verdict+evidence(id 조인)·posted/claim 셋(union, release로 무효).
- **왜 하이브리드인가(Finding D):** 순수 event-fold는 **키 삭제**를 표현 못 한다 — `reopen`이 `closed_at`을 드롭(work-item-store.ts:293), unclaim이 `claimed_branch` 삭제(work.ts:748,834). 이벤트 fold(`{...acc,...payload}`)로는 키 제거 불가. 하이브리드에선 closed_at·claim을 **status/claim 이벤트에서 파생**(드롭=명시 이벤트)해 삭제 문제가 사라지고, 저작 필드는 record.json full-mutator로 그대로 처리(단일 파일 원자).
- **왜 status/verdict/post-id만 이벤트인가:** 이들이 **고빈도·동시(worktree 병렬)·원자성 critical**. 저작 필드(title·goal·AC 멤버십·lineage)는 저빈도·단일 저자 → git 충돌 드묾, mutable 파일 수용.

### 1.2 현행 `workItem` 필드 배정 (요지)

- **record.json(Record):** id·title·source_request·goal·acceptance_criteria(멤버십+oracle+superseded+**evidence_required**)·owner_profile·declared_risk·promoted_to_heavy·follow_ups·discovered_by·follows·parent_id·child_ids·risks·github_issue(좌표만)·changed_files·language_overrides·re_entry.
- **events(Record):** status·closed_at·AC verdict+evidence·github posted_decision_ids·posted_claim_markers·claimed_branch.
- **Run(개인, `.ditto/local/work-items/<id>/` 유지):** autopilot.json·completion.json·intent.json·evidence/·metrics.jsonl·tech-spec-*·interview/journey 버퍼·active-leases·lsp-diagnostics·decision-conflict·runs·worktrees·handoff_path·started_at_sha·나머지 store 산출물.
- **Finding E:** `evidence_required`(현재 intent.ts:14-18의 intent AC에만, work-item.ts:68-90 base AC엔 없음)를 **base AC(record.json)로 승격**(additive optional). intent.json(Run) 삭제해도 "AC별 요구 증거 종류"가 Record에 남아 무손실. intent AC는 Record AC의 파생 뷰로 강등(멤버십 SoT=Record).

> **Run 삭제 무손실(공격 생존):** completion.json은 `assembleCompletionFromWorkItem`(completion-store.ts:95-110)로 재생성, durable verdict+evidence 포인터는 events에 있음. intent.json durable AC·evidence_required는 record.json에. **단 posted/claim 멱등 셋은 events(committed)에 둬야 무손실**(Finding A — §10-R4).

---

## 2. 상태 모델 — committed per-event immutable log (Q1·Q5, pre-mortem 교체)

**결정(v1 교체):** status/verdict/post-id 전이 = committed **per-event immutable 파일** 로그의 reduction. v1의 "shared events.jsonl + atomicWriteText append"는 **clobber**였다(§10-R1). memory-store 정확 템플릿(`memory-store.ts:104-119` — 파일당 1이벤트 + `open(wx)`).

### 2.1 이벤트 스키마 (schemas/work-item.ts additive)

```
workItemEvent = {
  schema_version, work_item_id,
  seq,            // REQUIRED, per-writer monotonic (Lamport 유사)
  actor,          // REQUIRED, writer 식별(profile/session) — (seq,actor) 순서 tiebreak
  event_id,       // REQUIRED, content-hash{kind,payload core} — dedupe 키(멱등)
  ts,             // informational only (순서에 안 씀 — clock skew 방지)
  kind: 'status'|'verdict'|'github_post'|'claim'|'claim_release',
  payload
}
```

- **파일명:** `events/<seq_zeropad>.<actor>.<event_id_short>.json`, `open(path,'wx')`(배타 생성). 파일당 1이벤트라 **동시 append 무충돌**(clobber 불가)·git 무충돌(서로 다른 파일).
- **reducer `reduceWorkItem(record, events)`:** events를 **(seq,actor)** 로 정렬(ts 아님), `event_id`로 dedupe, kind별 fold:
  - status: 최신(최대 (seq,actor)) 적용; **단 terminal(done/abandoned)은 first-terminal-wins**(최소 (seq,actor)의 terminal이 승 — R1 배타성). closed_at은 승 terminal 이벤트에서.
  - verdict: criterion_id별 최신 (seq,actor) 승(늦은 fail이 이른 pass를 이김 — 회귀 마스킹 방지).
  - github_post/claim: union; claim_release가 해당 marker 무효.

### 2.2 A1 원자성 — commit-last + reconcile

- 모든 Run-tier 쓰기(evidence·completion.json·autopilot 그래프)를 **먼저** 개인 tier에 완료.
- Record terminal 전이 = **단일 status 이벤트 파일** 생성(`wx`, 파일 1개 = 원자). **Finding F8 교정:** terminal 이벤트는 **AC verdict 전체를 payload에 동봉**(N+1 append 아님) — 한 파일에 done+전 verdict. 부분 상태 원천 차단.
- 2 이전 크래시 → events에 terminal 없음 → reduce head가 직전 non-terminal → 재실행 가능(event_id dedupe로 멱등).
- **reconcile(`ditto work reconcile <id>` 또는 doctor):** events에서 head 재도출; 없는 Run 참조·stale 파생 드러냄(조작 없이 surface).

### 2.3 D1 — terminal 배타성

- **first-terminal-wins reducer(§2.1)** 가 R1을 구조적으로 보장 — 동시 두 terminal이 각자 파일로 남아도 reduce가 하나만(최소 (seq,actor)) 채택. TOCTOU 무의미(Finding A-F4 해소: 경쟁해도 결과 결정적).
- append-guard(best-effort): append 전 reduce해 이미 terminal이면 거부(사용자 대면 즉시 에러). 하드 보장은 reducer.
- `work-item-handoff.ts:324-341` 직접 status write **제거** → 같은 이벤트 append 경로로. close()/R1 단일 chokepoint 복원.

---

## 3. A2 — leak + eager + 물리 base (pre-mortem 대폭 축소)

### 3.1 격리된 committed base (29-site 리네임 철회, §10-R2)

- **Record base = 신규 `.ditto/work-items/<id>/`(committed).** 오늘 이 경로에 쓰는 생산자 **0**(스윕 확인 — `dittoDir(...,'work-items')` 부재; codeql 등 reviewer-output도 `localDir`로 개인 tier). 즉 **격리된 신규 네임스페이스**라, Run 생산자를 하나도 안 옮겨도 **leak 물리적 불가**.
- **Run 생산자 전부 UNCHANGED**(`.ditto/local/work-items/<id>/` 유지, 개인 tier·gitignored). v1의 "Run base를 `.ditto/local/runs/`로 리네임"은 **철회** — ~15 store가 각자 경로를 하드코딩하고 그중 2개(lsp-diagnostics·decision-conflict)는 OFF-LIMITS autopilot-loop.ts에만 있어 T0 범위서 못 옮김(§10-R2).
- **미래-생산자 가드 = 물리 리네임이 아니라 정적 lint:** `check:committed-base-run-artifact` — committed base 밑에 Record 파일(`record.json`·`events/`) 외 아무것도 못 쓰게 정적 검사(+ pre-commit). 물리 분리보다 **강한 가드**(어느 base든 leak 검출).
- `.gitignore`: `.ditto/local/` 유지. line 482 `.ditto/work-items/` **제거**(이제 Record committed). **belt-ignore 철회**(Finding B-F4: belt가 leak-test oracle를 눈멀게 함) — 대신 lint + ls-files oracle로.
- `.gitattributes`(신규): `record.json`은 저작 파일이라 union 부적합(내용 병합 위험) — 표준 merge. `events/`는 파일당 1이라 충돌 자체가 없어 driver 불요.

### 3.2 create() eager evidence/ 제거

`create()`(work-item-store.ts:201)의 `ensureDir(evidence/)` **삭제**. 경량 Record 생성 = record.json + `created`(status=draft) 이벤트만. evidence/는 Run이 개인 base에서 lazy 생성.

### 3.3 archive 생애주기 (D2)

archive(work-item-store.ts:415-431) 디렉터리 통째 rename 금지. **분해:** Record(committed) = status(→archived) 이벤트 append만(git 추적 유지); Run(개인 base)만 물리 rename.

### 3.4 leak-test (검증, Finding B-F4 oracle 교정)

`git status --porcelain` 단독 = 불충분(이미 tracked·ignored-present 못 봄). **oracle = `git ls-files .ditto/work-items/`(tracked leak) + `git status --porcelain --ignored .ditto/work-items/`(present-but-ignored)** → `record.json`·`events/*` 외 0건 단언.

---

## 4. 갭별 소비자 변경

### B1 — spec 은퇴 ↔ digest (스키마 경계만; 게이트 배선 deferred)

- `specDigestStale` 게이트(autopilot-loop.ts:150-166) **OFF-LIMITS**. T0 안 건드림.
- **기여:** digest 스탬프 `source_digest{doc_path,sha256}`(intent.ts:23-31)는 **spec 산문 신선도 = Run측**(intent.json Run). durable 결정(AC·scope·evidence_required)은 Record. 은퇴 시 Record 결정 생존, digest(Run) 드롭 → 검사 대상 없음 → 영구 block 안 남. self-contained Record(source_digest 없음)는 게이트 대상 아님(intent.ts:75 이미 optional).
- **명시 의존(§9-B1 unmitigated):** 은퇴=digest-해제 원자 배선 = WS-PRISM-T0/WS-HND-T4. T0는 tier 경계만 보장. → **본 WI [의존]에 명시.**

### C1 — no-op 종결 (§10-R3, backlog §9-C1 반전)

- **pre-mortem 발견(Finding B/C):** `stop.ts:902-913` strong-block은 **completion-ABSENT + conv-absent + pilot-absent + non-terminal**에만 발화 — **"Run 부재"가 아니라 "completion 부재"** 로 게이트한다. 경량 WI는 `verify`(completion.json 생성) 후 통과, 전엔 block(정당). split이 이 트리거를 바꾸지 않는다(completion.json은 여전히 읽힘). 즉 §2.5/§9-C1이 우려한 "경량 Record가 매 Stop마다 걸림"은 **verify 전에만**이고 그건 옳은 block.
- 마커(또는 Run-부재) 면제를 **추가하면** 유일한 실효는 "경량·in_progress·completion 없음"(=verify 진짜 skip)의 안전망을 없애는 것 — 게이트가 잡으려던 바로 그 케이스. 게다가 3번째 heavy/light 플래그(`completion_path`)는 `promoted_to_heavy`/`autopilot_exempt`와 desync(promote는 promoted_to_heavy만 세팅, work.ts:2030-2033) → C1이 막으려던 "heavy가 게이트 탈출"을 플래그 desync로 재도입.
- **결정: stop.ts·스키마 변경 없음. completion_path 마커 도입 안 함.** 게이트는 이미 옳다. (검증 V-C1: 경량·in_progress·no-completion WI가 여전히 block됨을 재현 — 마커 없이.)

### C5 — 멱등 셋을 committed 이벤트로 (§10-R4, task "Record→Run" 반전)

- **pre-mortem 발견(Finding A):** posted_decision_ids/posted_claim_markers/claimed_branch를 **삭제 가능한 Run tier로 옮기면**, T0가 새로 축복한 "Run 삭제 무손실" 후 `rm runs/<id>` → 멱등 셋 소실 → **실 GitHub 이슈에 중복 코멘트 재포스트**(github-progress.ts:154,177-178; github-claim.ts:101,190-193). T0가 스스로 만드는 **신규 회귀**.
- 원래 C5 우려(Run-cadence Record 쓰기가 single-writer append 붕괴)는 **committed per-event 로그가 이미 해소** — post마다 `github_post` 이벤트 파일 1개 append(union-fold)는 append 가정을 안 깬다.
- **결정(Record→Run 대신 Record-이벤트로):** posted/claim 멱등 = **committed `github_post`/`claim` 이벤트**(§1.1 events). record.json엔 불변 좌표만. `store.update` 다중-writer 대신 이벤트 append(무충돌·durable·삭제 안전).
- **소비자 전수(Finding A — 1이 아니라 7):** `github-progress.ts:154,161,177-197`·`github-claim.ts:101,106,155,190-200`·`work.ts:656-657,748,825,834,1695,1981`·`autopilot.ts:567`. 이들의 posted/claim read/write/delete를 이벤트 API로 전환(claim 삭제=claim_release 이벤트). 검증 V9: Run 삭제 후 재포스트 **중복 0**.

### completion mirror

- `mirrorAcceptanceVerdicts`(completion-store.ts:124-136)는 verdict+evidenceRef(digest-safe) 복사 → **verdict 이벤트 append**로 표현. **event_id dedupe**로 재-mirror 멱등(Finding A-F5: 재실행이 중복 verdict 이벤트 안 만듦). seam #1 오채점 정정 유지.

---

## 5. 리더 팬아웃 (event-log 영향, 정직화)

`WorkItemStore` touch 26파일. **v1의 "get/update API 보존 → 호출부 무변경" 주장은 과장(Finding D).** 정직화:
- `get()`(record.json+fold)·`create()`는 API 보존.
- `update(id, mutator: WorkItem→WorkItem)`: **저작 필드**(record.json) 변경은 그대로. **status/verdict/claim 변경**은 mutator가 표현해도 **이벤트로 승격**해야 — reduce→mutate→**diff**→해당 kind 이벤트 emit. 키-삭제(reopen closed_at·unclaim)는 status/claim 이벤트로(§1.1). `started_at_sha` 백필(work-item-store.ts:236-240) 부수효과도 diff에 포함.
- `exists()`(:171)·`list()`(:433-466)·`archive()`(:421)는 `work-item.json` 기준 → **재작성 필수**(Finding B-F6): committed base 열거 + record.json/events 인식. **T0 코어 범위**(호출부 최소 아님).

---

## 6. 후방호환 / 마이그레이션 (Finding B-F2·F3 교정, strand·corruption 방지)

- **get() 폴백:** `.ditto/work-items/<id>/record.json` 있으면 그것+events reduce; 없으면 legacy `.ditto/local/work-items/<id>/work-item.json` 읽어 반환.
- **첫 write(legacy WI) — 강제 lazy-migrate(Finding B-F2, "TBD" 금지):** legacy WI에 patch가 오면, **먼저** legacy work-item.json에서 **완전한 record.json(+created 이벤트) 합성**(title·goal·AC·lineage 전부) → 그 다음 patch 적용. status만 든 events.jsonl로 required 필드 누락→`workItem.parse` throw 하는 corruption 차단.
- **list()/exists()/archive() 이중 base(Finding B-F3):** committed base + legacy 개인 base **둘 다** 스캔, id로 dedup(committed Record 우선). 마이그레이션 창 동안 두 코호트 모두 가시.
- **T4(벌크):** 전체를 record.json/events(committed)/Run(개인) 분해 이관, 가역(백업+롤백), leak-test 통과.

---

## 7. 검증 계획

| # | 검증 | 갭 |
|---|---|---|
| V1 | `git ls-files .ditto/work-items/`에 record.json+events 노출 | 코어 |
| V2 | Run(`.ditto/local/work-items/<id>/`) 삭제 후 status/AC verdict/posted-id 무손실 | 코어·A |
| V3 | 경량 Record가 Run 없이 done 도달 | 코어 |
| V-C1 | 경량·in_progress·no-completion WI가 stop.ts:902 strong-block 유지(마커 없이) | C1 |
| V5 | Run-write와 terminal 이벤트 사이 kill → reduce head non-terminal → 재실행 정합; reconcile 복원 | A1 |
| V6 | 동시 두 terminal 이벤트 → reduce가 first-terminal-wins 하나만 채택; handoff가 chokepoint 통과 | D1 |
| V7 | create+full run 후 `git ls-files` + `git status --porcelain --ignored .ditto/work-items/`에 record.json/events 외 0건 | A2 |
| V8 | archive가 Record는 이벤트 append·Run만 물리 이동 | D2 |
| V9 | Run 삭제 후 github 재포스트 **중복 0**; posted/claim 7 소비자 컴파일·동작 | C5 |
| V10 | source_digest 없는 self-contained Record가 스키마상 digest 무보유 | B1 |
| V11 | reopen이 closed_at 클리어·unclaim이 claimed_branch 무효(이벤트로); 재-mirror 멱등(중복 verdict 0) | D·F5 |
| V12 | `bun test` 전체 GREEN + schema/surface drift + 신규 lint 가드 통과 | 코어 |

---

## 8. 미해결 질문 (autopilot 입력)

1. **하이브리드 확정.** §1.1이 record.json(가변)+events(append) 하이브리드로 확정(Finding D가 순수 event-log를 배제). 잔여 세부(diff→event 승격의 field 매핑)는 구현 TDD에서.
2. **borderline durable 원장 10종** — T0 개인 tier 유지. 지금 committed 필요분 있나? (기본 없음, 후속 batch — **값 결정, 사용자/도메인**.)

---

## 9. 의존 / 폐기

- **선행:** P0 §8+§9 + 본 v2 pre-mortem(§10).
- **명시 의존(§9-B1):** 은퇴=digest-해제 원자 배선 = WS-PRISM-T0/WS-HND-T4.
- **차단:** WS0-T1·T2·T3·T4·WS-HND-T0·T2·WS2-T2·T4·WS-PRISM-T5.
- **파일 분리:** WS3(autopilot-loop.ts) 무충돌.
- **폐기:** 랜딩 후 코드 주석+ADR 흡수, 은퇴.

---

## 10. Pre-mortem 반영 결박 (v1 → v2 무엇이 뒤집혔나)

3-lens fresh-context pre-mortem(anti-SLOP file:line). **verdict=revise**(방향 생존, 메커니즘 교체). 생존한 공격-검증 클레임: Record/Run 컷·Run-삭제 무손실(멱등 셋 예외)·evidenceRef digest-safe·seam#1 오채점 정정.

- **R1 (CRITICAL, lens A F1):** v1 "atomicWriteText append"는 read-concat-rename = **last-writer-wins clobber**. → **per-event immutable 파일 + `open(wx)` + (seq,actor) 순서 + event_id dedupe + terminal-first-wins**(memory-store.ts:104-119 템플릿). §2 교체.
- **R2 (CRITICAL, lens B F1):** "base-split이 tier를 강제"는 거짓 — ~15 store 하드코딩 + 2 Run 산출물이 OFF-LIMITS autopilot-loop.ts에만. → **Run 리네임 철회**, Record만 격리 committed 신규 base(leak 물리 불가), 미래-가드=**정적 lint**. §3.1.
- **R3 (HIGH, lens C Finding B·C):** stop.ts:902는 **completion-부재**로 게이트(Run-부재 아님). 마커 면제는 verify-skip 안전망만 제거 + 3번째 플래그 desync. → **C1 no-op, stop.ts·completion_path 도입 안 함**(backlog §9-C1/task C1 반전, 근거: stop.ts:902-913·work.ts:2030-2033·user-prompt-submit.ts:224-227). §4 C1.
- **R4 (CRITICAL, lens C Finding A):** posted/claim을 삭제 가능 Run으로 옮기면 Run 삭제 후 **GitHub 중복 포스트**(신규 회귀). 소비자도 1/7만 셈. → **committed `github_post`/`claim` 이벤트로**(durable·삭제안전, append라 single-writer 안 깨짐), **7 소비자 전수**(task "Record→Run" 반전). §4 C5.
- **R5 (HIGH, lens A F5/F8·lens C D·E, lens B F2/F3/F6):** event_id dedupe(재-mirror 멱등)·terminal 이벤트에 verdict 동봉(단일 원자)·evidence_required를 Record AC로 승격(무손실)·강제 lazy-migrate(corruption 차단)·list/exists/archive 이중 base 재작성. §1.1·§2.2·§5·§6.

**anti-SLOP 기각/생존(반증):** "line 482 un-ignore가 reviewer-output leak" — 반증(오늘 committed base writer 0, stale 주석). "belt-ignore가 Record clobber" — 반증(events.jsonl 미매치)·단 belt가 leak oracle 눈멀림 → **belt 철회**. "heavy+autopilot_exempt 모순" — 반증(902/286 disjoint). "heavy WI no-autopilot block=회귀" — 반증(오늘도 block, 유지).

### 10.1 Plan-stage far-field coverage 추가 발견 (배치 sweep, 18-cat 중 2 revise)

autopilot 설계노드 coverage sweep(relevance 18 relevant/5 skip → 배치 정반합)이 16 settled + **2 new admissible branch**을 결박했다. 둘 다 grounded, 최소 비구조적 수정, 신규 AC 불요(기존 노드에 흡수).

- **R6 (observability, higher-sev):** `reduceWorkItem`이 memory-store.ts:143-150 템플릿의 bare-catch를 이어받아 파싱 실패 event를 **조용히 드롭**하면, work-item event는 **상태-bearing**이라 (a) corrupt/truncated **terminal** event가 fold에서 빠져 status가 직전 non-terminal로 부활(늦은 fail-verdict 소실=회귀 unmask), (b) 그 `open(wx)` 파일 시체가 동일 event_id 재-append를 EEXIST로 막아 §2.2 "terminal 없음⇒재실행 멱등"이 *absent*가 아니라 *present-but-corrupt*에서 깨진다. list()의 완화("explicit get()이 스키마 에러로 표면화")는 event에 부적용(event는 fold로만 소비). **결정:** reducer는 자기 WI의 `events/` 파싱 실패를 **조용히 드롭하지 않고 surface**(loud 진단); `reconcile`/`doctor`가 `events/` 밑 unparseable 파일을 **enumerate·count**해 드러낸다(surface-don't-mutate, §2.2 정합). memory-store의 skip 자세를 state-bearing work-item event에 무비판 상속하지 않는다. → n2(reducer surface)·n3(reconcile count)·n9(V13 corrupt-event 재현) 흡수. ac-4·ac-10 매핑. **과-수정 금지:** event-repair/GC 서브시스템으로 부풀리지 않음(T4-adjacent, §0 out).
- **R7 (deployment-rollout):** 이 변경이 work-item Record를 **처음으로 committed+shared** tier로 만든다(.gitignore:482 제거 + work-item-store.ts:158 오늘 committed base writer 0). §6은 new-binary-reads-legacy(전방)만 다루고 **old-binary-reads-new**(pre-split old ditto가 공유 repo pull → localDir-only get/list/exists가 committed-only WI를 blind → Q1 공유 backlog가 old 바이너리에서 무효, old `work done`이 divergent legacy 생성 위험) 축을 미다룸. old 바이너리는 **blind-but-safe**(committed base에 write 안 함 — 조율 저하지 데이터 손상 아님). **결정:** acceptable-documented-residual — 공유-repo 팀에 **required-version floor** 문서화(n11-knowledge/ADR-0012 supersession에 동반), 신규 메커니즘 불요. completion residual_risk로 표면화.
- **verification 갭(§7 보강):** V13(=events/에 corrupt/truncated 파일 주입 후 reduce가 상태 오도 없이 surface + 재-append 경로 확인)·V14(old-schema/pre-split 형식 read의 blind-but-safe 확인 or version-floor 문서 존재)를 n9-verify에 추가.
