# Progress: wi_v02handoff

## 현재 상태
`draft` — 2026-05-24 22:30 wi_v02harden post-review에서 식별된 work-item-handoff core 정리를 위한 work item 초안 생성. D-1 ~ D-3 [DECIDED] 박힘. P-1 시작 직전.

## 진행 로그
- 22:30 wi_v02harden post-review correction(F-2)에서 root cause 분리: (1) 기본 base가 origin/main(23+ commit 뒤처짐), (2) writeWorkItemHandoff가 union으로 changed_files 누적. 두 root cause를 본 work item으로 시드.
  - AC 3개: started_at_sha 도입 / collected replace / wi_v02doctor 정정
  - D 3건 모두 추천값으로 [DECIDED] 박힘. 기술 결정만이라 사용자 별도 확인 불필요(`feedback_decision_defaults.md` 적용).
  - status=draft, owner_profile=workspace-write로 시작.

## 사용자 seed review 통과 (2026-05-24 22:45)
- seed 자체 OK. 진행 시 리뷰 포인트 3개 명시:
  1. started_at_sha는 *"생성 시점"이 아니라 "draft → in_progress 전환 시점"에 한 번만* 세팅하는 게 안전.
  2. handoff base 우선순위는 explicit `--base > started_at_sha > 기존 fallback`. 명시 base를 이기면 안 됨.
  3. replace 회귀는 "기존 가짜 entry가 재실행 후 사라진다"를 꼭 박을 것.
- 반영:
  - **D-1 표현 정정**: "ditto work start 자동 채움" → "WorkItemStore.update가 status draft→in_progress 전환 감지 시 자동 박음 (idempotent)". plan.md D-1과 P-1, dod.md ac-1 검증 명령 모두 갱신.
  - 우선순위 #2: plan.md/dod.md 이미 일치 (`--base` > `started_at_sha` > origin/main fallback). 강조 명문화.
  - 회귀 #3: dod.md ac-2 이미 "가짜 entry가 사라짐" 박힘. 유지.

## 다음 동작
- work-item.json status를 draft → in_progress로 갱신 (이 work item 자체는 v0.2 동안 hook이 적용되지 않으므로 started_at_sha는 P-1 commit 후 backfill 검토).
- P-1(schema + WorkItemStore.update hook + handoff base 선택) 시작:
  - (structural) work-item.ts에 started_at_sha optional + handoff base 후보 list에 끼움
  - (behavioral) work-item-store.update가 status draft→in_progress 전환 시 git rev-parse HEAD로 박음
  - schemas:export로 work-item.schema.json 갱신
  - 회귀: work-item-store.test(전환 hook 3 케이스) + work-item-handoff.test(우선순위 2 케이스)
