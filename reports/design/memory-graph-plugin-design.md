# DITTO Memory-Graph Plugin — 설계

> **work item**: `wi_260609td5`
> **무엇에 대한 문서인가**: `agent-intelligence-memory-report.md`(이하 **메모리 보고서**)가 설계한 메모리/지식그래프 시스템을, ditto에 **네이티브 서브시스템(`ditto memory`)**으로 넣기 위한 설계. 왜 필요한지, 무엇을 어떻게 구현하는지, 대안보다 왜 나은지, ditto의 어디에 맞물려 어떤 가치를 주는지를 담는다.
> **데이터 계약의 권위**: 스키마(Zod, `src/schemas/memory-*.ts`)가 SoT다(ADR-0002). 이 문서는 설계 의도·근거·통합을 담고, 강제 규격은 스키마가 담는다.
> **작성일**: 2026-06-09 · **근거**: 메모리 보고서, `graphify-design-reference-companion.md`, 그리고 ditto 코드 실측(본문에 `파일:줄` 인용).

---

## 1. 왜 필요한가 — 오늘 ditto의 빈틈

ditto는 이미 **작업 단위(work item)**, **의도 계약(intent)**, **완료 계약(completion)**, **큐레이션된 지식(`.ditto/knowledge`: glossary·ADR)**, **결정적 코드 분석(`impact`·`codeql`)**을 갖췄다. 그런데 **"코드·문서·결정이 서로 어떻게 연결되는지에 대한, 출처가 달린, 세션을 넘어 지속되는, 질의 가능한 지도"가 없다.** 그래서 다음이 매번 비싸게 반복된다. (전부 코드로 확인한 사실이다.)

1. **에이전트가 매 세션 차갑게 시작한다.** autopilot가 researcher/planner 노드에 넘기는 위임 패킷(`DelegationPacket`)의 `context`는 `{work_item_id, file_scope, done_when, acceptance_refs}`뿐이다 [src/core/autopilot-dispatch.ts:16-20, 107-111]. **이전에 무엇을 발견했는지, 이 영역이 무엇과 얽혀 있는지에 대한 어떤 색인도 없다.** researcher는 grep·glob·read로 매번 코드베이스를 처음 보는 듯 탐색한다.

2. **지식 검색이 "제목 나열" 수준이다.** `.ditto/knowledge`는 CLAUDE.md로 투영되지만, 투영되는 건 **헤드라인뿐**이다 — ADR은 `id · status · 제목`, 용어는 이름만 [src/core/knowledge-bridge.ts:36-39, 111-125]. 본문은 경로 참조로만 남는다. "이 작업과 관련된 과거 결정"을 의미로 찾는 길이 없다. 에이전트가 직접 파일을 뒤져야 한다.

3. **컨텍스트 조립이 가볍고 수동이다.** `ditto context`가 만드는 컨텍스트 패킷은 goal·acceptance·git 상태를 적은 마크다운이고 [src/core/context-packet.ts:57-87], 명시 호출로만 생성되며 위임 경로에 자동으로 끼지 않는다. 즉 "관련 코드/결정/근거를 모아주는" 단계가 없다.

4. **근거(evidence) 추적이 코드 구조와 분리돼 있다.** `impact`가 심볼 영향 그래프를, `codeql`이 정적 분석을, `semantic`이 시그니처 변화를 결정적으로 계산하지만 [src/acg/impact, src/acg/boundary, src/acg/semantic], 이 결과들은 **한 번 쓰고 버려지는 일회성 산출물**이다. 지속되는 그래프로 누적되지 않아, "이 주장의 근거 경로", "이 함수가 어느 결정에 묶였나" 같은 질의를 싸게 못 한다.

**한 줄 문제 정의**: ditto의 컨텍스트·지식·근거가 **휘발성이고 출처가 약하고 질의 불가능**하다. 메모리 보고서가 겨냥한 정합성 문제(위키/그래프 불일치, 추측이 사실로 굳음, 낡은 주장)는 ditto가 이 지도를 갖는 순간 똑같이 생긴다. 그래서 **그래프를 도입하되, 보고서의 정합성 규칙을 처음부터 강제하는 설계**가 필요하다.

