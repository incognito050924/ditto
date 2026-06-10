# HANDOFF — ditto memory 서브시스템 v0 완료 + 후속 (2026-06-10)

다른 PC 이어받기용. **이어받은 뒤 갱신/삭제해도 됨**(git-tracked 세션 핸드오프).

> **주의**: `.ditto/local/`(work item 상태·autopilot 그래프·dialectic 원장·완료계약)과 `~/.claude` 자동 메모리는 **git으로 안 간다.** git으로 오는 건 코드·문서·ADR·이 파일뿐. 그래서 아래는 자기완결적으로 적었다. work item `wi_260609m41`은 이 PC에만 있고 새 PC엔 없다(아래 "새 PC 재등록" 참조).

## 무엇이 끝났나 — memory v0 (옵션 A) **DONE·푸시됨**

보고서의 메모리/지식그래프를 ditto 네이티브 `ditto memory`로 구축. dialectic 2라운드 검증 후 **옵션 A(measure-before-expand)**로 완주: autopilot 33/33 노드 passed, final_verdict=**pass**(15/15 AC 증거 close), 전체 `bun test` 1545 tests 0 fail.

**커밋(origin/main, push 완료, `f2b9a53`~`42f33f7`)** — 증분별:
- `f2b9a53` 설계 동결 §10 + dialectic 1·2라운드 + 옵션 A (문서)
- `65cd18a` #2 Store 4종 + scan/events + source.repo
- `eec6fd4`+`7cee8c1` #3 ACG→IR builder (+리뷰 fix: 엣지 properties·멀티kind·방향)
- `97e24a6` bootstrap ingest (knowledge/handoff→그래프, cold-start 해소)
- `bf7b3cf` #4 semantic 엔진 + 결정적 merge reducer
- `e2c77ca` #5 event→IR reducer + projection + status
- `c52fac2` #6 query/path/explain + audit
- `692da3e` §5-1 warm-start push + 계측
- `d0c481b` #7 쓰기모델 + #8 플러그인 배선
- `dcecdc8` ADR-0013 + CLAUDE.md 투영
- `42f33f7` 되돌림 플래그(`DITTO_MEMORY=off`) + #7 double-approve fix + ac-12 usage 리포트

**진실원(전부 git-tracked, pull로 옴)**:
- `reports/design/memory-graph-plugin-design.md` §10(구현계약)·§10-8/9(dialectic 반영·옵션 A·되돌림 4불변식)
- `reports/design/memory-graph-value-structure-assessment.md`(가치·구조 평가·옵션 A 의사결정 §6-1)
- `.ditto/knowledge/adr/ADR-0013-memory-subsystem-design.md`
- 코드: `src/core/memory-*.ts`(store/scan/ir/bootstrap/build/reduce/project/query/warmstart/flag), `src/cli/commands/memory.ts`, `skills/memory-graph/`, `agents/memory-extractor.md`

`ditto memory` 명령: scan · events(append/list) · build[--semantic] · project · status · query/path/explain · audit · propose/approve · bootstrap · usage.

## ⚠ ditto autopilot gotcha 4건 (이번에 우회·교정함 — 재발 가능, ditto 자체 개선 후보)

이 빌드 중 만난 autopilot 결함. autopilot.json은 `.ditto/local`이라 새 PC엔 안 가지만, **다음에 autopilot으로 큰 work item 돌리면 또 만난다**:
1. **seed↔planner 중복**: bootstrap이 generic 시드 N1→N2→N3 만드는데 planner가 자기완결 subgraph 내면 시드 N2/N3 중복 → next-node가 generic 시드 고름. 우회=시드 retire.
2. **impl↔verify 데드락**: `selectReadyNodes` B3 guard(`src/core/autopilot-graph.ts:87-92`)가 impl pending 시 모든 verify 보류. planner가 implement 의존을 verify에 걸면 순환 교착. 우회=verify-의존을 그 verify의 선행(impl/review)으로 lift.
3. **N1 planner가 evidence 없이 전체 AC addressing** → `autopilot complete`의 worst-fold(`autopilot-complete.ts:115-125`)가 전 AC를 unverified로(false-negative). 우회=N1.acceptance_refs 비움.
4. **work-item.json AC가 placeholder 1개**(intent 직접 작성 시 동기화 안 됨) → complete가 AC 못 매핑. 우회=work-item AC를 intent 15개로 동기화.
→ **개선 제안**: bootstrap이 planner 노드 만들 때 seed impl/verify 생략, planner 출력의 impl→verify 의존 자동 정규화, design/planner 노드에 AC refs 미부여, intent→work-item AC 자동 동기화. (별도 work item 후보)

## 후속 (measure-before-expand 게이트 + 운영 + 정리)

1. **§5 push 확대(§5-2/5-3/5-4/5-5) + audit→curator 자동** — 이번엔 **미배선**(out_of_scope). `ditto memory usage`의 hit율(opportunities/attempts/hits/actionable) 데이터가 dogfooding으로 쌓인 뒤, 그 증거로 게이트 열고 확대. 이게 옵션 A의 핵심.
2. **운영: 실 그래프 채우기** — `.ditto/memory/` SoT는 아직 비어있음(코드만 land, 실 ingest 미실행). 새 PC에서 `ditto memory bootstrap` → `ditto memory build [--semantic]` → `ditto memory project` 돌려 day-1 그래프 생성(SoT는 git-tracked라 커밋하면 따라옴).
3. **선재 드리프트 정리(Tidy-First, 이 작업 무관)**: 선재 tsc 214건·`schemas/*.schema.json` 드리프트 5건(autopilot/command-log-entry/e2e-journey/evidence-index/interview-state). 메모리 작업이 만든 것 아님(검증으로 확인). 별도 정리.
4. **CLAUDE.md knowledge 블록 sha256 마커** — ADR-0013 본문은 들어갔으나 마커 stale. 다음 `syncKnowledgeProjection`(knowledge-update 경로) 시 자가치유(본문은 `.ditto/knowledge/adr/`에서 재생성).

## 새 PC 재등록 (work item 상태는 안 따라옴 — 이미 v0 done이라 보통 불필요)

v0는 끝났으므로 후속은 **새 work item**으로 시작하는 게 맞다:
```bash
git pull && bun install && bun run build:bin && bun run build && bun link   # 터미널 ditto 갱신
ditto memory --help    # scan/build/query/... 보이면 OK
# 후속(예: §5 push 확대 측정·운영 ingest)은 그때 ditto work start 로 새 work item
```
이번 v0의 dialectic 원장·완료계약을 보려면 이 PC의 `.ditto/local/work-items/wi_260609m41/`(reviews/dialectic-{1,2}.json, completion.json) 참조 — git엔 없음.
