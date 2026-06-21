# ditto memory vs GBrain — 현재 구현 비교 + "원래 의도 완성형" 상상 비교

- 작성일: 2026-06-17
- 비교 대상: ① ditto memory **현재 v0 구현**(코드 확인), ② **원래 의도대로 완성된 ditto memory**(Memgraph/Neo4j 런타임 + 의미층·push 전면 배선, 설계문서 기반 추론), ③ **GBrain** v0.42.47.0(별도 보고서 `gbrain-code-level-research.md`)
- 근거: ditto는 `src/core/memory-*.ts`·`src/schemas/memory-*.ts`·`reports/design/memory-graph-plugin-design.md`·ADR-0013/0015 직접 확인. gbrain은 직접 clone 정독. **추론**은 그렇게 표시.

---

## 0. 핵심 결론 먼저

**두 시스템은 현재도, 완성형이어도 다른 종(種)이다.**

- **GBrain** = "에이전트가 세상(사람·회사·미팅·아이디어)을 기억하게 하는 **RAG 검색 엔진 + 도메인 엔티티 그래프**." 핵심 가치는 *검색이 아니라 답을 합성*하는 것.
- **ditto memory** = "코드·결정·근거가 어떻게 얽혔는지 **출처·신선도 보장된 엔지니어링 거버넌스 그래프**." 핵심 가치는 *답 합성이 아니라 관계·출처·확신도를 자문(advisory)으로 제공*하는 것.

결정적으로, ditto는 **현재도 완성형 설계에서도 벡터 RAG(임베딩 검색)를 깔지 않기로 했다**(설계 §3-6 기각). 따라서 ditto를 "원래 의도대로 완성"해도 gbrain의 하이브리드 RAG·synthesis 레이어와 **경쟁하는 방향으로 자라지 않는다.** 더 풍부한 거버넌스 그래프가 될 뿐이다. "축소했기 때문에 gbrain에 못 미친다"는 프레임은 부정확하다 — 애초에 겨냥점이 다르다.

---

## 1. 현재 ditto memory 스펙 (코드 확인 요약)

| 항목 | 현재 구현 | 근거 |
|---|---|---|
| 런타임 | **인프로세스 그래프** — `graph-ir.json`에서 빌드, 무서버 | ADR-0013 D1, `memory-query.ts` |
| 저장 | 2-tier: SoT(`.ditto/memory/` per-entity JSON, git-tracked) ↔ 파생(`.ditto/local/memory/`, gitignored) | ADR-0013 D2 |
| 노드 타입 | `Source, Artifact, Symbol, DocumentSection, Entity, Concept, Claim, Decision, Episode, MemoryEvent, GraphReport` | `memory-graph-ir.ts:31` |
| 엣지 타입 | `CALLS, IMPORTS, EXTENDS, IMPLEMENTS, MENTIONS, ASSERTS, SUPPORTS, CONTRADICTS, SIMILAR_TO, RELATED_TO, RATIONALE_FOR, ALIAS_OF, SUPERSEDES` (+하이퍼엣지 `PARTICIPATE_IN/IMPLEMENT/FORM`) | `memory-graph-ir.ts:47` |
| 구조 추출 | 결정적 — 기존 ACG/CodeQL/impact 산출물 흡수(`absorbAcgIntoIr`), `EXTRACTED`(confidence=1.0) | `memory-ir.ts`, 설계 §4-1 |
| 의미 추출 | subagent fan-out(`memory-extractor`), 호스트 위임 LLM(ditto는 provider 직접 호출 안 함, ADR-0001), `INFERRED`(0.4–0.95)/`AMBIGUOUS`(0.1–0.3) | `memory-build.ts`, 설계 §4-2 |
| 검색 | 그래프 traversal(BFS) + 라벨/식별자 매칭. **임베딩/벡터 없음** | `memory-query.ts`, 설계 §3-6 기각 |
| 쓰기 | propose→approve→re-projection. 에이전트 직접 쓰기 금지. supersedes 불변 이벤트 | ADR-0013 D3 |
| 신선도 | **2축**(SoT↔파생 / 코드↔SoT), `code_drift`/`code_dirty`, 모든 읽기에 `projection_id·freshness·dirty_sources` 동봉 | ADR-0015 |
| 통합 | autopilot warm-start **1지점만** 배선(push), CLI는 pull. 자동 트리거 없음(measure-before-expand) | ADR-0013 D4, `memory-warmstart.ts` |
| 되돌림 | `DITTO_MEMORY=off` 단일 플래그로 전 자동경로 off, fail-open | `memory-flag.ts` |
| 규모 | memory core 약 **2.9k LOC** | `wc -l src/core/memory-*.ts` |

