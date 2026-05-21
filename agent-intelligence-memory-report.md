# 에이전트 지능/메모리 구축 분석 보고서

작성일: 2026-05-15  
관점: source of truth와 정합성 유지 우선 설계, API/CLI 중심 제품화, MCP/Skill 기반 에이전트 접근  
범위: 코드, 문서, 스펙, 대화/작업 기록을 에이전트가 장기간 탐색하고 추론할 수 있는 지식/메모리 시스템으로 구축  
검토 대상: LLM Wiki, Graphify의 설계 개념, Memgraph

## 1. 핵심 결론

LLM Wiki와 GraphDB를 같이 운영할 때 가장 큰 리스크는 검색 성능이 아니라 **정합성**이다. 시간이 지나면 다음 문제가 생긴다.

- Wiki 요약과 GraphDB edge가 서로 다른 말을 한다.
- LLM이 추론한 관계가 사실처럼 굳어진다.
- 원문이 바뀌었는데 오래된 claim이 계속 검색된다.
- 같은 entity가 여러 node/page로 분산된다.
- 에이전트가 graph나 wiki에 직접 쓴 내용이 원문 근거 없이 누적된다.

따라서 이 시스템의 기본 원칙은 다음이다.

**LLM Wiki와 Memgraph는 source of truth가 아니다. 둘 다 raw source와 memory event에서 재생성 가능한 projection이어야 한다.**

또한 제품 경계는 MCP가 아니라 **Core API와 CLI**가 가져야 한다. MCP는 에이전트가 연결됐을 때 쓰는 선택적 adapter이고, skill은 에이전트가 적은 context로 제품을 올바르게 쓰기 위한 운용 레시피다. 즉 MCP와 skill은 제품의 진실 저장소도, 유일한 접근 경로도 아니다.

| 계층 | 역할 | Source of truth 여부 |
|---|---|---|
| Raw source / Git / Filesystem | 코드, 문서, 스펙, 로그, 원문 | Yes |
| Memory event log | 에이전트/사용자가 명시적으로 남긴 기억, 결정, 선호, 검증 결과 | Yes, 단 provenance와 review 필요 |
| Extraction run manifest | 어떤 source revision을 어떤 parser/model/schema로 처리했는지 기록 | Rebuild 기준 |
| Graph IR | 원문과 memory event에서 추출한 node/edge 중간 표현 | Compiled artifact |
| Core API | source, memory, graph, projection 상태에 접근하는 제품 계약 | Interface |
| CLI | 사람, skill, 자동화가 Core API를 호출하는 얇은 실행 표면 | Interface |
| LLM Wiki | 사람이 읽는 요약, 설명, 색인, synthesis | Projection |
| Memgraph | 질의 가능한 graph runtime, serving index, graph analytics backend | Projection |
| MCP tools | 에이전트가 API를 통해 graph/wiki/memory에 접근하는 선택적 tool adapter | Interface |
| Agent skill | 에이전트가 제품을 안전하게 사용하는 절차, 규칙, CLI/API 사용법 | Interface guide |

이 설계에서 Graphify는 도구로 도입하지 않는다. Graphify를 Memgraph 플러그인이나 vanilla Memgraph 기능으로 흉내 내는 것도 목표가 아니다. 참고할 것은 Graphify가 보여주는 **AST 기반 구조 추출, semantic extraction, confidence/provenance, graph analytics, audit report**라는 설계 원리다. 실제 구현은 별도 애플리케이션 계층이 담당하고, Memgraph는 그 결과를 저장하고 질의하는 runtime으로 둔다.

## 2. 전체 구조

권장 구조는 다음과 같다.

```text
Raw Source / Git / Filesystem
  ├─ code
  ├─ documents
  ├─ specs
  ├─ notes
  └─ logs

Memory Event Log
  ├─ user-approved memory
  ├─ agent observations
  ├─ decisions
  └─ review outcomes

        │
        ▼

Knowledge Graph Application
  ├─ source scanner
  ├─ parser adapters
  ├─ AST/structural extractor
  ├─ semantic extractor
  ├─ entity canonicalizer
  ├─ confidence/provenance manager
  ├─ Graph IR builder
  ├─ wiki compiler
  ├─ Memgraph loader
  ├─ audit/check runner
  ├─ Core API
  └─ CLI

        │
        ├──────────────► LLM Wiki
        │                 human-readable projection
        │
        ├──────────────► Memgraph
        │                 graph query/runtime projection
        │
        └──────────────► Audit Reports
                          consistency and health checks

        │
        ▼

Agent Access Layer
  ├─ Skill package
  │   ├─ operating rules
  │   ├─ CLI/API usage
  │   └─ fallback workflow
  │
  └─ Optional MCP adapter
      ├─ search_memory
      ├─ expand_node
      ├─ evidence_path
      ├─ impact_analysis
      └─ propose_memory_write
```

중요한 점은 LLM Wiki와 Memgraph가 서로를 직접 갱신하지 않는다는 것이다. 둘은 같은 raw source, memory event, extraction run, Graph IR에서 만들어지는 별도 projection이다. 서로 불일치가 나면 한쪽을 수동으로 고치는 것이 아니라, 공통 lineage를 따라 원인을 찾고 compiler/extractor를 고친다.

