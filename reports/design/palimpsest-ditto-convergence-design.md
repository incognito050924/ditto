> **work item**: (미등록 — 계획/의도 문서. 구현은 ditto/palimpsest 각 repo의 work item으로 분해)
> **무엇에 대한 문서인가**: ditto의 host-위임 의미 추출층과 palimpsest의 provider-free 지식그래프 substrate를 **하나의 지식 시스템**으로 수렴시키는 아키텍처 설계. ditto = 생산자(+소비자), palimpsest = substrate(적재·회상), 단일 온톨로지.
> **작성일**: 2026-07-04 · **근거**: 코드(ditto `src/`, palimpsest `src/palimpsest/`) + ADR(ditto ADR-0021/0013/0002, palimpsest ADR-20260701/20260702-*) — 인용은 `파일:줄`.
> **권위 주의(AGENTS.md:190)**: 이 문서는 **의도/배경**이다. 사실·계약의 권위는 코드·스키마(Zod SoT, ADR-0002)·ADR·SKILL이다. 여기 인용한 `파일:줄`이 drift하면 코드가 이긴다.

---

# palimpsest ↔ ditto 수렴 설계 — 단일 지식 시스템

## 0. TL;DR

두 시스템은 **같은 것을 절반씩** 만들고 있다.

- **ditto**: 코드/문서에서 의미(개념·주장·결정·관계)를 **생성**한다 — host-위임 LLM 추출(`ExtractFn` seam), 근거·confidence·2축 신선도·commit 결박, propose→approve→project 내구화. 그러나 그래프 substrate·회상은 서빙 그래프/wiki 수준.
- **palimpsest**: git 이력을 KG로 투영하고 **grounded 회상**한다 — Neo4j substrate, edge_kind 분리(deterministic/inferred), 근거결박 적재 계약, GraphRAG 회상, 브랜치 스코프 정체성. 그러나 의미층을 **절대 생성하지 않는다**(provider-free 불변식) — 외부 payload만 적재.

**ditto의 "외부"가 곧 palimpsest다.** ditto ADR-0021이 이미 이 분리를 결정: 메모리 시스템을 **별도 독립 프로젝트**로 떼고 ditto가 **consumer**로 소비(MCP/pluggable), git=SoT·graph=projection (`.ditto/knowledge/adr/ADR-0021-memory-seam-external-project.md:18-33`). palimpsest가 바로 그 독립 substrate, ditto는 그것의 **host-위임 생산자 + 소비자**.

수렴의 성립 조건 하나: **provider-free 경계를 시스템 경계로 승격**. palimpsest는 모델을 안 부른다(생성 0). 생성은 전부 ditto host가 위임 수행하고, 결과를 palimpsest 적재 계약(근거결박·no-laundering)으로 넘긴다. 두 시스템의 no-laundering 규율이 이미 동형이라 경계가 자연스럽다.

---

## 1. 왜 수렴하나 (근거: 철학이 이미 동일)

ditto `memory-system.md`(§고려사항)와 palimpsest `VISION`/`DESIGN.md`는 독립적으로 같은 결론에 도달:

| 원칙 | ditto | palimpsest |
|---|---|---|
| Graph substrate | GraphDB 도입(memgraph/neo4j) `memory-system.md` | Neo4j 5 Community `src/palimpsest/kg/ingest.py` |
| 근거결박·무환각 | confidence 3-class(EXTRACTED/INFERRED/AMBIGUOUS), no 0.5 default `src/schemas/memory-graph-ir.ts:5-9,98-125` | edge_kind 분리(deterministic/inferred), 세탁 금지, 적재 grounding |
| provenance | `memoryProvenance{source_id,source_hash,git_commit,...}` `memory-graph-ir.ts:69-79` | `source_commit/author/committed_at` per 노드·엣지 `kg/ingest.py:159-186` |
| 신선도 2축(commit 결박) | axis-1 SoT↔projection, axis-2 code↔SoT(`code_drift`) `src/core/memory-project.ts:561-570,620-689` | `code_bound_at` + `valid_from/valid_to`(결정계보) `kg/decision.py`, ADR-20260702-decision-lineage-freshness |
| git=SoT, graph=projection | ADR-0021 D3 `ADR-0021...:29-33` | ADR-20260626-foundational-architecture |
| 개인↔팀/브랜치 경계 | 개인/팀 분리, 브랜치별 신선도 `memory-system.md` | **브랜치 스코프 정체성 실현** `src/palimpsest/reconcile.py`, ADR-20260703 |
| 점진 회상(context rot 회피) | 필요 시점 부분 획득 `memory-system.md §목표4` | GraphRAG 점진 회상 + expand handle `recall/graphrag.py` |

