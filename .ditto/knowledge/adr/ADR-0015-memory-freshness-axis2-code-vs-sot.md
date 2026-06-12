# ADR-0015: Memory freshness 축2(코드↔SoT) 검출 — 증분 검출 채택, 델타/overlay 게이트

- 상태: accepted
- 결정 일자: 2026-06-12
- 결정자: hskim, claude
- 관련: ADR-0013 (D2 2-tier 저장, D4 measure-before-expand), `reports/design/memory-freshness-consistency-design.md` (커밋 44ba881), `.ditto/local/work-items/wi_260612503/reviews/dialectic-1·2.md`, `src/core/memory-project.ts`, `src/core/memory-warmstart.ts`, `src/core/git.ts`, `src/schemas/memory-projection-manifest.ts`

## 컨텍스트

memory는 분석 당시의 스냅샷인데, 코드·SoT가 그 뒤 변해도 freshness가 검출하지 못했다. `memoryStatus`(`memory-project.ts`)가 저장 레코드끼리만 비교하고, 실제 파일↔레코드 마디는 수동 `memory scan` 안에서만 갱신된다 → 편집·`git stash`·브랜치 이동 후에도 freshness가 `fresh`로 거짓 보고된다("조용한 거짓말"). 이것이 boxwood `assets/main → main` 브랜치 전환 시 memory 갱신 결함의 원천이다.

설계는 변증법 리뷰 2회(verdict=revise 2회)를 거쳐 증분 ①(검출)만 출시 단위로 확정하고, 델타·overlay(증분 ②~④)는 게이트 뒤로 미뤘다.

## 결정

freshness가 답해야 할 정합성을 **2축**으로 1급화하고, 축2(코드↔SoT)를 owning-repo별 싼 git 신호로 검출하되, 로그-구조 델타/overlay 계열은 비용 전제가 코드로 반증되어 게이트로 보류한다.

### D1 — 정합성 2축의 1급화

freshness를 2축으로 명시한다: 축1(SoT↔파생물, 기존 `memoryStatus`가 검출)·축2(코드베이스↔SoT, 신규).

### D2 — 축2 검출 = per-owning-repo 싼 git 신호, 신규 스키마 0

검출은 owning repo(sub-repo·submodule `.git` 파일 포함)별로 한다.

- **`code_drift`** = owning-repo 현재 HEAD ≠ 저장 `source_revisions[].git_commit` (memory가 다른 커밋의 코드에서 만들어짐).
- **`code_dirty`** = owning-repo 워킹트리 porcelain 더티.

baseline은 새 필드를 만들지 않는다 — projection manifest의 `source_revisions[].git_commit`이 빌드 시점에 owning-repo HEAD를 per-source로 이미 영속화한다(`memory-project.ts:250-256`). `memoryStatus`가 지금 그 필드를 안 읽고 content hash만 비교하는 지점(`:491-501`)에 축2 비교를 추가하는 것이 신규 배선이다. same-commit-dirty는 HEAD로 못 잡으므로 런타임 porcelain이 필수다. 비-git source(`revision=snapshot:<hash>`)는 그 source만 bounded content_hash 비교(전 파일 재해시 아님), root porcelain은 `.ditto/`(tracked SoT)를 제외한다. 검출은 owning repo당 상수 회 git 호출(headCache로 repo당 1회), 파일 수가 아니라 repo 수에 비례한다.

### D3 — code_dirty는 라벨만, code_drift는 warm-start 억제

`code_dirty`(워킹트리 더티 = 개발 중 정상)는 라벨만 단다 — 더티마다 억제하면 더티 트리에서 memory가 항상 inert가 된다(`memory-warmstart.ts:187` 단일 enum 가드로 실재). `code_drift`(HEAD 불일치 = 다른 커밋 코드)만 warm-start 주입을 억제한다. freshness 우선순위는 **code_drift > stale > code_dirty > fresh** — axis-1 stale이 code_dirty에 마스킹돼 stale projection이 주입되던 회귀를 차단한다(dialectic-2 HIGH). query/path/explain은 라벨만 달고 답을 거부하지 않는다; 소비자(memory-graph 스킬)는 `drifted_sources`에 든 소스만 코드로 직접 검증하고 나머지는 신뢰한다.

### D4 — 델타/overlay/커밋공유/compaction(증분 ②~④)은 게이트

증분 ②~④는 이번에 구현하지 않는다. "싼 구조 델타" 전제가 코드로 반증되었다(dialectic-1 V1 critical): 구조 IR(`absorbAcgIntoIr`)은 순수 변환이고, 실제 비용은 상류 CodeQL DB 생성이다(host-deps HEAD-키 캐시라 더티 트리 = 보장 캐시미스, 13.8초~3분). 세션 overlay가 노린 미커밋 편집이 바로 그 비싼 케이스다. 재개의 선행조건 4가지: ① 더티 트리 구조 델타의 실비용 측정, ② 싼-델타 비가정 재설계, ③ overlay 엣지 무결성 계약(dangling/모순 처리), ④ store 계약 결정(committed 델타는 tier② 추적 → ADR-0013 D2 개정 ADR 선행 필요).

## 근거

- 사용자가 요청한 "HEAD 스탬프 영속화"는 `source_revisions[].git_commit`으로 이미 충족되어, 검출은 새 스키마 없이 기존 baseline을 읽기만 한다(dialectic-2 E1, ADR-0013 D4·스키마 닫힘 준수).
- code_dirty/code_drift 분리는 "더티 = 항상 drift → warm-start 항시 억제 → memory 무용화"라는 inert 함정을 피한다(dialectic-2 V3).
- 증분 ②~④의 게이트는 known_limits에서 자인한 최대 리스크("델타가 싸다가 거짓이면 경제성 전제 붕괴")를 opponent V1이 코드로 true로 보인 결과다 — footnote가 아니라 설계 변경이며, 분리 가능한 견고한 ①이 있어 reject가 아닌 revise·게이트다(dialectic-1).

## 대안 (기각)

- 델타 read-overlay 모델 — 경제성 전제가 코드로 반증(상류 CodeQL DB 비용).
- memory 빌드가 git 커밋을 강제 — 비가역 부수효과라 기각, CLI 더티 경고까지만.
- projection에 신규 baseline 필드(built_head/clean-dirty) 추가 — `source_revisions.git_commit`이 이미 존재하므로 creep.
- whole-projection 대신 node-level warm-start 억제 — 증분 ②+ 범위로 미룸.
- code_drift 시 query/path/explain 거부 — 라벨만 달기로 채택(거부 안 함).

## 철회/재검토 조건

- CodeQL 증분 비용이 충분히 싸지거나 구조 추출이 변경 파일만 증분 가능해지면 → D4의 ②~④(델타/overlay/store 계약) 재검토.
- whole-projection warm-start 억제가 멀티레포에서 과잉으로 실측되면 → node-level granularity 도입.
- ac-4의 다수 sub-repo git 호출 wall-clock latency가 read 핫패스 문제로 실측되면 → 캐시·측정 도입.