제품화 관점에서 중요한 점은 MCP를 중심에 두지 않는 것이다. MCP tool schema와 resource는 에이전트 context를 차지하고, 연결 환경에 따라 항상 사용할 수 있는 것도 아니다. 따라서 기본 제품 계약은 HTTP API와 CLI로 고정하고, skill은 그 계약을 어떻게 사용할지 알려주는 작은 지침으로 제공한다. MCP는 API를 감싸는 optional bridge로 둔다.

## 3. 역할 정의

### 3.1 Raw source

Raw source는 변경 가능한 현실의 원문이다. 코드, 문서, 스펙, 회의 메모, 작업 로그가 여기에 해당한다.

필수 metadata:

| 속성 | 의미 |
|---|---|
| `source_id` | stable id |
| `source_type` | code, markdown, spec, note, log 등 |
| `path` 또는 `url` | 위치 |
| `content_hash` | 내용 hash |
| `captured_at` | 수집 시각 |
| `revision` | git commit, file mtime, snapshot id 등 |
| `sensitivity` | public/internal/secret 등 |

Raw source는 되도록 수정하지 않는다. 수정이 필요하면 원문 자체의 변경 이력은 Git/Filesystem에 남기고, memory system은 새 source revision으로 본다.

### 3.2 Memory event log

에이전트 메모리에는 원문에서 직접 재구성할 수 없는 것이 있다. 예를 들면 사용자의 선호, 에이전트가 수행한 작업 결과, 사람이 승인한 결정, 검토 결과다. 이런 것은 GraphDB에 바로 쓰지 말고 append-only event로 남긴다.

예시:

```yaml
event_id: memevt_20260515_001
event_type: decision
actor: user
text: "에이전트 메모리에서 Graphify는 구현 대상이 아니라 설계 참고점으로만 둔다."
created_at: 2026-05-15T00:00:00Z
status: approved
sources:
  - source_id: chat_20260515
confidence_kind: EXTRACTED
sensitivity: internal
```

Memory event는 raw source와 함께 projection의 입력이 된다. 즉 Memgraph에 있는 `Decision` node는 직접 쓴 진실이 아니라 memory event에서 생성된 projection이다.

### 3.3 Graph IR

Graph IR은 parser/extractor와 Memgraph/Wiki 사이의 중간 계약이다. 애플리케이션은 먼저 IR을 만들고, 그 IR을 검증한 뒤 projection을 갱신한다.

```text
Node {
  id: string
  node_type: Source | Artifact | Symbol | DocumentSection | Entity | Concept | Claim | Decision | Episode
  name: string
  source_id?: string
  source_revision?: string
  source_span?: SourceSpan
  properties: map
}

Edge {
  id: string
  from: string
  to: string
  edge_type: CALLS | IMPORTS | EXTENDS | IMPLEMENTS | MENTIONS | ASSERTS | SUPPORTS | CONTRADICTS | SIMILAR_TO | RELATED_TO
  confidence_kind: EXTRACTED | INFERRED | AMBIGUOUS
  confidence_score: number
  provenance: Provenance
  valid_from?: timestamp
  valid_to?: timestamp
}
```

Graph IR을 두는 이유:

- Memgraph를 잃어도 재생성할 수 있다.
- extractor 버그를 테스트하기 쉽다.
- 같은 source를 다시 처리했을 때 diff를 계산할 수 있다.
- LLM Wiki와 Memgraph가 같은 입력에서 만들어졌는지 검증할 수 있다.
- schema migration을 DB에 바로 때리지 않고 중간 산출물에서 검증할 수 있다.

### 3.4 Projection manifest

Projection manifest는 특정 Wiki projection과 Memgraph projection이 어떤 입력 기준으로 만들어졌는지 기록하는 작은 계약 파일이다. 정합성 유지 비용을 줄이는 데 가장 중요하다. 모든 node/page를 매번 비교하지 않아도 manifest만 보고 "이 projection이 어떤 source revision까지 반영했는지"를 판단할 수 있다.

예시:

```yaml
projection_id: proj_20260515_001
generated_at: 2026-05-15T12:00:00Z
schema_version: memory-v1
graph_ir_version: ir_20260515_001
wiki_version: wiki_20260515_001
memgraph_loader_version: loader-v1
extractor_versions:
  ast: ast-extractor-v1
  semantic: semantic-extractor-v1
source_revisions:
  - source_id: src_docs_a
    path: docs/a.md
    hash: sha256:abc
    revision: file-mtime-or-snapshot-id
    git_commit: abc123def456 # optional
  - source_id: src_user_ts
    path: src/user.ts
    hash: sha256:def
    revision: file-mtime-or-snapshot-id
    git_commit: abc123def456 # optional
memory_event_until: memevt_20260515_120000
dirty_sources: []
```

`git_commit`은 선택 속성으로 두는 것이 좋다. Git으로 관리되는 코드/문서에는 매우 강한 lineage가 되지만, URL snapshot, DB row, 외부 문서, 대화 로그처럼 Git 밖의 source도 있기 때문이다.

