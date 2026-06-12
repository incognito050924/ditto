# Memory Freshness — 정합성 2축 설계

- 상태: revised by dialectic-1·2 (둘 다 verdict=revise) — 증분 ① 최소화 확정
- 작성: 2026-06-12 · hskim, claude
- 리뷰: `.ditto/local/work-items/wi_260612503/reviews/dialectic-1·2.{json,md}`
- work item: wi_260612503 (ditto memory 기능 개선 — 브랜치 전환 시 memory 갱신 결함의 원천 수정)
- 관련: ADR-0013 (D2 2-tier, D4 measure-before-expand), `memory-project.ts`, `memory-scan.ts`, `memory-warmstart.ts`, `git.ts`, `schemas/memory-projection-manifest.ts`

## 1. 문제 — 두 정합성 축
- **축 1 — SoT ↔ 파생물**: SoT 레코드는 바뀌었는데 파생물 재빌드 안 됨. (검출됨: `memoryStatus`)
- **축 2 — 코드베이스 ↔ SoT**: 코드 수정/`git stash`/브랜치 이동으로 실제 코드가 SoT 스냅샷과 달라짐. (**검출 안 됨 — 핵심 결함**)

## 2. 현재 커버리지 (검증됨)
- **축 1**: `memoryStatus`(`memory-project.ts:500-501`) eventSetStale + dirty_sources, warm-start 억제(`memory-warmstart.ts:187`).
- **축 2 사각지대**: `memoryStatus`는 manifest hash vs **저장된** `source_revisions[].hash`(content)만 비교하고, **`source_revisions[].git_commit`도 owning-repo 현재 HEAD도 비교하지 않는다**(`:491-501`, 디스크 재해시 없음 `memory-store.ts:73`). → 편집/stash 후 `fresh` 거짓 보고. **①의 신규 배선 지점 = 여기에 축2 비교 추가.**

## 3. 설계 결정

### D-A. 정합성 2축을 freshness의 1급 개념으로

### D-B. 축 2 검출 = per-owning-repo, 기존 baseline 재사용 (신규 스키마 0)
**baseline은 이미 영속화돼 있다** — projection manifest의 `source_revisions[]`가 빌드 시점에 각 source의 `git_commit`(owning repo HEAD)을 per-source로 이미 저장(`memory-project.ts:250-256`, 스키마 `memory-projection-manifest.ts:21-24`). 그리고 source 레코드에도 `content_hash`(실제 내용)·`revision`이 있다(`memory-scan.ts:172,186,204`). **사용자가 요청한 "HEAD 스탬프 영속화"는 이미 충족 — 새 필드를 만들지 않고 이걸 읽기만 한다.** (dialectic-2 E1)

**검출은 owning repo별로**(scan의 `findOwningRepo` 귀속 미러링; sub-repo·submodule `.git` 파일도 `fileExists` stat으로 감지): source를 owning repo로 그룹핑 → repo마다 저장 `git_commit` vs **그 repo 현재 HEAD**(`git.ts` `gitRevParse`, headCache로 repo당 1회) + **그 repo porcelain**(`git.ts:23,38`). root repo porcelain은 `.ditto/`(tracked SoT) 제외.

**두 신호를 분리한다 (dialectic-2 E2 — inert 방지):**
- **`code_drift`** = owning-repo 현재 HEAD ≠ 저장 `git_commit` → **memory가 다른 커밋의 코드에서 만들어짐 = 진짜 신뢰 결함** → warm-start 억제 + 라벨. (boxwood `assets/main→main` 원 증상이 이것.)
- **`code_dirty`** = owning-repo 워킹트리 더티(porcelain 비어있지 않음) → **개발 중 정상 상태** → **라벨만, 억제 안 함.** (이게 핵심: 더티트리마다 억제하면 memory가 inert가 됨 — `memory-warmstart.ts:187` 단일 가드로 실재.)
- **비-git source**(`revision=snapshot:<hash>`, HEAD 없음): 그 source만 **bounded content_hash 비교**(전체 재해시 아님, 비-git은 rare edge). 영구-drift 하드시맨틱은 ②로.

### D-C. ~~싼 구조 델타~~ — 반증됨 (dialectic-1 V1: 비용은 상류 CodeQL DB, 더티트리=캐시미스 13.8초~3분)

### D-D. 로그-구조 델타(②~④) — 게이트. 추가로 ②로 미룬 것(dialectic-2):
- node-level warm-start 억제(whole-projection 과잉차단 완화; 현재 한 sub-repo drift가 전체 그래프 억제 `memory-warmstart.ts:185-190`).
- dirty/비-git의 영구 보수 drift 하드시맨틱(`baseline_untrusted`).
- 깨끗-유도 **agent/skill 안내 층**(미구현·관찰불가 vapor).
- exhaustive submodule(미초기화·중첩·gitlink) 처리.

