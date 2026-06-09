# DITTO Memory-Graph Plugin — 통합 설계

> **work item**: `wi_260609td5`
> **목적**: `agent-intelligence-memory-report.md`가 설계한 메모리/지식그래프 시스템을 **ditto 네이티브 서브시스템**(skills + bin CLI + 스키마 + dist/plugin)으로 구축한다. 이 문서는 보고서의 15개 컴포넌트를 ditto의 실제 스택(TypeScript/Bun · citty CLI · Zod-as-SoT · per-entity JSON · SKILL.md prose driver · subagent fan-out)에 매핑하고, 신규 스키마/명령/스킬/에이전트와 구현 순서, 그리고 보고서 대비 **의도적 분기**를 명시한다.
> **소비자**: 이 서브시스템을 구현·리뷰하는 엔지니어(=이후 증분의 구현 에이전트 포함).
> **권위**: 데이터 계약의 SoT는 보고서가 아니라 여기서 정의하는 **Zod 스키마**다(ADR-0002). 이 문서는 설계 의도와 매핑을, 스키마는 강제 계약을 담는다.
> **작성일**: 2026-06-09 · **근거**: 보고서(`agent-intelligence-memory-report.md`), 보완문서(`graphify-design-reference-companion.md`), ditto 코드베이스 실측(아래 인용).

---

## 0. 한눈에 보기

```
신규 서브시스템: ditto memory   (기존 ditto knowledge 와 별개·상호보완)

저장 (ADR-0005 per-entity JSON):
  .ditto/memory/
    sources/<source_id>.json        ← SoT: source 매니페스트 (git-tracked)
    events/<event_id>.json          ← SoT: MemoryEvent append-only (git-tracked)
    ir/graph-ir.json                ← compiled: Graph IR (gitignored, 재생성 가능)
    projections/manifest.json       ← compiled: projection 계보 (gitignored)
    projections/graph.json          ← compiled: 질의용 serving graph (gitignored)
    projections/wiki/               ← compiled: 사람용 wiki projection (gitignored)

스키마 (src/schemas/, Zod=SoT → schemas/*.schema.json 생성):
  memory-source.ts · memory-event.ts · memory-graph-ir.ts · memory-projection-manifest.ts

CLI (src/cli/commands/memory.ts → `ditto memory ...`):
  scan · events(append|list) · build · query · path · explain · status · audit · propose · approve · wiki

스킬/에이전트 (skills/, agents/ → dist/plugin):
  skills/memory-graph/SKILL.md     ← 운용 매뉴얼(user-invocable)
  agents/memory-extractor.md       ← semantic 추출 subagent (fan-out)
```

---

## 1. 설계 원칙 (보고서에서 그대로 계승)

보고서 §14의 성공 기준을 ditto에서 그대로 강제한다:

1. **raw source + 승인된 MemoryEvent만 SoT.** IR·projection은 전부 재생성 가능한 compiled artifact.
2. **deterministic / inferred 분리.** confidence_kind(EXTRACTED/INFERRED/AMBIGUOUS) + confidence_score를 스키마 레벨에서 강제(graphify의 보정 규율 채택: EXTRACTED=1.0, AMBIGUOUS 0.1–0.3, "0.5 기본값 금지").
3. **모든 node/edge에 provenance.** source_id·revision·hash·span·extraction_run_id를 스키마 필수/준필수로.
4. **양방향 동기화 금지.** projection 간 직접 갱신 없음 — 전부 IR에서 단방향 생성.
5. **agent write는 proposal 경유.** 직접 graph/wiki 수정 금지. `propose`→pending MemoryEvent→`approve`→재projection. (graphify가 빠뜨린 바로 그 불변식 — 보완문서 §5 참조.)
6. **projection은 직접 수정하지 않는다.** 불일치 시 source/event/extractor/compiler를 고치고 재생성.

---

## 2. ditto 스택 실측 (구현 기준점)