Projection manifest 사용 규칙:

- Wiki와 Memgraph는 각각 자신이 반영한 `projection_id`를 가져야 한다.
- MCP tool은 query 결과에 가능하면 `projection_id`, `generated_at`, `dirty_sources`, `requires_source_verification`을 함께 반환한다.
- manifest의 `source_revisions`와 현재 source hash가 다르면 projection을 stale로 표시한다.
- Wiki와 Memgraph의 `projection_id`가 다르면 둘의 정합성을 가정하지 않는다.

## 4. Graphify에서 가져올 것과 가져오지 않을 것

가져올 것은 구현 방식이 아니라 설계 관점이다.

| 차용할 개념 | 애플리케이션 계층의 구현 책임 | Memgraph의 역할 |
|---|---|---|
| AST extraction | tree-sitter 등 parser로 symbol, import, call, inheritance를 추출하고 Graph IR로 정규화 | 구조 node/edge 저장과 traversal |
| Semantic extraction | LLM/문서 parser로 claim, concept, entity, decision, summary 추출 | 의미 node/edge 저장과 검색 |
| Provenance | 모든 node/edge가 source id, revision, span, extraction run을 갖게 함 | evidence path 질의 |
| Confidence | deterministic 사실과 inferred 후보를 분리 | confidence metadata filtering |
| Incremental update | file hash와 parser version으로 변경분만 재처리 | idempotent upsert와 stale edge 처리 |
| Graph analytics | 중심 node, cluster, bridge, duplicate, orphan, contradiction 후보 계산 | Cypher/graph algorithm 실행 또는 결과 저장 |
| Structural similarity | node2vec, graph feature, embedding으로 유사 후보 계산 | `SIMILAR_TO` 후보 저장과 질의 |
| Audit report | projection health check와 정합성 리포트 생성 | audit query backend |
| MCP access | agent용 목적별 read/write tool 제공 | controlled query backend |

가져오지 않을 것:

- Graphify CLI/skill을 운영 dependency로 두는 방식
- Graphify 출력 포맷을 기준 계약으로 삼는 방식
- Memgraph 플러그인만으로 Graphify를 복제하려는 방식
- LLM이 만든 semantic edge를 deterministic edge처럼 취급하는 방식

## 5. 정합성 규칙

### 5.1 Projection은 직접 수정하지 않는다

LLM Wiki와 Memgraph는 projection이다. 수동 수정이 필요하면 원칙적으로 raw source, memory event, extractor rule, canonicalization rule 중 하나를 수정하고 projection을 다시 만든다.

예외적으로 운영 중 hotfix가 필요하면 다음 metadata를 남긴다.

| 속성 | 의미 |
|---|---|
| `override_id` | 수동 보정 id |
| `reason` | 왜 projection을 직접 보정했는지 |
| `approved_by` | 승인자 |
| `expires_at` | 만료 또는 재검토 시점 |
| `supersedes` | 대체 대상 |

### 5.2 모든 claim과 edge는 provenance를 가진다

출처가 없는 지식은 메모리가 아니라 임시 메모다. 최소한 다음 속성이 필요하다.

| 속성 | 적용 대상 | 의미 |
|---|---|---|
| `source_id` | node/edge/wiki claim | 근거 source |
| `source_revision` | node/edge/wiki claim | source의 어느 버전인지 |
| `source_hash` | node/edge/wiki claim | 내용 검증용 hash |
| `source_span` | node/edge/wiki claim | line, page, timestamp 등 |
| `extraction_run_id` | node/edge | 어떤 실행에서 만들어졌는지 |
| `extracted_by` | node/edge | parser, LLM, node2vec, human 등 |
| `schema_version` | node/edge/wiki page | 어떤 schema로 생성됐는지 |

### 5.3 Deterministic과 inferred를 분리한다

Deterministic edge는 parser나 원문에서 확인된 구조 관계다.

```json
{
  "edge_type": "CALLS",
  "from": "orders.createOrder",
  "to": "payments.process",
  "confidence_kind": "EXTRACTED",
  "confidence_score": 1.0,
  "extracted_by": "tree-sitter"
}
```

Inferred edge는 LLM, node2vec, clustering, embedding similarity 등이 만든 후보 관계다.

```json
{
  "edge_type": "SIMILAR_TO",
  "from": "webhook.retry_policy",
  "to": "payments.retry_policy",
  "confidence_kind": "INFERRED",
  "confidence_score": 0.72,
  "extracted_by": "node2vec"
}
```

운영 규칙:

- `EXTRACTED`는 답변 근거와 영향 분석에 사용할 수 있다.
- `INFERRED`는 탐색 후보와 추천에 사용한다.
- `AMBIGUOUS`는 review queue에 넣고 자동 행동의 근거로 쓰지 않는다.
- edge type별로 허용되는 `confidence_kind`를 schema에서 제한한다.

### 5.4 Entity canonicalization을 별도 문제로 다룬다

GraphDB 정합성에서 가장 흔한 문제는 중복 entity다. 예를 들어 같은 파일, 함수, 문서 섹션, 개념이 여러 node로 생긴다.

필요한 장치:

| 장치 | 설명 |
|---|---|
| Canonical id rule | `artifact:<path>`, `symbol:<path>#<qualified_name>`처럼 id 규칙 고정 |
| Alias edge | 같은 대상을 가리키는 이름을 `ALIAS_OF`로 연결 |
| Merge proposal | 자동 병합하지 않고 후보를 만든다 |
| Review state | proposed, approved, rejected |
| Back-reference update | 병합 후 기존 edge의 이동/무효화 이력 보존 |

### 5.5 Full rebuild와 diff 검증을 정기적으로 수행한다

Incremental update는 운영 효율을 위한 것이고, 신뢰성은 full rebuild와 diff에서 나온다.

권장 검증:

| 검증 | 목적 |
|---|---|
| Full rebuild diff | 같은 source에서 같은 graph가 나오는지 확인 |
| Projection parity check | Wiki claim과 Graph claim이 같은 source lineage를 갖는지 확인 |
| Orphan check | source 없는 node/edge 탐지 |
| Stale check | source hash가 바뀐 뒤 남은 claim 탐지 |
| Duplicate entity check | canonical id/alias 후보 탐지 |
| Inferred edge usage check | 답변에서 inferred edge가 과도하게 쓰이는지 확인 |
| Contradiction check | `CONTRADICTS` 또는 semantic conflict 후보 탐지 |

## 6. 정합성 유지 비용을 줄이는 방법

정합성을 항상 완벽하게 유지하려고 하면 운영 비용이 빠르게 커진다. 더 현실적인 목표는 **어디까지 최신이고 어디부터 stale인지 싸게 알 수 있게 만드는 것**이다.

### 6.1 양방향 동기화를 금지한다

Wiki와 Memgraph가 서로를 직접 갱신하면 정합성 비용이 폭증한다.

피해야 할 구조:

```text
Wiki 수정 -> GraphDB 갱신
GraphDB 수정 -> Wiki 갱신
Agent 수정 -> 둘 다 직접 갱신
```

권장 구조:

```text
Raw source + MemoryEvent
        ↓
Graph IR
        ↓
Wiki projection
Memgraph projection
```

동기화 대상은 Wiki와 GraphDB가 아니라 공통 입력, Graph IR, projection manifest다.

### 6.2 Wiki와 GraphDB의 역할 중복을 줄인다

둘 다 같은 지식을 자세히 들고 있으면 정합성 비용이 커진다.

| 대상 | 많이 담을 것 | 적게 담을 것 |
|---|---|---|
| Memgraph | id, 관계, provenance, confidence, source span | 긴 설명문, 원문 본문 |
| LLM Wiki | 사람이 읽는 요약, 결정 이유, synthesis | 세밀한 관계 전체, edge dump |
| Raw source | 원문 | generated 해석 |
| MemoryEvent | 승인된 기억, 결정, 수정 | 대량 파생 정보 |

Wiki는 설명서, Memgraph는 관계 인덱스에 가깝게 둔다.

### 6.3 Dirty set 기반 incremental update를 사용한다

매번 전체 rebuild를 하지 않고 변경된 source만 dirty로 표시한다.

```text
file changed
  ↓
mark source_id dirty
  ↓
reparse only dirty source
  ↓
compute node/edge diff
  ↓
patch Memgraph
  ↓
regenerate affected wiki pages only
```

이를 위해 dependency index를 유지한다.

```text
source:docs/payment.md
  affects:
    wiki/concepts/payment.md
    wiki/claims/retry-policy.md
    node:concept:payment
    node:claim:retry-policy
```

### 6.4 Volatility별로 다르게 관리한다

모든 데이터를 같은 엄격도로 관리하면 비용이 커진다.

| 데이터 유형 | 전략 |
|---|---|
| 코드 AST 관계 | 변경 시 즉시 재추출 |
| 공식 문서/스펙 | hash 변경 시 재추출 |
| LLM semantic relation | batch 또는 lazy update |
| node2vec / `SIMILAR_TO` | 주기적 재계산, stale 허용 |
| Wiki synthesis | affected page만 재생성 |
| agent observation | pending event로 저장 후 승인 |

`CALLS`, `IMPORTS` 같은 deterministic edge는 신선해야 하고, `SIMILAR_TO` 같은 inferred edge는 stale을 어느 정도 허용해도 된다.

### 6.5 Inferred edge는 TTL 있는 후보로 취급한다

LLM 추론 관계나 node2vec 유사도는 진실이 아니라 추천 신호다.

```yaml
edge_type: SIMILAR_TO
confidence_kind: INFERRED
confidence_score: 0.72
expires_at: 2026-06-15T00:00:00Z
requires_review: true
used_as_evidence: false
```

이렇게 두면 잘못된 inferred edge가 생겨도 사실 오염이 아니라 후보 품질 문제로 제한된다.

### 6.6 Full rebuild는 검증 경로로 둔다

운영 경로는 incremental update가 맡고, full rebuild는 신뢰성 검증에 사용한다.

| 시점 | 작업 |
|---|---|
| 파일 변경 시 | dirty source incremental update |
| 매일 또는 주 1회 | full rebuild dry-run |
| release 전 | full rebuild + diff check |
| schema 변경 시 | full rebuild 필수 |

