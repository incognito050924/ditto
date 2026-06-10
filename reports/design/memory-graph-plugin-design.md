# DITTO Memory-Graph Plugin — 설계

> **work item**: `wi_260609td5`
> **무엇에 대한 문서인가**: `agent-intelligence-memory-report.md`(이하 **메모리 보고서**)가 설계한 메모리/지식그래프 시스템을, ditto에 **네이티브 서브시스템(`ditto memory`)**으로 넣기 위한 설계. 왜 필요한지, 무엇을 어떻게 구현하는지, 대안보다 왜 나은지, ditto의 어디에 맞물려 어떤 가치를 주는지를 담는다.
> **데이터 계약의 권위**: 스키마(Zod, `src/schemas/memory-*.ts`)가 SoT다(ADR-0002). 이 문서는 설계 의도·근거·통합을 담고, 강제 규격은 스키마가 담는다.
> **작성일**: 2026-06-09 · **근거**: 메모리 보고서, `graphify-design-reference-companion.md`, 그리고 ditto 코드 실측(본문에 `파일:줄` 인용).
>
> ⚠ **가치·구조 평가 필독**: 이 설계의 §10 계약 정합성(dialectic 1라운드)은 통과했으나, **가치(증분 가치)와 구조(의도한 시점 발화)는 [memory-graph-value-structure-assessment.md](./memory-graph-value-structure-assessment.md)에서 별도 검증됐고 verdict=revise다** — 증명된 가치는 "색인-shaped"이고 그래프 기계장치는 미검증 의미층을 위한 것이라, 빌드 범위 재고(A′/A/원안) 결정 대기 중. 이 설계서를 "승인됨"으로 읽지 말 것.

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

> **동기화 한계 (knowledge↔memory).** ADR/glossary 본문을 memory로 끌어오는 길은 bootstrap ingest(증분, §10-9) 하나뿐인데, 이건 수동 1회성(CLI 호출)이고 scan은 `.ditto`를 제외(SKIP_DIRS)하므로 `.ditto/knowledge`를 수정하면 ingest 사본이 drift한다. **현재 정책**: knowledge 변경 후 `ditto memory bootstrap` 재실행으로 source를 갱신한다(source는 content_hash 변경 시 다시 write되나, 불변 이벤트 본문은 supersede 없이는 안 바뀜). 자동 재ingest/supersede는 drift가 실제 문제가 되면 후속 work item. (ADR-0013 철회/재검토 조건과 일관.)

### 3-6. 의미 검색 — 임베딩 벡터 스토어를 까나?

**기각(v0).** 보고서도 graphify도 임베딩을 1차 수단으로 쓰지 않는다(graphify는 LLM 판단 유사도 + Leiden 군집). v0 검색은 **그래프 traversal + 라벨/식별자 매칭**으로 충분하다. 벡터 검색은 필요성이 증명된 뒤 별도 증분으로. (불필요한 추상화 금지.)

### 3-7. cross-repo — 별도 지식 저장소를 두나, rooting으로 푸나?

선행 사례(hannes/boxwood-knowledge)는 지식을 **별도 git 저장소 + submodule**로 격리해 여러 코드 repo를 가로지르게 했다. ditto는 이걸 안 쓴다.

| 대안 | 왜 채택/기각 |
|---|---|
| 별도 지식 repo(submodule) | **기각.** submodule friction(원격 하드코딩·SSH·동기화)이 크고, 실측(boxwood-knowledge)에서 그 대가로 **커밋 단위 provenance를 잃었다**(파일 경로+timestamp만 남음). ditto의 `source_revision`이 더 정밀하다. |
| **`.ditto/memory/`를 rooting 지점에 — 단일 repo면 repo 루트, 멀티 repo면 workspace 루트** | **채택.** 멀티 repo 워크스페이스(예: `boxwood-workspace` git 루트가 하위 6개 repo를 clone·`.gitignore`로 제외하고 하네스 상태만 추적)에선 `.ditto/memory/`가 **그 workspace 루트에 앉아 하위 repo를 자연히 가로지른다.** 별도 repo·submodule·`knowledge://` federation 불필요. SoT(sources·events)는 workspace git이 버전 관리. ditto의 세션 rooting 모델(ADR-0011)·project-global tier가 그대로 workspace 루트에 적용될 뿐 — 새 tier 아님. |

**대가(설계 부채) — owning-repo provenance.** workspace git HEAD ≠ 코드 git HEAD다(하위 repo는 workspace에서 gitignore됨). 그래서 source 하나하나의 버전·신선도는 **소속 repo 기준**이어야 한다. `memory-source`에 **`repo` 식별 필드**가 필요하고(현재 `path`/`revision`/`git_commit`만 있어 멀티 repo에서 `path`가 어느 repo 기준인지·`git_commit`이 어느 repo 커밋인지 귀속 불가), scan이 각 source의 소속 repo를 해석해 그 repo의 HEAD를 revision으로 기록하고 staleness도 그 repo 작업트리 대비로 계산해야 한다. 단일 repo 케이스에선 `repo` 생략/단일값이라 비용 0. repo 식별 체계는 ditto의 기존 cross_repo 자산(ADR-0007 `internal_packages`, ADR-0011)을 재사용. **구현은 증분 #2(scan).**

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

**재현성 규율 — 비결정성(§9 "(A)")의 분산 통제.** LLM 의미 추출은 같은 입력에도 결과가 run마다 흔들린다(이건 *쓰기* 시점 성질이다 — 읽기/질의는 고정 IR 위 결정적 트래버설이라 안 흔들린다). 제거 대상이 아니라 **감수하되 분산을 싸게 줄이는** 대상이다. 세 가지로 통제한다(새 서브시스템 0개).