| 관심사 | 실제 위치/패턴 | 근거 |
|---|---|---|
| CLI 프레임워크 | `citty` `defineCommand`, root `src/cli/index.ts`의 `subCommands` 맵에 등록 | src/cli/index.ts:33-58 |
| 서브명령 구현 | `src/cli/commands/<name>.ts` 1파일/패밀리 | src/cli/commands/*.ts (23개) |
| 스키마 SoT | Zod (`src/schemas/*.ts`) → `zod-to-json-schema`로 `schemas/*.schema.json` 생성 | ADR-0002, scripts/export-schemas.ts |
| 스키마 등록 | `scripts/export-schemas.ts`의 `schemaExports` 배열에 수동 등록(누락 시 등록 테스트 실패) | export-schemas.ts:40-71 |
| 공용 프리미티브 | `src/schemas/common.ts` (isoDateTime, sha256, relativePath, evidenceRef, schemaVersion, *Id regex) | common.ts |
| 영속화 | per-entity JSON, `readJson/writeJson`(Zod 검증+atomic), append-only는 JSONL | ADR-0005, src/core/fs.ts:87-133 |
| 경로 헬퍼 | `dittoDir(root)`=`.ditto`(프로젝트전역), `localDir(root,...)`=`.ditto/local/...`(개인) | src/core/ditto-paths.ts:15-26 |
| Store 패턴 | `class XStore { constructor(repoRoot); path(); get/create/update }` | src/core/*-store.ts |
| 스킬 | `skills/<name>/SKILL.md` frontmatter(name/description/argument-hint/user-invocable), **prose driver**가 `bin/ditto` 호출 | skills/*/SKILL.md |
| 에이전트 | `agents/<name>.md` frontmatter(name/description/tools), `subagent_type`로 spawn, `KIND_TO_OWNER` 매핑 | agents/*.md, src/core/autopilot-graph.ts |
| 빌드 | `build:bin`→`bin/ditto`, `build:plugin`→`dist/plugin/`. **둘 다** 빌드 후 재설치 필요 | package.json, scripts/build-plugin.mjs |
| TS 분석 자산(재사용) | `ditto impact`(TS 심볼 해석), `ditto codeql`(정적 분석) | src/cli/commands/impact.ts, codeql.ts |

---

## 3. 보고서 15 컴포넌트 → ditto 매핑

| 보고서 §9 컴포넌트 | ditto 구현 | 비고 |
|---|---|---|
| Source scanner | `ditto memory scan` → `memory-source.ts` 매니페스트 | hash/revision은 git+mtime |
| Parser adapters | tree-sitter(코드) + 문서 reader | AST는 결정적·무료 |
| AST extractor | **ditto 기존 TS 심볼 해석(`impact`)/CodeQL 재사용** + tree-sitter | §6 분기 참조 |
| Semantic extractor | **`agents/memory-extractor.md` subagent fan-out** | graphify 모델 채택(보완문서 §2.1) |
| Canonicalizer | id 규칙(`artifact:<path>`, `symbol:<path>#<qn>`) + `ALIAS_OF` 엣지 + merge proposal | 보고서 §5.4 |
| Graph IR builder | `ditto memory build` → `memory-graph-ir.ts` | nodes/edges/**hyperedges** |
| IR validator | Zod + superRefine(provenance/confidence 밴드) | 읽기/쓰기 시 자동 |
| Projection compiler | IR → serving graph.json + wiki | 단방향 |
| Memgraph loader | **drop(v0). in-process graph + Neo4j export 어댑터** | §6 분기·ADR 후보 |
| Wiki compiler | `ditto memory wiki` → `projections/wiki/` | community별 1 article |
| Audit runner | `ditto memory audit` → orphan/stale/dup/contradiction/inferred-usage | 보고서 §5.5 |
| Core API | (v0는 CLI 우선, HTTP는 후속) | 보고서 §9.1 |
| CLI | `ditto memory ...` (citty) | thin client |
| Agent skill | `skills/memory-graph/SKILL.md` | 운용 매뉴얼 |
| MCP server | (후속) read-only + `propose_memory_write` 어댑터 | 보고서 §9.3 |

---

## 4. 신규 스키마 (Increment 1 — 이 설계의 기반)

Zod로 정의하고 `schemaExports`에 등록한다. confidence/provenance 불변식은 superRefine으로 강제.

- **`memory-source.ts`** — `source_id`, `source_type`(code|markdown|spec|note|log|chat|image|other), `path|url`, `content_hash`(sha256), `captured_at`, `revision`, `git_commit?`, `sensitivity`(public|internal|secret), `word_count?`. (보고서 §3.1)
- **`memory-event.ts`** — `event_id`, `event_type`(decision|observation|preference|review_outcome|analysis|correction), `actor`, `text`, `created_at`, `status`(pending|approved|rejected|superseded), `sources[]`, `confidence_kind`, `sensitivity`, `approved_by?`, `decided_at?`, `supersedes?`. superRefine: approved ⇒ approved_by+decided_at 필수; pending ⇒ approved_by 금지. (보고서 §3.2, §10)
- **`memory-graph-ir.ts`** — `provenance`(source_id/revision/hash/span/extraction_run_id/extracted_by/schema_version), `node`, `edge`(edge_type 13종 + confidence_kind + confidence_score + valid_from/to + expires_at + requires_review), `hyperedge`(nodes≥3), 컨테이너(`ir_version`/`extraction_run_id`/nodes/edges/hyperedges). superRefine: EXTRACTED⇒score=1.0, AMBIGUOUS⇒0.1–0.3, INFERRED⇒0.4–0.95. (보고서 §3.3 + 보완문서 §2.3, §4-1 hyperedge·rationale)
- **`memory-projection-manifest.ts`** — `projection_id`, `generated_at`, `graph_ir_version`, `wiki_version?`, `serving_version?`, `extractor_versions{}`, `source_revisions[]`, `memory_event_until`, `dirty_sources[]`. (보고서 §3.4)

---

## 5. CLI 표면 (`ditto memory`)

```
ditto memory scan <path>          # source 매니페스트 작성/갱신 (hash/revision)
ditto memory events append ...    # MemoryEvent 추가 (기본 status=pending)
ditto memory events list          # 이벤트 조회
ditto memory build [--deep]       # scan→AST→semantic(subagent)→IR→projection (dirty만)
ditto memory query "<q>" [--dfs] [--budget N]   # BFS/DFS traversal, freshness 동반 반환
ditto memory path "A" "B"         # 최단 경로
ditto memory explain "<node>"     # 노드 설명
ditto memory status               # projection freshness / dirty_sources
ditto memory audit                # orphan/stale/dup/contradiction/inferred-usage 리포트
ditto memory propose ...          # agent write → pending MemoryEvent (직접 write 금지)
ditto memory approve <event_id>   # 사람/정책 승인 → 재projection 입력
ditto memory wiki                 # wiki projection 생성
```

질의 응답은 보고서 §6.7대로 `projection_id`·`generated_at`·`freshness`·`dirty_sources`·`requires_source_verification`를 항상 동반한다.

---

## 6. 보고서 대비 **의도적 분기** (리뷰/사인오프 필요 — ADR 후보)

세 가지는 ditto의 기존 결정(ADR-0001/0005)과 정합을 위해 보고서를 바꾼다. 가치/되돌리기 관점에서 사용자·dialectic 검토 대상.

1. **Memgraph 제거 (v0).** 보고서는 Memgraph를 graph runtime으로 둔다. ditto는 "서버/공유DB 금지, per-entity JSON, 로컬"이 원칙(ADR-0005는 SQLite조차 거부). 따라서 v0는 **graph-ir.json에서 빌드한 in-process 그래프**로 질의하고, **Neo4j/Memgraph는 선택적 export 어댑터**(graphify의 `--neo4j`처럼)로 둔다. 보고서의 "Memgraph는 projection일 뿐"이라는 입장과 모순되지 않음 — projection 런타임만 교체. **되돌리기 쉬움**(어댑터 추가로 복구).
   - 영향: 보고서 §8(Memgraph 운영 모델)은 v0에서 미적용, export 어댑터 스펙으로 축소.

2. **AST 추출은 ditto 기존 TS 분석 재사용.** 새 tree-sitter 파이프라인을 처음부터 만들기보다 `ditto impact`(TS 심볼 해석)·`ditto codeql`을 1차 코드 추출원으로 재사용. 비-TS 언어는 후속에 tree-sitter 추가. **단순성 우선**(MVP 공리).

3. **Semantic 추출 = subagent fan-out.** 앱 내부 LLM 호출이 아니라 `memory-extractor` 에이전트 군집으로 추출(graphify 모델, 보완문서 §2.1). ditto가 이미 autopilot에서 subagent 오케스트레이션을 하므로 결이 맞음.

추가 경계 결정:
4. **`ditto memory` ↔ 기존 `ditto knowledge` 관계.** 둘은 **별개·상호보완**. `.ditto/knowledge`(glossary/ADR)는 사람이 큐레이션한 durable 지식으로 유지. `memory`는 raw source+event 위의 IR/projection 계층. 접점: ADR/decision은 `event_type=decision`인 MemoryEvent로도 들어올 수 있고, audit가 모순을 찾으면 knowledge-curator로 승격. **중복 저장 금지**(보고서 §6.2).

---

## 7. 스킬·에이전트·배포

- **`skills/memory-graph/SKILL.md`** (user-invocable): 보고서 §9.2 그대로 — Trigger / Access order(MCP>CLI) / Freshness rule / Evidence rule / Confidence rule / Write rule(propose만) / Escalation. 짧은 운용 매뉴얼, 스키마 dump 금지.
- **`agents/memory-extractor.md`**: semantic 추출 subagent. 입력=파일 청크, 출력=`memory-graph-ir` 조각(JSON). tools: Read, Grep, Glob, Write, Bash. graphify 추출 프롬프트의 confidence 규율 계승.
- **배포 touchpoints**: 스키마는 `bin/ditto`에 컴파일. 스킬/에이전트는 `build:plugin`이 `dist/plugin/{skills,agents}`로 복사. 소스 변경 시 `npm run build && npm run build:plugin` 후 재설치(uninstall→install).

---

## 8. 구현 순서 (풀 설계를 증분으로 — 각 증분은 독립 검증 가능)

| # | 증분 | 산출/검증 | 보고서 POC |
|---|---|---|---|
| **1** | 4개 스키마 + 등록 + export + 타입체크 | `schemas:export` 통과, `bun test` 등록테스트 green, 타입체크 통과 | 1–3 |
| 2 | Store 4종 + `memory scan` + `events append/list` | scan이 source 변경 감지; 이벤트 append-only 저장 | 1–2 |
| 3 | AST 추출(impact/codeql 재사용) → IR builder → IR validator | 같은 source→같은 IR 재현; provenance 검증 | 3,7 |
| 4 | `memory build` semantic(extractor fan-out) → IR 병합 | claim/concept가 source span과 함께 생성 | 8 |
| 5 | projection compiler(serving graph + wiki) + manifest + `status` | stale/dirty를 status로 확인 | 9,11 |
| 6 | `query`/`path`/`explain` + `audit` | freshness 동반 응답; orphan/stale/dup 리포트 | 12 |
| 7 | `propose`/`approve` write model | 직접 write 없이 pending→승인→재projection | 14,15 |
| 8 | skill + extractor agent + build:plugin 배선 | `/memory-graph` 동작, dist/plugin 반영 | 6,13 |
| 9 | ADR(Memgraph-drop 등) + knowledge-update + dialectic-review | 결정 기록·검토 | — |

---

## 9. 리스크 (보고서 §13 + ditto 고유)

- **semantic edge 오염** → confidence_kind 분리 + propose/approve(보고서 §10).
- **provenance 누락**(graphify의 약점) → 스키마 필수화로 차단.
- **재현 불가** → IR/projection은 전부 재생성 가능, MemoryEvent만 SoT로 git-tracked.
- **Memgraph-drop이 대규모 graph algorithm을 막음** → v0는 in-process로 충분, 한계 도달 시 Neo4j export 어댑터로 외부 분석.
- **scope creep** → 보고서 전체가 크므로 증분별 독립 검증으로 통제. work item `wi_260609td5` 단일 의도 유지.

---

## 10. 미결정 (사용자/리뷰 확인 권장)

- §6의 분기 3건(특히 Memgraph-drop)에 대한 사인오프.
- Core API(HTTP)·MCP server를 v0에 포함할지, 후속으로 뺄지(현재 설계는 후속).
- `.ditto/memory/` git-tracked 범위(현재: sources/events=tracked, ir/projections=ignored).