Full rebuild 결과가 현재 projection과 크게 다르면 projection을 손으로 맞추는 것이 아니라 extractor, canonicalizer, compiler 문제를 찾는다.

### 6.7 LLM에게 freshness를 같이 반환한다

MCP tool 응답은 결과만 주지 말고 projection 상태도 함께 줘야 한다.

```json
{
  "nodes": [],
  "projection_id": "proj_20260515_001",
  "generated_at": "2026-05-15T12:00:00Z",
  "freshness": "stale",
  "dirty_sources": ["src/payment.ts"],
  "requires_source_verification": true
}
```

그러면 LLM이 stale projection을 확정 근거처럼 쓰지 않고, 필요한 경우 raw source나 memory event로 내려가 확인할 수 있다.

## 7. LLM Wiki 운영 모델

LLM Wiki는 사람이 읽는 projection이다. Wiki의 목적은 빠른 이해, 검토, 탐색이다. 정답 저장소가 아니다.

권장 page 유형:

| Page | 역할 |
|---|---|
| `index.md` | 전체 지도와 주요 entry point |
| `sources/*.md` | source summary와 ingestion metadata |
| `entities/*.md` | 사람, 조직, 모듈, 파일, 제품 등 entity 설명 |
| `concepts/*.md` | 개념, 기술, 패턴 설명 |
| `claims/*.md` | 검증 가능한 주장과 근거 |
| `decisions/*.md` | 승인된 결정과 이유 |
| `reports/*.md` | audit, contradiction, stale, duplicate 리포트 |
| `log.md` | append-only 생성/갱신 이력 |

Wiki page frontmatter 예시:

```yaml
id: claim:graphdb-is-projection
page_type: claim
generated_from:
  - source_id: chat_20260515
    source_revision: rev_001
    source_hash: sha256:...
    source_span: "lines 1-40"
schema_version: memory-v1
projection_run_id: proj_20260515_001
confidence_kind: EXTRACTED
status: active
updated_at: 2026-05-15T00:00:00Z
```

Wiki 운영 규칙:

- Wiki page는 source id와 claim id를 가져야 한다.
- Wiki 본문만 보고 Memgraph를 갱신하지 않는다.
- Wiki에서 발견한 오류는 correction event나 extractor rule 변경으로 반영한다.
- 좋은 답변은 바로 wiki에 붙이지 말고 `Analysis` 또는 `Decision` event로 구조화한 뒤 projection한다.
- 오래된 page는 삭제보다 `status: stale` 또는 `superseded_by`로 처리한다.

## 8. Memgraph 운영 모델

Memgraph는 graph query/runtime이다. 저장할 것은 전체 원문이 아니라 질의에 필요한 graph surface다.

저장 추천 대상:

| Label | 의미 |
|---|---|
| `Source` | 원천 자료의 metadata |
| `SourceRevision` | source의 특정 hash/revision |
| `ExtractionRun` | parser/model/schema 실행 기록 |
| `Artifact` | 파일, 문서, 스펙 같은 산출물 |
| `Symbol` | 함수, 클래스, 타입, 모듈 등 코드 구조 |
| `DocumentSection` | 문서 섹션 |
| `Entity` | 사람, 조직, 제품, 모듈 등 명명된 대상 |
| `Concept` | 추상 개념, 패턴, 기술 |
| `Claim` | 검증 가능한 주장 |
| `Decision` | 승인된 결정 |
| `Episode` | 대화, 작업, 실행 기록 단위 |
| `MemoryEvent` | append-only memory event의 graph 표현 |
| `GraphReport` | audit/health check 결과 |

저장하지 말 것:

- 전체 source code
- 전체 AST
- Markdown 본문 전체
- 원문 chunk 대량 복제
- 필요 이상으로 큰 embedding payload

관계 예시:

| Relationship | 의미 | Confidence 기본값 |
|---|---|---|
| `HAS_REVISION` | source가 revision을 가짐 | `EXTRACTED` |
| `GENERATED_BY` | node/edge가 extraction run에서 생성됨 | `EXTRACTED` |
| `EXTRACTED_FROM` | claim/entity/symbol이 source revision에서 추출됨 | `EXTRACTED` |
| `CONTAINS` | artifact가 symbol/section을 포함 | `EXTRACTED` |
| `IMPORTS`, `CALLS`, `EXTENDS`, `IMPLEMENTS` | 코드 구조 관계 | `EXTRACTED` |
| `MENTIONS` | source/section이 entity/concept를 언급 | `EXTRACTED` 또는 `INFERRED` |
| `ASSERTS` | source/event가 claim을 주장 | `EXTRACTED` |
| `SUPPORTS`, `CONTRADICTS` | claim 간 관계 | `EXTRACTED` 또는 `INFERRED` |
| `SIMILAR_TO`, `RELATED_TO` | 유사/관련 후보 | `INFERRED` |
| `SUPERSEDES` | 새 claim/decision이 이전 것을 대체 | `EXTRACTED` |

Memgraph에서 유효한 기능:

