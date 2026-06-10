# ADR-0013: 메모리 서브시스템 설계 — 인프로세스 그래프 · 2-tier 저장 · supersedes 승인 · 옵션 A 재범위

- 상태: accepted
- 결정 일자: 2026-06-10
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: ADR-0005 (런타임 산출물 저장 — per-entity JSON·무서버 준수), ADR-0011 (Distribution 축·session-rooting invariant — 멀티 repo 변형 비범위), ADR-0012 (3계층 격리 — dittoDir/localDir 경로 규약), `reports/design/memory-graph-plugin-design.md` §3-2·§7·§10-1·§10-2·§10-9, `reports/design/memory-graph-value-structure-assessment.md`, `src/core/ditto-paths.ts`

## 컨텍스트

DITTO에 코드·결정·핸드오프를 출처-동반 그래프로 묶어 cross-entity 맥락("이 코드/결정이 무엇과 얽혔나")을 질의 가능하게 하는 메모리 서브시스템을 더한다. 설계는 graphify류 그래프-위키 모델을 차용하되 ditto의 기존 기층(무서버 per-entity 저장 ADR-0005, 3계층 격리 ADR-0012, session-rooting ADR-0011)을 깨지 않아야 한다. 두 차례 dialectic-review를 거쳤다 — 라운드1은 계약 정합성, 라운드2는 증분 가치·시점 발화를 봤고 verdict=revise("그래프는 틀리지 않았으나 이르다 — 증명된 가치는 색인-shaped, 그래프 기계장치는 미검증 의미층용 과설계"). 본 ADR은 그 동결 결정 4건을 기록한다.

## 결정

### D1 — 그래프 런타임은 인프로세스 + 선택적 Neo4j export (§3-2)

- Memgraph/Neo4j를 **상시 런타임 서버로 두는 안을 기각**한다. 서버 의존은 ADR-0005가 못박은 무서버·per-entity JSON 모델과 ditto의 핸드오프·머지 모델을 깬다.
- 런타임 그래프는 `graph-ir.json`에서 **인프로세스로 빌드**한다. `query`/`path`/`explain`은 서빙 그래프를 인프로세스로 읽어 답한다.
- 대규모 분석이 필요하면 **선택적 Neo4j export 어댑터**(graphify의 `--neo4j` 모델)로 외부에서 처리한다. Neo4j는 projection일 뿐 SoT/런타임이 아니다.

### D2 — 저장은 SoT/파생을 가르는 2-tier (§7, §10-1)

- **SoT(sources/events)** = `dittoDir(root)/memory/`(Tier ②, git-tracked, per-entity JSON). 이것이 진실원.
- **파생물(ir/projections)** = `localDir(root,'memory',…)` 즉 `.ditto/local/memory/`(Tier ③, gitignored, 재생성 가능).
- SoT와 파생을 같은 서브트리에 둘 수 없다(파생을 `.ditto/memory/` 직하에 두면 git이 추적함) — 그래서 dittoDir/localDir로 가른다. **새 gitignore 특례 불필요**(기존 3계층 규약이 흡수).
- **event는 불변(append-only)**: 이벤트당 불변 JSON 파일(단일 JSONL 아님)이고, "append-only"는 파일 변형 금지 + `supersedes` 필드로 달성한다. ADR-0005의 git-tracked SoT 무충돌 머지를 위해 per-entity 파일을 강제한다.

### D3 — 승인은 원본 변형이 아니라 supersedes 새 불변 이벤트 (§10-2 F2)

- pending→approved 전이는 원본 이벤트 파일을 변형하지 않는다. 대신 `status=approved`(+`approved_by`+`decided_at`)이고 `supersedes=이전_event_id`인 **새 불변 이벤트를 append**한다(`'wx'` 플래그로 존재 시 실패 — 불변·TOCTOU 차단). 원본(pending) 파일은 그대로 남는다.
- **논리적 식별성 = supersedes 체인의 head**이지 단일 id가 아니다. reducer가 체인 head로 현재 상태를 해소한다. reject/supersede도 동일 메커니즘. 이로써 "불변 파일"과 "approval invariant"가 충돌 없이 양립한다.

### D4 — 옵션 A 재범위: measure-before-expand (§10-9)

