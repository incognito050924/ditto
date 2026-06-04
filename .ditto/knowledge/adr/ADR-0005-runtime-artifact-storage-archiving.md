# ADR-0005: 런타임 산출물 저장 — per-entity 파일 + 수동 명령 아카이빙

- 상태: accepted
- 결정 일자: 2026-06-04
- 결정자: hskim, claude (claude-opus-4-8)
- 관련: ADR-0001 (런타임 스택), ADR-0002 (Schema SoT), CLAUDE.md §9 (문서/산출물 위치), `.ditto/` 레이아웃, `src/core/*-store.ts`

## 컨텍스트

DITTO는 작업마다 런타임 산출물을 생성한다 — work-item/completion/review/contract JSON, run 로그, evidence blob, dialectic ledger 등. 이를 공유 file-based RDB(SQLite)로 옮기는 안을 검토했고, 측정·분석 후 기각한다. 동시에 무한 누적에 대비한 아카이빙 정책을 정의한다.

**측정 (2026-06-04):** `.git` 9.4M, git-tracked `.ditto` 1.8M / 333파일 / 57 work-item, 전체 git 객체 3,386개 중 `.ditto` 경로 793개(~23%). 절대 크기는 사소하다(자동 아카이빙은 현재 YAGNI). 단 객체 비중은 런타임 트레일이 작업마다 쌓이는 반면 코드 변경은 둔화되므로 장기적으로 우세해진다 — 그래서 **정책은 지금 정의하되 집행은 사용자 호출 시점**으로 한다.

현 저장은 `.gitignore`로 이미 두 계층으로 갈려 있다: git-tracked durable(`.ditto/work-items/*` 계약 산출물, `.ditto/knowledge/`)와 gitignored ephemeral(`.ditto/runs/`, `.ditto/work-items/*/evidence/`, `.ditto/cache/`, `logs`). `src/core/*-store.ts` 10개가 일관된 Store 추상화로 파일 I/O를 감싼다.

## 결정

### D1 — 런타임 산출물은 공유 RDB가 아니라 per-entity 파일로 저장한다

- durable 계약 산출물(work-item/completion/review, knowledge/glossary/adr)은 **git-tracked per-entity JSON**으로 유지한다. 이것이 SoT.
- ephemeral(runs/·evidence/·cache/·logs)은 gitignored 파일로 유지(현 상태).
- SQLite 등 **공유 가변 DB로 SoT 이전을 금지**한다. 이유:
  - **감사·diff·handoff:** git diff/blame/merge/cherry-pick/PR 리뷰가 깨진다. DITTO 연속성 모델은 git-committed work-item 상태에 의존한다(연속성 = memory + git + work-items).
  - **동시 작업 머지:** per-entity 파일은 one-file-per-entity(사실상 event-sourced)라 서로 다른 산출물은 머지 충돌이 **설계상 없다**. 단일 바이너리 DB는 두 브랜치의 임의 변경이 **머지 불가능한 바이너리 충돌**이 된다. 런타임 동시 쓰기도 SQLite 단일 writer 락이 산출물-당-파일보다 불리하다.
  - **이중 스키마 진화:** 이미 Zod `schema_version`(ADR-0002)으로 스키마를 버전한다. DB는 별도 마이그레이션 체계를 더해 이중 관리가 된다.
  - **장애 반경·가독성:** JSON 한 개 손상 = 산출물 하나 손실. DB 손상 = 전체 손실. 에이전트/사람이 `cat`/`jq`/`grep`로 즉시 읽는 디버그성도 잃는다.
- **예외(SoT 교체 아님):** cross-run 질의·시계열 분석 needs가 실재하면, JSON을 SoT로 둔 채 **gitignored·rebuildable 파생 read-model**(SQLite 인덱스)을 기존 Store 인터페이스 뒤에 additive로 둘 수 있다. 깨지면 파일에서 재빌드. 이건 캐시지 진실원이 아니다.

### D2 — 지식(영구·경량) vs 트레일(아카이빙 가능)을 구분한다