1. **구조화 출력 + 낮은 temperature + 고정 프롬프트·청크 경계** — 추출 흔들림을 입력단에서 최소화.
2. **concept 안정 ID + concept 수준 diff** — 엣지 표현이 살짝 달라져도 안정 ID로 묶여 build diff·freshness 판정에 "변경"으로 새지 않게. (재추출 노이즈가 변경 감지를 오염시키지 않음.)
3. **INFERRED = advisory 라벨 + propose/approve 게이트(§4-5)** — 흔들린 추측이 확실한 사실로 굳지 않게 격리. (이미 스키마·쓰기 모델로 강제.)

이 셋이 (A) 피해의 대부분을 싸게 막는다. 잔존 비결정성과 보류한 대안은 §9.

### 4-3. IR → projection (단방향 생성)

`graph-ir.json`(재생성 가능한 중간표현)에서 **서빙 그래프**(질의용 인접 구조)와 **위키**(사람용)를 단방향 생성. projection은 직접 수정 안 함 — 틀리면 원본/추출기 고치고 재생성. projection manifest가 "어느 원본 버전까지 반영했나"를 적어 freshness를 싸게 판정.

### 4-4. 질의 (출처·freshness 동반)

`query`(BFS/DFS)·`path`·`explain`은 서빙 그래프를 인프로세스로 읽어 답한다. 응답은 항상 `projection_id`·`generated_at`·`freshness`·`dirty_sources`를 동봉(보고서 §6.7) — 에이전트가 낡은 결과를 확정처럼 쓰지 않게.

### 4-5. 쓰기 (proposal → approval)

에이전트는 그래프에 직접 못 쓴다. `propose`가 **pending MemoryEvent**를 만들고, `approve`(사람/정책)가 승인하면 재projection 입력이 된다. 스키마의 approval invariant(approved는 approved_by+decided_at 필수, pending은 approved_by 금지)가 이를 강제. **graphify의 write-back 오염 경로를 닫는다**(보완문서 §5).

### 4-6. 갱신·자동화 경계 + audit 영속 (hannes 차용)

선행 사례(hannes)는 **싼·결정적 산출만 자동 재생성하고 비싼 LLM 추출은 수동**으로 갈랐다(post-commit이 vocab overlay만 자동, wiki는 `/graphify` 호출 시에만). ditto도 같은 원칙을 둘로 차용한다.

**(성능) 자동화 경계를 비용 등급으로 긋는다** — (A) 통제(§4-2)와 같은 결:

| 단계 | 비용 | 자동화 |
|---|---|---|
| scan (hash 매니페스트, §증분 #2) | 매우 쌈 | githook(post-commit) 등에서 자동 가능 |
| 구조 추출 → IR (CodeQL 흡수, §4-1) | 중간 | 변경된 source만 증분; 자동 가능하되 변경분 한정 |
| 의미 추출 (LLM, §4-2) | 비쌈·비결정적 | **자동 루프에 넣지 않음 — 명시 호출만** |

결과: commit마다 LLM 비용이 나지 않고, 그래프는 "구조는 최신 · 의미는 명시 시점" 상태로 수렴한다. ditto의 기존 post-commit githook 경로에는 scan(+선택적으로 구조 증분)만 얹고 의미 빌드는 제외한다. 이게 §4-2의 "LLM은 명시적일 때만"과 정확히 맞물린다.

**(관리) audit를 append-only 이력으로 남긴다** — hannes `log.md`/`lint_log.jsonl` 모델. audit(§증분 #6)를 일회성 리포트로 버리지 않고, 매 실행의 orphan/낡음/중복/모순 카운트를 **git-tracked append-only 이력**으로 기록한다. 그러면 drift를 단발이 아니라 **시계열**로 본다("orphan 3→9→14, 모순 0→2"). SoT events가 이미 append-only·git-tracked이므로 같은 패턴이고, 재계산 가능한 IR과 달리 "그 시점에 무엇이 orphan이었나"는 이력이 없으면 재현 불가라 보존 가치가 있다.

> **보류**: boxwood의 `knowledge://` 안정 URI는 multi-repo federation용이다. ditto는 단일 그래프라 §4-2의 안정 node ID가 인용·cross-link 핸들을 겸하므로 별도 URI 스킴은 두지 않는다(과한 추상화). 그래프 federation 필요가 증명되면 재고.

---

## 5. ditto와 맞물림 — 통합 지점과 가치

메모리 그래프는 **읽기 자문 층**이다. 소비는 두 방식으로 나뉜다 — 이 구분이 "누가 쓰나"의 답이다.

- **pull(능동 질의) — 에이전트 구분 없는 보편 능력.** `query`/`path`/`explain`은 CLI다(§4-4, §8). bash를 쓰는 **어떤 역할이든** 필요할 때 직접 부른다: researcher·planner·implementer·reviewer·verifier·security-reviewer·e2e·knowledge-curator, 그리고 **사용자와 대화하는 main agent**까지. "이 심볼이 뭐와 얽혔나", "전에 이건 왜 이렇게 결정했나", "이 영역 현황이 어떤가" 같은 **컨설팅·현황 파악 질문**이 여기 해당한다. **특정 노드에 묶이지 않는다.** 응답이 항상 출처·freshness를 달고 오므로(§4-4) 누가 부르든 낡은 결과를 확정처럼 쓰지 않는다.
- **push(자동 주입) — 콜드스타트 비용이 큰 지점만.** 아래 §5-1~5-5는 에이전트가 *묻지 않아도* 시스템이 관련 기억을 패킷·프롬프트·투영에 **미리** 넣어주는 지점이다. 모든 에이전트에 무차별 주입하면 토큰·노이즈 비용이 크므로, 재탐색 비용이 예측 가능하게 큰 곳만 고른다(그래서 §5-1이 researcher/planner로 좁다 — 전용이라서가 아니라 *자동주입 대상*이 그 둘이라서).

즉 **질의 능력 자체는 보편**이고, §5-1~5-5는 그 위에 *자동화*를 더한 특정 지점일 뿐이다. 각 지점은 비침습적(기존 필드에 선택적 추가)이고, 에이전트는 무시하고 차갑게 일해도 시스템은 돈다. (위치는 전부 코드로 확인.)

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

> **정정(ac-0 동결)**: 메모리는 **두 tier에 걸친다.** 기존 3-tier 규약(`src/core/ditto-paths.ts`: `.ditto/local/`만 gitignored, `.ditto/` 직하는 git-tracked) 검증 결과, SoT와 파생물은 같은 서브트리에 둘 수 없다(파생물을 `.ditto/memory/` 직하에 두면 git에 추적됨). 그래서 SoT는 `dittoDir`(Tier ②, tracked), 파생물은 `localDir`(Tier ③, auto-ignored)로 가른다. 새 gitignore 특례 불필요. 구현-등급 계약은 §10-1.

```
<rooting 루트>/.ditto/memory/        (Tier ②, git-tracked SoT — dittoDir, §3-7 rooting 지점)
  sources/<source_id>.json          ← SoT, per-entity JSON (멀티 repo면 repo 식별 포함)
  events/<event_id>.json            ← SoT, per-entity 불변 JSON (논리적 append-only)
<rooting 루트>/.ditto/local/memory/  (Tier ③, gitignored 파생물 — localDir)
  ir/graph-ir.json                  ← 재생성 가능
  projections/{manifest.json,graph.json,wiki/}  ← 재생성 가능
```
ADR-0005 준수: git-tracked SoT는 **per-entity JSON**(one-file-per-entity)이라 무충돌 머지가 설계상 보장된다 — 그래서 events도 단일 append-only JSONL이 **아니라** 이벤트당 불변 파일이고, "append-only"는 파일 변형 금지 + `supersedes` 필드로 달성한다. SoT(원본·이벤트)만 rooting 지점 git이 추적, 파생물은 `.ditto/local/`이 흡수해 자동 무시. 멀티 repo workspace에선 하위 코드 repo가 workspace에서 gitignore되므로 source의 `revision`/staleness는 소속 repo 기준(§3-7).

배포: 스키마는 `bin/ditto`로 컴파일. 스킬(`skills/memory-graph`)·에이전트(`agents/memory-extractor`)는 `build:plugin`이 `dist/plugin`으로 복사. 소스 변경 시 `build && build:plugin` 후 재설치.

---

## 8. 구현 순서 (증분, 각 단계 독립 검증)

| # | 증분 | 검증 | 상태 |
|---|---|---|---|
| 1 | 데이터 계약 4 스키마 | schemas:export·tsc·lint·불변식 | **완료** |
| 2 | Store 4종 + `memory scan` + `events append/list` **+ `memory-source`에 `repo` 식별 필드(§3-7)** | scan이 변경 감지·owning repo 해석, source `revision`이 소속 repo HEAD, 이벤트 append-only | 다음 |
| 3 | 구조 추출(`impact`/`codeql`/`semantic` 흡수)→IR builder→validator | 같은 source→같은 IR, provenance 검증 | |
| 4 | `memory build` 의미 추출(extractor fan-out)→IR 병합 | concept/claim이 출처와 함께 | |
| 5 | projection(서빙 그래프+위키)+manifest+`status` | freshness/dirty 확인 | |
| 6 | `query`/`path`/`explain`+`audit` **(append-only 이력, §4-6)** | 출처 동반 응답, 고아/낡음/중복 리포트 + audit 카운트가 시계열로 누적 | |
| 7 | `propose`/`approve` 쓰기 모델 | 직접 쓰기 없이 승인→재projection | |
| 8 | skill+extractor agent+build:plugin 배선 **+ 각 owner 프롬프트에 조건부 pull 습관 1줄** | `/memory-graph` 동작; 프롬프트에 pull 지침 존재 | |
| 9 | 통합 끼우기(§5) + ADR + dialectic-review | 위임 패킷/투영/훅 자문 동작, 결정 기록 | |

> **#8 pull 습관(§5 push/pull 구분 이행)**: owner agent(implementer·reviewer·verifier·security·e2e·researcher·planner·knowledge-curator) 프롬프트에 **조건부** 지침 한 줄을 넣는다 — "cross-entity 맥락(코드·결정이 뭐와 얽혔나)을 grep/explore로 파악하기 전에 `ditto memory query` 먼저; 결과가 빈약하면 평소대로 탐색; 단일 파일 편집 등 맥락 불필요 시 생략." **"항상 조회"는 금지**(강제 단계 → 무관 작업 토큰 낭비 + 초기 빈 그래프 노이즈). 조건부라 판단을 죽이지 않고 부트스트랩에 graceful degrade. push 대상은 §5-1~5-5에서 늘리지 않는다(비용 증명 후 별도).

---

## 9. 리스크 · 미결정

**리스크**
- **(A) LLM 의미 추출 비결정성** — 같은 source라도 INFERRED 엣지가 run마다 다를 수 있다. **쓰기(build) 시점 문제이며 읽기(query)는 결정적**이다(고정 IR 위 트래버설). 또한 변경 없는 source는 hash 게이트로 재추출 자체를 안 하므로(§증분 #2 scan) (A)는 source가 실제로 바뀌어 재추출될 때만 발동한다. **제거 불가, 감수 전제.** 분산 통제 = §4-2 (1)(2)(3). 잔존분은 confidence 분리 + propose/approve로 격리.
  - **고려 후 보류한 대안 2건** (재제안 방지용 기록):
    - ① *쓰기 시 충돌 → 코드베이스 재검증 게이트*. 충돌 상대가 **EXTRACTED(결정적 사실)** 일 때만 깨끗한 판정이 가능하고, INFERRED끼리의 충돌은 비결정 절차로 비결정 출력을 심판하는 꼴이라 효과가 약함. 이 좁은 케이스는 **audit(#6)의 모순 탐지**로 흡수하고 별도 쓰기 게이트는 보류.
    - ② *임베딩 기반 결정적 유사도*. 결정적이긴 하나 **타입 있는 의미 엣지(의존·인과·rationale)를 대체 못 하고**(§3-6), 임베딩 모델 인프라가 ADR-0001/§3-6에서 닫은 결정을 재개방. (A) 대응이 아니라 **검색 품질 후속 증분**으로 분리, 필요성 증명 후.
- ditto 산출물에 provenance 부재 → 변환 단계에서 필수 주입(§4-1).
- 인프로세스 그래프의 규모 한계 → ditto 규모에선 충분, 초과 시 Neo4j export 어댑터.
- scope creep → 보고서 전체가 크므로 증분별 독립 검증으로 통제. work item 단일 의도 유지.

**미결정 → 확정 (ac-0 동결, 2026-06-10 사용자 사인오프)**
- **§3-2 Memgraph 제거(v0)** → **확정.** 런타임은 인프로세스 그래프(`graph-ir.json`에서 빌드), 대규모 분석은 선택적 Neo4j export 어댑터. 상시 서버 없음.
- **Core API(HTTP)·MCP server** → **v0 제외, 후속 work item.** query/path/explain CLI로 v0 충분.
- **§5 통합 5지점** → **이번 work item에 포함**(사용자 v0 경계 선택 = 코어+§5). 증분 #9에서 비침습 배선(§10-6).

---

## 10. 구현-등급 계약 (ac-0 설계 동결)

> **목적**: 증분 #2~#9·§5를 *구현이 기계적으로 떨어지는* 수준으로 못박는다. 모든 계약은 실코드 패턴(`파일:줄`)에 근거하며, 서브에이전트 조사 초안에서 발견한 정정 2건(§10-1)을 반영했다. 이 절이 동결의 산출물이고, 빌드(autopilot)는 이 계약을 그대로 따른다.

### 10-1. 저장 tier·경로 계약 (정정 반영)

근거: `src/core/ditto-paths.ts:16-26`(`dittoDir`=Tier ② tracked, `localDir`=Tier ③ `.ditto/local/` gitignored), `.gitignore:477`(`​.ditto/local/`만 ignore), ADR-0005 D1(git-tracked SoT=per-entity JSON, 무충돌 머지).

| 엔티티 | 경로 | tier | 형태 | 근거 |
|---|---|---|---|---|
| source | `dittoDir(root)/memory/sources/<source_id>.json` | ② tracked | per-entity JSON | §7, ADR-0005 |
| event | `dittoDir(root)/memory/events/<event_id>.json` | ② tracked | per-entity **불변** JSON (supersedes로 갱신) | ADR-0005 |
| graph IR | `localDir(root,'memory','ir','graph-ir.json')` | ③ ignored | 단일 현행 스냅샷(재생성) | §4-3 |
| projection | `localDir(root,'memory','projections',…)` | ③ ignored | manifest.json + graph.json + wiki/ | §4-3 |

> **정정①**: 조사 초안은 전부 `localDir`(gitignored)에 뒀으나 §7은 sources/events를 git-tracked SoT로 요구 → SoT는 `dittoDir`. **정정②**: 조사 초안은 events를 단일 append-only JSONL로 제안했으나 ADR-0005가 git-tracked SoT의 무충돌 머지를 위해 per-entity 파일을 강제 → 이벤트당 불변 JSON, "append-only"는 파일 변형 금지 + `supersedes` 필드로 달성.

> **F4 (OBJ-12) — 멀티 repo rooting × ADR-0011 scope-out.** ADR-0011은 faithful(서브에이전트 위임) autopilot 쓰기가 **세션 repoRoot 안**에서만 허용되고 PreToolUse가 그 밖 쓰기를 차단함을 못박았다. workspace 루트의 `.ditto/memory/`에 *쓰는* 작업(scan-write·propose·approve·build)을 target 코드 repo에 rooting된 서브에이전트가 수행하면 scope-out에 막힌다. 그래서: **멀티 repo workspace에서 workspace-루트 `.ditto/memory/`는 read/scan/projection(읽기·조회·투영) 전용**으로 선언하고, *변형* 메모리 작업은 쓰는 repo에 rooting된 세션에서 돌린다. **단일 repo(공통 케이스, §3-7이 비용 0이라 한 그 케이스)는 workspace 루트=repo 루트라 영향 없음.** 더 넓은 멀티 repo 변형이 필요해지면 ADR-0011 재개 대상(현 v0 비범위).

### 10-2. Store 4종 계약

골격(근거 `src/core/work-item-store.ts`): `constructor(public readonly repoRoot: string)`, 경로는 private 메서드로 `dittoDir`/`localDir` 조합, IO는 `src/core/fs.ts`의 `readJson(path,schema)`·`writeJson(path,schema,value)`·`ensureDir(path)`. 스키마는 증분 #1 산출(`src/schemas/memory-*.ts`) 그대로 사용.

```
MemorySourceStore(repoRoot)        // .ditto/memory/sources/
  path(id) = dittoDir(repoRoot)/memory/sources/<id>.json
  get(id): Promise<MemorySource>           readJson
  write(s: MemorySource): Promise<MemorySource>  writeJson(memorySource)
  list(): Promise<MemorySource[]>          readdir → readJson each
  exists(id): Promise<boolean>

MemoryEventStore(repoRoot)         // .ditto/memory/events/  (불변 per-entity)
  append(e: MemoryEvent): Promise<MemoryEvent>   // 'wx' 플래그 write — 존재 시 실패(불변·TOCTOU 차단)
  get(id): Promise<MemoryEvent>
  list(): Promise<MemoryEvent[]>                 // created_at 정렬
```
**승인·갱신 모델 (F2 — OBJ-1/dialectic-1 해소, 스키마 변경 0).** 이벤트 파일은 절대 변형하지 않는다. pending→approved 전이는 *새 불변 이벤트*를 쓰는 것으로 한다: `status=approved`(+`approved_by`+`decided_at`, approval invariant 충족)이고 `supersedes=이전_event_id`인 새 이벤트를 `append`. 원본(pending) 파일은 그대로 남는다. **논리적 식별성 = supersedes 체인**이지 단일 id가 아니다 — `event_id`가 바뀌는 건 정상이고, reducer가 체인의 head로 현재 상태를 해소한다(아래 §10-4b). reject/supersede도 동일 메커니즘. 이로써 "불변 파일"과 "approval invariant"가 충돌 없이 양립한다.

파생물 store(재생성, gitignored):
```
MemoryGraphIrStore(repoRoot)       // .ditto/local/memory/ir/  (재생성)
  read(): Promise<MemoryGraphIr | null>
  write(ir: MemoryGraphIr): Promise<MemoryGraphIr>   // 전체 교체

MemoryProjectionStore(repoRoot)    // .ditto/local/memory/projections/  (재생성)
  readManifest(): Promise<MemoryProjectionManifest | null>
  writeManifest(m), writeServing(graph.json), writeWiki(dir)
```

> **D5 (OBJ-16)**: 증분 #2는 `memory-source`에 `repo` 식별 필드를 **추가**한다(default=scan repoRoot; 단일 repo면 생략/단일값으로 비용 0, §3-7). 즉 §10-2의 "스키마 그대로 사용"은 source 스키마엔 적용되지 않는다 — #2가 `memory-source.ts`를 고치고 `scripts/export-schemas.ts` 재실행 후 store를 구현한다. **D (OBJ-17)**: memory-* 4종을 `src/schemas/index.ts` barrel에도 추가(현재 `export-schemas.ts`엔 등록돼 `schemas:export`는 정상이나 barrel 누락 — 일관성 차원, #2에서).

### 10-3. CLI 표면 계약

근거: `src/cli/index.ts` subCommands 등록, `src/cli/commands/work.ts`(중첩 서브커맨드 패턴), `src/cli/util.ts`(`parseOutputFormat`·`writeJson`·`writeHuman`·`writeError`·`USAGE_ERROR_EXIT=65`·`RUNTIME_ERROR_EXIT=1`), `src/core/fs.ts:52 resolveRepoRootForCreate`.

- **파일**: `src/cli/commands/memory.ts` (단일 파일). 부모 `memoryCommand = defineCommand({ subCommands: {…} })`.
- **등록**: `index.ts`에 `import { memoryCommand } from './commands/memory'` + subCommands에 `memory: memoryCommand,`.
- **공통 핸들러 관례**: `parseOutputFormat(args.output)` → `resolveRepoRootForCreate()` → Store 인스턴스화 → 로직 → `format==='json'?writeJson(obj):writeHuman(text)`; 에러는 `writeError`+`process.exit`.

| 서브커맨드 | 증분 | 핵심 args | 산출 |
|---|---|---|---|
| `scan` | 2 | `--source-root`,`--output` | sources/* 갱신, 변경 리스트 |
| `events append` | 2 | `--type`,`--text`,`--source…`,`--output` | event JSON 1건 |
| `events list` | 2 | `--limit`,`--output` | 이벤트 목록 |
| `build` | 3,4 | `--semantic`(LLM 추출 포함 여부),`--output` | graph-ir.json |
| `query <node>` | 6 | `--depth`,`--output` | 이웃 + 출처·freshness |
| `path <from> <to>` | 6 | `--output` | 경로 + 출처 |
| `explain <node>` | 6 | `--output` | 설명 + 출처 |
| `status` | 5 | `--output` | freshness/dirty_sources |
| `audit` | 6 | `--strict`,`--output` | orphan/낡음/중복/모순 + 이력 append |
| `propose` | 7 | `--change`(JSON),`--reason` | pending MemoryEvent |
| `approve <eventId>` | 7 | `--by` | 승인 이벤트 + 재projection 트리거 |

모든 query/path/explain 응답은 `projection_id`·`generated_at`·`freshness`·`dirty_sources` 동봉(§4-4, ac-6).

### 10-4. 구조 추출 → IR 변환 계약 (증분 #3)

근거: `src/acg/impact/impact-graph.ts:90 produceImpactGraph`, `src/acg/boundary/codeql-edges.ts:38 CodeqlEdgeAnalyzer.edges`, `src/acg/semantic/signature-codeql.ts scanSignatureChanges`. **이 산출물엔 provenance·confidence가 없다 → 변환 단계가 필수 주입.**

**엣지 의미 정정 (D3 — OBJ-6/OBJ-7).** impact 분석기(`src/acg/impact/codeql-analyzer.ts:110-113`)는 call뿐 아니라 import/value 참조도 `direct_caller`로, 타입-위치 참조를 `type_contract`로 분류한다. 따라서 ACG `kind`를 IR `edge_type`로 강하게 단정하지 **않고**, 보수적으로 `RELATED_TO` + `properties.acg_kind=<원본 kind>`로 보존한다(원본 의미 무손실). 단 확실한 것만 좁혀 단정: boundary import→`IMPORTS`. 강한 의미 엣지(`CALLS`/`IMPLEMENTS`)는 그것이 실제 call/impl임이 분석기 출력으로 확정될 때만.

| ACG 산출 | → IR 노드 | → IR 엣지 | provenance / confidence |
|---|---|---|---|
| impact `affected_nodes[{kind,path,symbol}]` (9 kind 전부) | `Symbol`(id=canonical, §10-4a) | `RELATED_TO` + `properties.acg_kind`·`reason` 보존 | `extracted_by:'impact'`, EXTRACTED=**1.0** |
| impact `unresolved[{kind,path,reason}]` | `Artifact` | `RELATED_TO` + `properties.acg_unresolved_kind`·`reason` (cross_repo/journey_unknown 등 보존, OBJ-8) | `extracted_by:'impact'`, **AMBIGUOUS=0.1**, `requires_review:true` |
| boundary `DependencyEdge{from,to}` | `Artifact`(id=`artifact:<path>`) ×2 | `IMPORTS` | `extracted_by:'codeql'`, EXTRACTED=1.0 |
| semantic `changes[{file,symbol,before,after}]` | `Symbol` properties에 before/after | (선택) `SUPERSEDES` | `extracted_by:'codeql'`, EXTRACTED=1.0, `source_revision`=관찰 envelope의 `base_used`(D4 — OBJ-9; `acg-semantic-scan-observation.ts:30`의 envelope 필드, per-change 레코드엔 없음) |

> **D2 (OBJ-5) — no-silent-drop**: `acgAffectedNode.kind`는 9종(`acg-impact-graph.ts:14-24`: direct_caller/transitive_caller/type_contract/generated_client/test/external_surface/ui_surface/user_journey + unresolved kinds). 변환기는 **전 kind를 매핑하거나, 미지원 kind를 만나면 loud fail**(조용한 누락 금지 — 누락=provenance 구멍, 설계가 금지). #3에서 전체 매핑표 확정.

**§10-4a canonical node id (OBJ-11 결정성).** 같은 심볼이 impact·boundary·semantic에서 같은 노드로 병합되도록 id 규칙을 고정: `symbol:<repo-relative-path>#<symbol>`, `artifact:<repo-relative-path>`. 경로는 정규화(확장자 정책은 boundary가 이미 벗김 — 일관 적용). 결정성(ac-3)은 **run 메타(`generated_at`·`extraction_run_id`) 제외한 canonical content**(정렬된 nodes/edges) 기준으로 정의 — 같은 source→같은 canonical content. 변환 함수 `absorbAcgIntoIr({impact?, boundaryEdges?, semantic?}, xrunId): {nodes, edges}`는 순수·결정적, 출력은 id 기준 안정 정렬. confidence 밴드는 스키마 superRefine이 강제.

### 10-4b. event→IR reducer (F3 — OBJ-1/OBJ-2/OBJ-3, 증분 #5/#7 게이트)

SoT 이벤트는 projection 전에 **reducer**를 거쳐 IR에 합류한다(이게 없으면 승인 상태가 query에 안 보임 — OBJ-2):
1. **supersession 해소**: events를 `supersedes` 체인으로 묶어 각 논리 이벤트의 **head**만 남긴다(§10-2 승인 모델의 읽기 측).
2. **승인 필터**: head 중 `status=approved`인 것만 IR 노드/엣지로 방출(pending/rejected/superseded 제외). `event_type=decision`은 `Decision` 노드 + `rationale_for` 엣지.
3. **freshness 경계 정정 (OBJ-3)**: projection manifest의 freshness 기준은 단일 `memory_event_until`(임의 id·체인에서 무의미)이 **아니라** *reduced approved-set의 해시*(head event_id 집합의 정렬 해시). `memory_event_until`은 coarse 마커로만 보조. dirty 판정 = 현재 reduced-set 해시 ≠ manifest 기록 해시.

reducer 시그니처: `reduceEvents(events: MemoryEvent[]): {approvedHeads: MemoryEvent[], setHash: string}` — 순수·결정적.

### 10-5. 의미 추출 계약 (증분 #4)

`memory-extractor` 에이전트: 입력=청크(파일 20~25개 경로 + 내용), 출력=IR 조각 JSON(`{nodes,edges}`, 각 confidence_kind∈{INFERRED,AMBIGUOUS}, 출처 source_id 필수). main이 fan-out→병합. 재현성 통제 §4-2(1)(2)(3). `build --semantic` 일 때만 호출(기본은 구조만, §4-6 비용 등급). **provider는 호스트가 쥠** — ditto는 위임만(ADR-0001).

> **D1 (OBJ-10) — 병합은 결정적 reducer로, #4에서 구현하되 의무는 지금 동결.** concept 안정 ID = `concept:<normalized-label>`만으론 부족하다. #4는 다음을 만족하는 **결정적 merge reducer**를 ship해야 한다: (a) label 정규화 규칙 명문화(소문자화·공백/구두점 정규화·trim), (b) 충돌 시 정책(같은 concept id의 중복 노드는 1개로 fold, 엣지는 (from,to,edge_type) 기준 dedup, confidence 충돌은 max 또는 명시 규칙), (c) 엣지 id 파생 규칙, (d) 출력 안정 정렬, (e) **same-input→same-IR를 단언하는 golden fixture 테스트**(ac-3·§9(A) 결정성이 load-bearing). 알고리즘은 노드에서 짜되, "결정적이고 fixture로 고정"이라는 요구는 동결 계약이다. LLM 비결정성(§9 A)은 이 reducer로 흡수되지 않는 잔여는 §4-5 propose/approve로 격리.

### 10-6. §5 통합 5지점 삽입 계약 (증분 #9, 전부 optional·graceful degrade)

| # | 위치 | 현재 | 추가(optional) | degrade |
|---|---|---|---|---|
| 1 | `autopilot-loop.ts:213,277` 조회 → `autopilot-dispatch.ts:70` `buildDelegationPacket` | `buildDelegationPacket`는 **순수·동기** | **조회는 loop에서**(fail-open, async) 하고 결과를 optional `memoryContext`로 빌더에 *주입*; `DelegationPacket.context.memory?` 필드는 빌더가 받기만 함 (F5 — OBJ-14) | 조회 실패/부재 시 `memoryContext=undefined` → 기존 packet |
| 2 | `user-prompt-submit.ts`+`charter.ts` CharterContext | work item·handoff 투영 | task-relevant top-N를 **여기**(프롬프트 입력 있는 훅)서 주입 — `memoryGraphInsight?` 섹션 (F5 — OBJ-13: §5-2의 관련도 주입은 정적 knowledge-bridge가 아니라 이 경로) | 미구성 시 스킵 |
| 3 | `knowledge-bridge.ts:111-131` `renderKnowledgeSummary` | ADR/용어 헤드라인 **정적** 투영(sha-keyed, prompt 입력 없음) | **정적 유지** — task-relevance 주입 안 함(드리프트 sha·결정성 깨짐 방지, OBJ-13). 그래프 연계는 #2(위)로 이동 | 변경 없음 |
| 4 | `knowledge-record.ts` `knowledgeDecision` | id/title/status/rationale/… | `decision` MemoryEvent 연계 + audit 모순→curator 승격 | 기본 [] |
| 5 | `completion-contract.ts`/`evidence-record.ts` | evidence_records (스키마 슬롯 없음) | `evidence_path` 질의 결과를 담을 **optional 스키마 필드 신설**(OBJ-15) + export + 테스트 — 기존 evidence_ref 재사용 아님 | 기본 [] |

> 통합은 **기존 필드에 optional 추가만** — 침습 변경(시그니처 파괴) 금지. **단 비침습≠무수정**: #1은 loop 호출부 수정(조회 주입), #5는 스키마 필드 신설+export가 필요하다(OBJ-14/OBJ-15). "optional 추가"의 blast radius를 과소평가하지 말 것. 각 지점 "그래프 빈/부재/stale/손상 시 기존 경로 보존"을 fail-open 테스트 매트릭스로 증명(ac-9).

### 10-7. 증분 → acceptance → 검증 매핑

| 증분 | acceptance | 검증 |
|---|---|---|
| 2 | ac-1,ac-2 | scan 변경감지·repo 귀속 test+log, events 불변·invariant test |
| 3 | ac-3 | 같은 source→같은 IR(결정성) test, provenance 주입 검증 |
| 4 | ac-4 | extractor 출력 confidence 밴드·출처 동반 test+log |
| 5 | ac-5 | projection 생성·manifest freshness test |
| 6 | ac-6 | query/path/explain 출처 동봉 test+log, audit 시계열 누적 |
| 7 | ac-7 | propose=pending·직접쓰기 불가·approve→재projection test |
| 8 | ac-8 | skill/agent 존재·build:plugin 복사·pull 습관 1줄 test+diff |
| 9 | ac-9 | 5지점 optional·degrade test |
| (전 구간) | ac-10,ac-11 | ADR doc, bun test/tsc/biome/schemas:export 클린 log |

> **dialectic-review 게이트(ac-0)**: 라운드1 완료 → §10-8. must-fix 전부 반영됨.

### 10-8. dialectic-review 라운드1 — verdict·반영 ledger

`reviews/dialectic-1.json`(+.md) 참조. Producer(Claude)/Opponent(Codex, codex-plugin-cc 위임)/Synthesizer(Claude) 3역 분리. **verdict = revise** — 기반은 견고(불변식이 Zod superRefine로 강제, tier 정합, §5 graceful-degrade)하나, 무인 한번에 빌드엔 13개 admissible(critical 1·high 12) objection이 위협. 재설계 아닌 경계화된 보강으로 닫음. 전 objection이 실코드로 확인됨(기각 0). main agent가 2건 정밀화(아래 ※).

| edit | objection | 처리 | 반영 위치 |
|---|---|---|---|
| F1 | OBJ-4 | ※**정정**: 0.5는 INFERRED 밴드 내 정당값, 스키마 value-거부 안 함; ac-4 문구 "0.5 금지"→"0.5 기본값 금지(프롬프트 규율)" | intent ac-4, §10-5 |
| F2 | OBJ-1(crit) | 승인=`supersedes`+`status=approved` 새 불변 이벤트, 논리식별=체인 head | §10-2 |
| F3 | OBJ-2,3 | event→IR reducer(supersession 해소·승인필터) + freshness=reduced-set 해시 | §10-4b |
| F4 | OBJ-12 | workspace-루트 메모리=read/scan/projection 전용, 변형은 target-rooted | §10-1 |
| F5 | OBJ-13,14 | #1 조회는 loop서 async fail-open→순수빌더 주입; task-relevance는 훅(§5-2)이지 정적 knowledge-bridge 아님 | §10-6 |
| D1 | OBJ-10 | 결정적 merge reducer + golden fixture 의무 동결(알고리즘은 #4) | §10-5 |
| D2 | OBJ-5 | 미지원 kind = loud fail(조용한 누락 금지), 전체 매핑표는 #3 | §10-4 |
| D3 | OBJ-6,7 | edge_type 과단정 금지 → `RELATED_TO`+`acg_kind` 보존 | §10-4 |
| D4 | OBJ-9 | semantic `source_revision`=관찰 envelope `base_used` | §10-4 |
| D5 | OBJ-16 | #2가 `memory-source.repo` 추가(스키마 변경 명시), default=scan repoRoot | §10-2 |
| — | OBJ-8,11,15,17 | OBJ-8(unresolved kind/reason 보존)·OBJ-11(canonical content 결정성)→§10-4/10-4b; OBJ-15(evidence_path 스키마 슬롯 신설)→§10-6 #5; ※OBJ-17(barrel)→**강등**(export-schemas엔 등록됨, schemas:export 정상; barrel은 #2 일관성) | §10-4a,10-6,10-2 |

**열린 값-결정(사용자 확인 권장 1건)**: F2 승인모델은 "supersedes 체인" 방식으로 확정([DECIDED], 스키마 변경 0·감사이력 보존 우수). 별도 `approves_event_id` 필드 신설안은 기각(불필요한 스키마 확장). 승인 감사 의미가 더 엄격해야 하면 재고.

### 10-9. dialectic-review 라운드2 + 옵션 A 재범위 (가치·구조)

라운드1이 계약 정합성을 봤다면, 라운드2는 **가치(증분 가치)와 구조(의도한 시점 발화)**를 봤다. 전체 종합·근거는 [memory-graph-value-structure-assessment.md](./memory-graph-value-structure-assessment.md)(git-tracked). verdict=**revise**. 핵심: 증명된 가치는 "색인-shaped"이고 그래프 기계장치는 미검증 의미층(④)용이라 — **그래프는 틀리지 않았으나 이르다(과설계).**

**2026-06-10 사용자 결정 = 옵션 A (measure-before-expand).** 근거: "가치가 실재하면 도전하되, 확실한 바닥(capability + duplicateSearch 초과) 위에서 불확실한 상방(의미층)을 bounded·measurable·reversible하게." 엔진 척추는 짓고, push 소비는 1개로 좁혀 측정, 확장은 hit율 게이트.

**라운드2 required_edits → A 반영:**
| edit | objection | 처리 | 위치 |
|---|---|---|---|
| 가치 split 명시 | OBJ-R2-002 | EXTRACTED=day-1 net-positive(결정적), INFERRED=의미 coverage·fresh일 때만 조건부 | 본 절 + assessment §2 |
| push 의미-coverage/freshness 선결 | OBJ-R2-002/008 | value push는 의미 content 없거나 stale이면 주입 억제(빈/stale 안 실음) | intent ac-9, §10-6 |
| **bootstrap 증분 신설** | OBJ-R2-003/004 | 기존 .ditto/knowledge(ADR/glossary)+closed/archived handoff를 sources/events로 ingest → cold-start-0 제거 | intent ac-14, 아래 빌드순서 |
| 가치 AC | OBJ-R2-005/006 | query 사용 계측(opportunities/attempts/hits/actionable) + push 확대 hit율 게이트; ac-8을 실제 query 발화 검사로 | intent ac-12, ac-8 |
| stale-result 정책 | OBJ-R2-008 | stale 의미 source push 억제, 구조/의미 freshness 분리 | intent ac-9, §10-3 |
| **되돌림(reversibility)** | 사용자 명시 요구 | memory 전체를 단일 플래그로 비활성(비활성 시 §5 통합 graceful-degrade로 ditto 불변); 제거=command/skill/agent+optional-field read 제거로 충분 | intent ac-13 |
| (non-gating) push 4개로 재서술·evidence_path EvidenceRecord 종결 시만 gating | OBJ-R2-010/011 | §5-2 정적·§5-5 보조 | §10-6 |

**옵션 A 빌드 순서 (§8/§10-7을 이걸로 대체):**
#2(scan/events/repo) → #3(구조 IR) → **bootstrap ingest** → #4(semantic 엔진 — push 소비는 게이트) → #5(projection/status) → #6(query/path/explain/audit) → #7(propose/approve) → **§5-1 warm-start push 1개만 배선+계측** → #8(skill/agent/build:plugin/pull 습관) → ADR + 회귀게이트.
**게이트(이번 미배선)**: §5-2/5-3/5-4/5-5 push 확대, audit→curator 자동 트리거. ac-12 hit율 데이터 후 후속 work item.

**되돌림 설계 불변식**: ① memory 비활성 플래그 1개로 전 기능 off, ② §5 통합은 전부 optional·fail-open이라 off 시 기존 경로, ③ SoT(.ditto/memory/)·파생(.ditto/local/memory/)은 삭제해도 ditto 코어 불변, ④ 제거 = command/skill/agent 등록 + optional-field read만 떼면 됨. 빌드는 이 4불변식을 깨지 않는다.