두 시스템을 따로 두면 이 표의 모든 행이 **이중 구현 → drift**다. 수렴은 중복 제거이자 각자 강한 절반(ditto=생성 규율, palimpsest=substrate·회상·브랜치)을 합치는 것.

---

## 2. 현 상태 대조 — 무엇이 있고 무엇이 갭인가

### 2-1. ditto가 가진 것 (생산 기계장치, 재사용 대상)

- **host-위임 추출 파이프라인** `ditto memory build --semantic` (`src/cli/commands/memory.ts:394-519`, `src/core/memory-build.ts`): scan→chunk(결정론 22파일 `memory-build.ts:33,65-85`)→**host가 LLM 실행**(주입 `ExtractFn:(chunk)=>Promise<IrFragment>` `memory-build.ts:132,357-366`)→**결정론 merge**(`mergeIrFragments`, 순서무관 fold `memory-build.ts:190-320`). ditto는 provider를 **직접 호출 안 함** — host가 `memory-extractor`로 팬아웃(ADR-0001 인용; 실질 근거 ADR-0013+0016). **provider-free 경계의 ditto측 절반.**
- **secret 배제**: `sensitivity:'secret'`는 chunk 전 제거 — LLM 미도달 `memory-build.ts:73-75`.
- **memory-extractor 에이전트**(`agents/memory-extractor.md`): read-only, 출력 `{nodes,edges}`. 하드 불변: 모든 것에 `source_id`, `confidence_kind∈{INFERRED,AMBIGUOUS}`(EXTRACTED 금지 `memory-build.ts:88`), calibrated band(out-of-band=LOUD fail `memory-graph-ir.ts:98-125`).
- **내구화 propose→approve→project**: 에이전트 직접쓰기 금지(`memory.ts:904-906`), propose가 EXTRACTED→INFERRED 강등(`memory.ts:1184`), approve 원본불변+supersedes append(`memory.ts:1002-1004`), approved만 projection(`memory-event.ts:18-20`, `memory-project.ts:322`).
- **스키마 export**: `scripts/export-schemas.ts`→`schemas/*.schema.json`(**현존 유일 외부 emit 경로**).

### 2-2. palimpsest가 가진 것 (substrate·회상, 소비 계약)

- **온톨로지**(closed, `kg/ingest.py:56-60`): 결정론 `Repo·Package·File·Class·Method·Episode`(+`Community`·`CaptureManifest`), 의미 `Summary·Risk·DesignDecision·CommunityReport`. 엣지 결정론 `CONTAINS·CALLS·IMPORTS·DEPENDS_ON·MEMBER_OF`, inferred `SUMMARIZES·RISKS·DECIDES·SUPERSEDES·ADDRESSES_RISK·CAUSALLY_RELATES·RELATES_TO·CONFLICTS_WITH`.
- **적재 계약**(provider-free): claim ref가 코드 노드로 resolve(비해소 entity-atomic 거부), `edge_kind='inferred'` 강제(세탁 금지), provenance 강제. `kg/summary.py·risk.py·decision.py·relation.py`, ADR-20260701/20260702-*-load-contract.
- **회상**: GraphRAG 분리 채널(items/summaries/risks/decisions/relations/gaps/confidence), 역방향, 점진 확장. **N-way 브랜치 reconcile 회상** `reconcile_recall`.
- **CLI**: `ingest·backfill·query·load·reconcile`. `load`=외부 payload 적재 진입점.
- **불변식**: LLM **절대** 안 부름.

### 2-3. 갭

1. **생산자 부재(palimpsest)**: 로더·회상 완비, 실제 의미객체 **생성 없음** — 손으로 넣는 payload 의존. → ditto가 생산자.
2. **payload emit 부재(ditto)**: 자기 서빙그래프/wiki만 투영, **외부 소비자용 emit 없음**(스키마-JSON export만). → 신규 emit 층.
3. **노드 갭**: ditto `Decision`≈palimpsest `DesignDecision`✓; ditto `GraphReport`(enum만·**생산자 없음**)≈palimpsest `CommunityReport`(생산자 **있음** `kg/community.py`); ditto엔 전용 `Summary`·`Risk` **없음**(Claim/Concept 매핑) `memory-graph-ir.ts:31-45`.
4. **형상 갭**: ditto=관계형 `{nodes,edges}`, palimpsest=문서형 의미객체 JSON. → 매핑/emit 어댑터.

---

## 3. 단일 온톨로지 (수렴 핵심)

원칙: **palimpsest 온톨로지를 substrate SoT로, ditto의 confidence·provenance·신선도 규율을 그 위 governance로.** palimpsest는 이미 CPG 구조층·의미층 분리·edge_kind 세탁금지·브랜치 스코프까지 갖춘 substrate. ditto 강점은 스키마가 아니라 **생성 규율**(calibrated confidence, propose/approve, secret 배제).

