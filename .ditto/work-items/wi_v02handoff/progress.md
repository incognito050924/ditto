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

## P-1 완료 (2026-05-24 23:00)
- 22:55 work-item.json status draft → in_progress로 직접 편집 (이 시점엔 P-1b hook 코드가 아직 없어 자동 박힘 불가; P-4의 ditto verify 호출 시 hook이 backfill).
- 23:00 (structural) work-item.ts에 `started_at_sha: gitSha40.optional()` 추가. `writeWorkItemHandoff` base 후보 우선순위: `--base`(별도 분기, 가장 강함) > `started_at_sha` > origin/main 등 fallback. schemas:export로 work-item.schema.json 갱신. 회귀 121 pass(영향 0).
  - commit af96bbd `refactor(ditto): add started_at_sha field and pipe into handoff base list (structural)`
- 23:10 (behavioral) `WorkItemStore.update`가 status draft→in_progress 전환 시 `tryGitHeadSha`로 박음. 이미 박혀 있거나 git 실패 시 omit. 회귀 6건: store hook 4(omit/박힘/덮어쓰기 안 함/git 밖 omit) + handoff 우선순위 2(--base가 started_at_sha 이김 / started_at_sha가 fallback 이김). 127 pass.
  - commit 07eee87 `feat(ditto): backfill started_at_sha on draft→in_progress transition (behavioral)`
  - **메시지 오타**: 본문에 "wi_v02harden P-1b"로 잘못 적힘. 본 work item은 wi_v02handoff. amend 없이 본 진행 로그로 기록.

## P-2 완료 (2026-05-24 23:20)
- `writeWorkItemHandoff`의 `merged = union(item.changed_files, collected)` → `merged = collected`. 한 번 잘못 박힌 list가 누적되지 않음.
- 회귀 1건 교체: 기존 "renders changed_files section when present"는 union 가정이라 D-2 의도에 맞게 교체. 새 회귀 "replace (not union)": git repo + init commit + 실제 파일 변경 + 가짜 entry → handoff 후 가짜 사라지고 collected만 남음을 completion.json/handoff.md/work-item.json 셋에서 확인.
  - commit d75cccd `feat(ditto): replace work item changed_files with git collected on handoff (behavioral)`

## 검증 (P-1 + P-2)
- `bun run tsc --noEmit` pass
- `bun run lint` pass
- `bun test` 127 pass / 0 fail (이전 121 + 신규 6: store hook 4 + handoff 우선순위 2; union → replace 회귀는 기존 1건 교체로 수 동일)
- schema self-validation 10/10

## 다음 동작
- 사용자 review 시점 (P-1 + P-2 묶음). plan.md Review 합의대로 여기서 한 번 review 받기.
- review 통과 시 P-3(wi_v02doctor changed_files 정정) + P-4(self-validation + manual smoke + handoff) 묶음으로 마감.
- P-4의 ditto verify 호출 시 본 wi_v02handoff의 started_at_sha가 hook으로 자동 backfill됨 (현재 직접 편집한 status 변경 후 첫 store.update가 trigger).