- `.ditto/knowledge/`(glossary·ADR·durable learning) = **영구 보존·경량 결정 메모리**. **아카이빙하지 않는다.** "프로젝트 의사결정 이력"의 실체는 여기다.
- `.ditto/work-items/` = 장황한 **원시 트레일**. durable 가치는 `ditto:knowledge-update`로 knowledge에 승격된다 → 승격 이후엔 cold 처리(아카이빙) 가능.

### D3 — 아카이빙은 사용자가 호출하는 수동 CLI 명령이다 (move-not-delete, no history rewrite)

- 아카이빙은 **사용자가 원할 때 직접 실행하는 CLI 명령**으로 제공한다(자동 트리거·cron·임계치 자동집행 아님). 사용자가 마일스톤/스프린트/분기 종료 등 자기 판단으로 실행한다.
- **주 동기 = agent-context·활성 작업셋 경량화**(git 크기 절감이 아니다). 활성 `.ditto/work-items/`가 비대하면 에이전트가 매 세션 로드·grep하는 컨텍스트가 커진다 — 이것이 실질 비용이다. `.git` 크기는 현 규모에서 비문제다.
- **대상:** 닫힌 work-item만(completion `final_verdict=pass` / status done). 진행 중·`knowledge/`는 hot 유지.
- **동작:** `.ditto/work-items/<wi>/` → `.ditto/archive/<label>/<wi>/`로 **이동**(삭제 아님, 복원 가능). `<label>`은 호출자가 지정(예: `2026-Q2`, `sprint-12`).
- **git 히스토리 재작성 금지:** audit 불변 체인을 보존한다. "아카이빙"은 활성 작업셋에서 빼는 것이지 `.git`을 깎는 게 아니다. `.git` 절감이 먼 훗날 진짜 필요해지면(예: clone/CI 부담) `git bundle` cold 보관을 그때 별도 검토.

> **구현 범위:** 이 ADR은 **정책 결정**까지다. 명령 자체(`ditto archive <label> [--wi ...]` 류)의 구현은 별도 fast-follow work item이다. ADR-0004의 "결정은 정책, 코드는 별도 work item" 선례를 따른다.

## 근거

- 측정이 자동 아카이빙을 불필요로 만든다(`.git` 9.4M). 그래서 정책은 자동이 아니라 **수동 명령**이다.
- per-entity 파일의 무충돌 머지·git 감사가 동시 작업 모델에 load-bearing이다 — 본 세션 중 병렬 커밋(`bb841ae`)이 무충돌로 공존한 것이 실례.
- context-leanness가 진짜 비용 동인이라는 것은 사용자 본인의 통찰이며, git 크기보다 유효한 트리거다.
- 신규 의존·스키마 0: 기존 파일 Store·gitignore 분리·knowledge 승격 메커니즘만으로 성립(ADR-0002 SoT·단순성 준수).

## 대안 (기각)

- **공유 SQLite를 SoT로:** 머지·감사·동시성 회귀. 기각(D1).
- **자동/주기 아카이빙(cron·임계치 자동집행):** 현 규모에서 불필요·복잡. 사용자 호출 수동 명령으로 충분(D3).
- **work-item 통삭제:** 트레일 손실. move-not-delete.
- **git history rewrite로 `.git` 절감:** 감사 체인 파괴 — 보존하려는 대상을 스스로 파괴하는 자기모순. 기각.

## 철회/재검토 조건

- cross-run 질의·시계열 분석 needs가 실증되면 → JSON-SoT 위 **파생 rebuildable SQLite read-model** 추가(D1 예외 발동).
- `.git` 크기가 실제 운영 부담(clone/CI 시간 등)이 되면 → `git bundle` cold 보관 + 워킹트리 제거 검토.
- 활성 work-item 비대가 반복적 수동 부담이 되면 → 그때 임계치 **자동 제안**을 더하되, 여전히 move·사용자 확인 후 실행.
- knowledge 승격(`ditto:knowledge-update`)이 work-item durable 가치를 신뢰성 있게 추출하지 못하는 사례가 나오면 → 아카이빙 전 승격 강제 게이트 재검토.
