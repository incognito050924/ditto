# `ditto memory` 서브시스템 종합 리뷰

> **무엇에 대한 문서인가**: 구현 완료(v0, 옵션 A)된 `ditto memory` 서브시스템을 (1) 동작 정확성, (2) 설계 대비 구현 정합, (3) ditto 하네스 컨셉과의 정합·다른 기능과의 맞물림·방향성, (4) 보안/버그 위험 네 축으로 적대적으로 검토한 결과.
> **소비자**: 이 work item을 이어받는 세션/사람. 후속(§5 push 확대 게이트, 운영 ingest)을 열기 전에 닫아야 할 갭의 판단 근거.
> **작성일**: 2026-06-10 · **work item**: wi_260610s7c
> **검토 방법**: 메모리 소스 15파일 전수 정독 + 통합지점/테스트커버리지/knowledge대조 3개 병렬 조사 + 격리 repo 실측 2건(부록 A). 주장마다 `파일:줄` 또는 실행 로그 인용.
> **검토 대상 커밋 범위**: `f2b9a53`~`42f33f7` (origin/main).

---

## 0. 한 줄 요약

**엔진 척추는 설계 계약(§10)에 충실하게, 결정적으로, 되돌릴 수 있게 잘 구현됐다. 그러나 이 v0를 정당화한 핵심 가치(bootstrap day-1)가 구현에서 절반 단절돼 있고, 쓰기 거버넌스(제안→승인)가 코드로 강제되지 않아 자기승인이 가능하다. 둘 다 후속(push 확대)을 열기 전에 닫아야 한다.**

verdict: **revise (조건부 합격)** — 회귀 위험은 없다(fail-open·되돌림 견고). 하지만 "측정해서 확장하겠다"는 옵션 A의 전제가, 측정하려는 가치가 런타임 경로에서 끊겨 있어 **편향된 데이터를 측정**하게 된다.

| # | 발견 | 심각도 | 축 |
|---|---|---|---|
| F1 | bootstrap이 ingest한 handoff/glossary가 projection에서 제외돼 그래프에 안 나타남(ADR만 남음) | 🔴 High | 정합/방향성 |
| F2 | 본문 검색(`searchEventBodies`, ac-14 핵심)이 런타임 어디에도 배선 안 됨 — 테스트에만 존재 | 🔴 High | 정합/방향성 |
| F3 | propose→approve 권한 분리가 형식적 — agent self-approve 실측 성공 | 🔴 High | 보안 |
| F4 | RATIONALE_FOR 엣지의 `source:` 노드가 dangling — 출처까지 query/path 불가 | 🟡 Med | 동작 |
| F5 | knowledge↔memory 동기화 부재 — bootstrap 1회성, 본문 사본이 drift | 🟡 Med | 정합 |
| F6 | `sensitivity` 하드코딩 'internal' + 전 경로 미사용 → event 본문이 평문 git-tracked | 🟡 Med | 보안 |
| F7 | `approve <eventId>` 입력 미검증 → 약한 path-traversal 표면(append/propose와 비일관) | 🟡 Med | 보안 |
| F8 | 새 용어(event/projection/claim/confidence_kind)가 glossary 미등재 | 🟢 Low | 정합 |
| F9 | 검증 갭: >2 supersedes 체인·scan race·hostile fragment·플래그 비-warmstart 경로 미테스트 | 🟢 Low | 검증 |

---

## 1. 동작 정확성 & 설계 정합성 (ac-1, ac-2)

### 1-1. 잘 된 것 (증거 기반)

설계 §10의 구현-등급 계약이 실제로 코드에 떨어졌다. 다음은 전부 코드로 확인됨:

- **2-tier 저장 (ADR-0013 D2 / §10-1)**: SoT(sources/events)는 `dittoDir(root)/memory/`, 파생(ir/projections)은 `localDir(root,'memory')`. `memory-store.ts:54,97,163,181`에서 경로가 정확히 그렇게 갈린다. 새 gitignore 특례 없이 기존 3-tier 규약이 흡수.
- **이벤트 불변성 + TOCTOU 차단**: `open(path,'wx')`로 존재 시 `MemoryEventExistsError` (`memory-store.ts:115-121`). 변형 없는 append-only가 파일 레벨에서 강제됨.
- **승인 모델 = supersedes 새 이벤트 (§10-2 F2)**: `approveEvent`가 원본을 변형하지 않고 `supersedes`+`status=approved`인 새 불변 이벤트를 append (`memory-project.ts:358-367`). 논리 식별성 = 체인 head.
- **reducer 순수·결정성 (§10-4b)**: `reduceEvents`는 clock/IO/입력순서 의존 없음 (`memory-reduce.ts:38-54`). approved head만 emit, setHash로 freshness 경계.
- **approval invariant를 스키마가 강제**: `approved/rejected ⇒ approved_by+decided_at`, `pending ⇒ approved_by 금지` (`memory-event.ts:45-68` superRefine). 런타임 우회 불가.
- **double-approve fork 차단**: 원본이 영구 pending이라 status 체크만으론 부족 → 이미 supersede한 이벤트가 있으면 `MemoryEventAlreadyDecidedError` (`memory-project.ts:346-350`). 이전 핸드오프의 #7 fix가 실재함을 확인.
- **confidence 밴드 강제 + no-silent-clamp**: extractor가 EXTRACTED를 못 내고(`memory-build.ts:77`), 밴드 이탈은 스키마 superRefine에서 loud fail(`memory-build.ts:298-300` 주석 + assembleSemanticIr).
- **merge reducer 결정성 (D1/§10-5)**: `mergeIrFragments`는 입력 순서 무관 — concept 정규화 ID, 속성 union(사전식 작은 노드 우선), 엣지 dedup `(from,edge_type,to)`, confidence 충돌은 보수적 kind 우선 (`memory-build.ts:179-294`). golden fixture 테스트 존재.
- **ACG 흡수 무손실 (D2/D3/§10-4)**: impact kind를 CALLS로 과단정하지 않고 `RELATED_TO`+`acg_kind`로 보존, 미지원 kind는 `UnsupportedAcgKindError`로 loud fail (`memory-ir.ts:134-135`). canonical id에 run 메타 미포함 → 결정성.
- **freshness 동봉 (§4-4)**: 모든 query/path/explain 응답이 `projection_id·generated_at·freshness·dirty_sources`를 단다 (`memory-query.ts:46-54`, CLI `writeFreshnessHuman`).
- **warm-start fail-open (§10-6 #1)**: 비-owner/비활성/projection 부재/stale/무커버리지/무이웃/throw 전부 `undefined` → 패킷 불변 (`memory-warmstart.ts:147-220`). 호출부도 동기 throw 없음(`autopilot-loop.ts:213,279`).
- **되돌림 단일 마스터 (ac-13)**: `DITTO_MEMORY=off`가 warm-start를 끄고 granular 플래그를 포섭 (`memory-flag.ts:14-17`, `memory-warmstart.ts:72-74`).

요약하면 **"불변식을 스키마로, 결정성을 순수 함수로, 비침습성을 fail-open으로" 강제한다는 설계 약속이 실제로 지켜졌다.** 이건 칭찬할 부분이다.

### 1-2. F1 (🔴) — bootstrap의 day-1 가치가 절반만 실현된다

**무엇**: `bootstrapIngest`는 ADR을 `status=approved`인 `decision` 이벤트로, glossary와 archived handoff를 `status=pending`인 `observation` 이벤트로 쓴다 (`memory-bootstrap.ts:234-238` vs `298,377`). 그런데 projection은 `reduceEvents`의 **approved head만** IR에 합류시키고(`memory-project.ts:187-188`), 그중에서도 `projectDecisionEvents`는 `event_type==='decision'`만 Decision 노드로 만든다(`memory-project.ts:57-58`).

**결과(실측, 부록 A-1)**: ADR 1 + glossary 2 + handoff 1을 ingest한 격리 repo에서 `project` 후 **serving graph의 노드는 1개(Decision 1개)뿐**. glossary·handoff(둘 다 pending)는 그래프에서 완전히 사라진다.

```
events: pending observation (glossary x2), approved decision (ADR x1), pending observation (handoff x1)
project → node count: 1, types: {'Decision': 1}
```

**왜 문제인가**: 가치·구조 평가(`memory-graph-value-structure-assessment.md` §3 시나리오 ③)는 **"bootstrap만으로 handoff·ADR 본문 검색으로 과거 작업 포인터가 warm-start에 실린다 — 싸고 결정적인 day-1 핵심 가치"**라고 적었고, **이 시나리오가 옵션 A를 정당화한 근거**다. 그러나 구현은 handoff를 pending으로 두어 projection에서 배제하므로, warm-start가 보는 serving graph에 handoff가 없다. 즉 옵션 A의 방어선이 코드에서 끊겼다. 현재 warm-start가 매칭할 수 있는 것은 ADR Decision 노드뿐이고, "과거 유사 작업(handoff)"은 절대 실리지 않는다.

> 설계 의도와의 충돌: glossary/handoff를 pending으로 둔 것은 "추출은 승인 전"이라는 §4-5 정신에는 맞지만, 그러면 **bootstrap이 cold-start를 해소한다는 ac-14의 주장과 양립하지 않는다.** 둘 중 하나가 틀렸다.

### 1-3. F2 (🔴) — 본문 검색이 런타임에 배선되지 않았다

**무엇**: `searchEventBodies`(query가 substring/token으로 event 본문 검색, **pending 포함 전체 이벤트** 대상)는 ac-14의 "본문 검색이 title-token duplicateSearch보다 recall이 넓다"를 증명하는 핵심 함수다(`memory-bootstrap.ts:412-435`). 그런데 이 함수의 호출자는 **테스트뿐이다.** CLI(`memory.ts`)는 `bootstrapIngest`만 import하고 `searchEventBodies`는 import하지 않는다. warm-start와 query 엔진은 serving graph(approved-only)만 본다.

**결과**: ac-14가 단언하는 가치("본문 검색")는 **단위 함수로만 참이고, 사용자/에이전트가 실제로 도달할 수 있는 경로가 없다.** F1과 합치면, bootstrap이 만든 day-1 데이터의 대부분(pending observation 본문)은 어떤 런타임 질의로도 닿지 않는다.

**F1+F2의 종합 함의 (방향성)**: 옵션 A의 계측(`ditto memory usage`)은 warm-start hit율을 측정해 push 확대를 게이트한다. 그러나 warm-start가 보는 것이 ADR Decision 노드로 한정되므로, **계측은 "그래프 가치"가 아니라 "ADR 제목 토큰 매칭률"을 측정한다.** 게이트 입력이 구조적으로 편향돼 있어, "hit율이 낮으니 그래프는 가치 없다" 또는 그 반대의 결론 모두 신뢰할 수 없다. 측정 전에 F1/F2를 닫지 않으면 옵션 A의 핵심 메커니즘이 무의미해진다.

### 1-4. F4 (🟡) — RATIONALE_FOR 엣지의 source 노드가 dangling

**무엇**: ADR Decision 노드는 `source:<sourceId>`를 from으로 하는 RATIONALE_FOR 엣지를 만든다(`memory-project.ts:73-76`). 그러나 그 `source:` 노드 자체는 projection의 nodes 배열에 추가되지 않는다 — adjacency의 키로만 등장한다(부록 A-1: `adjacency keys: ['source:src_...']`이지만 `node count: 1`).

**결과**: `queryNeighbors`/`shortestPath`/`explainNode`는 `present.has(node)`로 노드 존재를 확인하므로(`memory-query.ts:128,159,195`), `ditto memory query source:src_...`는 `MemoryNodeNotFoundError`로 실패한다. 즉 **§5-5가 약속한 "이 주장의 출처 source까지의 경로"(evidence_path)를 query/path로 따라갈 수 없다.** 엣지의 도착점이 그래프에 없는 노드라서 traversal이 거기서 끊긴다. 설계상 source 노드를 명시 생성하거나(권장), 아니면 §5-5를 v0 비범위로 명확히 내려야 한다.

---

## 2. 하네스 컨셉 정합성 & 맞물림 (ac-3)

### 2-1. 기층 ADR과의 정합 — 충돌 없음 (확인)

ADR-0013의 결정 4건을 선행 ADR과 대조한 결과 **모순 없음**:

- **ADR-0002 (Zod=SoT)**: memory 스키마 4종이 Zod로 정의·`export-schemas.ts` 등록. 정합.
- **ADR-0005 (per-entity JSON·무서버)**: events/sources가 이벤트당 불변 파일. 인프로세스 그래프(서버 없음). 정합 — 오히려 모범적.
- **ADR-0011 (session-rooting)**: 멀티 repo workspace에서 workspace-루트 메모리는 read/scan/projection 전용으로 선언(§10-1 F4), 변형은 repo-rooted. ADR-0011을 깨지 않고 v0 경계로 존중. 정합.
- **ADR-0012 (3-tier)**: `dittoDir`/`localDir` 헬퍼를 그대로 사용. 정합.

통합 표면도 외과적이다: 비-메모리 코드가 메모리를 참조하는 곳은 `autopilot-loop.ts`(warm-start 2회)와 `autopilot-dispatch.ts`(타입+optional 필드 주입)뿐이고, **hook은 메모리를 전혀 건드리지 않는다.** 의존 방향이 단방향(bootstrap이 knowledge를 읽지, knowledge가 memory를 읽지 않음)이라 순환 없음. 되돌림 4불변식(SKILL.md §"Disable & remove")이 실재한다.

### 2-2. F5 (🟡) — knowledge ↔ memory 동기화 부재

**무엇**: `bootstrapIngest`는 `.ditto/knowledge/adr/*.md`와 `glossary.json` 본문을 event.text(최대 4000자)로 **복제**한다(`memory-bootstrap.ts:225,287`). 그런데 (a) bootstrap은 수동 1회성 명령이고, (b) `scan`은 `.ditto`를 SKIP_DIRS로 제외하므로(`memory-scan.ts:24-34`) knowledge 파일 변경을 감지하지 못하며, (c) 재ingest를 트리거하는 메커니즘이 없다.

**결과**: ADR을 수정하면 `.ditto/knowledge/`의 원본과 `.ditto/memory/events/`의 사본이 갈라진다. memory는 자신의 source content_hash 변경은 감지하지만(scan), knowledge는 scan 대상이 아니라 그 drift를 영영 모른다. v0 범위에선 의도적 단순화로 볼 수 있으나(ADR-0013 D4 measure-before-expand), **"같은 사실이 두 곳에 살고 한쪽이 조용히 낡는다"**는 것은 메모리 보고서가 경계한 정합성 문제(중복 저장) 그 자체다. 최소한 ADR-0013 철회조건에 "knowledge 변경 시 memory 재ingest 필요"를 명시해야 한다.

### 2-3. F8 (🟢) — 새 용어가 glossary 미등재

`event`, `projection`, `claim`(node_type), `confidence_kind`(EXTRACTED/INFERRED/AMBIGUOUS), `extraction_run_id` 등 사용자대면 어휘가 `.ditto/knowledge/glossary.json`에 없다. 기존 용어(`evidence`, `context packet`, `run`)와 직접 충돌하지는 않으나(orthogonal), 메모리가 ubiquitous language 밖에 떠 있다. knowledge-update로 핵심 용어 5개 정도 승격 권장.

---

## 3. 보안 · 버그 위험 (ac-4)

### 3-1. F3 (🔴) — 제안→승인 권한 분리가 형식적, self-approve 가능

**무엇**: 설계 §4-5의 핵심 안전장치는 "에이전트는 그래프에 직접 못 쓴다. propose(pending)→approve(사람/정책)→재projection"이다. 그런데 `propose`와 `approve`는 **같은 CLI에 나란히 노출**돼 있고, `approve --by <approver>`는 **임의 문자열**이다(`memory.ts:846`, 내용 검증 없음). PreToolUse hook은 `.ditto/memory/`가 repoRoot 내부라 scope-out으로 막지 않는다.

**실측(부록 A-2)**: agent 역할로 INFERRED 추측을 propose한 뒤, **같은 주체가 `--by implementer-agent-self`로 approve → `status=approved`, 그래프에 fact로 합류, freshness=fresh.**

```
propose --type analysis --confidence INFERRED --actor agent --role implementer  → pending
approve <id> --by implementer-agent-self                                          → approved ✅
```

**왜 위험한가**: 자율주행(autopilot) 중 owner 에이전트가 bash로 propose+approve를 연달아 실행하면, **미검증 INFERRED 추측이 "approved fact"로 굳는다.** 이는 설계 §4-2(3) "흔들린 추측이 확실한 사실로 굳지 않게 격리"와 §4-5의 존재 이유를 정면으로 무력화한다. graphify의 write-back 오염 경로를 닫겠다던 설계 목표(§3-1)가 코드 레벨에서 닫히지 않았다.

**완화 정황**: 현재는 §5-1 warm-start 1개만 push라 오염된 노드의 blast radius가 제한적이고, approve가 인간 호출이라는 *규약*은 SKILL.md에 적혀 있다. 그러나 **push 확대(후속 게이트)를 열기 전에 반드시 닫아야 한다.** 최소 방어: (a) `actor.kind==='agent'`가 자신이 propose한 이벤트를 approve하지 못하게(제안자≠승인자 강제), 또는 (b) approve를 별도 권한 경로(hook 게이트/전용 명령)로 분리, 또는 (c) autopilot 컨텍스트에서 approve를 차단.

### 3-2. F6 (🟡) — sensitivity 하드코딩 + 전 경로 미사용 → 본문 평문 git-tracked

**무엇**: 스키마는 `sensitivity: public|internal|secret`를 정의하지만(`memory-source.ts:16`, `memory-event.ts:39`), (a) `scan`은 모든 source를 `sensitivity:'internal'`로 **하드코딩**하고(`memory-scan.ts:196`) secret 분류 로직이 없으며, (b) projection/wiki/serving graph/warm-start **어디서도 sensitivity로 필터링하지 않는다.** 라벨은 있으나 작동하지 않는다.

**결과**: 두 가지 노출 경로.
1. **bootstrap의 본문 복제**: handoff/ADR/glossary 본문 4000자가 `.ditto/memory/events/*.json`에 평문으로 들어가고, 이 디렉토리는 **Tier ② git-tracked**다. archived handoff에 민감정보(내부 경로, 결정 근거, 임시 토큰 흔적)가 있으면 sensitivity 라벨이 internal 고정이라 걸러지지 않고 **git에 커밋·공유된다.** 원본 handoff는 `.ditto/local/`(gitignored)인데 사본은 git으로 나간다 — 격리 등급이 역전된다.
2. **build --semantic**: chunk packet이 파일 content를 host LLM(memory-extractor)에 보낸다(`memory.ts:429`). secret이 코드/문서에 하드코딩돼 있으면 그대로 전달. (단 scan은 .ts/.md 등 확장자만 잡으므로 `.env`류는 대개 제외 — content_hash만 저장하고 원문은 source에 저장 안 함. 노출은 events 본문과 semantic chunk에 한정.)

**권고**: 최소한 bootstrap이 handoff를 ingest할 때 sensitivity를 보존/상향하거나, git-tracked SoT에 본문 평문을 넣는 정책을 ADR로 명시. secret 등급 source는 projection·chunk에서 제외하는 게이트 추가.

### 3-3. F7 (🟡) — approve eventId 입력 미검증 (약한 traversal, 비일관)

**무엇**: `events append`와 `propose`는 `--source` id를 `memorySourceId.safeParse`로 검증한다(`memory.ts:180,796`). 그러나 `approve <eventId>`는 positional eventId를 **검증 없이** `approveEvent`→`store.get(id)`→`readJson(path(id))`로 넘기고, `path(id)=join(dir, id+'.json')`로 파일 경로를 조립한다(`memory-store.ts:100`).

**실측(부록 A-2)**: `ditto memory approve "../../../../etc/hosts"` → `event ../../../../etc/hosts not found`. 즉 traversal 경로로 repo 밖 `.json` 파일 읽기를 **시도**한다(존재하면 읽고 memoryEvent 스키마 파싱에서 거부). 실익(익스플로잇 가치)은 낮다 — 임의 .json이 유효 MemoryEvent여야 하고 읽기 전용이다. 하지만 **입력 위생이 명령 간 비일관**하고(append/propose는 검증, approve는 미검증), 신뢰 경계가 흐려진다. `query/path/explain`의 node id는 serving graph 인메모리 조회라 파일경로에 안 닿아 안전.

**권고**: approve의 eventId에도 `memoryEventId.safeParse` 게이트 추가(1줄). 일관성·심층방어.

### 3-4. F9 (🟢) — 검증 갭 (회귀 위험 낮음, 신뢰 공백)

조사로 확인된 미테스트 시나리오(검증 agent 결과 + 직접 확인):
- **>2 supersedes 체인**(A→B→C)을 reducer가 옳게 head로 접는지 미테스트(2단계만).
- **scan race**: 디렉토리 나열과 해시 사이 파일 삭제 시 동작 미테스트.
- **hostile fragment**: 존재하지 않는 source_id를 참조하는 fragment, 밴드 외 AMBIGUOUS/EXTRACTED 조합 미테스트(INFERRED 0.99만 테스트).
- **`DITTO_MEMORY=off`의 적용 범위**: 플래그는 warm-start만 끈다(설계 의도 — CLI pull은 수동이라 유지). 그러나 "off인데 scan/project/propose/approve가 계속 동작"이 명시적으로 테스트되지 않아, off의 의미("자동주입만 끔")가 회귀로 넓어지거나 좁아져도 안 잡힌다.
- **약한 테스트 3건**: 이름이 본문보다 큼 — "superseded head" 테스트가 2단계만, "out-of-band rejection"이 한 밴드만, "freshness state machine"이 set-hash drift만(source-hash drift 경로 누락).

회귀를 일으키는 버그는 아니나, F1·F3 같은 갭이 테스트를 통과한 이유가 여기 있다 — **happy-path는 촘촘하나 "가치가 끝까지 흐르는가"와 "권한이 강제되는가"를 검증하는 테스트가 없다.**

---

## 4. 방향성 판단 — ditto에 좋은 추가인가 (ac-5)

**그렇다, 단 지금 형태로 "측정해서 확장"을 시작하면 안 된다.**

- **컨셉은 옳다**: 출처-동반·freshness-stamped·제안승인 그래프는 ditto의 "증거 기반 완료" prime directive와 결이 같다. 무서버·per-entity·되돌림으로 기층을 안 깬다. 옵션 A(measure-before-expand)는 charter §4-3(단순 해법·프레임워크화 경계) 정신에 부합하는 건전한 자기절제다.
- **그러나 측정 장치가 측정 대상과 끊겨 있다**: 옵션 A의 전부는 "warm-start hit율을 봐서 push를 확대한다"인데, F1/F2 때문에 warm-start가 보는 것이 ADR Decision 노드로 한정된다. 지금 게이트를 켜면 **편향된 hit율**을 근거로 의사결정하게 된다. 이건 "미검증 가치를 측정하겠다"가 아니라 "측정기를 고장 낸 채 측정하겠다"가 된다.
- **거버넌스 구멍이 확장 시 증폭된다**: F3(self-approve)은 push가 1개일 때는 작지만, push를 5지점으로 늘리고 audit→curator 자동화를 켜면 오염된 노드가 여러 프롬프트·큐레이션에 전파된다. 확장 전 차단이 필수다.

**결론**: 기각할 기능이 아니다. **F1·F2·F3을 닫은 뒤** 운영 ingest→계측→게이트 순서로 가면, 옵션 A가 의도한 "확실한 바닥 + 측정되는 상방"이 비로소 성립한다.

---

## 5. 권고 (우선순위)

| 순위 | 항목 | 근거 | 규모 |
|---|---|---|---|
| **P0** | F3 self-approve 차단(제안자≠승인자, 또는 autopilot 내 approve 차단) | push 확대 전 거버넌스 필수 | 소 (gate 1곳) |
| **P0** | F1 bootstrap handoff/glossary를 projection에 노출(observation도 노드화, 또는 approved 승격 정책) | 옵션 A 계측의 전제 | 중 |
| **P1** | F2 본문 검색을 query 경로에 배선(또는 ac-14를 "단위 함수만"으로 정직하게 강등) | day-1 가치 실현 | 중 |
| **P1** | F4 source 노드 명시 생성(또는 §5-5 evidence_path를 v0 비범위로 문서화) | 출처 traversal | 소 |
| **P2** | F6 sensitivity 게이트(secret source는 projection/chunk 제외) + bootstrap 본문 git-track 정책 ADR | 민감정보 노출 | 중 |
| **P2** | F7 approve eventId 입력 검증 1줄 | 입력 위생 일관 | 소 |
| **P3** | F5 ADR-0013 철회조건에 knowledge→memory 재ingest 명시 | drift 인지 | 소 |
| **P3** | F8 핵심 용어 glossary 승격 · F9 테스트 갭(체인>2·플래그 범위·약한 테스트 3건) | ubiquitous language·신뢰 | 소 |

> P0 2건은 **후속 work item(§5 push 확대)을 열기 전 차단 게이트**로 다루기를 권한다. 나머지는 운영 ingest와 병행 가능.

---

## 부록 A — 실측 증거 (격리 repo, 2026-06-10)

격리 환경: `mktemp -d` repo + `git init` + 최소 픽스처(ADR 1·glossary 2항·handoff 1, front-matter 포함). `ditto` 현재 빌드 사용. 실행 후 삭제.

### A-1. F1/F4 — bootstrap→project 후 그래프에 ADR만 남음

```
bootstrap → events: [pending observation(glossary x2), approved decision(ADR), pending observation(handoff)]
project   → projection_id proj_b4f1c19b71d3, nodes:1, edges:1
serving graph → node count: 1 · types: {'Decision': 1} · names: ['ADR-0001: wave concurrency cap…']
              · adjacency keys: ['source:src_93141b2e2809']   ← source 노드는 nodes에 없음(dangling, F4)
```
→ glossary·handoff(pending)는 projection에서 완전 제외. handoff 본문은 어떤 런타임 query로도 닿지 않음.

### A-2. F3/F7 — self-approve 성공 · approve 입력 미검증

```
propose --type analysis --text "moduleA secretly depends on moduleB (guessed)" --confidence INFERRED --actor agent --role implementer
  → pending memevt_260610fkx
approve memevt_260610fkx --by "implementer-agent-self"
  → decision status: approved · approved_by: implementer-agent-self · reprojected nodes: 1   ← self-approve 성공(F3)
status → freshness: fresh   (INFERRED 추측이 approved fact로 그래프에 합류)

approve "../../../../etc/hosts" --by x
  → memory approve failed: event ../../../../etc/hosts not found   ← 검증 없이 파일경로 조립 시도(F7)
```

## 부록 B — 검토 범위 메모

- **읽은 소스(15)**: memory-{flag,reduce,scan,warmstart,store,ir,query,build,project,bootstrap}.ts, cli/commands/memory.ts, schemas/memory-{source,event,graph-ir,projection-manifest}.ts.
- **대조 문서**: 설계서 §1–§10-9, value-structure-assessment, ADR-0013, SKILL.md, memory-extractor.md.
- **검증 못 한 것**: 실 코드베이스 전체에 대한 `build --semantic` end-to-end(host LLM 필요), 멀티 repo workspace rooting 실동작(단일 repo만 실측), Neo4j export 어댑터(미구현·후속).
- **환경 주의**: bun 1.0.2에서 memory 테스트 33건 가짜 실패(`FileHandle.close` 미구현) → 1.3.14에서 해소. 이 리뷰의 실측은 1.3.14 기준.
