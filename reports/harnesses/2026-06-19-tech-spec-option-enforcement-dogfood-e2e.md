# tech-spec 옵션 enforcement seam 행동 실증 — 도그푸딩 e2e (2026-06-19)

> **목적**: wi_260619nep의 옵션 enforcement seam(`next-round` levers 하달 + 옵션 obey + cap 코드 강제 + `gate_mode` 분기)의 **런타임 행동**을, 계약-텍스트 테스트가 닿지 못하는 영역까지 실런으로 관찰한 기록.
> **소비자**: 이 워크플로/옵션을 이어 손보는 에이전트·사람.
> **갱신 주기**: 갱신 안 함(특정 시점 실런 스냅샷).
> **삭제 조건**: enforcement seam이 폐기되거나, 후속 실런 harness가 이 문서를 명시적으로 supersede하면.
> **work item**: wi_260619wo5(vehicle). **enforcement 대상**: wi_260619nep. **vehicle 과제**: "불필요한 문서 정리"(doc-cleanup, 실제 삭제 안 함 — 질문 유도 관찰이 목적).
> **선행 harness**: `reports/harnesses/2026-06-19-tech-spec-workflow-dogfood-e2e.md`(증분 2~3 워크플로 실증). 이 문서는 그 위에 enforcement seam 행동을 얹어 관찰한 후속 실런(supersede 아님).

## 1. 무엇을 실증했나

driver(메인 세션) → **`next-round`(levers 하달)** → **생성기 ×3 fan-out(`generator_effort`/`granularity` obey)** → **선정 게이트 fan-in(`threshold`/`count_hint`/consensus obey)** → **`record-round` 영속** → **`next-round` 재호출(`max_rounds` cap 코드 강제)** → **`doctor intent-quality` 소비** → **`gate_mode=draft` 처리(안전경계)**, 한 흐름을 실제로 돌렸다. 선행 harness가 본 fan-out→gate→영속→소비 위에, 이번 seam이 추가한 **값 하달·옵션 obey·cap 강제·draft 분기**를 관찰했다.

## 2. 라이브 증거 (재현 가능)

- **vehicle/옵션**: `./bin/ditto tech-spec start --work-item wi_260619wo5 --doc .ditto/specs/doc-cleanup.md -g 3 -e high -d high -m draft -r 1 -t 0.6`.
- **`next-round` 하달**: `{generators:3, threshold:0.6, granularity:high, generator_effort:high, gate_mode:draft, count_hint:3, max_rounds:1, cap_reached:false}` — persist된 `question_config`(개인 config + CLI)를 그대로 반환.
- **생성기 ×3(대역, fresh context)**:
  - `generator_effort=high` obey → 각자 tool 8~10회로 `reports/` 실파일을 열어 grounding, 후보 거의 전부에 `file:line`/파일명(예: `unified-design.md` frontmatter가 삭제된 3원본을 비대칭 대체, `three-design-docs-honesty-review.md`가 MISSING 경로 본문 나열).
  - `granularity=high` obey → 각자 target을 10개 fine-grained 결정 단위로 분할. 총 **30 후보**.
- **게이트(대역, fan-in)**: 30 → 14 클러스터, 4차원 점수. `threshold=0.6` obey(미달 탈락: grep완전성 ~0.58, forward-link ~0.56), `count_hint=3` obey(정확히 3 선정), consensus obey(교차생성기 합의 7클러스터 측정). `dry=false`.
- **영속**: `./bin/ditto tech-spec record-round --work-item wi_260619wo5 --json <payload>` → `round 1, selected 3, all_scored 14`. trail `tech-spec-rounds.jsonl` 1라인.
- **cap 코드 강제(이번 seam의 핵심)**: `./bin/ditto tech-spec next-round` 재호출 → `rounds_so_far:1` = `max_rounds:1` → **`cap_reached:true, cap_reason:"max_rounds"`**. 선행 워크플로는 cap이 prose뿐(코드가 라운드를 안 셈)이었으나, 이번엔 CLI가 trail을 세어 강제 신호를 낸다.
- **소비**: `./bin/ditto doctor intent-quality --work-item wi_260619wo5` → `tech_spec_rounds:1, tech_spec_selected:3, tech_spec_mean_answer_value:0.833`(선정 3개 answer_value 평균과 일치).
- **`gate_mode=draft` 처리(driver, 안전경계 obey)**: 선정 3개 중
  - C4(불변 memory referrer 하 ac-2 규칙) = 기술·가역 → **draft 잠정 답 채움**(근거: events append-only ADR-0013).
  - C2(`git rm` 허용 경계) = **비가역** → draft라도 **사용자 잔류**.
  - C1(기록 위치 커밋 vs memory) = 가치/선호 + append-only → **사용자 잔류**.
  - → `draft`가 "답 가능한 건 채우되 비가역·가치는 사용자"를 정확히 obey.

