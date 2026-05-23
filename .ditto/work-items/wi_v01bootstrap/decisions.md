# Decisions: wi_v01bootstrap

본 work item에서 내린 작은 결정의 토론 기록. 되돌리기 어려운 architectural 결정은 [[ADR-0001-runtime-stack]], [[ADR-0002-schema-source-of-truth]]에 별도 보존.

## D-1: 단일 패키지 시작
- 결정: workspace로 처음부터 쪼개지 않고 `src/`, `tests/`, `scripts/`, `schemas/`만 둠.
- 이유: v0.1 시점에는 외부에 export할 패키지가 없고 binary 1개로 묶임. 분리 비용은 작아 v0.4 전후로 재검토.

## D-2: ID 규약
- 결정: work item id는 `wi_[a-z0-9]{8,}`, run id는 `run_[a-z0-9]{8,}`, review id는 `rv_[a-z0-9]{8,}`.
- 이유: 사람이 읽고 구분하기 쉬운 prefix + 충분한 엔트로피.
- 예시: `wi_v01bootstrap`, `wi_v01implement`, `wi_pwdcheck`(fixture는 8자 이상 보장 위해 의미 슬러그 사용).

## D-3: 경로 처리
- 결정: schema의 `relativePath`는 절대 경로와 `..` 상위 이동을 reject.
- 이유: evidence/changed_files가 repo 밖을 가리키지 못하게 막아 사고 방지.

## D-4: completion contract의 cross-field 룰
- 결정: `final_verdict=pass`는 모든 acceptance가 `pass`일 때만 허용. non-pass는 `next_handoff_path` 필수.
- 이유: "검증 없는 완료 주장" 차단의 첫 결정적 룰. self-check가 이후 lint 단계에서 동일 규칙을 다시 적용.

## D-5: reviewer-output의 unverified 룰
- 결정: `verdict=unverified`는 `evidence` 또는 `review_not_run_reason` 중 하나가 반드시 있어야 함.
- 이유: 모름은 모름이라고 *왜 모르는지*까지 기록해야 다음 단계가 판단 가능.

## D-6: CLI exit code
- 결정: not_implemented는 exit 64, usage error는 65, 향후 실제 동작 실패는 1.
- 이유: 64=`EX_USAGE` 인접 영역으로 "기능 미구현" 신호. v0.1 중에는 사용자/CI가 골격임을 명확히 구분 가능.

## D-7: golden fixture 시나리오 선택
- 결정: "비밀번호 정책 추가"라는 보편적 가상 시나리오. acceptance 3개 중 1개를 의도적으로 partial로 마감.
- 이유: pass-only fixture로는 partial/unverified 흐름과 cross-field 룰을 시연하기 어려움.

## D-8: plan-check 누락에 대한 합의
- 결정: 본 부트스트랩은 회고형으로 기록하고, wi_v01implement부터는 사전 plan/dod/rollback/context-packet을 두고 사용자 합의 후 execute.
- 이유: DITTO 자신이 자기 단계 분리 원칙을 지키지 않으면 다른 프로젝트에서도 같은 위반을 정당화하게 된다.