---

## 2. 무엇을 만드나

> **한 문장**: 코드·문서·결정을 **출처가 달린 단일 그래프**로 추출·저장하고, 에이전트가 세션을 넘어 **질의**하며, 그래프 쓰기는 **제안→승인**을 거치게 하는 ditto 서브시스템 `ditto memory`.

기능(능력) 목록:

- **scan** — 원본(코드·문서) 매니페스트화(해시·revision). 변경 감지의 기준.
- **build** — 결정적 구조 추출(코드) + 의미 추출(문서) → Graph IR → projection. 바뀐 것만(증분).
- **query / path / explain** — 그래프 탐색(BFS/DFS), 두 개념 간 경로, 한 노드 설명. **항상 출처·최신여부 동반.**
- **events / propose / approve** — 에이전트가 남기는 기억은 append-only 이벤트로. 그래프 쓰기는 **제안→승인** 후 재생성으로만.
- **status / audit** — 어디까지 최신인지, 고아·낡음·중복·모순 리포트.

---

## 3. 핵심 설계 결정과 대안

각 결정마다 **무엇을 고려했고 왜 이걸 골랐는지**를 적는다. (단순성 공리: 오늘 필요한 문제를 가장 작게 푼다.)

### 3-1. 그래프를 새로 만드나, graphify를 가져오나?

| 대안 | 내용 | 왜 채택/기각 |
|---|---|---|
| graphify 래핑 | graphify 스킬을 그대로 ditto에 붙임 | **기각.** 출처(provenance)가 약하고, `graph.json` 단일 가변 파일을 직접 고치며, 에이전트 답을 검토 없이 되써넣는다(보완문서 §5·§8). 보고서의 정합성 불변식과 정면 충돌. Python 의존도 추가. |
| **보고서 설계를 ditto 네이티브로 구축** | 출처·확실/추측 분리·proposal 쓰기를 스키마로 강제 | **채택.** 사용자가 "풀 설계부터"로 선택. graphify의 *작동하는 메커니즘*은 참고하되 정합성 규칙은 우리가 강제. |

graphify에서 **참고만** 하는 것: 추출 파이프라인 형태, confidence 보정 규율(0.5 금지), code-only fast path, 하이퍼엣지·rationale 엣지(보완문서 §2.3, §4).

### 3-2. 그래프 런타임 — 그래프 DB인가, 인프로세스인가?

| 대안 | 왜 채택/기각 |
|---|---|
| Memgraph/Neo4j를 런타임으로 | **기각(v0).** ADR-0005는 공유 DB(심지어 SQLite)를 거부하고 per-entity JSON·무서버를 못박았다. 서버 의존은 ditto의 핸드오프·머지 모델을 깬다. |
| **인프로세스 그래프(`graph-ir.json`에서 빌드) + 선택적 Neo4j export** | **채택.** 보고서도 "Memgraph는 projection일 뿐"이라 했으니 런타임만 교체. ditto 규모(개인/프로젝트)에선 인메모리로 충분. 대규모 분석이 필요하면 Neo4j export 어댑터(graphify의 `--neo4j` 모델)로 외부에서. **되돌리기 쉬움.** |

### 3-3. 구조 추출 — tree-sitter를 새로 까나, ditto 자산을 재사용하나?

| 대안 | 왜 채택/기각 |
|---|---|
| 새 tree-sitter 파이프라인 | **기각.** ADR-0006이 정적 분석 엔진을 **CodeQL 단일**로 통일했고, TS 컴파일러 직접 사용을 금지했다. 별도 파서는 그 결정과 충돌하고 중복. |
| **기존 `impact`·`codeql`·`semantic` 재사용** | **채택.** ditto는 이미 CodeQL로 심볼 해석(호출·import·type·시그니처)을 **결정적으로** 계산한다 [src/acg/impact/codeql-analyzer.ts, src/acg/boundary/codeql-edges.ts, src/acg/semantic/signature-codeql.ts]. 이 결과를 그래프의 EXTRACTED 엣지로 흡수하면 새 엔진 없이 확실한 구조를 얻는다. (§4-1 상술) |