---

## 2. 현재 ditto memory vs GBrain (차원별)

| 차원 | ditto memory (현재 v0) | GBrain (v0.42) | 격차의 성격 |
|---|---|---|---|
| **목적** | 코드·결정·근거 거버넌스 지도 (자문) | 범용 에이전트 장기기억 + 답 합성 | **타깃 차이** |
| **저장 런타임** | 인프로세스 + JSON, 무서버 | Postgres/PGLite(WASM) 실 DB | gbrain이 무겁고 확장적 |
| **검색** | 그래프 traversal + 라벨 매칭 | 하이브리드 RAG(벡터 HNSW + BM25 + RRF + rerank + intent + contextual retrieval) | **gbrain 압도** (설계 철학 차이) |
| **답 합성** | 없음 (관계·출처만 반환) | synthesis + gap analysis ("모르는 것" 명시) | **gbrain 고유 능력** |
| **그래프 추출** | 코드 구조(결정적) + 문서 의미(LLM 위임) | 도메인 엔티티(zero-LLM 정규식) + contextual synopsis 재임베드 | 도메인 다름(코드 vs 사람/조직) |
| **확신도 계급** | EXTRACTED/INFERRED/AMBIGUOUS 강제(superRefine) | 명시적 계급 없음(엣지=사실로 적재) | **ditto 고유 엄격성** |
| **출처·신선도** | 2축 freshness, 읽기마다 envelope, code_drift 억제 | sync(git→DB)+soft-delete, page provenance | **ditto가 더 정교** |
| **쓰기 거버넌스** | propose→approve→re-project, 불변 이벤트, ADR 충돌 가드 | 페이지 직접 쓰기(takes만 큐) | **ditto가 더 보수적·감사 지향** |
| **자율 유지보수** | 수동(scan/build/project/audit), push 1지점 | dream cycle 24/7 + Minions 워커 풀 | **gbrain 압도** |
| **수집(ingestion)** | 코드·문서·ADR(저장소 내부) | Gmail/Calendar/X/Twilio/transcript 등 외부 커넥터 | **gbrain 압도** |
| **소비 인터페이스** | ditto autopilot/CLI 내부 전용 | MCP 서버(typed tool, 범용 호스트) | gbrain이 범용 |
| **멀티모달** | 없음(스키마에 image 슬롯만) | 이미지 임베딩·디코드(jsquash/heic/exifr) | gbrain 보유 |
| **성숙도/규모** | v0, 2.9k LOC, measure-before-expand | v0.42, 243k LOC, 857 tests, 프로덕션 146k pages | **gbrain 압도** |
| **provider 결합** | 직접 호출 안 함(호스트 위임, ADR-0001) | Vercel AI SDK로 직접 멀티 제공자 | 철학 차이 |

요약: 현재 ditto memory는 gbrain의 **부분집합도 아니고 축소판도 아니다.** 검색·합성·수집·자율성에서는 gbrain이 압도적이지만, **출처·신선도·확신도·쓰기 거버넌스**에서는 ditto가 더 엄격하다. 이건 "덜 만들어서"가 아니라 ditto가 *거버넌스*를 1급 가치로 두기 때문이다.

---

## 3. "원래 의도대로 완성된 ditto memory" 정의

