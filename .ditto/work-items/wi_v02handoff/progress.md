# Progress: wi_v02handoff

## 현재 상태
`draft` — 2026-05-24 22:30 wi_v02harden post-review에서 식별된 work-item-handoff core 정리를 위한 work item 초안 생성. D-1 ~ D-3 [DECIDED] 박힘. P-1 시작 직전.

## 진행 로그
- 22:30 wi_v02harden post-review correction(F-2)에서 root cause 분리: (1) 기본 base가 origin/main(23+ commit 뒤처짐), (2) writeWorkItemHandoff가 union으로 changed_files 누적. 두 root cause를 본 work item으로 시드.
  - AC 3개: started_at_sha 도입 / collected replace / wi_v02doctor 정정
  - D 3건 모두 추천값으로 [DECIDED] 박힘. 기술 결정만이라 사용자 별도 확인 불필요(`feedback_decision_defaults.md` 적용).
  - status=draft, owner_profile=workspace-write로 시작.

## 다음 동작
- work-item.json status를 draft → in_progress로 갱신.
- P-1(schema + work-item-store + handoff base 선택) 시작:
  - (structural) work-item.ts에 started_at_sha optional 추가 + handoff base 후보 list에 포함
  - (behavioral) work-item-store.create가 git rev-parse HEAD로 자동 채움
  - schemas:export로 work-item.schema.json 갱신
  - 회귀: work-item-store.test + work-item-handoff.test