| 기능 | 사용 방식 |
|---|---|
| Cypher traversal | source-grounded path, dependency, evidence path 질의 |
| Text search | identifier, path, exact term 검색 |
| Vector search | semantic pivot 검색. 단 source-grounded traversal과 결합 |
| PageRank/centrality | hub, 영향도 높은 node 탐지 |
| Community detection | 큰 graph를 주제/구조 cluster로 압축 |
| node2vec | 구조 기반 유사 후보 탐색 |
| MCP | agent에게 curated query/tool 제공 |

## 9. 애플리케이션 계층 설계

이 프로젝트에서 핵심 구현 대상은 Memgraph plugin이 아니라 별도 애플리케이션이다.

필수 컴포넌트:

| 컴포넌트 | 책임 |
|---|---|
| Source scanner | source 목록, hash, revision 계산 |
| Parser adapters | code/doc/spec별 parser 연결 |
| AST extractor | deterministic symbol/edge 추출 |
| Semantic extractor | claim/concept/entity/summary 추출 |
| Canonicalizer | id 정규화, alias/merge 후보 생성 |
| Graph IR builder | node/edge event 생성 |
| IR validator | schema, provenance, confidence 규칙 검증 |
| Projection compiler | Wiki와 Memgraph projection 생성 |
| Memgraph loader | idempotent upsert, stale 처리 |
| Wiki compiler | Markdown page 생성/갱신 |
| Audit runner | 정합성/품질 리포트 생성 |
| Core API | 제품의 안정적인 외부 계약 제공 |
| CLI | 사람, skill, 자동화가 API를 호출하는 thin client 제공 |
| Agent skill package | 에이전트용 사용 절차, 판단 규칙, CLI/API 호출법 제공 |
| MCP server | Core API를 감싸는 optional agent tool adapter 제공 |

처리 절차:

```text
1. scan sources
2. compute source hash and revision
3. parse changed sources
4. extract deterministic structure
5. extract semantic candidates
6. canonicalize ids
7. build Graph IR
8. validate provenance/confidence/schema
9. diff previous IR
10. update Memgraph projection
11. update LLM Wiki projection
12. run audit checks
13. expose Core API
14. expose CLI commands
15. publish/update agent skill
16. optionally expose curated MCP tools
```

### 9.1 제품 인터페이스 원칙

제품의 기본 인터페이스는 Core API와 CLI다. MCP는 LLM 전용 adapter이므로 여기에만 기능을 구현하면 제품이 특정 agent runtime에 묶이고, context 비용도 커진다.

권장 계층:

| 계층 | 책임 | 금지할 것 |
|---|---|---|
| Core API | source, memory event, IR, projection, audit에 대한 안정적 계약 | LLM별 prompt/workflow 내장 |
| CLI | API 호출을 스크립트/skill/사람이 쓰기 쉽게 래핑 | DB 직접 수정 |
| Agent skill | 적은 context로 제품 사용 절차와 판단 규칙 제공 | 대량 schema dump, 긴 문서 복제 |
| MCP server | API를 LLM tool/resource로 노출 | business logic, approval 권한, raw query 권한 |

API 예시:

```text
GET  /health
GET  /projection/status
POST /sources/scan
GET  /sources/{source_id}
GET  /search?q=...
GET  /nodes/{node_id}
GET  /nodes/{node_id}/expand
GET  /claims/{claim_id}/evidence
GET  /audit/latest
POST /memory-events/propose
GET  /memory-events/{event_id}
```

CLI 예시:

```text
memoryctl status
memoryctl search "retry policy"
memoryctl expand node:concept:payment --depth 2
memoryctl evidence claim:graphdb-is-projection
memoryctl propose decision --text "..." --source chat_20260515
```

CLI는 skill과 자동화의 기본 경로다. MCP가 연결되지 않은 에이전트도 skill만 읽고 CLI/API를 통해 같은 제품 기능을 사용할 수 있어야 한다.

### 9.2 Agent skill 제공 모델

Skill은 제품 자체가 아니라 에이전트용 운용 지침이다. 목표는 MCP를 항상 켜지 않아도 에이전트가 제품을 안전하게 쓰게 만드는 것이다.

Skill에 담을 내용:

| 항목 | 내용 |
|---|---|
| Trigger | 코드/문서/결정/메모리 근거를 찾아야 할 때 이 제품을 사용 |
| Access order | MCP가 있으면 MCP read tool 우선, 없으면 CLI/API 사용 |
| Freshness rule | projection이 stale이면 raw source 또는 memory event 확인 |
| Evidence rule | 답변에는 source citation과 evidence path 우선 사용 |
| Confidence rule | `INFERRED`는 후보로만 표시하고 확정 근거로 쓰지 않음 |
| Write rule | 직접 write 금지, `propose_memory_write` 또는 CLI proposal만 사용 |
| Escalation | approval, merge, raw query, rebuild는 사람/관리 경로로 넘김 |

Skill에 넣지 말 것:

- 전체 graph schema dump
- 긴 Wiki 본문 복사
- Memgraph 접속 정보나 secret
- raw Cypher 실행 권한
- approval/admin workflow를 자동 수행하는 절차