원래 최초 의도와, 그 후 축소(measure-before-expand)로 게이트 뒤에 미뤄둔 것을 합치면, **완성형 ditto memory**는 다음을 갖는다. (출처: 설계 §3-2 / §5 / ADR-0013 D4 / ADR-0015 D4 — 미뤄진 항목들)

1. **그래프 DB 런타임 (Memgraph/Neo4j).** 인프로세스 대신 상시 그래프 DB로 대규모 traversal·Cypher 질의. — *단, 설계는 이걸 "projection일 뿐"이라 결론지었으므로, 완성형에서도 SoT는 여전히 JSON, Neo4j는 export 타깃.*
2. **의미층 전면 신뢰.** INFERRED 엣지를 게이트 뒤가 아니라 1급 소비. 의미 추출(subagent fan-out)이 코드+문서 전반에 상시 가동.
3. **push 5지점 전면 배선**(현재 1지점) — §5-1 warm-start + §5-2 지식투영을 "제목→관련도"로 + §5-3 프롬프트 시점 사전 컨텍스트 + §5-4 knowledge-curator↔audit 양방향 + §5-5 근거 경로=완료 증거.
4. **audit→curator 자동 트리거** — 고아·낡음·중복·모순을 자동 감지해 큐레이션 루프에 투입.
5. **(증분 ②~④) 세션 overlay·델타 빌드** — 미커밋 편집까지 그래프에 실시간 반영.

**여전히 안 하는 것(완성형에서도)**: 벡터 임베딩 RAG(§3-6 영구 기각), 답 합성(synthesis — ditto는 *자문* 모델), 외부 커넥터(Gmail 등 — ditto는 저장소 내부 대상).

---

## 4. 완성형 ditto memory vs GBrain

| 차원 | 완성형 ditto (상상) | GBrain | 누가 앞서나 |
|---|---|---|---|
| 그래프 규모/질의 | Neo4j export로 대규모 traversal·Cypher | Postgres 그래프 신호(relational arm) | **대등** (그래프 질의는 ditto-full, RAG는 gbrain) |
| 검색 패러다임 | 그래프 traversal + LLM 유사도 + 군집(graphify 모델), **벡터 RAG 없음** | 하이브리드 RAG(벡터 1급) | **여전히 다른 패러다임** — 직접 비교 불가 |
| 답 합성 | 여전히 없음 (자문) | synthesis + gap | **gbrain 고유** |
| 자율성 | push 5지점 + audit 자동 트리거 | dream cycle + Minions 데몬 | **근접하나 형태 다름** (ditto=작업단위 구동, gbrain=24/7 데몬) |
| 출처·신선도·확신도 | 2축 freshness + confidence 계급 (이미 1급) | sync + provenance | **ditto-full 우위** |
| 쓰기 거버넌스 | propose→approve + ADR 충돌 가드 (이미 1급) | 직접 쓰기 | **ditto-full 우위** |
| 수집 범위 | 저장소(코드·문서·결정) | 외부 세계(사람·미팅·메일) | **목적이 달라 비교 무의미** |
| 무서버/머지 | git-native, 핸드오프·머지 보존 | DB 중심(PGLite로 무서버 가능하나 머지 모델 아님) | **ditto 우위**(분산 협업·감사) |
| 멀티모달 | 미정(스키마 슬롯만) | 보유 | gbrain |
| 성숙도 | v1(상상) | 프로덕션 v0.42 | gbrain |

---

## 5. 핵심 통찰

### 5-1. "축소"가 격차를 만든 게 아니다
ditto가 Memgraph를 기각한 것은 **올바른 결정**이었다. 설계문서 자체가 "Memgraph는 projection일 뿐"이라 인정했고(§3-2), 상시 서버는 ditto의 핸드오프·머지·무서버 모델(ADR-0005)을 깬다. 완성형에서도 Neo4j는 export 타깃이지 SoT가 아니다. **즉 Memgraph 도입 여부는 gbrain과의 격차와 거의 무관하다** — gbrain은 그래프 DB가 아니라 RDB+벡터다.

