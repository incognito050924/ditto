# memory — 코드·결정·문서를 출처·신선도 동반 그래프로 묶어 cross-entity 맥락을 질의하는 서브시스템

> 문서 성격: 코드 설명(재설계용). 코드 변경에 자동 동기화되지 않으므로 시간이 지나면 실제 코드와 어긋날 수 있다(권위는 코드에 있다). 기준 커밋: `c2d2e16` (2026-07-19).

## 1. 이 기능이 실현하려는 설계 의도 (개념)

`ditto memory`는 **cross-entity 맥락** — "이 코드/결정이 무엇과 얽혔나" — 을 질의 가능하게 하는 메모리 서브시스템이다. 코드 심볼, ADR 결정, 핸드오프/관찰을 하나의 그래프로 묶되, 모든 노드/엣지가 **출처(provenance)** 와 **신선도(freshness) 스탬프**를 달고 다녀서, 검색 결과를 "정착된 사실"로 오용하지 못하게 한다.

핵심 문제의식(ADR-0013 컨텍스트, `ADR-0013-memory-subsystem-design.md:8-10`): 그래프-위키 모델(graphify류)은 매력적이지만 두 차례 dialectic-review에서 verdict=revise("그래프는 틀리지 않았으나 이르다 — 증명된 가치는 색인-shaped, 의미층은 미검증 과설계")를 받았다. 그래서 이 서브시스템은 **확실한 바닥(결정적 구조 IR·색인) 위에 불확실한 상방(LLM 의미 추출 엣지)을 bounded·measurable·reversible하게** 얹는 구조로 재범위(옵션 A, D4)되었다.