## 3. 핵심 발견 — 실런만이 드러낸 것

**(A) enforcement seam은 설계대로 작동한다.** levers 하달 → obey → cap 강제 → 소비가 끊김 없이 흘렀고, **옵션이 실제로 행동을 바꿨다**: effort high=grounding 적극(tool 8~10회), granularity high=10단위 분할, threshold/count=선정 입자, cap=강제 종료. "relay만 하고 obey 기준 없음"이 아니라, 각 dial이 받는 주체의 관찰 가능한 행동 차이로 나타났다.

**(B) [VERIFY] 배포 seam 갭(선행과 동일) — 실사용 차단.** `ditto:question-generator`/`ditto:question-gate`는 **실행 중 세션에서 spawn 불가**(레지스트리가 세션 시작 시 로드, 막 재조립한 `dist/plugin`은 "새 세션부터"). 이 실런은 `general-purpose` 대역에 두 계약을 인라인으로 실어 진행 — 동작은 동일하나 *실제 에이전트 타입 미사용*. 실타입 실증은 새 세션/플러그인 리프레시 선행 필요.

**(C) [VERIFY] 발견 — intensity 100 → threshold 1.0 게이트 무력화.** 개인 config(`.ditto/local/config.json`의 `performance:exhaustive`)가 깔려 무인자 start 시 intensity 100 → `threshold 1.0` 파생. threshold 1.0은 "4차원 만점만 통과"라 게이트가 사실상 전부 dry. intensity 다이얼의 끝점 선형매핑(d90e449) 이슈로, enforcement seam과 별개. 이번 실런은 `-t 0.6` 명시로 우회. 후속 판단 필요(매핑 곡선 완화 or 상한 캡, 예: intensity 100 → 0.9).

**(D) 게이트가 점수 컷을 넘어 *무엇이 사용자 결정인가*까지 판별.** `convergence-contract`(§4-8 제품 결정으로 명시 플래그)를 "user-fork 아님"으로 배제; 이미 결정된 항(커밋 분리 §7/§8)은 consensus 3이어도 necessity를 낮춰 탈락. `gate_mode=draft`도 비가역(`git rm`)·가치를 사용자에 잔류 — **가치 결정을 코드도 에이전트도 가로채지 않는다**(charter §4-2/§4-8).

**(E) 생성기 grounding 오류를 게이트가 자기 적발.** g1-3 경로 오인(`reviews/` vs `design/`), g3-3 'status superseded 33건' 오표현(실제 1건, 33은 status 필드 보유 파일 수) — 게이트가 necessity 판정 중 실제 파일을 확인해 교정. fan-in이 단순 집계가 아니라 검증 단계로 기능.

## 4. 판정

- **enforcement seam 행동 실증 = PASS**(대역 기준). `next-round` 하달 · 옵션 obey(effort/granularity/threshold/count/consensus) · `max_rounds` cap 코드 강제 · `gate_mode=draft` 안전경계 · doctor 소비가 라이브로 작동.
- **[VERIFY]** 실제 `ditto:` 에이전트 타입으로의 실증은 **새 세션 필요**(갭 B). 본 실런은 대역 사용임을 명시.
- **[VERIFY]** intensity 100 → threshold 1.0 매핑 이슈(C)는 enforcement seam 밖의 후속 판단 항목.
- 이번 실런은 vehicle 문서를 **삭제하지 않았다**(질문 유도 관찰이 목적; 실제 doc-cleanup 정리는 별도 승인 사항).