### 3-4. 의미 추출 — 앱 안 LLM 호출인가, 에이전트 위임인가?

| 대안 | 왜 채택/기각 |
|---|---|
| 앱 코드가 직접 LLM API 호출 | **기각.** ditto는 LLM 키를 직접 들지 않고, 프로바이더는 호스트(Claude Code/Codex)가 쥔다. ADR-0001/제품 경계와 충돌. |
| **서브에이전트 fan-out 위임** | **채택.** ditto는 이미 autopilot에서 subagent 오케스트레이션을 한다. graphify와 동일한 모델(보완문서 §2.1). 새 에이전트 `memory-extractor`가 청크를 읽고 IR 조각을 낸다. |

### 3-5. 기존 `.ditto/knowledge`와의 관계 — 흡수인가, 별개인가?

| 대안 | 왜 채택/기각 |
|---|---|
| knowledge를 그래프로 흡수/대체 | **기각.** knowledge(glossary·ADR)는 **사람이 큐레이션한 저빈도 durable 지식**이고, 그래프는 **기계 추출 고빈도 source-grounded** 층이다. 휘발성·신뢰도가 다르다. 합치면 둘 다 망가진다(보고서 §6.2 중복 저장 금지). |
| **별개·상호보완** | **채택.** knowledge는 그대로. 접점만 명시: ADR/결정은 `event_type=decision`인 MemoryEvent로도 그래프에 들어오고, 그래프 audit가 모순을 찾으면 knowledge-curator로 승격. (§5-4) |

### 3-6. 의미 검색 — 임베딩 벡터 스토어를 까나?

**기각(v0).** 보고서도 graphify도 임베딩을 1차 수단으로 쓰지 않는다(graphify는 LLM 판단 유사도 + Leiden 군집). v0 검색은 **그래프 traversal + 라벨/식별자 매칭**으로 충분하다. 벡터 검색은 필요성이 증명된 뒤 별도 증분으로. (불필요한 추상화 금지.)

---

## 4. 기능별 설계 — 어떻게 구현하나

### 4-1. 구조 추출 (결정적, EXTRACTED) — ditto CodeQL 자산 흡수

코드에서의 확실한 관계는 **새로 파싱하지 않고** 기존 분석기 출력을 IR로 변환한다.

| ditto가 이미 내는 것 | 형태 | → IR 변환 |
|---|---|---|
| `impact`의 영향 노드 | `affected_nodes:[{kind:direct_caller/type_contract/…, path, symbol}]` [src/schemas/acg-impact-graph.ts] | Symbol 노드 + `CALLS`/`IMPLEMENTS` 엣지, `extracted_by:'impact'`, confidence EXTRACTED(1.0) |
| `boundary`의 import 엣지 | `DependencyEdge[from,to]` [src/acg/boundary/codeql-edges.ts] | Artifact 노드 + `IMPORTS` 엣지, `extracted_by:'codeql'` |
| `semantic`의 시그니처 변화 | `changes:[{file,symbol,before,after}]` [src/schemas/acg-semantic-scan-observation.ts] | Symbol 노드 properties(before/after) |
| `architecture-spec`의 layer/forbidden | `layers{can_call}`, `forbidden_dependencies` | Artifact의 `layer` property, 위반은 `CONTRADICTS` 후보 |

**핵심**: ditto의 이 산출물엔 출처(provenance)·confidence가 **없다.** 변환 단계에서 메모리 그래프 스키마가 그걸 **필수로 채운다**(extraction_run_id·extracted_by·source_revision). 즉 "확실한 구조 + 출처"가 결합된다.

### 4-2. 의미 추출 (추측, INFERRED) — subagent fan-out

문서·코드의 의미 관계(개념, 주장, 결정 이유, 의미 유사)는 `memory-extractor` 에이전트가 청크(파일 20~25개)를 읽고 IR 조각(JSON)을 낸다. graphify의 추출 규율 계승: EXTRACTED=1.0 / INFERRED 0.4–0.95 / AMBIGUOUS 0.1–0.3, "0.5 기본값 금지", 하이퍼엣지·`rationale_for` 지원. 이미 스키마로 강제돼 있다.

