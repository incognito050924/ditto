# DITTO 품질 개선 — 설계 + 실행 백로그

> 입력: `quality-issues.md`(사용자 불만 5축) + 대화 추가 이슈(백로그 관리 부재).
> 성격: **일회용 백로그 씨앗**. 여기 담긴 항목은 추적 가능한 work item / GitHub 이슈로 전환되어야 하며, 전환되면 이 문서는 폐기한다. 권위는 코드에 있다(charter §4-11) — 아래 모든 진단은 file:line 근거로 코드에서 확인했다.
> 작성 근거: 4개 병렬 조사 에이전트가 현재 코드 상태를 매핑(2026-07-06).

---

## 0. 이 산출물이 스스로 지키는 규율 (메타 강제)

`quality-issues.md`가 비판하는 함정이 **이 백로그 산출 자체에서도** 재발하지 않도록 강제한다:

| 문서가 비판한 함정 | 이 산출물의 강제 장치 |
|---|---|
| 의도 임의 축소 | §5 커버리지 매트릭스 — 문서의 **모든** 불만 항목을 태스크로 추적. 누락 0. |
| 슬라이스 일부만 하고 떠넘김 | 전체 범위를 한 번에 전개. 우선순위/단계는 매기되 어떤 축도 "다음에"로 버리지 않음. |
| 잔여를 명확한 방안 있음에도 떠넘김 | 각 태스크에 [변경 대상·파일·검증법·무게] 명시. 애매한 잔여 없음. |
| 중복/컨텍스트 분산 | §6에서 기존 열린 work item과 겹침을 **reconcile**(중복 생성 금지). |
| 백로그가 문서로 흩어져 잊힘 | 이 문서의 첫 실행 항목(WS0-T1)이 **백로그 뷰**라, 나머지 항목이 그 안에서 관리됨 = 자기참조 해소. |

---

## 1. 근거 요약 — 뿌리 원인 (코드 확인)

각 축의 표면 불만 아래 **실제 코드 뿌리**를 조사로 특정했다. 이게 해법 설계의 출발점이다.

| 축 | 표면 불만 | 코드 뿌리 (file:line) |
|---|---|---|
| 컨텍스트 로트 | 관제탑 에이전트 context 관리 안 됨 | 서브에이전트 격리·planner fresh·owner 봉투는 **실제 집행됨**(`autopilot-dispatch.ts:49-479`, `planner.md:9-15`). 그러나 **오케스트레이터(메인 에이전트) 자신의 context는 완전 무관리** — 토큰/버짓 회계 0, 경계 자동 handoff/reset 0. 유일한 완화는 프롬프트 규율 "매 라운드 autopilot.json 재읽기"(`skills/autopilot/SKILL.md:16,22,45`)뿐, 코드 강제 아님. |
| 의도 표면 | 의도 조용히 축소, 편향, live map 원함 | (1) live decision-map = coverage 그래프가 **이미 코드에 있으나 인터뷰 루프에 미배선**(`interview-driver.ts:505-606`, `ditto deep-interview project-coverage`; SKILL이 호출 안 함). dimension은 추가만 되고 삭제 경로 없음(`:187-210`). (2) self-answer 투명성 = `selfAnswers: []`로 **하드코딩**(`interview-driver.ts:596`) → 에이전트가 사용자 대신 답해 의도 좁힌 기록이 사용자에게 안 보임. (3) 전제 의심 = **어느 표면도 안 함**. pre-mortem은 "구현이 어떻게 실패하나"만 봄(`interview-state.ts:114-129`), "만들어야 하나·미러링 토대가 안정적이냐"는 무소유. dialectic도 premise 없음. |
| 의도→AC | 오파악 → 재작업/갈아엎기 | AC가 dimension/질문으로 **되돌아가는 provenance 없음**(`intent.ts:14-18`). **stub가 AC를 충족 가능** — verify/verifier에 non-stub 요구 0(grep zero). 관찰값만 맞으면 통과. |
| 질문 UX | 뭘 밝히려는지 모르고 답함 | 질문은 `why_matters`는 보여주나 **어느 ambiguity dimension을 푸는지·얼마나 critical한지 안 보임**(`interview-state.ts:27-36`은 내부용, 표시 계약 아님). 열린/해결 dimension 지도는 미배선 coverage.json에만 존재. |
| 표준 절차 | 범위 확산·슬라이스 떠넘김 | **경량 경로엔 `intentDriftGate`가 아예 없음**(intent.json 없어서, `gates.ts:815-884`는 heavy 전용). 경량 경로는 "intent.json 부재"로만 정의됨(음의 정의). `completion_boundary`에 'slice' 변형 없음 — 승인된 부분 완료 개념 부재(`autopilot.ts:170`). |
| 잔여/후속 | 후속 묻힘, 인지비용 폭증 | 후속을 done까지 강제하는 건 **self-caused high/critical bug 하나뿐**(`work-item-store.ts:88-97`). 그 외(비자책·low/med·idea)는 draft placeholder WI로 물질화돼도 **영원히 고아**. 잔여는 grounding 문자열 "존재"만으로 release 가능(품질 무검사, `gates.ts:238-257`). |
| 백로그 | 관리 시스템 부재 | **집계 뷰 자체가 없음** — `ditto work status`의 4필드 flat 목록만(`work-item-store.ts:433-466`). `ditto work list` 없음. GitHub는 **write-mirror + 이슈별 수동 pull**, 백로그 reader 아님(`work.ts:297-321`). 잔여는 보드에 절대 안 감(기껏 linked 이슈 코멘트 1줄). |
| 코드 품질 | ACG 효능감 없음 | 효능 신호는 **있으나 루프에서 분리됨**. CodeQL·fitness·drift는 루프 밖 CLI(`fitness.ts`, `codeql.ts`) — autopilot 루프가 호출 안 함 → snapshot 굶어 `fitness drift`는 "no snapshots". tidy L1/L2 provider 미배선 → behavior-lock fail-open(ADR-0017 D5/D8). **변경당 "코드가 나아졌다" 단일 수치 없음**. |
| 성능 | 너무 오래 걸림 | 지배 비용 = **plan 닫기 전 필수 coverage sweep**(23 카테고리, breadth-full 기본, relevance-judge 보수적 "애매하면 포함"). wave당 ~12 spawn(3 sweep + 3 dialectic + 6 axis) × wave × dry까지 라운드. **모델 다운티어링 0** — sweep/judge 수십 spawn 전부 host 모델. relevance skip이 유일한 싼 경로인데 안전설계상 얻기 어렵게 만들어 둠. |
| 핸드오프/세션상태 | 새 세션에 과거 핸드오프 섞여 오염 | 은퇴가 store `wi_*.md` happy path에만(consume-on-read + 7일 sweep, `handoff-store.ts:233-314`). **비-WI/세션 핸드오프는 store 경로 없어 hand-authored → parse-gate로 소비·sweep 둘 다 skip → 영구 잔존**(`handoff-store.ts:214-224`). 로컬은 `work_item_id` 결박(`:47-69`), 원격은 git 커밋 HANDOFF.md **방송**(`SKILL.md:57-68`). 세션 포인터(20개 잔존, clear/delete 없음)·active-node lease(age reaper 없음)도 같은 "write, no-GC" family. |

---

## 2. 설계 관통선 (해법의 뼈대)

개별 수정을 나열하기 전에, 조사가 드러낸 6개 관통 명제:

- **A. 백로그가 빠진 척추다.** 후속/잔여/버그가 잊히는 것과 컨텍스트가 흩어지는 것은 같은 뿌리 — 단일 관리 백로그 표면 부재. work item·후속·잔여·이 문서의 태스크가 **하나의 질의 가능한 백로그**로 흘러야 한다. "work item 관계 재설계" 요구도 여기에 걸린다. **→ 사용자 결정(Q1·Q2)으로 이 명제가 핵심 아키텍처(§2.5)로 승격됨.**
- **B. 의도 충실도가 세 seam에서 새고, 각 seam엔 반쯤 만든 미배선 장치가 있다.** live map(미배선) · self-answer 투명성(하드코딩 빈값) · 전제 의심(아예 없음). 대부분 "만들다 만 것을 배선 + 없는 것 하나 추가".
- **C. 완결성/보존 게이트가 heavy 전용이라 경량 경로가 무방비 구멍이다.** 표준 절차의 의도 축소는 경량 경로에 보존 게이트가 아예 없어서 생긴다.
- **D. 컨텍스트 로트는 관제탑에 집중돼 있다.** 서브에이전트 격리는 실재. 메인 에이전트만 무관리 → 여기만 고치면 됨.
- **E. ACG 효능감이 없는 이유는 신호가 루프에서 분리돼 있어서다.** 배선 + 변경당 단일 health delta 노출이 핵심.
- **F. 성능 지배 비용은 필수 coverage sweep이다.** 모델 다운티어 + 진짜 additive 변경용 싼 레인.
- **G. "구현했지만 미배선"은 AC 품질 결함의 관측 signature다 (사용자 지적, 시급 최우선).** 조사가 찾은 결함 대부분이 이 형태였다 — coverage 그래프·self-answer·CodeQL·tidy provider가 전부 "코드는 존재하나 사용자가 닿는 표면에 안 걸림". 뿌리: **AC가 잘못된 고도로 쓰인다** — "함수/기능이 존재한다"로 충족되지, "사용자 표면에서 종단(end-to-end) 관측된다"를 요구하지 않는다. 검증도 실제 표면(CLI·skill·hook)이 아니라 내부 함수 호출(proxy)로 통과한다. 이게 false-green·의도 축소·재작업의 공통 상류 원인이다. → **WS-ACQ.**
- **H. 일회성 세션 상태가 은퇴되지 않고 쌓여 컨텍스트를 오염한다 (사용자 지적).** 핸드오프는 **단일 소비·수신자 지정·읽으면 은퇴**여야 하는 세션 전이 데이터다. 그런데 (1) 은퇴는 store가 쓴 `wi_*.md` happy path에만 있고, **비-WI/세션 핸드오프는 store 경로가 없어 hand-authored → parse-gate에 걸려 소비·sweep 둘 다 안 됨 → 영구 잔존**(지금 `active/`의 2개가 그 상태). (2) 로컬은 `work_item_id`에 결박돼 세션 컨텍스트가 일급이 아님. (3) 원격은 git 커밋 HANDOFF.md **방송**이라 다중 개발자 오염. 세션 포인터·active-node lease도 같은 "write, no-GC" family(은퇴 primitive 부재). §2.5가 "영속 Record가 개인 tier에 갇힘"이라면, 이건 그 거울상 — **일회성 상태가 은퇴 없이 잔존/방송된다.** → **WS-HND.**
- **I. 가치 단위는 ditto가 아니라 "ditto가 설치된 프로젝트 P"다 (사용자 지적 — 프레이밍 교정, 관통 렌즈).** 이 백로그의 진단은 ditto 자신의 코드를 매핑해 나왔다(line 5·§1 뿌리 표). 그건 *버그*의 정당한 출처지만 *가치 우선순위*의 편향된 출처다 — "ditto로 ditto를 개발하다 아픈 것" ≠ "ditto를 새로 설치한 개발자가 가장 필요로 하는 것". **도그푸딩(ditto-on-ditto)은 P₀ — 우리가 그 안에 살아서 편한 첫 시험대일 뿐, 목표가 아니다.** 편향은 균일하지 않다: §2.7 가치/방향 taxonomy·WS-PRISM는 이미 사용자의 프로덕트 P를 겨눠 outward지만, 위생 워크스트림(WS4 ACG·WS3 context·WS5 성능)과 "라이브 dogfood on ditto"로 닫히는 검증 기준들이 inward로 갈렸다. 세 귀결: **(1) 신호의 스택 일반화** — ditto는 TS지만 P는 임의 언어. ACG health-delta·CodeQL 신호가 ditto의 TS에서만 의미 있으면 무가치. 단 정직하게: **ACG/CodeQL은 ADR-0006상 지원 언어에 bounded다 — "임의 스택"이 아니다**(미지원 언어는 fail-closed). 'language ledger'는 stack coverage가 아니라 glossary 협상 스키마(`language-ledger.ts:35-43`)라 여기 근거로 못 쓴다(P0 dialectic 범주오류 정정). §WS4의 진짜 게이트 = 지원 언어 내 일반성 + 미지원 스택 fallback 신호. **(2) 검증에 non-ditto 타깃 필수** — "라이브 dogfood on ditto"는 메커니즘이 *도는* 증거지 *가치* 증거가 아니다. 최소 한 번은 boxwood 등 ditto 아닌 프로젝트에서 설치 개발자에게 가치가 나와야 한다. **(3) 우선순위 재검** — §4 시퀀싱은 "ditto 쓰다 아픈 순서"라 설치자 우선순위와 다를 수 있다(새 설치자에겐 §2.7 E축 first-run 가치가 WS3 context rot보다 앞설 수 있음). → **전역 검증 규칙: 모든 WS 검증 기준은 "ditto에서 돈다"가 아니라 "설치된 P의 개발자가 X를 얻는다(ditto는 P₀ 시험대로 검증)"로 읽혀야 통과.** dogfood는 필요조건이되 충분조건이 아니다.

---

## 2.5 핵심 아키텍처 — 영속 공유 백로그 + 기록/실행 분리 (Q1·Q2 수렴)

사용자 결정 두 개가 한 점으로 모인다:
- **Q1**: 백로그는 ditto 내부의 **공유 가능한** 위치여야 한다("로컬에만 있으면 무의미"). GitHub Project(칸반)는 SoT가 아니되 지금처럼 활용 가능해야 한다.
- **Q2**: work item↔구현 결합은 구멍 메우는 임시 처방이 아니라 **10년·100년 가는 근본 설계**여야 한다.

**결정적 사실(코드 확인).** 지금 work item 전체가 `.ditto/local/work-items/`에 사는데, `.ditto/local/`은 `.gitignore:477`로 **개인 tier ③(gitignored)**이다. 즉 백로그·후속·잔여가 **개인 파티션에 갇혀 공유되지 않는다**. 반면 tier ②(`.ditto/knowledge`, `.ditto/memory/events`, `.ditto/specs`)는 커밋되어 공유된다. ADR-0012(3계층 격리)가 이 구조를 정한다.

### 절개선 — 하나의 컷이 Q1·Q2를 동시에 푼다

work item을 두 entity로 가른다. **이 컷이 "공유(Q1)"와 "구현 분리(Q2)"를 동시에 만족한다.**

| | **기록 (Record)** — 영속·공유 | **실행 (Run)** — 일회성·개인 |
|---|---|---|
| **내용** | intent statement · in/out scope · AC(provenance+verdict+**증거 포인터/다이제스트**) · status · priority · 계보(follows/discovered_by) · follow_ups · risks · github_issue | autopilot 그래프(autopilot.json) · per-node 원증거·traces · runs/ · worktree · tech-spec-state · completion.json 원본 |
| **tier** | **② 프로젝트전역 (committed, 공유)** | **③ 개인 (`.ditto/local/`, gitignored)** |
| **수명** | 영속 — 프로젝트의 "무엇을·왜 했나" 기억 | 폐기 가능 — run은 지우고 다시 돌려도 기록은 안 잃음 |
| **결합** | work_item_id로 느슨히 연결. 기록은 실행 없이 존재 가능(경량 경로가 이미 그렇다) | 기록에 종속, 그 역 아님 |