Skill은 짧아야 한다. 상세 schema, API spec, 운영 정책은 제품 문서나 API discovery로 빼고, skill에는 에이전트가 작업 중 즉시 따라야 하는 판단 규칙과 명령 예시만 둔다.

### 9.3 MCP 제공 모델

MCP는 context를 점유하므로 tool 수를 최소화한다. 제품 API 전체를 MCP로 그대로 노출하지 않는다.

권장 MCP tool:

| Tool | 역할 | 권한 |
|---|---|---|
| `projection_status` | projection freshness와 dirty source 확인 | read-only |
| `search_memory` | query 기반 node/page/claim 후보 검색 | read-only |
| `expand_node` | 특정 node 주변 graph 탐색 | read-only |
| `evidence_path` | claim/node의 근거 source path 확인 | read-only |
| `impact_analysis` | deterministic edge 기반 영향 분석 | read-only |
| `propose_memory_write` | pending memory event 생성 | propose-only |

MCP에 열지 않을 것:

- raw Cypher query
- approval/admin action
- full rebuild 실행
- source file 직접 수정
- secret 또는 민감 원문 반환
- 대량 graph dump

MCP tool 응답은 항상 `projection_id`, `generated_at`, `freshness`, `requires_source_verification`을 포함하는 것을 원칙으로 한다. 이렇게 해야 에이전트가 tool 결과를 최신 사실처럼 과신하지 않는다.

## 10. Agent write model

에이전트가 Memgraph나 Wiki를 직접 고치게 하면 정합성이 깨진다. 에이전트 write는 항상 proposal/event로 들어와야 한다.

권장 흐름:

```text
Agent observation
  ↓
propose_memory_write
  ↓
MemoryEvent(status=pending)
  ↓
policy check / human review / automatic validator
  ↓
MemoryEvent(status=approved or rejected)
  ↓
projection compiler
  ↓
Memgraph + LLM Wiki update
```

쓰기 tool 구분:

| Tool | 권한 |
|---|---|
| `search_memory` | read-only |
| `expand_node` | read-only |
| `evidence_path` | read-only |
| `impact_analysis` | read-only, deterministic edge 우선 |
| `propose_memory_write` | pending event 생성 |
| `approve_memory_event` | 사람 또는 별도 policy agent만 사용 |
| `merge_entity_proposal` | 중복 병합 후보 생성 |

## 11. Retrieval 전략

질문 유형별로 검색 방식을 분리한다.

| 질문 유형 | 우선 전략 | 근거 요구 |
|---|---|---|
| 정확한 값/목록/카운트 | Cypher direct query | node/edge provenance |
| 특정 주제 설명 | Wiki index + Memgraph evidence path | source citation |
| 코드/문서 영향 분석 | deterministic traversal | `EXTRACTED` edge 우선 |
| 비슷한 구조 찾기 | node2vec/vector 후보 + review 표시 | `INFERRED` 표시 |
| 결정 이유 확인 | Decision/MemoryEvent + source path | 승인 event |
| 모순 탐지 | claim graph + audit query | 양쪽 source citation |
| 다음 행동 추천 | procedural memory + current context | inferred는 후보로만 표시 |

답변 규칙:

- 최종 답변은 가능한 한 source citation과 evidence path를 함께 제공한다.
- inferred edge를 썼으면 추론 기반임을 명시한다.
- ambiguous edge만으로 결론을 내리지 않는다.
- Wiki summary를 인용하더라도 raw source 또는 graph provenance까지 내려갈 수 있어야 한다.

## 12. POC 순서

| 단계 | 작업 | 성공 기준 |
|---:|---|---|
| 1 | source inventory와 hash/revision manifest 작성 | source 변경 감지 가능 |
| 2 | MemoryEvent append-only 포맷 정의 | 에이전트/사용자 기억이 event로 저장됨 |
| 3 | Graph IR schema 정의 | node/edge/provenance/confidence 검증 가능 |
| 4 | Core API skeleton 구현 | health/status/search/propose endpoint가 동작 |
| 5 | CLI thin client 구현 | skill과 사람이 MCP 없이 API를 호출 가능 |
| 6 | Agent skill 초안 작성 | 에이전트가 freshness/evidence/write 규칙을 따름 |
| 7 | AST extractor 1개 언어부터 구현 | deterministic edge가 재현 가능 |
| 8 | Semantic extractor 최소 구현 | claim/concept/entity가 source span과 함께 생성 |
| 9 | Projection status/freshness API 구현 | stale/dirty source를 API와 CLI에서 확인 가능 |
| 10 | Memgraph projection loader 구현 | IR에서 idempotent upsert 가능 |
| 11 | LLM Wiki projection compiler 구현 | 같은 IR에서 wiki page 생성 |
| 12 | Full rebuild diff와 audit runner 구현 | stale/orphan/duplicate/inferred usage 리포트 생성 |
| 13 | MCP read-only adapter 연결 | MCP가 Core API만 감싸고 curated query만 수행 |
| 14 | Memory write proposal 연결 | direct write 없이 pending event 생성 |
| 15 | Review/approval 후 projection update | 승인된 event만 graph/wiki에 반영 |

## 13. 주요 리스크와 대응