### 4-3. IR → projection (단방향 생성)

`graph-ir.json`(재생성 가능한 중간표현)에서 **서빙 그래프**(질의용 인접 구조)와 **위키**(사람용)를 단방향 생성. projection은 직접 수정 안 함 — 틀리면 원본/추출기 고치고 재생성. projection manifest가 "어느 원본 버전까지 반영했나"를 적어 freshness를 싸게 판정.

### 4-4. 질의 (출처·freshness 동반)

`query`(BFS/DFS)·`path`·`explain`은 서빙 그래프를 인프로세스로 읽어 답한다. 응답은 항상 `projection_id`·`generated_at`·`freshness`·`dirty_sources`를 동봉(보고서 §6.7) — 에이전트가 낡은 결과를 확정처럼 쓰지 않게.

### 4-5. 쓰기 (proposal → approval)

에이전트는 그래프에 직접 못 쓴다. `propose`가 **pending MemoryEvent**를 만들고, `approve`(사람/정책)가 승인하면 재projection 입력이 된다. 스키마의 approval invariant(approved는 approved_by+decided_at 필수, pending은 approved_by 금지)가 이를 강제. **graphify의 write-back 오염 경로를 닫는다**(보완문서 §5).

---

## 5. ditto와 맞물림 — 통합 지점과 가치

메모리 그래프는 **읽기 자문 층**으로 다음 지점에 끼운다. 각 지점은 비침습적(기존 필드에 선택적 추가)이고, 에이전트는 무시하고 차갑게 일해도 시스템은 돈다. (위치는 전부 코드로 확인.)

### 5-1. 위임 패킷 따뜻한 시작 (가장 큰 가치)
**어디**: `buildDelegationPacket`의 `context`에 선택적 `memory` 필드 추가 [src/core/autopilot-dispatch.ts:107-111].
**무엇**: researcher/planner 노드를 띄우기 직전, `(work_item_id, acceptance_refs, file_scope)`로 그래프를 질의해 관련 엔티티·이전 발견·관련 결정을 패킷에 넣는다.
**가치**: 노드가 **차갑게 재탐색하지 않는다.** "이 영역은 무엇과 얽혔나, 전에 뭘 찾았나"가 패킷에 이미 있다 → 재발견 비용·토큰 절감, 그리고 출처가 달려 환각 위험 감소.

### 5-2. 지식 투영을 "제목"에서 "관련도"로
**어디**: `renderKnowledgeSummary`/지식 브리지 투영 [src/core/knowledge-bridge.ts:111-125].
**무엇**: 지금은 ADR/용어를 헤드라인으로만 나열한다. 그래프가 "이 작업과 관련된 결정 top-N"을 골라 투영할 수 있다.
**가치**: 에이전트가 `.ditto/knowledge`를 손으로 뒤지지 않고, **관련 결정을 프롬프트 시점에** 본다.

### 5-3. 프롬프트 시점 사전 컨텍스트
**어디**: UserPromptSubmit 훅의 charter projection [src/hooks/user-prompt-submit.ts, src/core/charter.ts].
**무엇**: 활성 work item 로드 후, 프롬프트 키워드로 그래프를 질의해 "유사한 과거 작업/결정/반복 학습"을 charter에 덧붙인다.
**가치**: **중복 work item 감소, 빠른 범위 협상**(사용자가 과거 결과를 떠올림).

### 5-4. knowledge-curator ↔ audit 양방향
**어디**: knowledge-update 스킬/`knowledgeRecord` [skills/knowledge-update, src/schemas/knowledge-record.ts].
**무엇**: 결정은 그래프에 `decision` MemoryEvent로도 들어오고, 그래프 audit가 모순/중복 결정을 찾으면 curator로 승격 제안.
**가치**: 결정 중복·모순을 **그래프가 먼저 잡아** 큐레이션 품질을 높임.