**이것이 Q2의 답이다.** 구현(실행)을 work item에서 스키마 수준으로 떼어낸다. 조사가 확인했듯 구현은 이미 de-facto 분리 가능(autopilot.json은 형제 store, 경량 경로는 실행 객체 자체가 없음) — 이 설계는 그 우연한 분리를 **의도된 불변식**으로 승격한다.

### 불변식 (설계를 오래 가게 하는 것)

1. **기록/실행 분리.** 영속 기록(의도+해소)은 공유·영구. 실행(어떻게 했나)은 개인·폐기 가능. run을 지워도 프로젝트 기억은 남는다.
2. **하나의 백로그, 여러 투영.** SoT = **공유 ditto 백로그 tier(committed)**. `ditto work list`·GitHub 칸반·계보 뷰는 전부 그 위의 **파생 projection**(= SoT 아닌 read-optimized 뷰; '투영' 방향의 정확한 정의는 아래 "왜 projection 모델인가"). 두 SoT 금지.
3. **무소유로 죽는 항목 없음.** 모든 후속/잔여/버그 = 계보를 단 공유 백로그 항목. 개인 파티션·산문에 숨지 못하고, 보존 게이트가 terminal 상태 도달을 강제.
4. **양방향 provenance.** AC ← 의도 dimension/질문(WS1-T5), 백로그 항목 ← discovered_by 계보. 양방향 추적이 영속.

### GitHub Project의 자리 (Q1 후단)

SoT는 공유 ditto 백로그 tier다. GitHub 칸반은 **그 위의 두 번째 projection** — 지금처럼 활용 가능하되 SoT 아님. 이는 ADR-20260628의 D3("GitHub 보드 = 백로그 SoT")를 **정정**한다(조사상 실제로도 GitHub는 백로그 reader로 안 쓰이고 write-mirror였음 — 계약을 실제와 일치시키는 것). 정정은 새 ADR로 기록해야 한다.

### 왜 projection 모델인가 (동시성·영속성) — 방향 정의 (P0 dialectic 정정)

공유 committed 백로그를 여러 개발자가 git으로 쓰면 병합 충돌이 난다. ditto엔 이미 답이 있다 — **단 memory의 방향을 정확히 가져와야 한다.** memory 패턴은 **committed tier가 SoT**이고(events/sources가 git-tracked, `memory-store.ts:6-10`), **gitignored가 파생 projection**이다(재생성 가능한 serving 상태). 초기 서술("개인 tier에서 만들고 공유 tier로 투영")은 이 방향을 **거꾸로** 인용했다 — Producer·Opponent가 독립 수렴한 CRITICAL, `memory-store.ts:6-10`로 확인. 정정:

- **Record fact = committed tier가 SoT** — per-entity 불변/append 파일(ADR-0005, append 원자성 ADR-20260628-append-decision-atomicity)로 git 무충돌 머지. 이게 "여러 개발자가 써도 안 깨짐"의 실체다.
- **`ditto work list`용 집계 뷰 = gitignored 파생 projection** — committed fact를 결정적 reducer로 재생성. 지워도 committed SoT에서 복원.
- 즉 **'투영' 방향 = committed SoT → gitignored 파생 뷰**(개인→공유가 아님). 실행(Run)만 개인 tier에 산다.
- committed Record엔 원증거 대신 다이제스트/포인터만. **단 이 digest-only가 비-저자 감사(charter 증거-closure)를 만족하는지는 미해결** — Q4 재확인 대상(§7).

### 상태·정합·트랜잭션 모델 (P0 필수 명세 — dialectic 지적)

memory는 **append-only 이벤트 reduction**이지 가변 lifecycle이 아니다(`memory-event.ts`·`memory-reduce.ts`). 그런데 백로그 Record는 `draft→in_progress→blocked/partial/done`으로 **자주 가변**하다. 그래서 "memory식"을 그대로 쓰면 정작 중요한 지점이 빈다. P0에서 명세할 것:

- **상태 = 가변 파일 in-place 갱신이 아니라 committed 이벤트-로그 reduction**으로 표현(상태 전이 = append, 현재 status = reduce의 head). Opponent 대안(2)("committed append-only 백로그 이벤트로그 + reducer")이 정확한 해소 방향.
- **cross-tier 트랜잭션/복구.** 현재 work item 상태변경은 **단일 원자적 파일 교체**다(`work-item-store.ts:217-243`). Record(committed)/Run(개인)/GitHub 투영으로 갈리면 이 원자성이 깨져 — `status=done` Record는 committed인데 Run·증거 링크(개인) 또는 보드 투영이 부분/미갱신인 크래시 창이 생긴다. **single-writer append 순서 보장 또는 명시적 reconcile/repair 단계**를 P0 설계 산출물로. WS0-T0 검증에 "부분 실패 후 재조정으로 정합 복원" 기준 추가.

### 소비자 영향 스윕 결과 (P0 후속 — work_item 소비자 전수)

읽기전용 스윕(6차원)이 §2.5 split에 깨지거나 정합 결정이 필요한 소비자를 코드에서 전수 색출했다. **한 줄 구조 사실: 오늘 work item은 아무것도 committed가 아니다**(`.gitignore:477`; 모든 store가 `localDir(repoRoot,'work-items',<id>)` 한 디렉터리에 Record/Run 물리 혼재). 즉 이 split은 "기존 committed 재-tier"가 아니라 **gitignored 통합 디렉터리에서 Record 절반을 떼어 commit** — 이게 WS0-T4 마이그레이션의 진짜 성격이다(디렉터리 통째 commit 금지, 분해 후 Record만).

**영향 4계급 (지배 순):**
- **LEAK-RISK (지배).** ~20개 Run 생산자가 곧 commit될 `work-items/<id>/`에 쓴다 — 일부는 Run 없어도 디렉터리 자동 생성(`work-item-store.ts:201` create가 evidence/ eager 생성; `impact.ts:120`·`change-contract.ts:93`·`acg-review.ts:80`·deep-interview/tech-spec/journey/fitness/e2e 세션 버퍼). **디렉터리를 순진하게 commit하면 private Run이 샌다.** → WS0-T4에 leak-test(“commit tier에 Run 아티팩트 0” 재현) 필수.
- **BREAK — in-place 상태변경 전면.** 모든 status write가 `WorkItemStore.update`(`:222-244`) 전체파일 원자 재작성 = append-only 이벤트로그가 대체할 바로 그 연산. in_progress 승격 3곳(`autopilot-bootstrap.ts:87`·CLI `autopilot.ts:169`·`claimWorkItem work.ts:698`)·done writer 3곳이 **한 "started"/"done" 이벤트로 수렴**해야. 특히 `work-item-handoff.ts:324-341`이 `close()`와 R1 종단 가드를 **우회**해 status 직접 write — append-only에서 가장 발산하기 쉬운 지점.
- **RECONCILE — finalize/complete/archive + Stop 게이트 교차tier 읽기.** `gates.ts`의 completionGate·intentDriftGate·landGate가 Record(AC·intent) × Run(completion·graph)을 함께 읽음 — Record-only 또는 Run-only 뷰는 false drift/false block. `stop.ts:902-913` strong-block이 Record status만으로 gate하나 Run(completion/convergence/autopilot) 부재를 block → **경량 Record(in_progress·Run 없음)가 매 Stop마다 걸림. "경량 경로 ⇒ Run 불요" 면제 필요**(유일한 진짜 hook BREAK).
- **de-risk (이미 정렬됨).** 증거 모델은 이미 digest-safe(`evidenceRef` common.ts:76-88 raw 필드 없음; `evidence-record.ts` "raw 없이 judge 가능" 스키마 = split의 Record 증거 모델 그대로). memory 서브시스템은 **committed SoT + gitignored projection의 정확한 템플릿**(work_item_id 커플링 0) — Record split이 따를 원본.

**비자명 cross-subsystem seam (핸드오프 계급), 위험순:**
1. **`completion-store.ts:124-136` mirror-write** — completion verdict를 Record AC로 복사. ⚠ **P0 pre-mortem 정정(§9, 두 슬라이스 독립 반증)**: 복사 대상은 `evidenceRef[]`(`common.ts:76-88` — raw 필드 없음, path/command/sha256/summary 포인터뿐)라 **이미 digest-safe** — line 114와 정합. 초기의 "raw evidence 복사·digest-only 정면 위반·최고 위험" 판정은 **오채점**(문서 내부 모순: line 114 스스로 digest-safe라 진술). 실질 잔여는 BREAK가 아니라 매 complete가 tier 경계를 넘는 다-파일 쓰기(RECONCILE) — RISK-A1(원자성, §9)의 하위 사례로 흡수. 별도 최고 위험 아님.
2. **`work-item-handoff.ts:324-341` status 직접 write**(위 BREAK) — close()·R1 가드 우회.
3. **`handoff-store.ts` consume-on-read 컨테이너**(WS-HND-T0 기지 seam) — durable 결정이 은퇴 그릇에 inline.
4. **`change-contract.json` 경합 tier** — in/out scope(Record 개념)를 인코드하나 **PreToolUse 안전훅**(`pre-tool-use.ts:550`)이 Run 중 SoT로 소비. 어느 tier인지 진짜 애매(값 결정).
5. **`e2e-verdicts.jsonl`(`e2e.ts:491`)** — durable 사용자 fix-authorization인데 Run-listed. 의미상 Record-ish.
6. **`github-progress.ts` Run-cadence Record 커밋** — decision-post마다 Record(posted_decision_ids)에 write → Run 주기가 Record 커밋 유발, single-writer 가정 붕괴.

**2·6은 WS0-T0 상세설계에서 라우팅 확정**(6=posted_decision_ids는 P0 pre-mortem에서 HIGH로 격상 §9-C5 — worktree 동시 세션 시 committed Record 다중 writer 창; Record→Run 이동 권고), 1은 위 정정으로 RISK-A1에 흡수, 4·5는 값 결정(어느 tier)이라 사용자·도메인 판단 필요. Stop 면제(3계급)는 WS2-T1(경량 경로 보존)과 함께 — 단 **면제 조건을 'Run 부재'가 아니라 명시적 경량 마커에** 걸어야(P0 pre-mortem §9-C1: Run 부재로 걸면 미검증-종료 게이트가 통째로 무력화).

> **이 아키텍처는 제안이다.** P0 dialectic-review 결과 = **revise**(§8): 방향은 유효, 위 네 지점(방향·상태모델·트랜잭션·감사) + 이 소비자 스윕의 seam을 상세설계에서 닫아야 한다. Q3(설계만·보류)에 따라 여기서는 코드를 만들지 않는다.

---

## 2.6 의도 표면 단계 모델 (대화로 확정)

의도 표면들은 "한 뿌리의 수렴/발산 형제"가 아니라 **서로 다른 단계의 서로 다른 장기(organ)**다. audience/durability × 인지행위로 다시 그림:

| 단계 | 표면 | 산출물 | 인지행위 · 청중 |
|---|---|---|---|
| 발견·설계 | **prism** (= tech-spec 진화·대체) | 구체화된 프로덕트급 설계 (공유 산출물, 구현후 은퇴) | 발산→가치압박→구체화 · 사용자↔(팀)↔에이전트 |
| 상세 명세 | **deep-interview** | intent.json (검증가능 AC) | 모호성 해소 · 사적 |
| 구현 | autopilot | 코드+증거 | 실행 |

**확정 결정(사용자):**
- **prism가 tech-spec을 진화·대체한다** — 병렬 추가(a)도, mode(b)도 아니고, **tech-spec의 형태를 개선해 대체**(신규 표면 하나를 안 늘림, 저사용 표면 rot 제거). tech-spec의 13섹션(개발 대상 구체화·정리)이 이미 prism의 절반이다.
- **물려받음**: 13섹션 템플릿·expert-elicitation·증거 게이트·question fan-out. **net-new만 얹음**: 발산(3~5 방향)+가치·전제 심문+가치/방향 taxonomy.
- **대체의 조건**: tech-spec의 anti-inflation 가드(`tech-spec/SKILL.md:67` "no 10x version")를 걷어내는 대신, 발산을 **근거 있는 3~5 방향으로 한정**하는 규율(가치/방향 taxonomy)로 대체 — 경직을 SLOP-인플레이션으로 맞바꾸지 않도록. **경고(P0 dialectic)**: taxonomy는 judgment를 *유도*할 뿐 환각 방향을 *기계적으로* 막지 않는다. 제거되는 `SKILL.md:67`은 hard boundary였다. 그러므로 규율은 산문 규칙이 아니라 **기계적 상한**이어야 한다 — relevance-gate(이 요청에 발산이 필요한가) + route-by-weight(고가치·고모호에만) + **명시적 방향 수 cap(≤5)** + 각 방향의 근거 필수(무근거 방향은 드랍). 이 셋이 없으면 hard-guard 제거가 곧 SLOP 유입이다.
- **베팅(검증 대상)**: tech-spec 저사용 원인 = 개념 불필요가 아니라 *형태가 나빠서*. 형태를 고치면 쓰인다는 가정.
- tech-spec을 "수렴 도구"로 본 초기 분류는 오류였다 — 그건 설계 단계의 공유 산출물이고, prism는 그 산출물을 *발산·가치로 벼려* 만드는 개선형이다.

**핵심 원칙 — 신선도 민감 산출물은 구현 후 은퇴 (charter §4-11 + 핸드오프 single-consumption family):**
> 설계/기획 산출물(tech-spec spec · plan brief · prism 탐색노트 · **이 백로그 문서 자체**)은 코드에 자동 동기화 안 돼 빠르게 drift한다. 그러므로 작업 *중*엔 권위를 갖되, **구현 후 durable 결정만 code·ADR·knowledge로 흡수하고 산문은 은퇴**한다. "결정은 남기고, 산문은 은퇴." → WS-HND-T4로 집행.

---

## 2.7 가치/방향 taxonomy 설계 (prism의 유일 net-new)

prism의 모든 재사용을 빼면 남는 진짜 신규는 **가치/방향 taxonomy** 하나다. 여기가 moat의 심장이자 가장 위험한 곳.

**중심 위험 (먼저).** 가치 판단은 위험 판단보다 **환각에 더 취약**하다 — "돈 낼 사람 있나"는 코드로 못 짚는다. 사용자가 pre-mortem에서 이미 배운 교훈(③약함 카테고리를 auto-sweep서 빼고 deep-interview 사용자확인으로; `project_premortem_redesign`)이 여기 **더 강하게** 적용된다. #1 설계 제약 = 내용이 아니라 **anti-SLOP 구조**: 도구는 가치를 단언하지 않는다 — 근거를 대거나(groundable) 사용자에게 묻는다(judgment). **"프로덕트급" 판정은 늘 사용자의 종합.**

**backbone (기존 프레임워크, 발명 아님).** risk taxonomy 23종(`coverage-taxonomy.ts:38-131`)은 Cagan 4대 제품위험 중 **feasibility(구현 실패)**만 덮는다. 가치/방향 taxonomy = 그 dual — **value(쓸/살 것인가)·viability(제품·사업 정합)·일부 usability**. risk가 STRIDE/OWASP/CWE에 교차검증되듯, 이건 **Cagan 4-risk · Jobs-to-be-Done · Opportunity-Solution-Tree · Kano**에 교차검증.

**"프로덕트급" = 다차원 bar (사용자 정의, Q1 인터뷰).** 단일 기준 아님. 7 차원, groundability 순 — 위쪽일수록 도구가 객관 검증, 아래쪽일수록 사용자 judgment. **핵심: R·E가 체크리스트로 grounded라 SLOP 위험이 낮다.**