### 3-1. 노드 매핑

| 개념 | ditto | palimpsest | 수렴 결정 |
|---|---|---|---|
| 코드 구조 | Source/Artifact/Symbol `memory-graph-ir.ts:31-45` | Repo/Package/File/Class/Method | palimpsest CPG를 SoT(tree-sitter 결정론) |
| 요약 | (전용 없음→Claim/Concept) | **Summary** `kg/summary.py` | palimpsest `Summary`, ditto 생성 |
| 위험 | (전용 없음) | **Risk** `kg/risk.py` | palimpsest `Risk`, ditto 생성(원래 C) |
| 결정 | **Decision** | **DesignDecision** | 동형 통합(`decision:<sha>`) |
| 커뮤니티 요약 | **GraphReport**(생산자 없음) | **CommunityReport**(생산자 있음) | palimpsest 검출 + ditto report 생성 |
| provenance | (source) | **Episode**(commit) | commit 스파인(브랜치 무관·이력 보존) |

### 3-2. 신선도·confidence·근거 통합

- **confidence**: ditto 3-class(calibrated band)를 palimpsest payload 필수 필드로. palimpsest `edge_kind='inferred'`=ditto{INFERRED,AMBIGUOUS}, `deterministic`=EXTRACTED. **두 세탁금지 규율 통합**: 생성물은 inferred 대역+confidence+source로만 적재, deterministic 위장 불가(palimpsest 로더 강제).
- **신선도 2축**: palimpsest `code_bound_at`=ditto axis-2(`code_drift`); `valid_from/valid_to`=계보축; ditto axis-1(SoT↔projection)=palimpsest `load <dir>` 재적재 멱등성. **브랜치 축**: palimpsest 브랜치 스코프 정체성이 ditto가 원한 "브랜치별 신선도(커밋해시 라벨)"를 구현 — 개인↔팀 = N-way reconcile.
- **grounding**: ditto `source_id→memorySource{path,git_commit}`=palimpsest claim ref→코드 노드 resolve. 통합 규칙: 생성 payload claim ref는 palimpsest 코드 노드 id로 resolve돼야 적재(비해소 거부) = ditto provenance-or-nothing.

---

## 4. 생산자 ↔ substrate 경계 (provider-free 불변식 = 시스템 경계)

```
  git repo
    │
    ├─(결정론: tree-sitter)──────────► palimpsest: 구조층 KG (ingest/backfill)   [생성 0]
    │
    └─(host-위임 LLM: ditto ExtractFn seam)
          │  ditto memory-extractor(host가 모델 실행) → {nodes,edges}
          │  ditto merge(결정론 fold, calibrated confidence, secret 배제)
          │  ditto propose → approve(사람/게이트) ──────────┐
          │                                                  ▼
          │  [NEW] palimpsest-payload emit 어댑터: approved → Summary/Risk/DesignDecision/CommunityReport JSON
          │                                                  │
          └──────────────────────────────────────────────────┘
                                                             ▼
                          palimpsest: load(근거결박·no-laundering·거부표면화)   [생성 0]
                                                             ▼
                          palimpsest: GraphRAG 회상(분리 채널·점진·N-way 브랜치)
                                                             ▲
                          ditto(소비자): MCP/pluggable로 회상 질의 (ADR-0021 consumer)
```

**불변식 보존**: 경계 왼쪽(생성)은 전부 ditto host-위임 — palimpsest 미관여. 오른쪽(적재·회상)은 전부 palimpsest — 모델 안 부름. 합쳐도 palimpsest "LLM 0" 유지. ditto "provider 직접호출 안 함"(host CLI spawn)도 유지.

**propose→approve→load 정렬**: ditto propose(EXTRACTED→INFERRED 강등)·approve(사람 승인, 원본불변)를 palimpsest **적재 전 게이트**로 재사용. approved만 `load`로 → 적재 계약(entity-atomic·no-laundering)과 이중 방어. git-tracked payload dir(`load <dir>`)이 approved-set SoT → drop 후 재적재 멱등(palimpsest durability ↔ ditto projection 동형).

---

## 5. 아키텍처 / 노출

- **substrate = palimpsest**(ADR-0021 "별도 독립 프로젝트"). git=SoT, Neo4j=재구축 projection. 소유: 온톨로지·적재계약·회상·브랜치/신선도.
- **생산자 = ditto host-위임 추출**(기존 `memory build --semantic` + 신규 palimpsest-payload emit 어댑터·extractor 변형).
- **소비자 = ditto**(ADR-0021: MCP OR pluggable로 palimpsest 회상 질의). palimpsest §5 노출 ⬜(MCP/스킬/pluggable)를 ADR-0021이 **소비 계약으로 확정** → palimpsest 노출 결정 입력.
- **경계 계약 = 스키마(Zod SoT)**: palimpsest load payload 스키마를 ditto `export-schemas.ts`에 등록해 양측 동일 JSON Schema 검증(단일 계약). AGENTS.md:190 — 계약은 코드/스키마, 이 문서는 의도만.