진짜 축소는 **push 1지점(vs 5지점) + 의미층 게이트 + audit 수동**이다. 이게 메워지면 ditto memory는 "에이전트가 매 세션 차갑게 시작하는" 문제(설계 §1)를 훨씬 강하게 푼다. 하지만 그래도 gbrain의 검색·합성과는 다른 축에서 강해진다.

### 5-2. 두 시스템의 진짜 차이는 "검색 vs 거버넌스"
- gbrain은 **"무엇을 아는가"를 빠르고 풍부하게 꺼내는** 데 최적(하이브리드 RAG, 합성, 외부 수집, 24/7 강화).
- ditto memory는 **"무엇이 무엇에 왜 묶였고, 그게 최신인가, 확신할 수 있나, 누가 승인했나"를 보장하는** 데 최적(출처·2축 freshness·confidence 계급·propose/approve·ADR 충돌 가드).

gbrain을 ditto에 이식한다면 얻을 것: 검색 품질, 합성 능력, 외부 수집. 잃을 것: 무서버 git-native 머지, 엄격한 freshness/confidence 계급, 거버넌스 감사성. **ditto는 후자를 핵심 가치로 의도적으로 선택했다.**

### 5-3. 서로에게서 배울 점 (단순 격차가 아니라)
- **ditto가 gbrain에서 차용할 가치(완성형에서 검토할 만한 것)**: ① **contextual retrieval**(청크에 LLM synopsis 부착) — 의미 추출 품질↑, 단 ditto는 임베딩을 안 깔므로 "synopsis를 라벨/식별자 인덱스에" 적용하는 변형. ② **dream cycle류 페이즈 오케스트레이션** — ditto의 수동 scan/build/project/audit를 의미순서 페이즈로 묶기(단 24/7 데몬이 아니라 작업 경계 트리거). ③ **자가배선 즉시성** — gbrain은 *매 페이지 쓰기에* 엣지 추출. ditto는 build를 따로 돌림. 쓰기 후크로 당기면 freshness 격차↓.
- **gbrain이 ditto에서 차용할 가치**: ① **2축 freshness envelope + confidence 계급** — gbrain의 "stale heads-up"은 휴리스틱이지만 ditto의 code_drift/code_dirty + EXTRACTED/INFERRED/AMBIGUOUS는 형식화돼 있다. ② **propose→approve 불변 이벤트 + supersedes 체인** — gbrain의 직접 쓰기보다 감사·되돌림에 강하다. ③ **ADR 충돌 가드(ADR-0020)** — 추론 시점에 기록된 결정을 강제하는 거버넌스 메커니즘은 gbrain에 대응물이 없다.

---

## 6. 한 줄 정리

ditto memory를 "원래 의도대로 완성"해도 GBrain이 되지 않는다 — 그리고 그게 정상이다. GBrain은 *검색·합성·수집*의 깊이를 추구하는 범용 에이전트 기억이고, ditto memory는 *출처·신선도·확신도·거버넌스*의 엄격성을 추구하는 엔지니어링 작업 기억이다. Memgraph 축소는 격차의 원인이 아니라 올바른 단순화였고, 실제 미완 부분은 **push 5지점·의미층·audit 자동화**다. 그 부분이 메워지면 ditto는 "더 나은 RAG"가 아니라 "더 강한 거버넌스 그래프"로 자란다.

---

## 부록 — 미검증·추론 표시

- **추론**: "완성형 ditto memory" 정의는 설계문서의 미뤄진 항목(§5-2~5-5, ADR-0013/0015 게이트)을 합친 것으로, 실제 구현이 존재하지 않는다. 완성형의 동작 특성은 설계 의도에서 추론한 것.
- **자가보고**: gbrain의 벤치마크 수치(P@5 49.1%/R@5 97.9%)·운영 규모(146k pages)는 저자 자가보고, 제3자 미감사(별도 보고서 §14).
- 본 비교의 ditto 측 사실은 전부 코드/설계문서 1차 확인. gbrain 측은 직접 clone 정독(별도 보고서 근거).