| 리스크 | 설명 | 대응 |
|---|---|---|
| Source of truth 혼란 | Wiki, GraphDB, 원문이 서로 다른 말을 함 | raw source와 memory event만 진실로 두고 projection 재생성 |
| Semantic edge 오염 | LLM 추론 관계가 사실처럼 쓰임 | confidence_kind 분리, inferred edge review |
| 중복 entity | 같은 대상이 여러 node/page로 생김 | canonical id, alias, merge proposal |
| stale claim | source 변경 후 오래된 claim이 남음 | source_hash 비교, valid_to, superseded_by |
| projection drift | Wiki와 Memgraph가 다른 입력에서 생성됨 | projection_run_id, extraction_run_id 비교 |
| 직접 write 오염 | agent가 GraphDB/Wiki를 직접 수정 | MemoryEvent proposal만 허용 |
| MCP 중심 설계 | 제품 기능이 MCP tool 안에 갇히고 context 비용이 커짐 | Core API/CLI를 기본 계약으로 두고 MCP는 adapter로 제한 |
| skill/API drift | skill의 사용법이 실제 API/CLI와 달라짐 | skill validation, CLI smoke test, version 표시 |
| 권한 우회 | MCP나 skill이 approval/admin 기능을 자동 실행 | read-only/propose-only 원칙, admin 경로 분리 |
| prompt injection | source 안의 지시가 agent instruction으로 승격 | source는 데이터로만 처리, instruction 계층 분리 |
| 과도한 저장 | DB가 원문/AST/vector dump가 됨 | graph surface만 저장, raw는 Git/Filesystem에 유지 |
| 재현 불가 | DB 장애 후 graph를 다시 못 만듦 | Graph IR export, full rebuild, manifest 보존 |

## 14. 운영 판단

이 구조에서 성공 기준은 "GraphDB에 많이 넣는 것"이 아니다. 성공 기준은 다음이다.

- 원문에서 graph와 wiki를 다시 만들 수 있다.
- 모든 claim과 edge가 근거로 내려간다.
- deterministic relation과 inferred relation이 섞이지 않는다.
- 에이전트 write가 event/review 절차를 거친다.
- 제품 기능이 MCP가 아니라 Core API/CLI로 먼저 제공된다.
- skill은 짧은 운용 지침으로 유지되고 API/CLI와 drift가 나지 않는다.
- MCP는 optional adapter이며 read-only/propose-only 범위를 넘지 않는다.
- Wiki와 Memgraph가 서로를 직접 수정하지 않는다.
- 불일치가 생기면 projection을 수동 보정하는 대신 source, event, extractor, compiler를 고친다.

정리하면, LLM Wiki와 Memgraph를 같이 쓰는 가장 안전한 방법은 둘을 경쟁하는 지식 저장소로 보지 않는 것이다. LLM Wiki는 사람이 읽는 projection이고, Memgraph는 에이전트가 질의하는 projection이다. 진실은 raw source와 승인된 memory event에 있고, 애플리케이션 계층이 AST/semantic 정보를 관리해 두 projection을 일관되게 생성해야 한다.

제품화 관점에서는 Core API와 CLI가 기본 계약이고, skill과 MCP는 에이전트를 위한 접근 계층이다. Skill은 context-light operating manual로 두고, MCP는 API를 감싸는 optional bridge로 제한한다. 이렇게 해야 MCP가 없거나 context 예산이 작은 환경에서도 같은 제품을 사용할 수 있고, 정합성 규칙도 한곳에서 유지된다.

## 15. 참고 자료

- Andrej Karpathy, [LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
- safishamsi, [Graphify GitHub repository](https://github.com/safishamsi/graphify)
- Graphify, [README raw](https://raw.githubusercontent.com/safishamsi/graphify/main/README.md)
- Graphify, [ARCHITECTURE.md raw](https://raw.githubusercontent.com/safishamsi/graphify/main/ARCHITECTURE.md)
- Memgraph, [Neo4j Alternative: What are My Open-source Database Options?](https://memgraph.com/blog/neo4j-alternative-what-are-my-open-source-db-options)
- Memgraph Docs, [GraphRAG with Memgraph](https://memgraph.com/docs/ai-ecosystem/graph-rag)
- Memgraph Docs, [Knowledge graph creation](https://memgraph.com/docs/ai-ecosystem/graph-rag/knowledge-graph-creation)
- Memgraph Docs, [Atomic GraphRAG Pipelines](https://memgraph.com/docs/ai-ecosystem/graph-rag/atomic-pipelines)
- Memgraph Docs, [Indexes](https://memgraph.com/docs/fundamentals/indexes)
- Memgraph Docs, [Text search](https://memgraph.com/docs/querying/text-search)
- Memgraph Docs, [Vector search](https://memgraph.com/docs/querying/vector-search)
- Memgraph Docs, [node2vec](https://memgraph.com/docs/advanced-algorithms/available-algorithms/node2vec)
- Memgraph Docs, [Model Context Protocol](https://memgraph.com/docs/ai-ecosystem/mcp)
- Memgraph, [AI Memory with Memgraph](https://memgraph.com/ai-memory)