### D-E. baseline 스탬프 → 신규 필드 없음 + CLI 경고만 (커밋 강제 안 함)
projection 신규 baseline 필드(built_head/clean-dirty)는 **만들지 않는다** — 검출은 기존 `source_revisions[].git_commit` + 런타임 porcelain으로 충분(dialectic-2 E1, ADR-0013 D4·스키마 닫힘 준수). 깨끗-유도는 **CLI mechanism까지만**: `memory scan`/`build`가 더티 트리면 **경고 출력**(block 안 함, 비대화 안전), `--require-clean` 시에만 hard-fail, **git 커밋 안 만듦**. (agent 안내 층은 ②.)

### D-G. axis-2 API 형태 (dialectic-2 E3)
`freshness` enum에 `code_drift` 추가 → warm-start 억제 자동(`:187` enum-agnostic 확인). 변별정보(어느 repo/source가 drift·dirty)는 **별 필드 `drifted_repos`/`drifted_sources`**로(축1 `dirty_sources`와 충돌 회피). query/path/explain 라벨은 `memory-query.ts`에 freshness 배선이 **전무**하므로 신규 작업.

### D-H. 소비자 계약 — 라벨을 actionable하게 (라벨 inert 방지)
라벨은 *받은 쪽이 행동을 바꿔야* 의미가 있다. 두 표면:
- **warm-start**: code_drift면 주입 억제 → 에이전트는 memory 지름길 없이 **소스에서 출발**(자동으로 직접 코드 확인). 별도 지침 불필요.
- **직접 query/path/explain**: 답 + `drifted_sources` 노출 → **소비자(memory-graph 스킬)는 "code_drift면 drifted_sources에 든 것만 소스로 직접 검증, 나머지는 신뢰"** 지침을 따른다. 코드는 라벨·필드를 싣고, 행동 지침은 memory-graph 스킬 문서에 1급화(코드 강제 불가, 소비 표면 책임).

## 4. 구현 범위 (증분 ①만 deliverable)
**① 축2 drift 검출**: D-B(per-owning-repo, code_drift/code_dirty 분리, 기존 baseline 재사용) + D-G(enum+별필드) + D-E(CLI 경고). memoryStatus(`:489-501`)에 축2 비교 추가가 신규 배선. **②~④는 게이트.**

## 5. Acceptance Criteria — 증분 ① (deep-interview에서 확정)
- **ac-1**: 파일 편집(미scan) 후 status/read가 `code_dirty` 보고(현재 `fresh`).
- **ac-2**: `git stash`로 워킹트리가 baseline과 어긋나면 `code_dirty`.
- **ac-3**: owning-repo HEAD ≠ 저장 git_commit(브랜치/커밋 이동) → `code_drift` (원 증상 검출).
- **ac-4**: 검출은 owning repo당 상수 회 git 호출(rev-parse+porcelain, headCache로 repo당 1회), 파일 수 아닌 repo 수; 전 파일 재해시 없음; root porcelain은 `.ditto/` 제외. (지연은 미측정 — §6, 다수 sub-repo 측정 선결.)
- **ac-5**: **`code_drift`** 시 warm-start 주입 억제; **`code_dirty`는 억제 안 함**(라벨만 — inert 방지).
- **ac-6**: `.ditto/memory`(tracked SoT)만 바뀌고 코드 안 바뀐 경우 거짓양성 없음.
- **ac-7**: query/path/explain은 drift/dirty여도 답 반환 + 라벨(freshness enum + `drifted_repos`/`drifted_sources` 별 필드). 거부 안 함.
- **ac-8 (negative)**: 비-git source는 bounded content_hash 비교; 축2 검출이 자동 재scan/재빌드 트리거 안 함.
- **ac-9**: `memory scan`/`build`가 더티 트리면 CLI 경고 출력하되 **block 안 함**; `--require-clean` 시에만 hard-fail; **git 커밋 안 만듦**; **projection 신규 필드 없음**.
- **ac-10**: sub-repo/submodule HEAD 이동이 **per-owning-repo** `code_drift`로 검출(cwd 껍데기 HEAD 아님).
- **ac-11**: code_drift 응답이 `drifted_repos`/`drifted_sources`를 노출하고, memory-graph 스킬 문서가 "code_drift면 drifted_sources를 소스로 직접 검증" 소비자 지침을 포함한다(라벨 inert 방지).

## 6. 미해결 (구현/§7에서)
- ac-4 per-repo git 호출 실지연(수십 sub-repo) 미측정 — ① 구현 선결.
- `code_drift` enum 추가의 소비자 파급 — 특히 `evidence-record.ts:49,56` freshness 이진('fresh'|'stale') 가정이 깨지는지 grep 전수확인.
- submodule 미초기화·중첩·gitlink더티 vs internal더티, `findOwningRepo`가 rootingRoot 위로 안 올라감(`:87-91`) → exhaustive는 ②.
- whole-projection warm-start 억제 과잉(node-level=②+).

## 7. 다음
deep-interview finalize(intent·acceptance·pre-mortem) → ADR(knowledge-update) → autopilot ① TDD 구현(ac-1부터).
