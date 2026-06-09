# HANDOFF — memory-graph 플러그인 (설계 + 스키마 기반 / 2026-06-09)

다른 PC에서 이어받기용. **이어받은 뒤 삭제해도 됨**(세션 핸드오프, 영구 문서 아님).

> **주의**: 이 PC의 `.ditto/local/`(work item 상태)과 `~/.claude` 자동 메모리는 **다른 PC로 가지 않는다.** git으로 가는 건 코드·문서·이 핸드오프뿐. 그래서 아래는 자기완결적으로 적었다.

## 무슨 작업인가

`agent-intelligence-memory-report.md`(메모리 보고서)가 설계한 메모리/지식그래프 시스템을 **ditto 네이티브 서브시스템 `ditto memory`로 풀 구축**하는 다증분 작업.
- 사용자 결정: "graphify 래핑"이 아니라 **보고서 설계 자체를 풀 설계부터**.
- work item: **wi_260609td5** (단, `.ditto/local`이라 이 PC에만 있음 → 새 PC에선 아래 "이어받기"대로 재등록).

## 읽을 문서 (전부 git-tracked, pull로 따라옴)

1. `reports/design/memory-graph-plugin-design.md` — **설계서(이게 중심).** 왜 필요한가(ditto 빈틈 4개)·기능별 메커니즘·대안 6결정·ditto 맞물림 5지점·구현 순서 9단계·미결정.
2. `graphify-design-reference-companion.md` — Graphify 실제 구현 대조(메커니즘 참고원, 정합성 반례).
3. `agent-intelligence-memory-report.md` — 원본 설계 보고서(SoT 분리·projection·provenance·proposal write 철학).

## 완료된 것 (커밋·푸시됨)

- **증분 #1 — 데이터 계약 4 스키마** (`src/schemas/memory-{source,event,graph-ir,projection-manifest}.ts`, `scripts/export-schemas.ts` 등록, `schemas/memory-*.schema.json` 생성).
  - confidence 밴드 강제(EXTRACTED=1.0 / AMBIGUOUS 0.1–0.3 / INFERRED 0.4–0.95, 0.5 금지), MemoryEvent approval invariant(approved⇒approved_by+decided_at, pending⇒approved_by 금지), 하이퍼엣지·rationale_for 지원.
  - 검증: `schemas:export` 통과, tsc(내 파일 0에러), biome 클린, 불변식 런타임 safeParse 통과.
- **문서**: 위 설계서 + companion.
- 커밋: `836d2a4`(companion) · `fd86842`(스키마+설계) · `e927909`(설계서 재작성) → 전부 `origin/main` 푸시 완료.

## 다음 (증분 #2~#9, 설계서 §8)

| # | 증분 | 검증 |
|---|---|---|
| **2 (다음)** | Store 4종(WorkItemStore 패턴) + `ditto memory scan` + `events append/list` | scan이 변경 감지, 이벤트 append-only |
| 3 | 구조 추출 — **기존 `impact`/`codeql`/`semantic`(CodeQL) 출력을 IR로 흡수** + provenance 주입 → IR builder/validator | 같은 source→같은 IR |
| 4 | `memory build` 의미 추출(`memory-extractor` subagent fan-out)→IR 병합 | concept/claim이 출처와 함께 |
| 5 | projection(서빙 그래프+위키)+manifest+`status` | freshness/dirty 확인 |
| 6 | `query`/`path`/`explain`+`audit` | 출처 동반 응답 |
| 7 | `propose`/`approve` 쓰기 모델 | 승인→재projection |
| 8 | skill(`skills/memory-graph`)+agent(`agents/memory-extractor`)+build:plugin 배선 | `/memory-graph` 동작 |
| 9 | 통합 끼우기(설계서 §5) + ADR + dialectic-review | 위임패킷/투영/훅 자문 |

**구현 시 ditto 패턴**: citty CLI(`src/cli/commands/<name>.ts` → `src/cli/index.ts` subCommands 등록), Zod=SoT(스키마 추가 시 `scripts/export-schemas.ts`에도 등록 안 하면 등록 테스트 실패), Store는 `src/core/*-store.ts` 패턴(`readJson/writeJson` + `localDir/dittoDir`), 저장은 `.ditto/memory/`(sources/events=SoT git-tracked, ir/projections=gitignored).

## 미결정 (이어받아 사용자와 확인)

- 설계서 §3-2 **Memgraph 제거(v0)** — in-process 그래프 + Neo4j export 어댑터로 대체. 사인오프 필요.
- 설계서 §5 **통합 5지점을 이 work item에 포함할지, 별도 work item으로 분리할지.**
- Core API(HTTP)·MCP server를 v0에 넣을지(현재 설계: 후속).

## 주의 — 선재 드리프트 (내 변경 무관)

`bun run schemas:export` 실행 시 `autopilot/command-log-entry/e2e-journey/evidence-index/interview-state` 5개 `schemas/*.schema.json`이 재생성된다 = repo의 Zod ↔ 커밋된 JSON 드리프트(누가 Zod만 고치고 export 안 함). **내 커밋엔 안 섞었다(매번 revert).** 별도 Tidy-First 수정 대상. 새 스키마 작업 후 export하면 또 뜨니 `git checkout -- schemas/{그 5개}`로 분리할 것.

## 이어받기 (새 PC)

```bash
git pull                                          # 코드 + 문서 + 이 핸드오프
bun install
bun run build:bin && bun run build && bun link    # 터미널 `ditto`를 현재 빌드로
# 확인: ditto --help 에 memory 는 아직 없음(증분 #2부터 추가). work·knowledge 등 보이면 OK
ditto work start "보고서의 메모리/지식그래프 시스템을 ditto 네이티브 플러그인으로 구축 (증분 #2~)" \
  --request "다른 PC에서 이어서 — memory-graph plugin (HANDOFF.md 참조)"   # work item 재등록(이 PC 것은 안 따라옴)
```

그 뒤 `reports/design/memory-graph-plugin-design.md` §8 표의 **증분 #2**부터 시작.