- 라운드2 dialectic 결과를 반영해 **옵션 A**를 채택한다: 증명된 가치는 색인-shaped(capability + duplicateSearch 초과로 증명됨), 의미층(INFERRED 엣지)은 미검증 — 그래서 확실한 바닥 위에서 불확실한 상방을 bounded·measurable·reversible하게 짓는다.
- **이번 범위**: 엔진 척추(scan/events/structure IR/semantic 엔진/projection/query·path·explain·audit/propose·approve) + bootstrap ingest(기존 knowledge·closed handoff를 cold-start-0 제거) + **§5-1 warm-start push 1개만 배선·계측**.
- **게이트(이번 미배선, hit율 데이터 후 후속 work item)**: §5-2~5-5 push 확대, audit→curator 자동 트리거. query 사용 계측(opportunities/attempts/hits/actionable)으로 확장을 결정한다.
- **단일 플래그 되돌림**(`DITTO_MEMORY=off`): 비활성 1개로 전 기능 off, §5 통합은 전부 optional·fail-open이라 off 시 기존 경로, SoT/파생 삭제해도 코어 불변, 제거=command/skill/agent 등록 + optional-field read만 떼면 됨.

## 근거

- **D1**: 서버리스 유지가 ADR-0005·핸드오프·머지 모델을 보존한다. ditto 규모(개인/프로젝트)에선 인메모리로 충분하고, Neo4j는 필요 시 외부 export라 되돌리기 쉽다(ADR-0001 단순성).
- **D2**: 경로가 곧 정책(ADR-0012). per-entity JSON SoT는 무충돌 머지·git 감사를 보존하고(ADR-0005 D1), 파생은 localDir이 흡수해 신규 gitignore 특례 0.
- **D3**: 불변 이벤트 + supersedes 체인은 스키마 변경 0으로 "불변 파일"과 "approval invariant"를 양립시킨다. audit 불변 체인(ADR-0005 D3 정신)도 보존.
- **D4**: 가치는 도전하되 불확실 상방을 측정 후 확장 — dialectic 라운드2의 "과설계(이르다)" 지적을 비용 증명 게이트로 흡수한다. 비결정 의미 추출(리스크 A)은 쓰기 시점에 격리되고 읽기는 결정적이라 bounded.

## 대안 (기각)

- **Memgraph/Neo4j 상시 런타임 서버**: 서버 의존이 무서버·핸드오프·머지 모델 파괴. 기각(D1).
- **메모리 전체를 localDir(gitignored)에 두기**: sources/events SoT가 팀 공유·감사를 잃음. SoT는 dittoDir(D2).
- **events를 단일 append-only JSONL로**: git-tracked SoT의 무충돌 머지를 깸. 이벤트당 불변 파일(D2).
- **승인 시 원본 이벤트 변형**: "불변 파일"과 충돌. supersedes 새 이벤트(D3).
- **§5 5지점 push 전부 즉시 배선(전체 그래프 가치 가정)**: 의미층 미검증 — dialectic 라운드2 verdict=revise. measure-before-expand(D4).
- **(리스크 A) 쓰기 시 코드베이스 재검증 게이트 / 임베딩 결정적 유사도**: 전자는 INFERRED끼리 충돌에 무력(audit이 흡수), 후자는 타입 있는 의미 엣지 대체 불가 + ADR-0001/§3-6 닫은 결정 재개방. 둘 다 보류(재제안 방지 기록).

## 철회/재검토 조건

- 인프로세스 그래프가 ditto 규모를 초과해 성능 한계에 닿으면 → Neo4j export 어댑터를 상시 분석 경로로 승격 검토(D1).
- query 사용 계측의 **hit율이 게이트를 넘으면** → §5-2~5-5 push 확대 + audit→curator 자동 트리거를 후속 work item으로 배선(D4 게이트 해제).
- 멀티 repo workspace에서 workspace-루트 `.ditto/memory/`에 **변형**(scan-write/propose/approve/build)이 필요해지면 → ADR-0011 session-rooting scope-out 재개 대상(현 v0는 read/scan/projection 전용).
- 의미 추출 비결정성(리스크 A)이 confidence 분리 + propose/approve로 격리되지 못하는 사례가 나오면 → 보류한 쓰기 게이트/임베딩 대안 재검토.
- 단일 플래그 되돌림(`DITTO_MEMORY=off`)이 §5 통합 graceful-degrade를 실제로 보장하지 못하는 회귀가 나오면 → 4불변식(D4) 재검토.
- **knowledge↔memory 동기화** — bootstrap ingest는 수동 1회성이고(CLI `ditto memory bootstrap`만 호출), scan은 `.ditto`를 SKIP_DIRS로 제외하므로(src/core/memory-scan.ts), `.ditto/knowledge`(ADR/glossary) 본문을 수정하면 memory의 ingest 사본이 drift한다. **현재 정책**: knowledge 변경 후 `ditto memory bootstrap`을 재실행해 source를 갱신한다 — source는 content_hash가 다르면 다시 write되어 갱신되나, 불변(append-only) 이벤트 본문은 supersede 없이는 갱신되지 않는 한계가 있다(재실행은 동일 event_id를 graceful-skip). 이 drift가 실제 문제를 일으키면 → bootstrap 재ingest 자동화(예: githook) 또는 이벤트 supersede 경로를 후속 work item으로.