| 차원 | 무엇 | groundability |
|---|---|---|
| **F 의도 충실도** | 진짜 원한 것과 정합 (palimpsest 갈아엎기 방지) | grounded: 앞선 답·intent 대조 |
| **R 운영 준비도** | 기술적으로 '운영' 가능한가 (배포·관측·장애 대응) | **checklist grounded** (ops 체크리스트) |
| **E 제품 필수 요소·수준** | 제품이라면 갖출 요소·수준을 갖췄나 | **checklist grounded** (사용자: "어느 정도 체크리스트 존재") |
| **U 사용자 관점 합리성** | 여정·스토리·UI/UX가 사용자에게 합리적인가 | 부분 grounded — **journey-author 재사용** |
| **D 방향·틀 (발산)** | 근본 need(JTBD) · 대안 3~5 · 강한 버전(bounded) | need·대안 grounded / 강한버전 judgment |
| **X 타이밍·commitment** | 지금인가·의존 · 가역성(one-way door) · build/buy/skip · 기회비용 | 대개 grounded / 기회비용 judgment |
| **M market·먹힐 포인트** | 트렌드 반영 · 먹힐 포인트 (사용자: "다소 추상적") | **judgment (단언 금지, graduated grounding)** |

지불자(who-pays)·순수 사업 viability는 **de-emphasize** — 사용자=solo+팀 개발자(Q2), 외부 유료고객이 주 대상 아님. 단 팀이 범위라 공유 산출물·정합은 유지.

**anti-SLOP 규칙.** groundable 차원(F·R·E·U·need·대안·X)은 도구가 조사해 **증거 제시**, judgment 차원(M·강한버전·기회비용)은 **묻기만**(auto-assert 금지). 가치 verdict는 사용자 종합.

**anti-"메뉴에서 고르기" (사용자 원 불만 직격).** 도구가 방향 메뉴를 내밀면 사용자는 하나 골라 ditto 편향을 따른다(원 불만). 그러므로 출력은 메뉴가 아니라 **방향을 가르는 결정 축(axes) + trade-off + 모르는 것** — 사용자가 *스스로* 방향을 만든다. orientation(고르기) 금지, expansion(공간+차원 제시)만. `feedback_deep_interview_exploration` 정합.

**posture = 강한 적대 + gate (Q3), anti-SLOP과 화해.** prism는 프로덕트급 미달이면 deep-interview로 **진행 거부**(hard gate). 단 '거부'의 뜻 = **사용자가 judgment 차원(M·강한버전)을 대면하고, groundable 체크리스트(R·E·F)가 통과할 때까지** — *도구가 가치를 승인*할 때까지가 아니다. **막는 건 groundable, 강제하는 건 judgment 대면.** 이게 hard-adversary와 anti-SLOP의 화해점.

**grounding = graduated (Q4 — web 조사 too heavy, 절충).** 기본은 **싼 내부 앵커**(코드·memory·prior-answers·R/E 체크리스트, web 없이)로 질문에 근거를 댄다. 유사제품·web 조사(deep-research 재사용)는 **사용자 pull 또는 최고 stakes 소수(M)에만**. WS5 비용과 정합.

**구동 (risk 엔진 재사용).** relevance-gate(이 요청에 어느 차원? 작은 내부변경엔 M·U 불필요) → groundable 조사 / judgment 질문 → 발산 dry까지. route-by-weight로 고가치 작업에만.

**발산 기계적 상한 (P0 Q-close — 산문 규칙이 아니라 코드 상한).** `tech-spec/SKILL.md:67` hard-guard를 걷어내는 대가로, 발산이 SLOP로 번지지 않게 **기존 coverage 엔진의 admissibility 규율을 그대로 재사용**한다(신규 발명 없음):

1. **relevance-gate (진입 자체를 막음).** route-by-weight — 작고 가역·단일표면 요청은 발산을 **skip**(prism 미진입, 경량 경로로). 발산은 고가치·고모호에만. relevance-judge(`agents/relevance-judge.md`) 재사용, 보수적 "애매하면 포함"의 **역**: "애매하면 발산 skip"(비용·SLOP 둘 다 낮춤).
2. **admissible 방향만 카운트.** 방향은 **근거를 달 때만** admissible — JTBD need 앵커·물질적으로 다른 대안·코드/memory 사실 중 하나. 무근거·재탕(near-dup) 방향은 **드랍**. coverage-manager의 `admissibleBranchesAdded` 규율 재사용 — *생성 수*가 아니라 *admissible 수*를 신뢰([[project_premortem_redesign]]의 핵심 교훈: LLM 생성 카운트는 환각 포함, admissible 카운트만 코드-결박).
3. **hard cap = admissible 방향 ≤ 5.** loop-until-dry가 아니라 **loop-until(dry ∨ 5 admissible)**. 5 도달 즉시 정지 → 사용자에게 축 제시(anti-메뉴: 방향 리스트가 아니라 방향을 가르는 결정 축).
4. **judgment 차원(M·강한버전)은 auto-generate 금지.** 근거 못 대는 차원은 방향을 *만들지* 않고 *묻기만*(anti-SLOP). groundable 차원만 도구가 방향을 제안.

이 넷이 "hard-guard 제거 = 규율 없는 인플레이션"을 막는 실체다. 검증: 무근거 방향이 admissible 카운트에 안 들어가고 cap이 5에서 정지함을 재현(합성 vibe로).

**정직한 천장.** M(market)·D-강한버전은 체크리스트 없는 judgment라 taste 천장 최대 — generic 대안(SLOP)·강한 버전 놓침. 완화: graduated grounding으로 근거만 대고 판정은 사용자. 이 구간은 도구가 덜, 사용자가 더.

**R·E 체크리스트 실제 항목 (grounded 앵커의 실체).**

*R 운영 준비도 = 기존 risk taxonomy 재사용 (부분).* R은 새 도메인이 아니라 **기존 23 카테고리(`coverage-taxonomy.ts:38-131`)의 운영 subset**을 쓴다 — 아래 표의 10개 id 매핑이 실재한다. ⚠ **P0 pre-mortem 정정(§9-D4)**: "무발명·재사용"은 **id/topic 수준에서만** 참이다. `FarFieldCategory`는 `{id, lens}`뿐이고(`coverage-taxonomy.ts:21-26`) lens는 전부 **실패-프레이밍**("…깨질 우려?")이라 pre-mortem 노드 seeding에 소비된다. "readiness로 뒤집기"는 (a) 새 readiness lens 텍스트 + (b) 구조체에 없는 평가 필드(auto/semi/ask)를 요구 = **둘 다 net-new**. 즉 같은 id를 공유하는 **병렬 taxonomy**(WS-PRISM-T1 line 345의 "병렬 신설"과 정합; line 226의 "빌드 비용 축소"는 lens·평가 필드 net-new만큼 과대). 두 taxonomy(pre-mortem·readiness)의 id 동기화 규칙을 한 소스로 고정할 것.

| R 항목 | 재사용 카테고리 | 평가 |
|---|---|---|
| 관측성 (로그/알림으로 실패를 보나) | `observability` | semi (로깅 존재?) |
| 실패·복구 (경로·롤백·fallback) | `failure-recovery` | semi (에러처리 diff) |
| 배포·롤아웃 (순서·flag·혼재버전) | `deployment-rollout` | ask/semi |
| 외부 의존 (3rd-party/env·side-effect) | `external-env` | ask/semi |
| 자원·성능 (한도·타임아웃·N+1) | `resource-exhaustion` | semi |
| 설정·시크릿 (env 검증·노출) | `configuration`·`secret-exposure` | auto(스캔)/ask |
| 데이터 안전 (손실·마이그레이션·멱등) | `data-integrity` | ask/semi |
| 동시성 (레이스·락·순서) | `concurrency-ordering` | ask |
| 호환·버전 (스키마/API 진화) | `compat-version` | semi |
| 감사 (누가/언제/무엇, 필요시) | `auditing` | ask |

*E 제품 필수 요소·수준 = net-new (DoD/completeness).* 23엔 제품 완결성 없음 → 미소유. U와 구분: **E=요소가 있나(완결성 체크), U=그게 합리적인가(품질 judgment).**

| E 항목 | 무엇 | 평가 |
|---|---|---|
| 온보딩·발견성 | 사용자가 시작·설치·설정 되나 | ask/semi |
| 핵심 여정 완결 | happy path 끝까지·막다른 길 없나 | semi (journey-author 재사용) |
| 실패·빈·경계 상태 | 에러/빈/경계 상태 UX 처리 | semi |
| 되돌리기·안전장치 | 실수 복구·파괴적 동작 확인 | ask |
| 문서·도움말 | 사용자가 스스로 풀 수 있나 | auto (문서 존재?) |
| 피드백·상태 가시성 | 뭐가 일어나는지 아나 | ask |
| 일관성 | 기존 제품 패턴과 일관 | semi |

평가 = **auto**(코드/repo 검출) / **semi**(부분+확인) / **ask**(judgment이나 체크리스트로 구체). floor는 tier-② config로 프로젝트가 enable/disable/add (`resolveTaxonomy` 패턴 동일).

**함의**: R은 **id/topic 재사용 + lens·평가 필드 net-new**(§9-D4 정정). moat의 진짜 net-new = **E + R의 readiness lens/평가 필드 + 가치/방향 lens(A2·A3·M)**. 빌드 비용은 pre-mortem taxonomy 데이터 구조·엔진 재사용만큼만 축소(전면 재사용 아님).

---

## 3. 백로그 (워크스트림 → 태스크)

각 태스크: **[변경] / [파일] / [검증] / [무게·경로] / [의존]**. 무게=경량(단일표면·가역) / 중 / 무거움(다표면·비가역·설계).

### WS0 — 영속 공유 백로그 척추 (명제 A + §2.5 아키텍처) — *근본·가장 먼저*

> 이제 단순 "뷰 추가"가 아니라 **기록/실행 분리 + 공유 tier 이동 + projection**의 근본 워크스트림. Q2 "10년 가는 설계"의 본체.

