# tech-spec 질문 워크플로 (a) 행동 실증 — 도그푸딩 e2e (2026-06-19)

> **목적**: 증분 2~3에서 구현한 tech-spec §6-6 다중-에이전트 질문 워크플로의 **런타임 행동**을, 계약-텍스트 테스트(ac-10~12)가 닿지 못하는 영역까지 실제 실런으로 관찰한 기록.
> **소비자**: 이 워크플로를 이어 손보는 에이전트/사람.
> **갱신 주기**: 갱신 안 함(특정 시점 실런 스냅샷).
> **삭제 조건**: §6-6 워크플로가 폐기되거나, 후속 실런 harness가 이 문서를 명시적으로 supersede하면.
> **work item**: wi_260619gr1. **vehicle 과제**: "불필요한 문서 정리"(실제 삭제는 안 함 — 질문 유도 관찰이 목적).

## 1. 무엇을 실증했나

driver(메인 세션) → **생성기 ×3 fan-out** → **선정 게이트 fan-in(4차원 점수)** → **`record-round` 영속** → **`doctor intent-quality` 소비** → **dry 라운드 종료**, 한 흐름을 실제로 돌렸다. 계약-텍스트 테스트는 "지침이 그렇게 적혀 있다"까지만 보증하지만, 이 실런은 "에이전트가 실제로 그렇게 행동하는가"를 본다.

## 2. 라이브 증거 (재현 가능)

- **fan-out**: `ditto:question-generator` 대역 3개 병렬 → 각 9~10개 후보(총 29), 전부 3성질(맹점/확장/정향) + why_matters 부착, 패킷 사실에 grounding(SUPERSEDED 핸드오프·헌장 §9·ADR-0005).
- **fan-in/게이트**: 29개를 7개 테마로 클러스터링, 4차원 점수화, **6개 선정(consensus 2~3)**, `dry=false`. 임계 미달 클러스터(일회성 vs 재사용 규칙)는 §4-3 근거로 탈락, 증분-게이팅 질문은 §4-8 절차결정이라 "사용자 fork 아님"으로 배제 — 게이트가 단순 점수 컷을 넘어 *무엇이 사용자 결정인가*까지 판별.
- **영속**: `./bin/ditto tech-spec record-round --work-item wi_260619gr1 --json <payload>` → `Recorded round 1 (selected 6, scored 7)`; 라운드2 `--json '{"round":2,"dry":true}'` → `(selected 0, dry)`. trail `tech-spec-rounds.jsonl` 2라인.
- **소비**: `./bin/ditto doctor intent-quality --work-item wi_260619gr1 --output json` → `tech_spec_rounds=2, tech_spec_selected=6, tech_spec_dry_rounds=1, tech_spec_mean_answer_value=0.858`(선정 6개 answer_value 평균과 일치).
- **종료**: 라운드2 dry → driver가 인터뷰 종료 신호로 읽는 지점(점수 기반 종료).

### 선정된 6개 질문(작성 루프 산출 — vehicle 과제 기준)
1. (정향) 성공기준 = 레포 슬림화 vs 살아있는 문서 신뢰도/정합 회복?
2. (맹점) '불필요' 판정 = 명시 SUPERSEDED 마커(상태) vs 마커 없는 stale 추론(나이)?
3. (맹점) 삭제 전 inbound 역참조 확인 + 소비자가 사람 vs 에이전트(grep 참조)?
4. (정향) 처분 비가역(git rm) vs 가역(archive)? SUPERSEDED 마킹=삭제 vs 보존?
5. (확장) harnesses 1차 조사노트는 별도 보존부류 vs 동일 처분?
6. (확장) 범위 = reports 3종 vs projection/위치-틀림(ADR-0005 위반) 문서 포함?

## 3. 핵심 발견 — 실런만이 드러낸 것

**(A) 워크플로 행동은 설계대로 작동한다.** fan-out의 독립 생성 → 게이트의 consensus 기반 합의 측정 → 점수 선정 → 영속 → 소비 → dry 종료가 끊김 없이 흘렀다. 생성 품질도 높았다(최소 패킷·반-편향이 SUPERSEDED 처분·에이전트-소비자·1차자료 보존·참조 무결성 같은 전문가 고려사항을 강한 합의로 끌어냄).

**(B) [VERIFY] 배포 seam 갭 — 실사용 차단.** `ditto:question-generator`/`ditto:question-gate`는 **실행 중 세션에서 spawn 불가**였다(`Agent type not found`). 에이전트 레지스트리가 세션 시작 시 로드돼, 같은 세션에서 커밋한 새 에이전트는 안 보인다(post-commit이 "새 세션부터 반영"이라 한 그 지점). 이 실런은 **`general-purpose` 대역에 생성기/게이트 계약을 인라인**으로 실어 진행했다 — 동작은 동일하나 *실제 에이전트 타입은 미사용*.
- **함의**: 계약-텍스트 테스트(ac-10~12)는 이 갭을 절대 못 잡는다(파일 존재만 검사). 실사용하려면 **새 세션 또는 플러그인 리프레시**가 선행돼야 한다. tech-spec SKILL이 `ditto:question-generator`를 호출하는데 같은 세션에서 막 만든 경우 무력화된다.
- **후속 후보**: (1) SKILL/문서에 "새 에이전트는 세션 리스타트 후 사용 가능" 운영 주석, 또는 (2) 부재 시 우아한 강등 경로(general-purpose 폴백) 명시 — ADR-0018(옵셔널 도구 강등 불변식)과 같은 결.

## 4. 판정

- (a) **워크플로 행동 실증 = PASS**(대역 기준). 설계된 fan-out→게이트→영속→소비→종료가 라이브로 작동.
- **단서**: 실제 `ditto:` 에이전트 타입으로의 실증은 **새 세션 필요**(위 갭 B). 본 실런은 대역 사용임을 명시.
- 이번 실런은 vehicle 과제의 문서를 **삭제하지 않았다**(질문 유도 관찰이 목적, 실제 정리는 별도 승인 사항).