---

## 6. 빌드 로드맵 (증분 슬라이스 — 각 검증가능)

한 번에 안 한다. **payload 한 종류 얇은 수직 관통**부터 — ExtractFn seam이 있으므로 새 종류는 어댑터+에이전트 변형.

1. **경계 계약 고정(스키마)** — palimpsest 4종 payload를 Zod로 명문화, ditto `export-schemas.ts` 등록. *(검증: 기존 fixture payload 스키마 통과)*
2. **슬라이스 A — DesignDecision 관통**(최동형): ditto Decision 추출 → palimpsest DesignDecision emit → load → 회상 `decisions`. *(검증: 실 커밋 end-to-end, grounding 100%)*
3. **슬라이스 B — Risk 관통**(원래 C 핵심): 위험 추출 → Risk emit → 회상 `risks` + **품질 측정**(precision·recall@k·헛경보). palimpsest 표시만. *(검증: 라벨셋 recall@k, calibrated confidence의 헛경보 억제 기여)*
4. **슬라이스 C — Summary + CommunityReport**: palimpsest 커뮤니티 검출 위에 ditto GraphReport 생산자 신설(enum 슬롯) → CommunityReport emit → `recall_community`.
5. **소비 노출**: ditto→palimpsest 회상 MCP OR pluggable(ADR-0021 D1). palimpsest §5 결정 동반.
6. **완전 통합**: confidence 대역·2축 신선도·브랜치 축을 payload 스키마 1급으로. ditto propose/approve를 palimpsest 적재 전 게이트로 배선.

각 슬라이스 = **palimpsest lightweight WI + ditto WI** 쌍(계약은 스키마가 잇는다).

---

## 7. 미결 · 위험 · ADR 접점

**미결(결정 필요):**
- **소유권**: 경계 스키마 SoT는? (제안: palimpsest가 온톨로지·load 계약 SoT, ditto가 생성·소비, ditto가 import.)
- **propose/approve 강제 수준**: ditto 승인 워크플로 전체를 게이트로 쓸지, palimpsest 적재계약(entity-atomic)만으로 충분한지.
- **노출 메커니즘**(MCP vs pluggable) — ADR-0021 "OR" 열림. palimpsest §5와 결정.
- **ditto 로컬 memory graph 운명**: palimpsest로 완전이전 vs 로컬 서빙그래프 유지+palimpsest는 cross-repo/org 층(ADR-0021은 org/cross-repo 외부화 — 로컬 유지 여지).

**위험:**
- **온톨로지 통합 = 큰 재설계**(사용자 선택 "통합"). 억지 매핑 = 얕은 추상화(charter §4-3). → 슬라이스 1(스키마 계약)부터 실사용 검증, 빅뱅 금지.
- **provider-free 경계 누수**: 어댑터가 palimpsest에 생성 로직 흘리면 불변식 붕괴. → 어댑터는 **ditto측** 거주(approved→JSON 변환만), palimpsest는 load만.
- **confidence 대역 의미 전달**: palimpsest는 표시만이라 OK, 단 소비자가 band 의미 알아야.

**ADR 접점:**
- ditto: **ADR-0021**(외부 메모리 seam — 이 설계의 상위 결정), ADR-0013(memory-subsystem), ADR-0002(Zod SoT), ADR-0001/0016(host-delegation), ADR-0015(freshness).
- palimpsest: ADR-20260701-semantic-layer-load-contract, ADR-20260702-*-load-contract, ADR-20260702-decision-lineage-freshness, ADR-20260703-branch-scoped-node-identity, ADR-20260626-foundational.
- **ADR 후보(수렴 굳으면 승격)**: "palimpsest = ditto의 외부 지식 substrate(ADR-0021 실체화), 단일 온톨로지, provider-free 경계=시스템 경계" — 양쪽 상호참조 ADR.

---

## 8. 한 줄 요약

ditto는 지식을 **만들고**(host-위임, 규율 있는 생성), palimpsest는 지식을 **담고 꺼낸다**(provider-free substrate, grounded 회상). ADR-0021이 이 분리를 이미 결정했고 두 시스템의 근거·신선도·세탁금지 규율이 이미 동형이다. 수렴은 새 발명이 아니라 **중복 제거 + 경계 명문화** — provider-free를 시스템 경계로, palimpsest 온톨로지를 substrate SoT로, ditto 생성 규율을 그 위 governance로. 슬라이스 1(스키마 계약)→A(Decision)→B(Risk+품질)로 얇게 관통·실사용 검증.