- **WS0-T0 · 기록/실행 분리 + 공유 tier 이동 (아키텍처 코어)** *(설계·pre-mortem 먼저)*
  [상태 2026-07-07] ✅ **DONE · landed · 미push** — wi_2607069bk, 커밋 `0a0fc96`. 10/10 AC fresh-verify(full suite 3922 pass/0 fail, 드라이버 독립 확증), n8-review ACCEPT(0 blocking). Record=committed `.ditto/work-items/<id>/`(record.json + per-event immutable `events/`) · Run=`.ditto/local/work-items/<id>/`. per-event 로그 + first-terminal-wins reduce. **ADR-20260706 신규 + ADR-0012 D1 부분 supersede**(D3 decision-conflict 해소). 권위=코드+ADR(이 문서 아님). **구현 편차·후속(WS0-T4가 실제 동작 기준으로 이어받을 것)**: (a) archive(D2)는 'archived' status enum 부재·reducer의 2nd-terminal 거부로 terminal-이벤트-append가 **불가** → committed Record를 git-tracked **relocate**(`.ditto/work-items-archive/<label>/<id>`)로 구현. 아래 WS0-T4 archive 설계(§9-D2)는 이 실제 동작으로 교정 필요; (b) 그 archive 네임스페이스가 `check:committed-base` lint scope(`​.ditto/work-items/`) 밖 → 미래-writer 가드 공백(WS0-T4 §9-A2 미래생산자 가드와 병합); (c) verdict가 record.json + events **이중저장**(benign — reduce에서 events win, §1.2 순수성 편차); (d) **tidy 기계장치 버그** = 매 implement pass마다 `started_at_sha` 누적 diff 전체로 fan-out(9노드) + G7 floor가 no-op refactor 종결 거부 → 루프 정지. 드라이버가 tidy 서브그래프 제거로 우회. **별도 follow-up WI**(tidy-scheduling 계층 수정, G7 약화 아님). 상세 = ADR-20260706 + `.ditto/knowledge/knowledge.json`.
  [변경] work item을 **Record(영속·공유)** 와 **Run(일회성·개인)** 으로 스키마 분리(§2.5 표). Record를 tier ②(committed)로, Run을 tier ③(`.ditto/local/`)로. 결합은 work_item_id 단방향(Record는 Run 없이 존재 가능).
  [파일] `src/schemas/work-item.ts`, `autopilot.ts`, `completion-contract.ts`, `work-item-store.ts`, `.gitignore`(tier 경계)
  [검증] Record가 커밋되어 `git ls-files`에 나타남; Run을 삭제해도 Record·verdict 무손실; 경량 경로 Record가 Run 없이 done 도달. **소비자 스윕(§2.5) 반영**: (i) 상태 writer 6곳이 한 event로 수렴, `work-item-handoff.ts:324-341` 직접 write 제거 — append-only 전환 시 close()/R1 terminal 배타성 보존(§9-D1: single-writer가 append 직전 head를 reduce해 already-terminal 거부); (ii) `stop.ts:902` strong-block 면제를 **`Run 부재`가 아니라 Record의 명시적 경량 마커**(예: `completion_boundary==='lightweight'`)에 걸어야(§9-C1: Run 부재로 걸면 무거운 work item의 미검증-종료까지 함께 빠져나가 게이트 무력화 — 마커 없는 Run-부재는 여전히 block); (iii) `completion-store.ts:124-136` mirror는 이미 `evidenceRef[]`(digest-safe)라 digest-only Record로도 안 깨짐(§9 seam #1 오채점 정정); (iv) `github-progress.ts:196-197` `posted_decision_ids`를 Record가 아닌 Run(개인) 멱등 셋으로 이동, Record엔 github_issue 좌표(불변)만(§9-C5 — Run-cadence Record 쓰기가 single-writer append 가정 붕괴).
  [무게] 무거움 / 다표면·비가역·마이그레이션 동반. [의존] 없음(모든 것의 토대). **dialectic-review + pre-mortem 선행 필수** — P0 pre-mortem 완료(§9).

- **WS0-T1 · 공유 백로그 projection + `ditto work list` 집계·질의 뷰**
  [상태 2026-07-07] ✅ **DONE · landed · pushed(main=`faf739f`)** — wi_260706aka. 6/6 AC fresh-verify(67 real items, full suite 3997 pass/0 fail), n-verify 독립 확증. 신규 `src/core/work-item-project.ts`(recompute-on-read·no cache, memory-project 패턴) + `WorkItemSummary` OPTIONAL 위젠(unresolved_follow_ups·blocking_reason·github_issue·push_ready·lineage) + `work list` 필터(--status enum검증·--has-followups 미해결·--orphan-drafts draft∧>14d∧계보없음 AND) + --wide/--all + active-first 그룹. **O(n) 제약**: `computeStemViews` 단일 스냅샷(per-row stem 금지). 정식 경로(deep-interview → relevance-gated coverage sweep 24→13 → autopilot). 권위=코드(이 문서 아님).
  ⚠ **구현 편차(WS0-T4가 이어받을 것)**: projection을 committed-tier 단독으로 짜면 `work list`가 70→3개 붕괴(67 레거시 WI가 Run-tier 미마이그레이션) — **fresh 검증이 잡음**. 사용자 결정으로 **dual-base 브릿지**(committed+legacy 둘 다 표시, `store.listAll()`) + **ac-5 rescope**: "Run 삭제 후 목록 동일"(원문) → "committed Record의 결정성 보장(Run 삭제 후 committed 행 동일), 레거시는 표시 브릿지". **레거시→committed 마이그레이션이 WS0-T4** — 완료 시 dual-base 브릿지 은퇴. 별도 follow-up: intent-drift 과다선언 오탐(안 건드린 파일 change_surface 선언), land-dirt/tidy-diff-base/AC-mirror 인프라 gotcha 재발.
  [변경] Record들을 공유 tier에서 읽는 read-optimized 백로그 projection(memory projection 패턴). `WorkItemSummary`(현재 4필드) → status·follow_ups 수·blocking 사유·github_issue·push-ready·계보로 확장. `ditto work list [--status …] [--has-followups] [--orphan-drafts]`.
  [파일] `work-item-store.ts:433-466`, `src/cli/commands/work.ts`, projection 모듈(memory projection 참조)
  [검증] 63개 WI를 필터별 나열; projection이 공유 tier에서 재생성 가능(결정적).
  [무게] 중. [의존] WS0-T0.

- **WS0-T2 · 잔여→추적항목 보존 (고아 draft 차단, 불변식 3)**
  [변경] placeholder AC로 물질화된 후속이 영구 방치 안 되도록: `blockingFollowUp`을 self-caused high/critical 너머로 확장(줄기 push-ready 차단에 미구동 후속 포함). grounding **품질** 게이트(현재 존재만 검사). 후속은 이제 공유 백로그 항목이라 개인 파티션에 숨지 못함.
  [파일] `work-item-store.ts:88-97`, `gates.ts:238-257`, `completion-contract.ts:211-215`
  [검증] 고아 draft 있는 줄기가 push-ready 거부; 빈/저품질 grounding이 release 거부(재현 테스트).
  [무게] 중. [의존] WS0-T0·T1.

- **WS0-T3 · GitHub 칸반 = 두 번째 projection (SoT 아님, 불변식 2)**
  [변경] 공유 백로그 Record를 GitHub Project로 투영(칸반). SoT는 ditto 공유 tier — GitHub는 지금처럼 활용 가능한 뷰(Q1). 후속/잔여도 이 투영으로 보드에 나타남(현재는 기껏 linked 이슈 코멘트 1줄). ADR-20260628 D3("보드=백로그 SoT") 정정 ADR 동반.
  [파일] `github-progress.ts:124-127`, `work.ts` follow-up/reflect 경로, `src/schemas/ditto-config.ts`
  [검증] Record 상태 변화가 보드 카드로 투영(P₀ dogfood + non-ditto 타깃의 보드에서도 — 명제 I); SoT 역전 없음(보드→ditto 강제 sync 없음). **D3 정정 ADR을 이 랜딩 커밋에 원자적으로 동반**(§9-D3): `ADR-20260628-github-backlog-sot.md:18`이 여전히 "보드=백로그 SoT"라 서 있고 코드(github-progress write-mirror)도 그대로라, 정정 없이 랜딩하면 코드·표준 ADR·설계가 3자 불일치해 ADR-0020 intent-충돌 창이 P1~P2 내내 열림. 그 전 과도기는 "설계 근거로 의도 정정 진행 중"을 명시 disclosure.
  [무게] 중~무거움 / 외부. [의존] WS0-T0·T1.

- **WS0-T4 · 기존 63개 로컬 WI 마이그레이션**
  [변경] `.ditto/local/work-items/`의 기존 63개를 새 Record(공유)/Run(개인) 모델로 이관. 가역·검증 가능하게(백업 + 되돌리기).
  [파일] 마이그레이션 스크립트, `work-item-store.ts`
  [검증] 이관 후 전 항목이 `work list`에 나타나고 verdict 보존; 롤백 절차 실증. **leak-test 필수(§2.5 소비자 스윕)**: 디렉터리 통째 commit 금지 — Record 절반만 분해 commit, commit tier에 Run 아티팩트(evidence/·runs/·*-state.json·session 버퍼) 0건 재현. Run 없이도 디렉터리를 자동 생성하는 ~20 생산자가 private 데이터를 committed tier로 새지 않음을 확인. **미래 생산자 가드(§9-A2)**: 일회성 마이그레이션 테스트로는 회귀를 못 막으므로, Record/Run을 같은 디렉터리 하위가 아니라 **물리적으로 다른 base 경로**(committed=`.ditto/work-items/`, Run=`.ditto/local/runs/<id>/`)로 분리해 신규 생산자가 base 선택으로 tier를 강제받게. **archive 생애주기(§9-D2)**: `work-item-store.ts:415-431` archive가 디렉터리 통째 rename이라 committed Record가 섞이면 git 추적 밖으로 나감 — Record는 archive 시 terminal 이벤트 append만, 물리 이동은 Run tier에 국한.
  [무게] 중~무거움 / 비가역 주의. [의존] WS0-T0.

### WS-ACQ — AC 설계·검증 품질 (명제 G) — *시급 최우선, 교차 뿌리*

> 사용자 지적: "구현했지만 미배선" 출력이 반복 = AC 설계·검증 품질이 낮다는 신호. 이 결함이 false-green·의도 축소·재작업의 공통 상류다. WS1-T5(anti-stub)는 이 워크스트림의 한 조각이며, 여기서 뿌리째 다룬다.

- **WS-ACQ-T1 · AC 고도 게이트 — "종단 배선"을 관측 단위로**
  [변경] AC 관찰성 게이트(`acceptanceTestable`, `work-item.ts:71`)가 지금은 *관찰 형식*만 검사한다. 사용자 표면 동작을 주장하는 AC는 **사용자가 닿는 진입점(CLI·skill·hook)을 통해서만 통과 가능한 형태**를 요구하도록 강화. "함수 X가 존재한다"류를 거부하고 "표면 S에서 동작 B가 관측된다"를 요구.
  [파일] `gates.ts:141-158`(acceptanceTestable), `work-item.ts:5-47`(oracle class), `set-criteria` 경로
  [검증] "coverage 함수가 존재한다"류 AC가 게이트에서 거부됨; "인터뷰 중 답하면 지도가 갱신된다"류는 통과(재현 케이스 쌍).
  [무게] 중. ← **미배선 결함의 예방 게이트.**

- **WS-ACQ-T2 · 배선 검증 — 증거는 실제 표면에서 나와야**
  [변경] verify/verifier가 AC의 증거를 **실제 사용자 표면 실행**에서 수집하도록 강제(내부 함수 직접 호출 proxy 금지). WS1-T5 anti-stub와 결합 — stub도 unwired도 둘 다 종단 실행에서 걸림. `/verify` skill의 "drive the flow, not just tests"를 게이트로 승격.
  [파일] `skills/verify/SKILL.md`, `agents/verifier.md`, `completion-contract.ts`(evidence kind에 surface-origin 표식)
  [검증] 미배선 기능(함수는 통과, 표면 실행은 실패)이 verify에서 FAIL로 드러남(재현 — 이번 조사가 찾은 실제 케이스로).
  [무게] 중. [의존] WS-ACQ-T1.

- **WS-ACQ-T3 · 의도→AC 충실도 역검 (하류 되돌아보기)**
  [변경] 완료 직전, 닫히는 AC 집합이 **원 의도 statement를 실제로 충족하는지** 원의도로 되돌아가 재검하는 단계 추가(현재 어떤 게이트도 원의도로 회귀 안 함 — 조사 §2 확인). WS1-T5 provenance(AC←dimension)를 이 역검의 입력으로.
  [파일] `gates.ts`(completion 경로), `intent.ts`, verifier 계약
  [검증] AC는 다 pass인데 의도의 절반만 충족한 완료가 역검에서 blocked로 드러남(핸드오프의 Risk/Summary stub 케이스로 재현).
  [무게] 중~무거움. [의존] WS1-T5.

### WS-HND — 핸드오프 / 세션 전이 상태 재설계 (명제 H) — *근본, 컨텍스트 오염 직결*

> 핸드오프 = 일회성·수신자 지정·읽으면 은퇴하는 세션 전이 컨텍스트. 지금은 (로컬) WI에 결박되고 은퇴가 happy path에만, (원격) git 커밋으로 방송. §2.5의 tier/생애주기 원칙의 거울상 — 여기선 *일회성 상태를 잘못된 곳에 영속시킨다*. 패치 아닌 재설계(사용자 지시).

- **WS-HND-T0 · 핸드오프를 recipient-scoped 일회성으로 재정의 (아키텍처)** *(설계·pre-mortem 먼저)*
  [변경] 키를 `work_item_id`(필수, `handoff.ts:14`)에서 **producer 세션 → recipient 범위 + 선택 참조**로. 세션 컨텍스트 핸드오프(여러 결정 걸침·WI 없음)를 hand-authored fallback이 아닌 **일급 아티팩트**로. 저장은 개인 tier, 소비 시 은퇴.
  [§2.5 정합 — P0 후 추가] 두 seam을 §2.5 Record/Run 분리와 맞춰야 한다:
    · **(a) 참조 분리 (스키마가 이미 준비됨).** `handoff.ts`는 이미 `autopilot_id`(:15, 실행 재개)와 `work_item_id`(:14)를 분리 보유 → split 후 **work-ref = Record 0..1(영속 의도) + run-ref = autopilot/Run 0..1(재개할 실행)**로 명시. WI 없는 세션 핸드오프는 둘 다 0. 발명 없음, 명시만.
    · **(b) inline durable 필드의 은퇴 누수 (P0 미고려 gap).** `critical_decisions`·`irreversible_risks`(`handoff.ts:31-51`)는 "재도출 불가라 inline 보존"하는 durable 내용인데, 핸드오프는 소비 시 은퇴한다 → §2.5 규율("durable→영속 공유 tier")과 충돌: 은퇴 그릇에 영속 결정이 담겨 사라진다. WS-HND-T4 "결정은 남기고 산문은 은퇴"를 핸드오프 자신의 inline 필드에도 적용. ⚠ **흡수 타이밍 — P0 pre-mortem §9-C2 (훅↔에이전트 3중 충돌)**: "소비 시 흡수"는 불가하다. 소비는 UserPromptSubmit 훅의 **기계적 rename**(`handoff-store.ts:269-280`·`user-prompt-submit.ts:300,307`)이라 ADR/knowledge 저작(에이전트 판단 필요)을 못 하고, WI-less 세션 핸드오프는 흡수할 **Record 자체가 없으며**(line 297), 소비는 에이전트 추론 *이전*에 일어난다. → **흡수를 소비 시점이 아니라 핸드오프 *작성* 시점**(에이전트가 아직 있을 때)에 durable 결정을 committed Record/knowledge로 promote하고, 핸드오프엔 pointer만 남겨 소비 시 rename만 하도록 재배치.
  [파일] `src/schemas/handoff.ts:13-24`, `handoff-store.ts:47-69,160-174`, `skills/handoff/SKILL.md`
  [검증] WI 없는 세션 핸드오프가 store를 통해 쓰이고, 다음 세션이 1회 소비 후 은퇴됨(재현); 소비 시 `critical_decisions`/`irreversible_risks`가 Record/knowledge로 흡수돼 은퇴 후에도 조회 가능(재현).
  [무게] 무거움 / 다표면. [의존] **§2.5 Record 스키마(WS0-T0)** — 참조 분리·흡수 대상이 Record. **dialectic-review 선행.**

- **WS-HND-T1 · content-blind 은퇴 GC (잔존 뿌리 차단)**
  [변경] 소비·sweep이 `parseHandoffFile` 성공에 의존하는 것을 제거 — **filename/parse-agnostic age sweep**으로 malformed·비-WI 파일도 mtime로 은퇴. consume-on-read을 모든 핸드오프에 확장.
  [파일] `handoff-store.ts:214-224,293-314`(listActive/sweepStaleActive), `user-prompt-submit.ts:296-317`
  [검증] 지금 `active/`의 2개 `session_*.md`(parse 실패) 같은 파일이 age sweep으로 archive 이동됨(재현 — 실제 2파일로).
  [무게] 중. ← **지금 쌓이는 것의 직접 수리.** 
  [즉시·별건] 현재 lingering 2개(`session_260622_risks_processed.md`·`session_260706_...`)는 이미 소비됨 → 사용자 승인 시 archive로 은퇴(가역 move, 삭제 아님).

- **WS-HND-T2 · 원격 핸드오프 non-broadcast 재설계** *(인프라 결정 필요 — Q7)*
  [변경] git 커밋 `HANDOFF.md` 방송을 제거. 한 수신자용 일시 컨텍스트를 **recipient-scoped·만료** 채널로(전용 ref/branch 또는 per-recipient 경로, 소비 시 자동 제거). 팀 working tree 오염 금지.
  [파일] `skills/handoff/SKILL.md:57-68`, 원격 전송 경로
  [검증] 원격 핸드오프가 팀 공유 working tree를 오염시키지 않고 지정 수신자만 소비(설계 검증).
  [무게] 무거움 / 외부·인프라. [의존] WS-HND-T0, Q7.

- **WS-HND-T3 · "write, no-GC" family 통일 (세션 포인터·lease 은퇴)**
  [변경] `SessionPointerStore`에 clear/delete + 세션 종료 sweep(현재 get/set만, 20개 잔존). `ActiveNodeLeaseStore`에 age reaper(누수 lease 영구 잔존). 핸드오프 GC와 같은 은퇴 primitive로 통일.
  [파일] `session-pointer.ts:24-50`, `active-node-lease.ts:48-90`
  [검증] stale 포인터·누수 lease가 sweep으로 제거됨(이 세션이 겪은 stale wi_260628sx5 포인터가 실제 케이스).
  [무게] 중. ← **이 세션이 방금 수동으로 겪은 문제의 코드 수리.**

- **WS-HND-T4 · 신선도 민감 설계/기획 산출물 은퇴 (§2.6 원칙 집행)**
  [변경] tech-spec spec·plan brief·prism 탐색노트 등 설계/기획 산출물에 생애주기 부여 — 구현(work item done) 후 **durable 결정은 code·ADR·knowledge로 흡수, 산문은 은퇴**(archive/폐기). 지금 `.ditto/specs/*.md`에 은퇴 메커니즘 있는지 미확인 → drift-rot 위험. 핸드오프 GC와 같은 은퇴 primitive 공유.
  [⚠ CRITICAL — P0 pre-mortem §9-B1] **spec 산문을 그냥 은퇴시키면 autopilot이 영구 block된다.** `autopilot-loop.ts:150-166` specDigestStale 게이트가 `intent.source_digest.doc_path`(`intent.ts:25`)의 문서 존재·해시 일치를 매 `next-node`에 강제 — 문서가 사라지면 `action:'blocked'`("restore the document or re-run `ditto tech-spec finalize`")를 반환해 재검증·follow-up·재실행 등 done 이후 모든 autopilot 호출을 막는다. → **은퇴는 "결정 흡수 + digest 게이트 해제(source_digest nullify 또는 finalize된 intent를 self-contained로 승격)"와 원자적으로 묶어야** 한다. 문서만 지우면 안 됨. WS-PRISM-T0의 prism 산출물 은퇴도 동일.
  [파일] tech-spec store, `.ditto/specs/`, `autopilot-loop.ts:150-166`(digest 게이트 해제 경로), `src/schemas/intent.ts:25`, knowledge-curator 흡수 경로, WS-HND GC
  [검증] work item done 시 연결된 spec의 durable 결정이 ADR/knowledge로 흡수되고 원 산문이 은퇴됨(재현); **은퇴 후 같은 work item의 `ditto autopilot next-node`가 blocked를 반환하지 않음(재현 — §9-B1 회귀 방지).**
  [무게] 중. [의존] WS-HND-T1(GC primitive), §2.6, **WS-PRISM-T0(digest 게이트 해제 조정).**

### WS-PRISM — 의도 정련 표면 (tech-spec 진화·대체) — *ditto의 moat / North Star*

> **위생 vs moat.** 다른 워크스트림(WS0 백로그·WS-HND 핸드오프·WS3 컨텍스트·WS4 ACG·WS5 성능)은 진지한 도구라면 당연히 있어야 하는 **위생**이다 — 없으면 감점이나 돈 낼 이유는 아니고, 어떤 하네스든 결국 갖춘다. 구현도 commodity다. **유일하게 대체 불가능한 가치 = "바이브에서 시작했지만 이게 정말 내가 원한 거냐 / 돈 낼 프로덕트급이냐"를 끌어내는 의도 표면.** palimpsest 참사(매끄럽게 "성공" → 이틀 뒤 갈아엎음)가 그 부재의 반례.
>
> **사용자 결정.** deep-interview는 **수렴 유지**(WS1이 품질만 개선). "바이브 → 프로덕트급 의도"의 생성적 정제는 **tech-spec을 진화시켜 대체**(§2.6) — 신규 표면을 늘리지 않고, 저사용 tech-spec의 형태를 개선해 그 자리를 차지. 파이프라인: `vibe → [prism: 발산→가치압박→구체화] → [deep-interview: 수렴→AC] → autopilot`. prism는 **전치·선택적**(고가치·고모호에만, route-by-weight).
>
> **천장(정직).** "돈 낼 프로덕트인가"의 최종 판단은 사용자 안목이다 — 도구가 없는 taste를 지어내면 SLOP이 된다. 도구의 몫은 그 판단을 **강제로 끌어내고 구조화·근거화**하는 것. 발산·대조·심문·적대(아래 T1~T4)는 taste 없이 가능; taste 주입만 모델 prior+사용자에 의존.
>
> **재사용 vs 신규 (rot 방지 판정, 코드 조사).** prism는 **tech-spec을 진화**시킨 것이라 그 기계를 물려받는다(13섹션 템플릿·expert-elicitation·증거 게이트·question fan-out). 5능력 중 **신규는 (1)발산·(3)가치심문뿐**이고, 이 둘만 어떤 표면에도 소유자가 없다(tech-spec은 오히려 발산을 명시 금지 `tech-spec/SKILL.md:67`). (2)grounding·(4)변증법은 이미 엔진이 있어 **재사용**, (5)taste는 tech-spec expert-elicitation을 **확장**. **유일한 net-new 메커니즘 = 가치/방향 taxonomy** — 지금 coverage taxonomy는 전부 실패/위험 렌즈(`coverage-taxonomy.ts:38-131`)라 방향/가치 렌즈가 없다. 그리고 이 taxonomy가 tech-spec anti-inflation 가드(`SKILL.md:67`)를 대체하는 규율(발산을 근거 있는 3~5로 한정)을 겸한다. monolith 신설 금지.

- **WS-PRISM-T0 · tech-spec 진화·대체 (아키텍처)** *(설계·dialectic-review 먼저)*
  [변경] `skills/tech-spec/`을 개선해 prism로 전환 — 13섹션 구조화는 유지, 앞에 발산·가치 단계 추가, anti-inflation 가드(`SKILL.md:67`)를 가치/방향 taxonomy 규율로 교체. 입력=raw vibe, 출력=**구체화된 프로덕트급 설계**(구현후 은퇴, WS-HND-T4). 종료=사용자가 강한 버전에 commit. deep-interview가 이를 소비.
  [⚠ HIGH — P0 pre-mortem §9-C3, 파이프라인 소유권] 현재 deep-interview는 tech-spec *안에* 중첩돼 있고(`tech-spec/SKILL.md:123` "call deep-interview internally"), tech-spec finalize(`tech-spec.ts:574` `IntentStore.write` + `:572` source_digest + `:613` bootstrap)와 deep-interview(`interview-driver.ts:427` 독립 `intentStore.write`)가 **둘 다 intent.json을 컴파일·bootstrap하는 병렬 종단 표면**이다. "prism → deep-interview → autopilot" 3단계는 이 포함관계를 역전시킨다 → **intent.json 단일 writer + source_digest 소유 표면을 명시**해야(누가 컴파일하나: 이중 쓰기 시 AC 이중 깎임 = WS-PRISM-T5가 이름만 댄 그 위험). deep-interview zero-diff(`SKILL.md:169`)를 지키려면 prism이 intent를 소유하고 deep-interview는 내부 호출로 남기는 편이 코드 정합.
  [파일] `skills/tech-spec/SKILL.md`(진화), `src/core/tech-spec.ts`, `tech-spec-state.ts`, 기존 `.ditto/specs/*.md` 마이그레이션, `autopilot-loop.ts:150-166`(은퇴 시 digest 게이트 해제 — WS-HND-T4 조정)
  [검증] vibe 입력이 발산·가치 압박을 거쳐 구체화된 설계로 산출되고 deep-interview가 AC로 수렴(종단 재현). **비회귀 = 구체 compat 표면 목록으로 실증(P0 dialectic)**: CLI 명(`cli/index.ts:68` `tech-spec`)·섹션 ID·compile input·기존 테스트(`tech-spec-template.test.ts:54-62`)·기존 `.ditto/specs/*.md` 7개 문서. **⚠ P0 pre-mortem §9-C4 — compat 목록 확장(이름 결박이 위 목록보다 넓음)**: (1) 커밋된 surface 카탈로그 `.ditto/local/surfaces.json`·`surfaces.codex.json`(`surfaces:gen` 재생성 + `surface-inventory` loud-fail), (2) `tests/host/claude/skills.surface.test.ts:16-38`(SKILLS 리스트 + `toBe(11)` + frontmatter name), (3) config 키 `tech_spec.*`(`ditto-config.ts`)+backcompat 테스트, (4) doctor 출력 필드명 `tech_spec_rounds`·`tech_spec_mean_answer_value`(`intent-quality-doctor.ts:55-176`), (5) 사용자 대면 문자열 `autopilot-loop.ts:164-165` "re-run `ditto tech-spec finalize`", (6) 트레일/state 경로 `tech-spec-rounds.jsonl`·`tech-spec-state.json`. replace-in-place는 이들에 alias/마이그레이션을 동반, "비회귀"를 각 항목 pass로 정의(`surface-inventory.plugin.test.ts` `toBe(46)` 카운트는 rename에 불변이나 이름-리스트 테스트는 파손됨 — 구분).
  [⚠ MEDIUM — §9-D6 저사용 방어] prism은 tech-spec보다 엄격히 무겁다(13섹션+fan-out+상시 pre-mortem 위에 발산·가치를 얹음). 중형 작업 무게 문턱을 낮추려 **"발산 opt-out"(사용자가 이미 방향 확신 시) 경로**를 route-by-weight 옆에 둘 것.
  [무게] 무거움 / 진화·대체·마이그레이션. [의존] §2.5 Record, WS-PRISM-T1(taxonomy). **dialectic-review 선행.**

- **WS-PRISM-T1 · 발산 (옵션 공간 확장) — 신규 (net-new 메커니즘, 설계 §2.7)**
  [변경] 물질적으로 다른 3~5 방향 + "강한 버전" 제시. **가치/방향 taxonomy 신설(§2.7: 프로덕트급=7차원 bar F·R·E·U·D·X·M, 체크리스트 grounded 포함, hard-gate는 groundable만·judgment는 대면 강제, graduated grounding, anti-메뉴 축 출력)** — 지금 coverage taxonomy는 전부 실패/위험 렌즈(`coverage-taxonomy.ts:38-131`)라 방향 렌즈가 없다. coverage *엔진*(트리·loop-until-dry·completeness-critic)은 재사용하되 taxonomy만 방향/가치용으로 병렬 신설. tech-spec이 명시 금지한 바로 그 능력(`tech-spec/SKILL.md:67`).
  [파일] 신규 value/direction taxonomy, `coverage-manager.ts`/`coverage-loop.ts` 엔진 재사용, 신규 skill
  [검증] 한 vibe에서 사용자가 못 본 방향 포함 물질적으로 다른 3~5개가 제시됨. **⚠ P0 pre-mortem §9-D5 — 발산 기계적 상한의 "방향 admissibility" 술어는 net-new**: §2.7이 재사용 대상으로 지목한 coverage-manager `admissibleBranchesAdded`는 *pre-mortem 브랜치*용 카운트지 *발산 방향*용이 아니다. 코드화 전엔 상한이 산문 규칙에 머물러 hallucinated 방향이 cap에 안 걸린다(§2.7 line 143 자기경고와 정합) → 방향-admissibility 술어를 브랜치용과 **별도 결박 대상**으로 명시.
  [무게] 무거움 / 유일한 진짜 신규. ← **prism의 핵심 차별.**

- **WS-PRISM-T2 · 현실 대조 grounding (오판·정합성·미흡) — 재사용**
  [변경] 새 엔진 만들지 말 것. 기존 grounding 자산 재사용 — deep-interview self-answer + ADR-0020 intent-conflict(`deep-interview/SKILL.md:63-67`), coverage cross-cutting/memory-graph entanglement(`coverage-taxonomy.ts:139-143`). prism는 이걸 vibe 단계에서 호출해 모순·잘못된 가정·누락을 짚기만.
  [파일] 재사용(위) + 신규 skill의 호출 배선
  [검증] 이전 답/코드와 모순되는 의도에서 기존 grounding이 플래그를 올림(합성 케이스).
  [무게] 중 / 대부분 재사용.

- **WS-PRISM-T3 · 가치·전제 심문 — 신규 (무소유)**
  [변경] "무슨 결과를 원하나·만들 가치 있나·돈 낼 사람 있나·안 만들 이유는". 어떤 표면도 안 하는 것 — tech-spec은 business ambition 범위밖, 23 카테고리는 전부 실패 도메인. **구 WS1-T4(전제 의심)를 여기로 흡수** — 전제/가치는 발산적이라 수렴 표면이 아닌 여기가 제자리.
  [파일] 신규 skill(가치/방향 taxonomy T1과 공유)
  [검증] 전제 약한/가치 불명 요청에서 심문이 방향 재고를 유발.
  [무게] 중 / 신규.

- **WS-PRISM-T4 · 의도 변증법 (기존 dialectic 재조준)**
  [변경] dialectic(Producer/Opponent/Synthesizer)을 **의도 자체**에 겨눔 — 강한 버전 세우고 약한 가정 치고 단단해진 의도로 수렴. 새 기계 아님, 대상 변경.
  [파일] `skills/dialectic/`·`agents/dialectic-*` 재사용, 신규 skill이 호출
  [검증] 의도가 적대 라운드 후 실제로 단단해짐(before/after 비교).
  [무게] 중.

- **WS-PRISM-T5 · deep-interview 무손실 handoff 계약**
  [변경] 정련 의도 Record → deep-interview 이관 시 손실 방지(§4-9 계약). 두 표면이 의도를 두 번 깎지 않도록.
  [파일] 신규 skill ↔ `interview-driver.ts` 진입
  [검증] 정련 Record의 결정이 deep-interview AC에 100% 반영(누락 0, 재현).
  [무게] 중. [의존] WS-PRISM-T0, **WS0-T0(§10-a: 정련 의도를 Record로 이관 → Record 스키마 필요. Track D — 원 [의존]에 T0만 있어 오배치였음). ac-5가 이미 '이중 컴파일 방지'를 담당하므로 잔여 실체 = 무손실 매핑뿐(재구현 금지).**

### WS1 — deep-interview 수렴 품질 (명제 B) — *수렴 유지, 품질만 개선*

- **WS1-T1 · live decision-map을 인터뷰에 배선**
  [변경] 이미 존재하나 미배선인 coverage 그래프(`projectInterviewDimensions`)를 deep-interview/tech-spec 루프에 연결. 사용자가 답할 때마다 dimension 노드가 **추가·해결(제거)**되는 살아있는 지도를 봄. dimension 삭제 경로 신설(현재 additive-only).
  [파일] `interview-driver.ts:505-606`, `skills/deep-interview/SKILL.md`, `premortem-coverage-contract.md:281-288`(§12 후속으로 미룬 것)
  [검증] 인터뷰 중 map이 실시간 갱신; 답변이 형제 질문 노드를 resolve.
  [무게] 무거움 / 표면 재설계. [의존] 없음(엔진은 있음). ← **사용자가 명시 요구한 것.**

- **WS1-T2 · self-answer 투명성 복구 (조용한 축소 차단)**
  [변경] `selfAnswers: []` 하드코딩 제거, 실제 `self_answer_attempts`를 intent-dialog에 주입. 에이전트가 사용자 대신 답한 것 + **묻지 않기로 한 억압된 질문**을 사용자에게 노출해 교정 가능케(계약 §6 이행).
  [파일] `interview-driver.ts:596`, `:125,222-224`, `premortem-coverage-contract.md:174`
  [검증] 인터뷰 dialog에 self-answer 목록이 실제로 뜸(현재 항상 빈값).
  [무게] 중. ← **의도 조용한 축소의 직접 뿌리.**

- **WS1-T3 · 질문의 ambiguity 대상 노출**
  [변경] 질문 표시 계약에 dimension 연결(id·ambiguity 점수·critical 여부) 추가 → 사용자가 "이 질문이 무슨 불확실성을 얼마나 중요하게 푸는지" 앎.
  [파일] `question-context.ts:116-147`, `interview-state.ts:27-36`
  [검증] 표시된 질문이 해결 대상 dimension과 심각도를 함께 보여줌.
  [무게] 경량~중.

- **WS1-T4 · (WS-PRISM-T3로 이동)** — 전제 의심/가치 심문은 발산적이라 수렴 표면(deep-interview)이 아닌 정련 표면의 몫. WS-PRISM-T3 참조.

- **WS1-T5 · AC provenance + anti-stub**
  [변경] `intentAcceptanceCriterion`에 `resolved_dimension`/`from_question` provenance 추가. verify/verifier에 anti-stub 검사 — AC 관찰값이 하드코딩 반환이 아니라 실제 구현으로 충족됐는지.
  [파일] `intent.ts:14-18`, `skills/verify/SKILL.md`, `agents/verifier.md`
  [검증] stub 구현이 AC를 닫으려 하면 verifier가 거부(재현 테스트).
  [무게] 중. ← **"pass가 의도보다 덜 내놓음"의 뿌리.**

### WS2 — 범위 보존·자기완결성 (명제 C)

- **WS2-T1 · 경량 경로에 의도 보존 확장**
  [변경] `intentDriftGate`가 heavy 전용인 구멍을 메움 — 경량 경로에 최소 intent anchor 부여(또는 set-criteria를 동결 anchor로 승격 + done 시 보존 검사).
  [파일] `gates.ts:815-884`, `work.ts:1188-1204`
  [검증] 경량 WI를 조용히 재범위화하면 done에서 차단.
  [무게] 중.

- **WS2-T2 · 승인된 슬라이스를 일급 개념으로**
  [변경] `completion_boundary`에 'slice' 변형 추가 — 슬라이싱은 금지거나 명시적 사용자 승인, 나머지는 산문이 아니라 추적 항목으로 자동 물질화.
  [파일] `autopilot.ts:170`, bootstrap 경로
  [검증] 부분 완료 시 잔여가 자동으로 WS0 백로그에 항목으로 등장.
  [무게] 중. [의존] WS0-T1.

- **WS2-T3 · 경량 경로 문서화·명료화**
  [변경] 사용자가 구조/사용시점을 모르는 문제 해소. `ditto verify`(CLI, 경량) vs `/ditto:verify`(skill, verifier spawn) 이름 충돌 제거(rename/alias). WORKFLOW.md 보강.
  [파일] `WORKFLOW.md`, `src/cli/commands/verify.ts`
  [검증] 문서에 두 경로 차이·선택기준·명령이 1페이지로. 이름 충돌 없음.
  [무게] 경량.

- **WS2-T4 · 자기완결성 floor — 방안 있는 잔여 금지**
  [변경] agent-resolvable 잔여는 두 경로 모두에서 해결하거나 품질 grounding으로 명시 defer해야 함(WS0-T2와 함께).
  [파일] `gates.ts:213-261`
  [검증] 방안 있는 잔여를 park하면 완료 차단(재현).
  [무게] 중. [의존] WS0-T2.

### WS3 — 관제탑 컨텍스트 로트 (명제 D)

- **WS3-T1 · 오케스트레이터 컨텍스트 회계** — ✅ **완료 (2026-07-06, wi_2607068bo · commit 1e79d04)**
  [변경] 메인 루프에 경량 컨텍스트 회계(라운드 수·spawn/collect 서사 크기 proxy) + 임계치.
  [파일] `autopilot-loop.ts`(post_cost 인접, `:307-333`)
  [검증] 임계치 초과 시 신호 발화(합성 긴 run).
  [무게] 중.
  [상태] 구현됨: `readContextPressure`(디스크 파생 프록시 = `2*(decisionCount+nodeCount)+postCost`, `CONTEXT_PRESSURE_THRESHOLD`, 신규 stored counter 없음) + additive-optional `ContextPressureSignal`을 `RecordResultOutcome`/`NextNodeResult`에 부착(임계 미만이면 byte-identical). `computePostCost` 헬퍼 추출로 중복 제거. ac-1·ac-2 fresh 증거 pass.

- **WS3-T2 · 경계 자동 handoff/reset** — ✅ **완료 (2026-07-06, wi_2607068bo · commit 1e79d04) · 단 접근 재정의됨(아래 [상태])**
  [변경] 프롬프트 규율 의존을 코드로 대체 — 컨텍스트 압력 경계에서 자동 checkpoint→handoff로 관제탑을 fresh context로 리셋(그래프는 이미 디스크에 있음).
  [파일] `autopilot-loop.ts`, `skills/handoff`
  [검증] 긴 run이 경계에서 실제로 리셋되며 그래프 무손실 이어감.
  [무게] 무거움. ← **컨텍스트 로트의 진짜 수리.** [의존] WS3-T1.
  [상태] **위 [변경]의 "checkpoint→handoff→reset" 프레이밍은 구현 중 사용자가 기각**(강제 중단·새 세션 유도가 의도 아님). 실제 산출물 = **서브에이전트 적극 위임 + 보고 체계**(§4-9): 임계 크로싱 시 **edge-triggered `ReportDirective`**(디스크 band-artifact 존재를 latch로 → 매 라운드 재발화 없음) + `assembleProgressReport`(decisions.jsonl+autopilot.json 결정적 합성, `collectRetroContext` 확장·`projectRetroNarrative` 재사용, fail-open distinct degraded 상태) → 드라이버가 fresh 요약 subagent를 spawn해 누적 서사를 shed. **세션 리셋/강제 중단 없음**, `autopilot_id` 유지. 파일 = `autopilot-loop.ts` + **`skills/autopilot`**(`skills/handoff` 아님 — reset 프레이밍 폐기). 잔여(수용): shed 실행 여부를 구분하는 on-disk observability 신호 없음(SKILL.md 명시). ac-3·ac-4·ac-5 fresh 증거 pass.

- **WS3-T3 · 역할 분리 실측 가드(테스트)**
  [변경] 오케스트레이터가 콘텐츠 생성을 인라인하지 않음을 확인하는 테스트/가드.
  [파일] `autopilot-dispatch.ts`, tests
  [검증] 가드 테스트 green.
  [무게] 경량.

### WS4 — 코드 품질 효능 + gardening (명제 E·I)

> **프레이밍 (명제 I).** 이 워크스트림이 백로그에서 가장 inward하다 — "ditto 자기 루프가 CodeQL/fitness를 호출하나"로 진단됐다. 교정: **효능감의 주체는 ditto가 아니라 P의 개발자다.** health-delta는 P의 언어/스택에서 P의 개발자가 "내 코드가 나아졌다"를 느껴야 가치다. ditto의 TS에서만 도는 신호는 무가치. 따라서 아래 모든 검증은 P₀(ditto)에 더해 **non-ditto 타깃(boxwood 등) 최소 1회**를 요구한다.

- **WS4-T1 · fitness snapshot + 변경당 health delta를 루프에 배선**
  [변경] 루프가 CodeQL/fitness를 호출 안 하는 구멍 메움 — 변경당 assurance snapshot 기록 + **before→after 단일 "코드 health delta" 수치**를 사용자에게 노출. **신호는 CodeQL 지원 언어 내에서 일반화 가능해야 함**(ADR-0006 CodeQL 단일 엔진은 지원 언어에 **bounded** — 임의 스택 아님; 'language ledger'는 glossary 협상 스키마지 stack coverage 아님, P0 dialectic 정정). 미지원 스택(PHP/Scala/Dart/Lua/R 등, `codeql/doctor.ts:41-42` fail-closed)엔 health-delta fallback 신호 필요 여부를 선검.
  [파일] `autopilot-loop.ts`, `fitness.ts:27-146`, `drift.ts:57-162`
  [검증] autopilot run 후 snapshot 존재; `fitness drift`가 실데이터 반환; delta 수치 표시 — **ditto(TS)와 non-ditto 타깃 양쪽에서**(신호가 스택에 갇히지 않음 실증).
  [무게] 무거움. ← **ACG 효능감의 직접 수리 (P의 개발자가 주체).**

- **WS4-T2 · tidy behavior-lock 정직화**
  [변경] L1/L2 provider 미배선으로 fail-open인 것을 배선하거나 광고된 bar를 정직하게 하향.
  [파일] `src/acg/tidy/behavior-lock.ts`, `l2-differential.ts`, ADR-0017
  [검증] non-dataflow refactor에 behavior-preservation 증거가 실제로 붙거나, 계약이 실제 능력과 일치.
  [무게] 중~무거움.

- **WS4-T3 · 코드베이스 온톨로지 전제 — Glean/pre-compute 조사** *(코드 없음·연구)*
  [변경] 사용자 제공 자료 조사(Meta Glean, pre-compute, code indexing). 산출: 온톨로지 구축 여부/방식 결정 + "**P의** 코드베이스가 먼저 좋아야 하는가" 판단(대상은 ditto 코드가 아니라 설치된 프로젝트 — 명제 I). 온톨로지가 임의 스택에 구축 가능한지가 핵심 제약.
  [근거] engineering.fb.com/2024/12/19 Glean, github.com/facebookincubator/Glean, glean.software/docs/angle
  [검증] 결정 문서(ADR 후보) — 채택/기각 + 철회조건.
  [무게] 연구 / 코드 변경 없음 → **아무 때나 병렬 착수 가능.**

- **WS4-T4 · 지속 gardening 루프 + TIDY 분리**
  [변경] 변경당 ACG를 넘어 주기적 gardening 패스(구조 전용, Tidy First로 기능과 분리 커밋) 설계.
  [파일] `autopilot-tidy.ts`, ADR-0017 인접
  [검증] gardening 패스가 구조 변경만 담은 별도 커밋을 냄.
  [무게] 중~무거움. [의존] WS4-T2.

### WS5 — 성능·비용 (명제 F)

- **WS5-T1 · 싼 spawn 모델 다운티어링**
  [변경] per-agent 모델 pin 부재를 이용 — sweep angle / axis judge 수십 spawn을 싼 모델로, producer/opponent/synth는 강한 모델 유지.
  [파일] `agent-variants.ts`, `opponent-router.ts:43-53`
  [검증] run당 토큰/시간 측정 전후 비교(품질 회귀 없음 확인).
  [무게] 중.

- **WS5-T2 · 진짜 additive 변경용 싼 레인** *(독립 — §10-B: reconcile 대상 부재)*
  [변경] plan 닫기 전 필수 sweep(23 cat, breadth-full)이 지배 비용 — 증명된 additive 변경에서 breadth를 full 카테고리 밑으로 좁힘(현재 설계상 안 좁혀짐).
  [파일] `coverage-loop.ts:129-133`, `coverage-taxonomy.ts:279-282`, `relevance-judge.md:20`
  [검증] additive 변경에서 열린 카테고리 수·spawn 수 감소(품질 게이트 유지).
  [무게] 중~무거움. [의존] 없음(파일 분리, A2/ACG 레인). ⚠ **§10-B 정정**: 지목했던 `wi_26062227h`는 스토어에 없고 그 far-field 재설계는 이미 `wi_2606258zu`+`wi_260625l0v`(둘 다 done)로 실현됨 — '합쳐서 진행' 지시 폐기, 독립 진행.

- **WS5-T3 · 병렬화 감사**
  [변경] map-parallel/reduce-serial 경계 최적성 확인 + 다른 serial 경로 발굴.
  [파일] `coverage-manager.ts:16`, `skills/autopilot/SKILL.md:26,38-39`
  [검증] 감사 보고 + 개선 후보.
  [무게] 경량~중.

---

## 4. 우선순위·시퀀싱 (prism 진행중 기준 재시퀀싱, 2026-07-06)

P0 아키텍처 검증 완료(§8 dialectic + §9 pre-mortem). **WS-PRISM(원안 P3)이 앞당겨져 `wi_260705lc8`로 진행 중** — 나머지 워크스트림을 prism 병렬 기준으로 재시퀀싱한다. 이 재시퀀싱은 3-축 fresh-context 적대 검증(§10: 파일-충돌 / 커버리지 / 의존-시퀀스)으로 초안을 압박·교정한 결과다. Q3 유지 — 설계·계획만, 코드 착수는 사용자 허가 후.

> **원안 P0~P4 가치-단계 프레이밍은 §10 감사가 뒤집었다** — P1 "출혈 멈춤"의 병렬 가정은 과대(공유 파일에서 직렬), WS0-T0는 side-parallel이 아니라 **임계경로 루트**, Track C는 prism과 무충돌인 태스크 ~5개를 잘못 결박. 아래가 교정본이다. (P0~P4 값-단계 용어는 §2·§9의 기존 참조 보존용으로만 유지.)

prism-now(`wi_260705lc8`) 실측 파일 footprint(§10-A) = `interview-driver.ts`·`tech-spec.ts`·`skills/tech-spec→prism/*`·`cli/index.ts`(서브커맨드 등록·부분)·`prism-*`·`bin/ditto`. **예약**(설계상 잡히나 아직 git-clean, WI in_progress라 성장 가능) = `autopilot-loop.ts:150-166`·`tech-spec-state.ts`·`skills/deep-interview/*`.

### 4.1 실행 트랙 — 의존/파일 기반 (무엇이 무엇을 막나)

| 트랙 | 태스크 | 성격 | 공유파일·주의 |
|---|---|---|---|
| **B · 척추 (임계경로 루트)** | ~~WS0-T0~~ ✅ **DONE** · ~~WS0-T1~~ ✅ **DONE**(둘 다 main `faf739f` pushed) → 다음 spine = **WS0-T2**(고아 draft 차단) | prism과 파일 완전분리(§10-C1) → 조기 랜딩 완료 | 스키마 split + projection 랜딩됨(`work-item.ts`·`work-item-project.ts`·`work.ts`). WS0-T1 dual-base 브릿지라 **WS0-T4 마이그레이션 후 브릿지 은퇴**. A1이 아직이면 이 랜딩분 위에 얹을 것. |
| **A1 · AC-품질 (단일 직렬, 병렬 금지)** | WS-ACQ-T1→T2 · WS1-T5→WS-ACQ-T3 | 네 태스크가 한 워크스트림 | `gates.ts`·`work-item.ts`·`completion-contract.ts`·`verify/SKILL.md`·`verifier.md`·`intent.ts` 공유 → 서로 직렬. B와 `work-item.ts`/`completion-contract.ts` 조율(§10-c). |
| **A2 · 병렬-안전 (파일 분리)** | WS-HND-T1·T3 · WS3-T3 · WS5-T1·T3 · WS4-T2→T4 · WS4-T3 · WS5-T2 · WS1-T3 · WS2-T3 · WS2-T1 | 상호·prism 무충돌 → cross-PC 분산(§4.2) | WS2-T1 `gates.ts:815-884`는 A1의 141-158과 다른 리전(머지 가능하나 통합주의). WS2-T3은 `cli/index.ts` hotspot. |
| **LOOP · autopilot-loop 조율 (prism과 병렬)** | WS3-T1→T2 · WS4-T1(=`wi_260615lj6` 재개) | prism이 `autopilot-loop.ts` 안 건드림(§10-F) → **prism 게이트 아님, 병렬 가능** | `autopilot-loop.ts`·`fitness.ts`·`drift.ts` 내부 직렬. ⚠ prism 예약리전 150-166 — 머지 시 확인. |
| **C · 진짜 prism 충돌만 (prism 랜딩 대기)** | WS1-T1 · WS1-T2 · WS-PRISM residual T2·T4 · WS-HND-T4 | `interview-driver.ts` 충돌 or prism 소유 | WS-HND-T4 결속 dep = WS-PRISM-T0/§9-B1(digest 은퇴 원자성), **WS0-T0 아님**(흡수처 knowledge tier는 기존·committed). WS-HND-T1(A2) 선행. |
| **D · WS0-T0 랜딩 대기** | ~~WS0-T1~~✅→WS0-T2→T3→T4 · WS-HND-T0→T2 · WS2-T2·T4 · **WS-PRISM-T5** | 전부 Record(WS0-T0) 의존; **WS0-T4는 WS0-T1 dual-base 브릿지 은퇴도 겸함** | **WS-PRISM-T5 이동(§10-a): "정련 의도→Record 이관"이라 WS0-T0 필요 — 원 [의존]에 WS-PRISM-T0만 있어 잘못 Track C에 있었음.** |

### 4.2 cross-PC 병렬 디스패치 레인 (파일 분리 = 무충돌 머지)

다른 PC는 커밋된 main을 `git pull`(prism의 미커밋 작업은 안 옴)해 **파일 분리 레인**을 독립 WI+브랜치로 구동→push→머지. 분리이므로 머지 무충돌. 공유트리 머신(prism+계획 세션)에선 prism dirty와 겹치는 코드 레인을 돌리지 않는다.

| 레인 | 태스크 | 분리 파일셋 | 포장 |
|---|---|---|---|
| **P** (진행중·공유트리) | prism `wi_260705lc8` | interview-driver·tech-spec·skills/prism·prism-*·cli/index(부분) | — |
| **SPINE** (PC-2·임계경로) | WS0-T0 (스키마 split 먼저) | work-item-store·schemas/work-item·schemas/autopilot·completion-contract·.gitignore | 신규 WI, heavy, 자체 pre-mortem |
| **LOOP** (PC-3) | WS3-T1→T2 · WS4-T1 | autopilot-loop·fitness·drift | `wi_260615lj6` 재개, 내부직렬 |
| **HYG** (PC-4) | WS-HND-T1·T3 · WS3-T3 · WS5-T1·T3 · WS1-T3 | handoff-store·user-prompt-submit·session-pointer·active-node-lease·autopilot-dispatch·agent-variants·opponent-router·coverage-manager·question-context·interview-state | 다수 소형 WI 또는 묶음 |
| **ACG** (PC-5) | WS4-T2→T4 · WS5-T2 | src/acg/tidy·l2-differential·autopilot-tidy·coverage-loop·coverage-taxonomy | `wi_260615t8o` 재개, ⚠prism이 coverage 엔진 재사용(임포트)—시맨틱 조율 |
| **RESEARCH** (아무데나) | WS4-T3 Glean | 코드 없음 | 위임 가능 |

**A1(AC-품질)은 별도 동시 PC가 아니다** — SPINE과 `work-item.ts`·`completion-contract.ts`를 공유하므로 SPINE 스키마 split *뒤에* (같은/하류 PC에서) 직렬. PC 수가 적으면 HYG·ACG를 한 PC에서 순차로 접어도 무충돌(파일 분리라 아무 순서나 안전).

**cross-레인 직렬화 hotspot (반드시 조율):**
1. **`cli/index.ts`** — prism + 서브커맨드 추가 레인 전부(WS0-T1 `work list`·WS2-T3·WS-HND). +`skills.surface.test.ts`·`surfaces.json` 카탈로그. 서브커맨드 등록은 additive지만 인접 라인 충돌 가능 → 등록 블록만 마지막에 순차 반영.
2. `schemas/work-item.ts`·`completion-contract.ts` — SPINE ↔ A1.
3. `gates.ts` — A1 내부(+WS2-T1 다른 리전).
4. `autopilot-loop.ts` — LOOP 내부 + prism 예약.

### 4.3 임계경로·우선순위 원칙

- **임계경로 = WS0-T0→T1→T2→WS2-T4**(WS0 내부 체인이 지배, Track A 아님). ⇒ **spine-first가 최상위 원칙** — WS0-T0를 조기 랜딩하도록 적극 구동(side-parallel 방치 금지). Track A 병렬 churn이 WS0-T0 주의를 굶기면 전체 경로가 늘어난다.
- **WS-ACQ(AC품질) "시급 최우선"은 유지되나 blind 선착이 아니다** — B의 스키마 split과 `work-item.ts`/`completion-contract.ts`를 공유하므로, split을 먼저 랜딩하거나 A1 추가분(oracle class·evidence-kind)을 보존하도록 설계해야 재작업이 없다.
- **installer-value-first는 최상위 원칙이 아니다** — P4 내부(WS4 health-delta vs WS3 context-rot)의 tiebreak일 뿐, **boxwood 스택 확인(Q10) 게이트**(미확인 스택이면 WS4-T1 purpose-2 실증 불가). spine-first를 넘지 않는다. WS3(관제탑 context rot)은 사용자 최상위 불만이라 의존 없이 즉효 가치가 있다.

> **주의(명제 I 유지).** 위 트랙은 파일-의존으로 결정되나, prism 랜딩 이후의 가치 우선순위(C/D 내부)는 여전히 "ditto 쓰다 아픈 순서" 편향 가능 — 설치자 관점(§2.7 E축 first-run)으로 재검 대상.

---

## 5. 커버리지 매트릭스 (의도 무축소 증명)

`quality-issues.md`의 **모든** 항목 + 추가 이슈 → 태스크. 누락 0.

| 원문 항목 | 태스크 |
|---|---|
| **추가 지적: "구현했지만 미배선" 반복 = AC 설계·검증 품질 저하(시급)** | **WS-ACQ (T1·T2·T3), WS1-T5** |
| **추가 지적: 핸드오프 은퇴 안 됨·섞임·로컬 WI결박·원격 git오염** | **WS-HND (T0·T1·T2·T3)** |
| DITTO 전반: 관제탑 context rot | WS3 (T1·T2·T3) |
| 의도: 조용한 축소/왜곡 | WS1-T2 |
| 의도: 사용자가 선택지 고르며 ditto 방향 따름(확신 낮음) | **WS-PRISM**(발산·가치), WS1-T1·T3 |
| 의도: 질문 거듭할수록 편향 / live DAG 원함 | WS1-T1 |
| 의도: 질문 맥락 불투명 → 아무 답 → 품질저하 | WS1-T3 |
| 의도: 오파악 → 회귀/재작업/갈아엎기(구현·검증까지) | **WS-PRISM-T3**(가치·전제), WS1-T5, WS-ACQ-T3, WS2 |
| **대화 심화: 바이브→프로덕트급 의도 (ditto의 moat)** | **WS-PRISM (T0~T5)** |
| **대화 심화: prism가 tech-spec을 진화·대체 · 의도 표면 3단계 모델** | **§2.6, WS-PRISM-T0** |
| **대화 심화: 설계/기획 산출물 신선도 민감 → 구현 후 은퇴** | **WS-HND-T4, §2.6** |
| **대화 심화: 가치 단위=설치된 프로젝트 P, 도그푸딩은 P₀ 시험대(프레이밍 편향 교정)** | **명제 I(§2), WS4 재조준, 전역 검증 규칙** |
| 의도: work item 종속·구현 묶는 설계 재설계 | WS0(관계), WS2-T2, §7-Q2 |
| 표준: 의도 임의 축소(자기완결성 최악) | WS2-T1, WS1-T5 |
| 표준: pre-mortem에도 범위 확산 제어 실패 | WS2-T2, WS1-T4 |
| 표준: 슬라이스 일부만 하고 떠넘김 | WS2-T2·T4 |
| 표준: 방안 있어도 잔여 떠넘김 | WS0-T2, WS2-T4 |
| 표준: 후속 처리도 자기완결성 부족 → 묻힘·인지비용 폭증 | WS0 전체 |
| 표준: 후속/잔여/위험 위해 work item 관계 재설계 | WS0, WS2, §7-Q2 |
| 표준: 경량 경로 이해 못함 | WS2-T3 |
| 표준: 너무 오래 걸림(전반 최적화) | WS5 (T1·T2·T3) |
| 코드품질: ACG 효능감 없음·개선 검증 | WS4-T1 |
| 코드품질: 온톨로지 전제·Glean 조사 | WS4-T3 |
| 코드품질: 지속 gardening·TIDY 분리 | WS4-T4·T2 |
| **추가: 백로그 관리 부재** | WS0 (T1~T4) |

---

## 6. 기존 열린 work item과 reconcile (중복 금지)

| 기존 WI | 관계 |
|---|---|
| `wi_26062227h` (far-field pre-mortem 재설계) | ⚠ **§10-B: 스토어에 부재(유령).** 그 far-field 재설계는 이미 `wi_2606258zu`+`wi_260625l0v`(done)로 실현됨 — **재개할 실체 없음.** WS5-T2는 독립 진행(재개 아님). |
| `wi_260628sx5` (GitHub 백로그 tech-spec) | ⚠ **§10-B: 스토어에 부재(완전 유령).** 참조 대상 WI 자체가 없음 — 실질은 이미 shipped(spec+2 ADR+코드)로 흡수. WS0-T3·T4는 그 shipped 결정(보드→ditto read, 잔여→보드)을 **역전**하는 새 결정(§7-Q1). |
| `wi_2606276nc` (worktree ledger reason 빈문자열 버그) | 무관한 구체 버그 — WS0 백로그의 **실사용 예시**. 그대로 항목으로 편입. |
| `wi_260624a6d`·`wi_260625mrf`·`wi_260623rbb` | 무관. 별개 유지. |

**열린 WI housekeeping (§10-B 실측 `ditto work status`):**
- `wi_260629skv`(draft, push 게이트 *기획*)는 `wi_260629i9c`(done, push-gate *기능화*)에 **superseded** → 고아 draft 종료(abandon) 권장.
- `wi_260626099`(install 문서 엔드유저 재편)는 WS2-T3(경량경로/verify 문서)와 **대상이 다름** → 독립 install-doc 항목으로 취급(WS2-T3 흡수 아님).
- `wi_260615lj6`(in_progress)=WS4-T1(LOOP 레인 재개), `wi_260615t8o`(in_progress)=WS4-T2(ACG 레인 재개). `wi_2607026qs`·`wi_26070300p`는 별개 E2E 스레드(이 백로그 무관).

---

## 7. 결정된 것 + 남은 미해결 질문

### 사용자 결정 (해소됨 — 설계에 반영)
- **Q1 → 공유 tier가 백로그 집.** SoT = ditto 공유 백로그 tier(committed). GitHub 칸반 = 지금처럼 활용 가능한 두 번째 projection, SoT 아님. ADR-20260628 D3 정정 대상. (§2.5)
- **Q2 → 근본 분리.** 기록(영속·공유)/실행(일회성·개인)을 스키마 수준으로 가름. 임시 처방 아님, 10년 설계. (§2.5, WS0-T0)
- **Q3 → 설계만, 착수 보류.** 코드 미변경. 다음 단계 = §2.5 아키텍처의 dialectic-review + pre-mortem 검증(P0).
- **Q4 → 다이제스트/포인터만.** Record엔 verdict + 증거 요약/해시만 committed, 원 traces/runs는 개인tier. "증거 없는 verdict 불신"(완료 게이트) 긴장의 감사 갭은 **Q11(재현레시피+해시)로 해소** — 저장이 아니라 재현으로. (§2.5)
- **Q5 → committed SoT → 파생 뷰 투영 (에이전트 결정, P0 방향정정).** memory 패턴 재사용하되 방향은 **committed tier가 SoT(per-entity 불변파일)·gitignored가 파생 read 뷰**(`memory-store.ts:6-10`). 초기 서술의 개인→공유 방향은 P0 dialectic에서 뒤집어 정정. 재생성 결정적이라 실질 가역, 새 저장 메커니즘 발명 안 함. (§2.5)
- **Q6 → 에이전트 소유.** WS0-T0 랜딩 직후 백업+롤백 동반해 가역 이관. 시점·절차는 구현 세부(§4-8).
- **Q8 → prism.** 의도 정련 표면 이름 = **prism**(코드네임 FORGE 대체). "tech-spec"의 수렴·문서화 연상이 net-new(발산+가치, §2.7)를 가려서 기각. prism = 드러내다+발산 은유, 충돌-안전. 가역. tech-spec→prism 진화·대체는 WS-PRISM-T0. (§2.6)
- **Q9 → 기본값 확정.** front-door = prism(바이브·고가치·고모호) → deep-interview(수렴→AC) → autopilot; 경량은 작고 가역에. prism→deep-interview 자동 이관 + 사용자 명시 진입 둘 다 허용. UX 세부는 WS-PRISM 실물에서 정련.
- **Q10 → boxwood 고정.** 명제 I "non-ditto 타깃 최소 1회"의 실증 대상 = boxwood(이미 install dogfood 타깃). **선정 기준**: 비-ditto 실설치 + 실제 여정 有 + 설치 개발자 관점 가치 확인 가능. ⚠ **boxwood 스택 미확인**(이 머신에 없어 검증 못 함) — TS면 "value가 설치자에 닿음"(purpose 1)은 실증하나 "ACG 신호가 지원 언어 전반 일반화"(purpose 2, 명제 I가 CodeQL 지원언어로 축소됨)는 지원언어 다른 타깃이 추가로 필요. WS 착수 시 boxwood 언어 확인 후 결정.
- **Q11 → 재현레시피 + 해시 (P0 dialectic 재개봉 해소).** committed Record엔 opaque digest 대신 **검증 가능한 증거**: (i) verdict (ii) 재현 명령·표면(비-저자가 그대로 재실행) (iii) 캡처 증거 해시. 증거를 *저장*하는 게 아니라 *재현 가능*하게 — charter 증거-closure 정합, 커밋 가벼움. (§2.5·WS0-T0)

### 남은 미해결 질문 (착수 전 결정)
- **Q7 — 원격 핸드오프 전송 채널.** WS-HND-T2. git 커밋 방송을 무엇으로 대체하나 — **선택**: (a) 전용 git ref/branch(수신자 주소·소비 시 삭제), (b) working tree 밖 per-recipient 경로, (c) git 외부 채널. 팀 인프라·정책 결정. → WS-HND-T2 도달 시 결정(조기 결정 rot 회피).

(Q10·Q11은 위 "해소됨"으로 이동. §2.7 발산 기계적 상한도 설계 완료 — P0가 남긴 열린 결정 3개 모두 닫힘. Q7만 WS-HND-T2까지 정당 연기.)

### 확정 우선순위 (질문 아님 — 사용자 지적으로 격상)
- **AC 설계·검증 품질이 시급 최우선.** "구현했지만 미배선" 출력이 그 증거 — WS-ACQ(§3, 신설)로 P1 격상. 사용자 확인 불필요, 이미 지시됨.

(그 외 태스크의 경로·구현 세부는 에이전트가 책임진다 — §4-8.)

---

## 8. P0 아키텍처 검증 — dialectic-review 결과 (2026-07-06)

3역 dialectic(Producer=Claude / Opponent=Codex 교차모델 / Synthesizer=Claude), 초점 = §2.5 기록/실행 분리 · WS-PRISM-T0 · 명제 I. 코드 미변경(Q3).

**verdict = revise.** 방향은 선다 — 반론이 아키텍처를 무너뜨리지 못했다(재사용 논거 유효, Q3 설계-only 옳음). Producer·Opponent가 **독립적으로 같은 CRITICAL에 수렴**(projection 방향 역전)한 것이 최강 신호. 착수 전 문서에서 고칠 것을 아래처럼 반영했다.

**수용된 반론 → 반영한 required_edits (근거 확인됨):**
| 반론 | 심각도 | 오라클 | 반영 |
|---|---|---|---|
| projection 방향 역전(memory는 committed=SoT/gitignored=파생) | CRITICAL | `memory-store.ts:6-10` | §2.5 "왜 projection…" 재작성 + 불변식2 + 용어통일 |
| 상태모델 미명세(append-only reduction ≠ 가변 lifecycle) | HIGH | `memory-event.ts`·`memory-reduce.ts` | §2.5 "상태·정합·트랜잭션 모델" 신설 |
| cross-tier 트랜잭션 홀(단일 원자교체 상실) | HIGH | `work-item-store.ts:217-243` | 동상 + WS0-T0 검증기준 |
| digest-only 비-저자 감사 갭 | HIGH | `charter.ts:16` | Q11로 재개봉(사용자 결정) |
| 범주오류: language-ledger는 glossary 스키마 | HIGH | `language-ledger.ts:35-43` | 명제 I·WS4-T1 정정, CodeQL=bounded 명시 |
| 발산 기계적 상한 없음 | HIGH | `tech-spec/SKILL.md:67` | §2.6 대체조건에 relevance-gate+cap≤5+근거필수 |
| replace-in-place compat 미열거 | HIGH | `cli/index.ts:68`·`tech-spec-template.test.ts:54-62` | WS-PRISM-T0 검증에 compat 표면 목록 |
| work item 카운트 65→63 | factual | `.ditto/local/work-items/*/work-item.json`=63 | 전역 정정 |

**정당하게 기각된 반론(gate 안 함):**
- GitHub SoT 역전 → 문서가 이미 ADR-20260628 D3 정정을 공개하고 새 ADR로 라우팅, 사용자 Q1 승인(ADR-0020 정상 경로). novel 아님.
- "저사용은 형태 탓" 베팅 → 이미 "검증 대상 가정"으로 명시(§2.6), 비회귀 요구가 흡수. novelty 실패.
- "3 마이그레이션 P0 번들" → 전제 오류: P0는 설계-only(§4), 마이그레이션은 P2/P3 분산 + 각 T0가 개별 pre-mortem 선행.

**P0가 남긴 열린 결정 → 전부 닫힘(2026-07-06):** Q11(비-저자 감사) → 재현레시피+해시(§7)·§2.7 발산 기계적 상한 → relevance-gate+admissible-only+cap≤5 설계(§2.7)·Q10(non-ditto 타깃) → boxwood 고정(스택 미확인 flag, §7). WS0-T0/WS-PRISM-T0 상세설계 착수 가능 상태. **P0 pre-mortem 절반도 완료(§9, 2026-07-06)** — CRITICAL 3(A1·A2·B1)+HIGH 5+MEDIUM 6 결박·반영, seam #1 오채점 반증. B1(spec 은퇴↔digest 게이트)이 WS-HND-T4·WS-PRISM-T0 조정 요구하는 신규 unmitigated 갭.

**후속: §2.5 소비자 의존성 스윕(2026-07-06).** 사용자 지적(세션 핸드오프 work item 의존)의 일반화 — work_item 소비자 6차원 전수. 결과 = §2.5 "소비자 영향 스윕 결과" 소절 + WS0-T0/T4 검증 강화. 핵심: split은 net-new committed tier 추출이며 지배 위험은 LEAK-RISK(~20 Run 생산자가 commit될 디렉터리에 write) + in-place 상태변경 전면 BREAK + `completion-store` raw-evidence mirror seam. 증거모델·memory는 이미 타깃 tier에 정렬. change-contract.json·e2e-verdicts tier 귀속은 WS0-T0 값 결정으로 남김.

---

## 9. P0 아키텍처 검증 — pre-mortem 결과 (2026-07-06)

§8 dialectic-review의 나머지 절반. 초점 = §8과 동일(§2.5 기록/실행 분리 · WS0-T0 · WS-PRISM-T0 아키텍처 + 그에 의존하는 형제 워크스트림 seam). 코드 미변경(Q3).

**방법.** 3개 **fresh-context 슬라이스**(§2.5 데이터/트랜잭션/마이그레이션 · WS-PRISM-T0 진화·대체 · cross-workstream seam)에 병렬 위임. **anti-SLOP 계약 강제** — 모든 위험은 file:line 증거로 결박, 결박 못 하면 기각([[project_premortem_redesign]]: LLM pre-mortem은 없는 위험을 지어냄). 설계 문서가 이미 컨텍스트에 있는 main agent의 자기서사 편향을 피하려 fresh context에서 grounding(charter §4-9).

**최강 수렴 신호 = seam #1 오채점 반증.** §2.5·cross-seam 두 슬라이스가 **독립적으로** "seam #1(completion-store raw-evidence mirror)이 최고 위험·digest-only 위반"이라던 초기 판정을 코드로 **반증**했다 — 복사 대상은 `evidenceRef[]`(`common.ts:76-88`, raw 필드 없음)라 이미 digest-safe이고, 문서 line 114가 스스로 그렇게 진술해 **내부 모순**이었다. anti-SLOP이 작동해 "노력 배분을 왜곡하는 과대 위험"을 걷어낸 사례(§2.5 소비자 스윕·§8 §2.7에 정정 반영). dialectic이 projection 방향 역전에서 독립 수렴한 것과 같은 종류의 신호.

**verdict = revise(§8과 정합).** 방향은 여전히 선다 — pre-mortem이 아키텍처를 무너뜨리지 못했다(전부 partial/unmitigated 정합 갭이지 방향 오류 아님). 착수 전 문서에 반영한 발견은 아래.

**결박된 발견 → 반영(severity 순):**

| # | 심각도 | 발견 | 오라클(file:line) | 완화 상태 | 반영 위치 |
|---|---|---|---|---|---|
| A1 | CRITICAL | 교차-tier 다-파일 쓰기에 트랜잭션 없음 — done Record는 committed인데 Run/증거 부분·미기록인 크래시 창 | `work-item-store.ts:222-243`·`fs.ts:105-123`(atomicWrite=파일 1개)·`work-item-handoff.ts:306-341` | partial(line 104 식별, 메커니즘 미설계) | WS0-T0 검증(done 이벤트 append를 마지막 단일 원자쓰기로) |
| A2 | CRITICAL | 통합 디렉터리 순진 commit → Run leak + create()가 evidence/ eager 생성해 경량 Record도 Run 스캐폴딩 강제 | `work-item-store.ts:201`·~20 생산자·`.gitignore:477` | partial(WS0-T4 leak-test 有, 미래 생산자 가드·분해 규칙 미명세) | WS0-T4(물리적 다른 base 경로) |
| B1 | CRITICAL | **spec 산문 은퇴(WS-HND-T4) ↔ specDigestStale 게이트 → autopilot 영구 block** — 두 워크스트림 미조정 | `autopilot-loop.ts:150-166`·`intent.ts:25` | **unmitigated** | WS-HND-T4·WS-PRISM-T0(은퇴=digest 해제와 원자적) |
| C1 | HIGH | Stop 면제를 'Run 부재'에 걸면 무거운 미검증-종료까지 빠져나가 게이트 무력화 | `stop.ts:902-913`·`:882-887` | partial(면제 필요 명시, 양성 마커 미설계) | WS0-T0(ii)(명시 경량 마커) |
| C2 | HIGH | WS-HND durable 흡수 훅↔에이전트 3중 충돌(훅 저작불가·WI-less 타깃없음·타이밍) | `handoff.ts:31-51`·`handoff-store.ts:269-280`·`user-prompt-submit.ts:300,307` | partial(필요 명시, 메커니즘 미해소) | WS-HND-T0(b)(흡수를 작성 시점 promote로) |
| C3 | HIGH | 파이프라인 역전 — deep-interview가 tech-spec 안에 중첩·둘 다 병렬 종단, intent 컴파일/bootstrap 소유권 미명세 | `tech-spec.ts:574,572,613`·`interview-driver.ts:427`·`SKILL.md:123,169` | partial(WS-PRISM-T5 목표만) | WS-PRISM-T0(intent 단일 writer 명시) |
| C4 | HIGH | 이름 결박이 compat 목록보다 넓음(surface 카탈로그·skills.surface.test toBe(11)·config 키·doctor 필드·digest 에러 문자열·트레일 경로) | `surfaces.json`·`skills.surface.test.ts:16-38`·`ditto-config.ts`·`intent-quality-doctor.ts:55-176`·`autopilot-loop.ts:164-165` | partial(목록 불완전) | WS-PRISM-T0 검증(6군 추가) |
| C5 | HIGH | github posted_decision_ids Run-cadence Record 쓰기 → single-writer append 붕괴(worktree 동시) | `github-progress.ts:196-197`·`work-item.ts:173`·`work-item-store.ts:222-244` | unmitigated(seam #6, HIGH로 격상) | WS0-T0(iv)(Record→Run 이동) |
| D1 | MEDIUM | append-only가 close()/R1 terminal 배타성 상실 + handoff 직접 write 우회 | `work-item-store.ts:265-269`·`work-item-handoff.ts:324-341` | partial | WS0-T0(i)(single-writer terminal 게이트) |
| D2 | MEDIUM | archive() 디렉터리 통째 rename ↔ committed Record git 추적 충돌 | `work-item-store.ts:415-431` | unmitigated | WS0-T4(archive 생애주기) |
| D3 | MEDIUM | ADR-20260628 D3 정정 미랜딩 과도기 창(코드·ADR·설계 3자 불일치) | `ADR-20260628-github-backlog-sot.md:18,42` | partial | WS0-T3(정정 ADR 원자 동반) |
| D4 | MEDIUM | R축 "무발명" 과대 — id/topic만 재사용, readiness lens·평가 필드 net-new; 병렬 taxonomy 드리프트 | `coverage-taxonomy.ts:21-26,38-131` | partial(line 197 vs 345 내부 모순) | §2.7 R축·함의 정정 |
| D5 | MEDIUM | 발산 상한의 "방향 admissibility" 술어 net-new(pre-mortem 브랜치용과 구분) | `SKILL.md:67`·`coverage-manager`(admissible=브랜치용) | partial | WS-PRISM-T1(별도 결박) |
| D6 | MEDIUM | 저사용 반복 — prism이 tech-spec보다 엄격히 무거움(저사용 자체는 코드 미확증) | `tech-spec/SKILL.md` 구조 | partial(route-by-weight가 소형만 방어) | WS-PRISM-T0(발산 opt-out) |

**anti-SLOP으로 기각/강등된 후보(코드로 결박 실패 또는 반증):**
- **seam #1 raw-evidence leak "최고 위험"** — 반증(evidenceRef digest-safe, 위 수렴 신호). 별도 CRITICAL 아님, A1에 흡수.
- **evidence-store raw 저장 leak** — Record로 복사되는 건 evidenceRef 포인터뿐, A2에 흡수.
- **WS-HND-T0 ↔ WS0-T0 순환 의존** — 단방향(WS0-T0 무의존). 참조 분리는 스키마가 이미 `autopilot_id`/`work_item_id` 보유(발명 불요). 진짜 문제는 순환 아닌 C2 흡수 메커니즘.
- **sweepStaleActive가 durable 결정 삭제** — sweep은 archive move(삭제 아님). 소실은 "공유 tier promote 안 됨"이라 C2에 흡수(중복 계상 방지).
- **deep-interview 수렴 계약이 발산으로 오염** — deep-interview는 tech-spec/prism에 코드 의존 0, zero-diff 가드(`SKILL.md:169`). 실 위험은 오염 아닌 파이프라인 역전(C3).
- **surface count `toBe(46)` 파손** — rename은 카운트 불변, 생존. 파손은 이름-리스트 테스트(C4)에 흡수.
- **"저사용은 형태 탓" 베팅 오류** — §8에서 이미 정당 기각(novelty 실패), 재론 안 함.
- **malformed 핸드오프가 sweep/consume skip** — 실재하나 §2.5 tier seam 아닌 WS-HND-T1 기존 타깃, 이 검증 범위 밖.

**착수 전제 상태.** P0 = dialectic-review(§8) + pre-mortem(§9) 둘 다 완료. **신규 CRITICAL B1(spec 은퇴↔digest 게이트)은 두 워크스트림(WS-HND-T4·WS-PRISM-T0)이 조정해야 하는 unmitigated 갭**이므로, 그 둘의 T0 상세설계는 이 조정을 명시적 의존으로 물고 착수해야. 나머지는 partial 정합 갭으로 각 T0 상세설계·개별 pre-mortem에서 닫는다. Q3(설계-only) 유지 — 코드 착수는 사용자 허가 후.

---

## 10. 재시퀀싱 적대 검증 — 3축 fresh-context 감사 (2026-07-06)

§4를 prism 진행중(`wi_260705lc8`) 기준으로 재시퀀싱하며, 초안 v1을 3개 독립 fresh-context 적대 감사로 압박했다(charter §4-9: 자기맥락 검증 금지). 모든 발견은 git 상태·file:line·§ 참조로 결박(anti-SLOP). 코드 미변경.

**축 A — 파일-충돌 감사 (실측 git).**
- prism-now 실측 footprint 확정: `interview-driver.ts`(신규 `compileIntent`)·`tech-spec.ts`(finalize 재라우팅)·`skills/tech-spec→prism/*` rename·`cli/index.ts`(서브커맨드 등록)·`prism-*`·`bin/ditto`.
- **C1 확정** — WS0-T0의 5개 파일 전부 git-clean → **prism ⟂ WS0-T0**, 병렬 랜딩 안전.
- **C2 교정(과대·과소 둘 다).** 과대: `autopilot-loop.ts`·`tech-spec-state.ts`·`skills/deep-interview/*`는 실제 clean — ac-6 digest 면제를 게이트가 아니라 `interview-driver.ts` `compileIntent` 안 조건부 `sourceDigest`로 해결. 과소: `cli/index.ts`·`skills.surface.test.ts`·`tests/cli/prism-alias.test.ts` 누락 — 특히 `cli/index.ts`는 서브커맨드 추가 레인 공통 hotspot.
- **C7 교정.** intent *스키마*(`schemas/intent.ts`)·`intent-store.ts`는 clean(안전) → WS1-T5의 AC provenance *필드 추가*는 안전. 그러나 intent *컴파일 오케스트레이션*은 prism이 재구조화(ac-5) → "어떻게 컴파일하나"를 바꾸는 변경은 prism 존과 충돌.

**축 B — 커버리지 감사 (누락 0 규율).**
- §3 태스크 37개(WS-PRISM 6 포함; WS1-T4는 이동 포인터라 태스크 아님) 전수 → 전부 정확히 한 트랙, **누락·중복·하드 미스트랙 0**.
- WS-PRISM COVERED = {T0·T1·T3}(wi_260705lc8 ac-1~7 매핑), residual = {T2·T4·T5}. 단 **T5는 클린 residual 아님** — ac-5가 "이중 컴파일 방지" 절반 담당, 잔여 실체 = "정련 Record 결정의 deep-interview AC 100% 반영"뿐.
- **§6 유령 WI**: `wi_26062227h`(스토어 부재, far-field는 이미 `wi_2606258zu`+`wi_260625l0v` done으로 실현)·`wi_260628sx5`(완전 부재). ⇒ WS5-T2 "합쳐서 진행" stale, §6 reconcile 재개 실체 없음(위 §6 정정).
- **housekeeping**: `wi_260629skv`(draft)=`wi_260629i9c`(done)에 superseded → 종료 권장. `wi_260626099`(install 문서)는 WS2-T3 아닌 독립 항목.

**축 C — 의존/시퀀스 스켑틱 (더 나은 계획).**
- **v1 sequencing does NOT stand → revise.** 교정 4건:
  - **(a) WS-PRISM-T5는 Record 의존 → Track C에서 D로 이동** (missing dep WS0-T0; 원 [의존]엔 WS-PRISM-T0만).
  - **(b) Track A 13-way 병렬 과대** — AC-품질 클러스터 {WS-ACQ-T1·T2·T3, WS1-T5}는 `gates.ts`/`verify`/`verifier`/`intent.ts` 공유 → 단일 직렬. **A1(직렬)/A2(병렬-안전) 분리.**
  - **(c) WS0-T0는 side-parallel 아닌 임계경로 루트** — 조기 랜딩 최우선. +A1과 `work-item.ts`/`completion-contract.ts` 충돌(스키마 split 먼저).
  - **(f) Track C 과결박** — WS3-T1/T2·WS4-T1(`autopilot-loop.ts`)·WS1-T3(`question-context.ts`)는 prism 무충돌 → **LOOP 레인/A2로 해방(prism 게이트 제거).** 진짜 prism 충돌은 WS1-T1/T2·WS-PRISM residual T2/T4뿐.
  - (d) WS-HND-T4 = Track C 유지 정당 — 결속 dep는 WS-PRISM-T0/§9-B1(digest 은퇴 원자성), WS0-T0 아님(흡수처 knowledge tier 기존).
  - (e) installer-value-first = P4 tiebreak, boxwood-stack(Q10) 게이트, spine-first 미초과.

**반영.** 위 교정을 §4(트랙 B/A1/A2/LOOP/C/D + §4.2 cross-PC 레인 + §4.3 임계경로 원칙)·WS-PRISM-T5 [의존]·WS5-T2·§6에 반영. **cross-PC 요구(사용자)**: 파일-분리 레인이 곧 무충돌 머지 단위 — §4.2가 그 partition. Q3 유지 — 착수는 사용자 허가 후.
