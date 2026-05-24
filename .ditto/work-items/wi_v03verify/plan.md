# Plan

1. application plan line 754 "verification capture를 manifest에 연결" 항목과 현재 구현 상태(wi_v03sandbox 마감 후), 기존 `ditto verify` 명령 형태가 본 work item의 `--verify` 표면과 충돌 없이 정합하는지 점검.
2. Design note: `--verify` option semantics, verify 호출 시점(provider run 종료 직후), Verification schema 매핑, output_path 저장 위치, spawn 실패 surface 방식, CLI exit policy.
3. `RunStore.pathFor`에 `'verify.log'` 키 추가(structural 작은 commit) 또는 기존 키 재사용 결정.
4. `RunWithInput`에 `verify_command?` 추가, `runWithProvider`가 provider run 종료 직후 verify command spawn + manifest.verifications append (behavioral).
5. `ditto run with` CLI에 `--verify` flag 추가 (behavioral, 4와 같은 commit으로 묶거나 분리).
6. 회귀 fixture: verify pass / fail / spawn-fail 각각 manifest 표현 검증 (behavioral test).
7. DITTO self-validation, lint, build 통과 확인.
8. handoff + completion + work item close (changed_files에 self-artifacts 포함).