DITTO 4축(의도/오케스트레이션/E2E/지식) 중 **지식 축**에 속한다. `ditto knowledge`(glossary/ADR 큐레이션)가 사람이 손으로 관리하는 durable knowledge라면, `ditto memory`는 그 knowledge + 코드 + 핸드오프를 **기계가 그래프로 색인**해 오케스트레이션(autopilot warm-start)과 사람 질의에 서빙한다. autopilot 디스패치가 researcher/planner 노드를 띄우기 전 이 그래프를 1지점에서 consult하는 것(warm-start)이 유일하게 배선된 통합점이다(§10-6 #1).

## 2. 코드 위치와 진입점

### 진입

- `src/cli/commands/memory.ts` — citty 커맨드 정의. 16개 서브커맨드를 `memoryCommand.subCommands`에 등록(`memory.ts:1471-1488`).

### core (동작 로직)

| 파일 | 역할 |
|------|------|
| `src/core/memory-scan.ts` | 소스 루트를 walk → 파일별 content_hash → `MemorySource` 매니페스트. 소유 repo 귀속(§3-7). |
| `src/core/memory-store.ts` | 2-tier 저장소. SoT(sources/events, git-tracked, 불변 per-entity JSON) + 파생(ir/projections, gitignored). |
| `src/core/memory-bootstrap.ts` | ADR·glossary·아카이브 핸드오프를 approved 이벤트로 seed(cold-start 제거). |
| `src/core/memory-ir.ts` | ACG 분석 산출물(impact/boundary/semantic)을 구조 IR 노드/엣지로 흡수(결정적, provenance 주입). |
| `src/core/memory-build.ts` | `--semantic` 경로: 소스를 chunk로 쪼개 추출 요청 패킷 생성 + 호스트가 돌려준 IR fragment를 결정적으로 merge. |
| `src/core/memory-reduce.ts` | 이벤트 supersedes 체인을 head로 해소 → approved head만 + `setHash`(신선도 경계). |
| `src/core/memory-project.ts` | IR + approved 이벤트를 서빙 그래프·wiki·매니페스트로 one-way projection. propose/approve 쓰기 게이트. 신선도(axis-1/axis-2) 판정. |
| `src/core/memory-query.ts` | 서빙 그래프 read-only 질의(query/path/explain), body 검색, symbol 결정-계보 brief, audit. |
| `src/core/memory-measure.ts` | 재제안율(hallucination-reduction) 기준선 측정. 재사용 추출기(rejected-alt/invariant). |
| `src/core/memory-warmstart.ts` | autopilot 디스패치용 warm-start push(fail-open). 사용 계측. |
| `src/core/memory-flag.ts` | 마스터 스위치 `DITTO_MEMORY=off`(롤백 불변식). |

### schemas (SoT — ADR-0002)

- `src/schemas/memory-source.ts` — 원시 소스 매니페스트 엔트리(`MemorySource`).
- `src/schemas/memory-event.ts` — append-only 메모리 이벤트(`MemoryEvent`) — 원시 소스에서 재구성 불가한 지식의 SoT.
- `src/schemas/memory-graph-ir.ts` — Graph IR(노드/엣지/하이퍼엣지 + provenance + 보정된 confidence 밴드).
- `src/schemas/memory-projection-manifest.ts` — projection 계보 계약(어떤 입력에서 만들어졌나 → 신선도 판정 근거).

### 서브커맨드 표

| 서브커맨드 | 주요 인자 | 하는 일 |
|-----------|----------|--------|
| `scan` | `--source-root`, `--require-clean` | 소스 hash → 매니페스트, added/changed/unchanged 보고 |
| `events append` | `--type --text --source ...` | 불변 이벤트 1개 직접 append(직접 SoT 쓰기) |
| `events list` | `--limit` | 이벤트 목록(secret 본문은 redact) |
| `bootstrap` | — | knowledge/핸드오프를 approved 이벤트로 seed(멱등) |
| `build` | `--semantic --fragments --source-root` | 기본 structure-only. `--semantic`으로 chunk 패킷/merge |
| `project` | — | IR + approved 이벤트 → 서빙 그래프·wiki·매니페스트 |
| `status` | — | 신선도(fresh/stale/absent/code_drift/code_dirty) + dirty/pending |
| `query` | `<node> --depth --text` | 서빙 그래프 BFS 이웃, symbol brief, body fallback |
| `path` | `<from> <to>` | 두 노드 최단 경로 |
| `explain` | `<node>` | 노드 라벨 + 인접 엣지 |
| `audit` | — | orphan/stale/duplicate/contradiction 카운트 → append-only history |
| `usage` | `--work-item` | warm-start 계측 + pull-query 카운트 |
| `propose` | `--type --text --source ...` | pending 이벤트 제안(에이전트 쓰기 경로) |
| `propose-finding` | `--work-item --index` | evidence 레코드 → pending INFERRED observation |
| `capture` | `--text --source ...` | 코드-경로 근거 데이터 의존 관찰(코드 소스 ≥1 강제) |
| `measure` | `--against` | 재제안율 기준선 |
| `approve` | `<eventId> --by --actor --reject` | pending 이벤트 승인/기각 → 재-projection |

## 3. 데이터 흐름 (입력 → 변환 → 저장/출력)

### 저장 2-tier (ADR-0013 D2)

- **SoT (git-tracked, 불변, per-entity JSON)** = `dittoDir(root)/memory/` = `.ditto/memory/`
  - `sources/<src_...>.json` — `MemorySource` (`memory-store.ts:52-54`)
  - `events/<memevt_...>.json` — `MemoryEvent`, 불변('wx' 플래그) (`memory-store.ts:95-127`)
  - `audit-log.jsonl` — append-only audit history (`memory-query.ts:579-581`)
- **파생 (gitignored, 재생성 가능)** = `localDir(root, 'memory', …)` = `.ditto/local/memory/`
  - `ir/graph-ir.json` — 현재 IR 스냅샷(whole-file 교체) (`memory-store.ts:161-162`)
  - `projections/graph.json` — 서빙 그래프(adjacency)
  - `projections/manifest.json` — projection 매니페스트
  - `projections/wiki/index.md` — 사람용 wiki
  - `pull-usage.jsonl` — pull-query 계측 (`memory-query.ts:90-92`)
  - work-item별 `memory/warmstart-usage.jsonl` — warm-start 계측 (`memory-warmstart.ts:120-122`)

SoT와 파생을 같은 서브트리에 둘 수 없다(파생을 `.ditto/memory/` 직하에 두면 git이 추적) — 그래서 dittoDir/localDir로 가른다(`ADR-0013-memory-subsystem-design.md:24`).

### 파이프라인

```
[코드/문서 파일]
   │ scan (content_hash, 소유 repo HEAD)
   ▼
sources/*.json (MemorySource, SoT)
   │
   │            [ADR/glossary/handoff] ──bootstrap──▶ events/*.json (approved)
   │            [사람/에이전트]         ──append/propose/capture──▶ events/*.json
   │            [ACG 분석 산출물]        ──absorbAcgIntoIr(memory-ir)──┐
   │            [LLM(host)]              ──build --semantic──▶ ir/graph-ir.json
   ▼                                                          │
project ◀──────────────────────────────────────────────────┘
   │  reduceEvents(events) → approved head + setHash
   │  + IR 노드/엣지 병합
   ▼
projections/{graph.json, manifest.json, wiki/index.md}
   │
   ├─ query/path/explain (read-only, 신선도 envelope 동반)
   ├─ audit → audit-log.jsonl
   └─ warmStartMemoryContext → autopilot 디스패치 패킷
```

핵심: **읽기는 결정적, 쓰기(의미 추출)만 비결정적 호스트에 격리**된다. `project`가 SoT(events) + 재생성 가능한 IR을 읽어 파생물을 만들고, 모든 질의는 파생 서빙 그래프만 읽는다.

## 4. 핵심 개념과 채택 이유 (왜 이 개념인가)

### 4-1. propose → approve → re-projection (에이전트 직접 write 금지)

에이전트는 서빙 그래프나 IR을 **직접 쓸 수 없다** — write API 자체가 없다(`memory-project.ts:396-406`). projection에 영향을 주는 유일한 경로는 (1) `proposeEvent` → pending 이벤트, (2) `approveEvent` → supersedes를 단 **새 불변 approved 이벤트**, 그 다음 재-projection이다.

- **왜**: "흔들린 추측이 사실로 굳지 않게"(§4-5). 에이전트가 자기 제안을 자기 승인하면 게이트가 no-op이 되므로, agent가 제안한 이벤트는 user만 승인할 수 있다(`MemorySelfApprovalError`, `memory-project.ts:446-451, 536-538`).
- **한계(위협 모델, R2)**: actor-kind 게이트는 로컬 CLI honor-system이다 — `--actor`는 자기신고라 적대적 우회를 막지 못한다(정직한 실수 차단용). 적대적 차단은 §5 push 확대를 여는 work item의 선행 게이트로 보류(`ADR-0013-memory-subsystem-design.md:59`).

### 4-2. 불변 이벤트 + supersedes 체인 (승인이 원본을 변형하지 않음)

이벤트당 불변 JSON 파일(`'wx'` open 플래그로 존재 시 실패, TOCTOU 차단). pending→approved 전이는 원본을 변형하지 않고 `supersedes=원본_id`인 새 approved 이벤트를 append한다(ADR-0013 D3). **논리적 식별성 = supersedes 체인의 head**이지 단일 id가 아니다(`memory-reduce.ts:28-42`).

- **왜**: "불변 파일"과 "approval invariant"를 스키마 변경 0으로 양립. per-entity 불변 파일은 ADR-0005의 git-tracked SoT 무충돌 머지를 보존한다(단일 JSONL은 머지를 깸 — 기각, `ADR-0013-memory-subsystem-design.md:50`).
- **supersede 효력 규칙(R3)**: supersedes 엣지는 superseding 이벤트가 **effective**(자체 approved이거나 자기 체인으로 approved)일 때만 효력을 갖는다(`memory-reduce.ts:57-65`). pending 정정이 approved head를 조용히 떨어뜨리지 못하게 — §4-5 대칭(pending은 더하지도 빼지도 못한다).

### 4-3. confidence_kind = provenance 등급 (EXTRACTED / INFERRED / AMBIGUOUS)

관계의 출처 등급(`memory-graph-ir.ts:5-9`): EXTRACTED=소스에 명시(fact, score 1.0), INFERRED=추론(score [0.4,0.95]), AMBIGUOUS=불확실(score [0.1,0.3], review 전용). 스키마 superRefine이 밴드를 강제 — 밴드 밖은 조용한 clamp가 아니라 **loud fail**(`memory-graph-ir.ts:98-125`).

- **laundering 가드**: 에이전트가 propose로 EXTRACTED를 주장하면 INFERRED로 강등된다(`memory-project.ts:486-488`). 결정적 fact(ACG/codeql, ADR bootstrap)는 propose를 거치지 않고 직접 append되므로, propose를 통한 EXTRACTED 주장은 세탁이다.
- **의미 추출 엣지는 INFERRED|AMBIGUOUS만**: build fragment 스키마가 EXTRACTED를 제외(`memory-build.ts:88, 103`) — LLM은 fact를 만들 수 없다.

### 4-4. 신선도 envelope 2축 (모든 답에 동반)

query/path/explain 답은 항상 `projection_id·generated_at·freshness·dirty_sources·drifted_repos·drifted_sources`를 달고 나온다(`memory-query.ts:31-41`). 두 축(ADR-0015):

- **axis-1 (SoT ↔ projection)**: `stale` — 현재 reduced approved-set 해시가 매니페스트와 다르거나 소스 content_hash가 움직임.
- **axis-2 (코드 ↔ SoT)**: `code_drift`(소유 repo HEAD가 projection 빌드 커밋과 불일치) / `code_dirty`(작업트리가 baseline과 다름).
- 우선순위(의도적): `code_drift > stale > code_dirty > fresh`(`memory-project.ts:751-758`). code_dirty가 stale을 이기면 안 되는 이유: 개발 트리는 거의 항상 dirty라, stale한 projection이 code_dirty로 읽히면 warm-start 게이트가 그걸 정착된 것으로 서빙하게 된다.

### 4-5. 인프로세스 그래프 + 선택적 Neo4j export (ADR-0013 D1)

Memgraph/Neo4j 상시 런타임 서버는 **기각** — 서버 의존이 무서버·per-entity JSON·핸드오프·머지 모델을 깬다. 런타임 그래프는 `graph-ir.json`에서 인프로세스로 빌드하고, 대규모 분석은 선택적 Neo4j export(projection일 뿐)로 외부 처리(`ADR-0013-memory-subsystem-design.md:14-18, 48`).

### 4-6. 호스트-위임 LLM 추출 (ADR-0001)

ditto는 provider를 직접 호출하지 않는다. `build --semantic`은 chunk 요청 패킷만 만들고, 호스트가 `memory-extractor` 에이전트로 LLM 추출을 돌려 IR fragment를 돌려주면 ditto가 그것을 결정적으로 merge한다(`memory-build.ts:1-20`).

### 4-7. measure-before-expand (ADR-0013 D4)

증명된 가치는 색인-shaped, 의미층은 미검증 → §5-1 warm-start push **1개만** 배선·계측하고, §5-2~5-5 push 확대·audit→curator 자동 트리거는 **hit율 데이터 후 후속 work item**으로 보류(`ADR-0013-memory-subsystem-design.md:35-36`). `measure`/`usage`가 그 게이트 데이터원이다.

## 5. 코드 분해 (무슨 코드가 무슨 효과를 내는가)

### scan — `scanSources` (`memory-scan.ts:140-225`)

- 입력: repoRoot(rooting root·SoT 위치) + sourceRoot(walk 대상, 기본 repoRoot).
- `walkFiles`가 SKIP_DIRS(node_modules/.git/.ditto/dist/… `memory-scan.ts:24-34`)를 제외하고 코드+마크다운 확장자만 수집. `.ditto` 제외가 **bootstrap ingest 사본과의 drift 원인**(§6 참조).
- source_id = repo-relative 경로의 sha256 앞 12hex(`sourceIdForPath`, `:60-62`) — 경로 파생이라 stable.
- **소유 repo 귀속(§3-7)**: `findOwningRepo`가 가장 가까운 `.git` 조상을 rooting root로 bound해 찾음(`:82-94`). 그것이 scan repoRoot와 같으면(단일 repo 흔한 경우) `repo` 필드 생략 + revision=root HEAD(cost 0). 다르면 `repo`=rooting-root-상대 경로, revision/git_commit=서브repo HEAD.
- 효과: git 호출을 **repo당 1회**로 캐시(`headCache`, `:157-159, 182`) — 파일 수 독립.
- **sensitivity 보존(R7)**: 재scan 시 이전 레코드의 sensitivity를 보존(`:201`) — content 변경이 수동 'secret' 표시를 조용히 리셋하지 못하게(secret 게이트가 이 필드에 올라탐).
- unchanged 파일은 write하지 않음(`:212-216`) — captured_at churn 방지.

### events append vs propose vs capture — 쓰기 3경로

- `events append`(`memory.ts:178-289`): 이벤트를 **직접** SoT에 append. `MemoryEventStore.append`가 스키마 검증 후 `'wx'`로 씀 → 존재 시 `MemoryEventExistsError`(`memory-store.ts:108-127`). 직접 append는 confidence를 그대로 받음(laundering 가드 없음) — 결정적 fact 삽입용.
- `propose`(`memory.ts:902-998`) → `proposeEvent`(`memory-project.ts:467-502`): status=pending 강제, agent+EXTRACTED → INFERRED 강등. **새 지식을 쓰기 모델에 넣는 유일한 에이전트 경로.**
- `propose-finding`(`memory.ts:1128-1214`): evidence-index.json의 레코드 1개를 pending INFERRED observation으로 변환. EvidenceRecord는 stable id/source가 없어 provenance를 이벤트 `text`에 담음(`findingText`/`evidenceLocus`, `memory.ts:1099-1126`).
- `capture`(`memory.ts:1216-1322`): 데이터-의존 케이스 관찰. **CLI 계층에서 코드 소스 ≥1 강제**(`:1270-1288`) — 소스가 `source_type='code'` MemorySource로 resolve되어야 함. proposeEvent 계약 자체는 안 건드림.

### build — 구조-only 기본 + `--semantic` (`memory.ts:394-524`, `memory-build.ts`)

- 기본(`--semantic` 없음): structure-only 비용 등급만 출력하고 종료(`memory.ts:439-446`). 의미 추출은 비싸고 비결정적이라 opt-in.
- `--semantic --fragments <file>`: 호스트가 돌려준 fragment를 `mergeIrFragments`로 결정적 병합 후 IR 씀(`memory.ts:450-485`).
- `--semantic`만: scan → `chunkSources`로 22파일씩 chunk 패킷 생성(`memory-build.ts:33, 65-85`). secret 파일은 chunk 전에 제거(`:73`) — 호스트 LLM에 secret content가 안 감(F6).
- `mergeIrFragments`(`memory-build.ts:184-304`)는 **순수·결정적**: 같은 fragment(임의 순서)→ bit-identical 노드/엣지. Concept 노드는 정규화 라벨로 접힘(`conceptId`, `:141-143`), 엣지는 (from,to,edge_type)로 dedup, confidence 충돌은 **더 보수적 kind 승리**(AMBIGUOUS > INFERRED) 후 max score(`pickConfidence`, `:306-314`). dangling 엣지(노드 없는 endpoint)는 조용히 버리지 않고 진단으로 표면(`findDanglingEdges`, `:341-344`).

### project — `projectMemory` (`memory-project.ts:322-394`)

- IR(없으면 empty) + events + sources를 읽음.
- `reduceEvents`(`memory-reduce.ts:44-82`)로 approved head + setHash 산출.
- secret 소스는 노드/엣지에서 제외(`:335-337`), 코드 소스는 path 맵으로 Artifact 브리지 배선(`:342-345`).
- `projectEventNodes`(`:78-242`): decision 이벤트 → `Decision` 노드 + 소스 `RATIONALE_FOR` 엣지; 그 외 → `Episode` 노드 + `MENTIONS` 엣지. 각 grounding 소스는 `Source` 노드로도 emit(안 하면 엣지 `from`이 dangling — query/explain은 graph.nodes만 봄, `:60-64`). decision의 `governs` 경로(ADR `관련:` 헤더) → Artifact 노드 + Artifact→Decision `RATIONALE_FOR`(코드↔결정 브리지, `:195-238`).
- projection_id = `proj_<sha256(ir_version:setHash) 앞12hex>`(`:44-47`) — content 파생이라 stable.
- 서빙 그래프·wiki·매니페스트를 씀. **projection은 절대 제자리 수정 안 함** — 틀리면 소스/추출기를 고치고 재생성(§4-3).

### approve — `approveEvent` (`memory-project.ts:512-558`)

- pending 확인(아니면 `MemoryEventNotPendingError`).
- **더블-approve 가드**: 원본을 supersede하는 이벤트가 이미 있으면 `MemoryEventAlreadyDecidedError`(`:527-531`) — 원본 파일은 불변이라 영원히 pending이므로 status 체크만으론 감지 불가. 없으면 체인이 두 approved head로 갈라짐.
- 자기승인 가드(`:535-538`), 그다음 새 approved(또는 reject) 이벤트 append + **즉시 재-projection**.

### query — `memoryQuery` (`memory.ts:656-761`)

- `symbol:<path>#<name>` id → `querySymbolBrief`: BFS 이웃이 아니라 **결정-계보 brief**(지배 ADR + 기각된 대안 + 불변식 + per-item EXTRACTED/INFERRED 태그, `memory-query.ts:311-360, 407-415`). cite(governs가 파일을 명시=EXTRACTED) vs fallback(body 언급만=INFERRED). 하나도 안 맞으면 coverage=미발견 + 지배 ADR 없음(거짓 "결정 없음" 불가능).
- 일반 노드: `queryNeighbors` 무방향 BFS(기본 depth 2, `memory-query.ts:140-161`).
- 노드가 서빙 그래프에 없으면 `MemoryNodeNotFoundError` → **body 검색 fallback**(`memory.ts:751-755`, `queryBodies` `memory-query.ts:227-237`): 이벤트 body를 substring/토큰 검색 — rationale에만 사는 term도 찾힘. body 검색도 **approved head + sensitivity≠secret**만 노출(R1 단일 가시성 규칙, `:233`).
- 모든 query는 pull-query 1줄 계측(best-effort, telemetry가 답을 깨지 않음, `memory.ts:735-741`).

### audit — `runAudit` (`memory-query.ts:613-637`)

- 서빙 그래프 read-only + status → orphan/stale/duplicate/contradiction 카운트(`auditCounts` `:549-569`) → **append-only history**(`audit-log.jsonl`)에 1줄. 스냅샷 보고가 아니라 시계열(재생성 가능한 IR로는 "그때 orphan이 뭐였나"를 복원 못 함). **수동 전용** — curator 자동 트리거 없음(§5-4).

### warm-start — `warmStartMemoryContext` (`memory-warmstart.ts:170-282`)

- autopilot 디스패치가 researcher/planner 노드 spawn 전 그래프를 consult하는 **유일한 지점**. 전부 **fail-open**: 비-warm-start owner, 비활성, projection 부재/빈/stale, coverage 없음, 관련 노드 없음, 예외 — 전부 `undefined` 반환 → 패킷 무변경.
- 신선도 게이트: `{stale, absent, code_drift}`는 억제하되 `code_dirty`는 **억제 안 함**(`:200`) — code_dirty는 정상 개발 상태라, 억제하면 파일 하나 만지는 순간 메모리가 무력화됨.
- coverage: work item title/goal 토큰과 노드 id/name 토큰이 겹치는 노드가 root(`coverageRoots` `:101-110`).
- 값-순위 캡(`:222-236`): 알파벳 정렬이면 우발적 Artifact 노드가 캡 슬롯을 채워 coverage root·지배 Decision을 밀어냄 → tier(root→Decision→나머지)로 순위. 관련 Decision은 결정 brief로 확장(`:256-264`).
- 4계측(opportunity/attempt/hit/actionable)을 spawn당 1줄 JSONL로 기록(`:112-122`).

## 6. 설계 의도 ↔ 실제 동작 일치 여부

확인 범위: 위 12개 core 모듈 + 4개 스키마 + CLI 진입 파일 + ADR-0013 정독. 테스트는 실행하지 않음(정적 코드 독해만) — 동작 주장은 코드 인과에 근거하며, 런타임 검증은 **미검증**.

- **propose→approve→re-projection 불변식**: IR/서빙 그래프에 대한 에이전트 write API가 실제로 없음(코드에서 확인). approveEvent만 재-projection 호출. **일치.**
- **읽기 가시성 단일 규칙(R1)**: 서빙 그래프(project 시 secret 제외), body 검색(`queryBodies` approved+non-secret), events list(secret 본문 redact `memory.ts:330-331`) 모두 같은 규칙. **일치.**
- **신선도 우선순위**: `memory-project.ts:751-758`이 code_drift>stale>code_dirty>fresh를 정확히 구현. warm-start가 code_dirty만 통과시킴(`memory-warmstart.ts:200`). **일치.**
- **알려진 drift(설계가 명시한 갭, 죽은 경로 아님)**: `.ditto`가 SKIP_DIRS라(`memory-scan.ts:26`) `.ditto/knowledge`(ADR/glossary) 본문을 수정하면 bootstrap ingest 사본이 drift한다. 현재 정책은 수동 `ditto memory bootstrap` 재실행이나, **불변 이벤트 본문은 supersede 없이는 갱신 안 됨**(재실행은 동일 event_id를 graceful-skip) — 소스는 갱신되나 이벤트 텍스트는 안 됨(`ADR-0013-memory-subsystem-design.md:80`에 명시된 알려진 한계).
- **invariant 위반율 미계산**: `measure`는 재제안율만 결정적으로 계산하고 불변식 위반율은 `invariant_violations_computed: false`로 **명시 보류**(`memory-measure.ts:104, 156`) — ADR-0013 D4의 measure-before-expand 신호. 의도대로 미완을 미완으로 드러냄.
- **actionability(pull) 미측정**: warm-start push엔 actionable 카운터가 있으나, pull 질의가 에이전트 행동을 실제 바꿨는지는 미측정(발화 수·neighbor_count뿐). ADR-0013 보강 R9에 명시 보류로 기록. **일치(의도된 갭).**

## 7. 잠재 위험·부작용·재설계 시 고려점

### 재설계 시 반드시 보존할 불변식

1. **에이전트 직접 write 금지**: propose→approve→re-projection 외에 IR/서빙 그래프를 쓰는 경로를 절대 열지 말 것. 자기승인 가드(actor-kind)는 약하지만(honor-system) 정직한 실수 차단선.
2. **이벤트 불변 + supersedes 체인**: SoT 이벤트를 mutable로 바꾸면 ADR-0005 무충돌 머지가 깨짐. 승인=새 이벤트, 절대 원본 변형 아님. supersede 효력 규칙(effective일 때만)을 빼면 pending 정정이 approved head를 조용히 떨어뜨림(R3 회귀).
3. **신선도 envelope 동반 + 우선순위**: 답에서 freshness를 떼면 stale 결과를 정착된 사실로 오용. code_dirty가 stale을 이기게 하면 warm-start가 stale을 서빙.
4. **confidence 밴드 loud-fail + laundering 강등**: 밴드 밖을 clamp로 바꾸거나 agent EXTRACTED 강등을 빼면 추측이 fact로 세탁됨.
5. **결정적 읽기 / 비결정 쓰기 격리**: LLM(비결정)은 쓰기(build --semantic 추출)에만, 읽기 경로는 순수 함수 유지. Neo4j를 상시 런타임으로 승격하면 무서버 모델(ADR-0005) 파괴.

### 동시성·정합성·drift 위험

- **knowledge↔memory drift(위 §6)**: 가장 실질적인 정합성 위험. 이벤트 본문 supersede 자동화가 없으면 ADR 본문 수정이 memory에 반영 안 됨. autopilot이 warm-start로 stale한 결정 gist를 주입할 수 있음(단 freshness가 stale/drift면 억제되므로 일부 완화).
- **bootstrap 세탁 경로(R6)**: repo에 파일 쓰고 `ditto memory bootstrap` 실행하면 propose→approve를 우회해 approved 이벤트를 만들 수 있음. 특히 handoff archive(에이전트 자동 생성, 큐레이션 없음)의 신뢰 전제가 약함. 현재는 `approved_by='bootstrap'` 감사 라벨 + 수동 CLI로만 완화. handoff 유래 이벤트 신뢰 등급 분리는 세탁이 실측되면 후속.
- **동시 쓰기**: 이벤트는 `'wx'` 플래그로 TOCTOU 차단(같은 id 동시 write는 하나가 EEXIST). 다만 projection은 whole-file 교체라 두 세션이 동시에 project하면 마지막 쓰기 승리(락 없음) — 파생물이라 재생성 가능하니 손실은 아니나, 매니페스트 setHash가 순간적으로 불일치할 수 있음.
- **멀티 repo workspace 쓰기 미지원**: 현 v0는 workspace-루트 `.ditto/memory/`에 대해 read/scan/projection 전용. 서브repo에 대한 scan-write/propose/approve/build가 필요해지면 ADR-0011 session-rooting scope-out 재개 대상(`ADR-0013-memory-subsystem-design.md:75`).

### 재고할 수 있는 결정

- **measure-before-expand 게이트(D4)**: warm-start push 1개만 배선된 상태. hit율 데이터가 게이트를 넘으면 §5-2~5-5 push 확대 + audit→curator 자동 트리거를 열 수 있음. 단 그 전에 승인 게이트의 적대적 차단(honor-system 보완)이 선행 게이트로 요구됨(R2).
- **body 검색 재현율**: substring + len≥3 토큰 매칭(`memory-query.ts:168-175, 188-211`)은 crude. 재설계 시 임베딩 유사도 유혹이 있으나 ADR-0013이 "타입 있는 의미 엣지 대체 불가 + ADR-0001 닫은 결정 재개방"으로 **기각**(재제안 방지 기록, `:53`).
- **measure의 재제안 매칭**: latin 토큰/괄호 term 기반 crude 매칭이라 순수 한국어 대안은 놓칠 수 있음(재현율 bounded, `memory-measure.ts:16-21`). 결정적·비임베딩 제약은 D1에서 옴.