### 5-5. 근거 경로 = 완료 증거
**어디**: verify/completion의 evidence [src/schemas/completion-contract.ts, evidence-record.ts].
**무엇**: `evidence_path` 질의가 "이 주장의 출처 source까지의 경로"를 돌려준다.
**가치**: 완료 계약의 증거를 **출처 인용으로** 채워, "증거 기반 완료"(prime directive) 게이트를 강화.

> **주의**: 이 통합들은 **설계 제안**이다(현재 동작은 위 인용으로 확인됨, 끼우는 코드는 후속 증분). 가치는 정성적으로만 적었다 — 정량 효과는 구현 후 측정 대상.

---

## 6. 데이터 계약 (증분 #1 — 구현 완료)

Zod 스키마로 정의·등록·검증 완료. (커밋 `fd86842`)

- `memory-source` — 원본 매니페스트(hash/revision/sensitivity).
- `memory-event` — append-only 이벤트 + approval invariant.
- `memory-graph-ir` — 노드/엣지/하이퍼엣지 + provenance + confidence 밴드 강제.
- `memory-projection-manifest` — projection 계보·freshness 입력.

검증: `schemas:export` 통과, tsc(내 파일 0에러), biome 클린, 불변식 런타임 safeParse 통과.

---

## 7. 저장·배포 레이아웃

```
.ditto/memory/                      (프로젝트 전역 — knowledge와 같은 tier)
  sources/<source_id>.json          ← SoT, git-tracked
  events/<event_id>.json            ← SoT, git-tracked
  ir/graph-ir.json                  ← 재생성 가능, gitignored
  projections/{manifest.json,graph.json,wiki/}  ← 재생성 가능, gitignored
```
ADR-0005(per-entity JSON·무서버) 준수. SoT(원본·이벤트)만 추적, 파생물은 무시.

배포: 스키마는 `bin/ditto`로 컴파일. 스킬(`skills/memory-graph`)·에이전트(`agents/memory-extractor`)는 `build:plugin`이 `dist/plugin`으로 복사. 소스 변경 시 `build && build:plugin` 후 재설치.

---

## 8. 구현 순서 (증분, 각 단계 독립 검증)

| # | 증분 | 검증 | 상태 |
|---|---|---|---|
| 1 | 데이터 계약 4 스키마 | schemas:export·tsc·lint·불변식 | **완료** |
| 2 | Store 4종 + `memory scan` + `events append/list` | scan이 변경 감지, 이벤트 append-only | 다음 |
| 3 | 구조 추출(`impact`/`codeql`/`semantic` 흡수)→IR builder→validator | 같은 source→같은 IR, provenance 검증 | |
| 4 | `memory build` 의미 추출(extractor fan-out)→IR 병합 | concept/claim이 출처와 함께 | |
| 5 | projection(서빙 그래프+위키)+manifest+`status` | freshness/dirty 확인 | |
| 6 | `query`/`path`/`explain`+`audit` | 출처 동반 응답, 고아/낡음/중복 리포트 | |
| 7 | `propose`/`approve` 쓰기 모델 | 직접 쓰기 없이 승인→재projection | |
| 8 | skill+extractor agent+build:plugin 배선 | `/memory-graph` 동작 | |
| 9 | 통합 끼우기(§5) + ADR + dialectic-review | 위임 패킷/투영/훅 자문 동작, 결정 기록 | |

---

## 9. 리스크 · 미결정

**리스크**
- 의미 엣지 오염 → confidence 분리 + propose/approve로 차단.
- ditto 산출물에 provenance 부재 → 변환 단계에서 필수 주입(§4-1).
- 인프로세스 그래프의 규모 한계 → ditto 규모에선 충분, 초과 시 Neo4j export 어댑터.
- scope creep → 보고서 전체가 크므로 증분별 독립 검증으로 통제. work item 단일 의도 유지.

**미결정 (사인오프/리뷰 권장)**
- §3-2 Memgraph 제거(v0) 등 분기 확정.
- Core API(HTTP)·MCP server를 v0에 넣을지(현재: 후속).
- §5 통합 지점을 이번 work item에 포함할지, 별도 work item으로 분리할지.
