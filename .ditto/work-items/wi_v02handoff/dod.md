# Definition of Done: wi_v02handoff

각 ac는 회귀 테스트 + manual smoke로 검증한다. D-1 ~ D-3는 모두 [DECIDED]이므로 본 dod는 결정 분기 없이 단일 경로.

## 공통 게이트

```
bun run tsc --noEmit
bun run lint
bun test
```

하나라도 실패하면 어떤 ac도 pass로 표시하지 않는다.

## ac-1: started_at_sha 도입 + base 선택 우선순위 (D-1)

검증
```
DITTO_SRC=/Users/incognito/dev/projects/ditto
TMP=$(mktemp -d); cd "$TMP" && git init -q && git commit --allow-empty -m "init"
HEAD_SHA=$(git rev-parse HEAD)

# work start: draft 생성. started_at_sha는 비어 있음.
"$DITTO_SRC"/dist/ditto work start "smoke goal" --request "smoke" --output json > out.json
WI=$(jq -r '.work_item_id' out.json)
test "$(jq -r '.started_at_sha // ""' .ditto/work-items/$WI/work-item.json)" = ""
test "$(jq -r '.status' .ditto/work-items/$WI/work-item.json)" = "draft"

# draft → in_progress 전환 (WorkItemStore.update 경유)
# v0.2에는 CLI 전환 명령이 없으므로 직접 편집 → 다음 store.update 호출 (verify) 시 hook 발동
jq '.status = "in_progress"' .ditto/work-items/$WI/work-item.json > /tmp/wi.json
mv /tmp/wi.json .ditto/work-items/$WI/work-item.json
# verify가 store.update를 호출하면서 hook이 한 번만 박음
"$DITTO_SRC"/dist/ditto verify $WI --criterion ac-1 -- true
test "$(jq -r '.started_at_sha' .ditto/work-items/$WI/work-item.json)" = "$HEAD_SHA"

# 두 번째 commit
echo "x" > a.txt && git add a.txt && git commit -m "second"

# work handoff가 --base 미지정 시 started_at_sha 사용
"$DITTO_SRC"/dist/ditto work handoff $WI --output json > h.json
test "$(jq -r '.base_used' h.json)" = "$HEAD_SHA"
test "$(jq -r '.changed_files | length' h.json)" -ge 1
test "$(jq -r '.changed_files[] | select(.=="a.txt")' h.json)" = "a.txt"

# --base 명시는 started_at_sha를 이김
SECOND=$(git rev-parse HEAD)
"$DITTO_SRC"/dist/ditto work handoff $WI --base $SECOND --output json > h2.json
test "$(jq -r '.base_used' h2.json)" = "$SECOND"
```

기준
- `schemas/work-item.schema.json`에 `started_at_sha`가 optional 필드로 노출
- `ditto work start` 직후 started_at_sha는 비어 있음 (draft에선 작업 시작 시점이 정해지지 않음)
- `WorkItemStore.update`가 status를 draft → in_progress로 전환할 때 `started_at_sha`가 비어 있으면 한 번만 `git rev-parse HEAD`로 박음
- 이미 박혀 있으면 update가 덮어쓰지 않음(idempotent)
- git 밖에서 실행되거나 git 명령 실패 시 필드 omit (기존 work-item.json도 무수정 통과)
- `writeWorkItemHandoff` base 후보 순서: **`--base` 인자(가장 강함) > `started_at_sha` > origin/main > origin/master > main > master**
- 회귀: `tests/core/work-item-store.test.ts`에 (i) start 직후 omit, (ii) draft→in_progress 전환 시 자동 박힘, (iii) 이미 박힌 sha 덮어쓰지 않음. `tests/core/work-item-handoff.test.ts`에 우선순위(--base가 started_at_sha를 이김 + started_at_sha가 origin/main을 이김)

## ac-2: collected replace (D-2)

검증
```
cd "$TMP"
WI=$(ls .ditto/work-items | head -1)
# work-item.json에 가짜 entry 박음
jq '.changed_files = ["never-existed.txt"]' .ditto/work-items/$WI/work-item.json > /tmp/wi.json
mv /tmp/wi.json .ditto/work-items/$WI/work-item.json

# handoff 재실행
"$DITTO_SRC"/dist/ditto work handoff $WI --output json > h.json
# never-existed.txt가 사라져야 함
test "$(jq -r '.changed_files[] | select(.=="never-existed.txt")' h.json | wc -l)" = "0"
# 실제 git diff 결과만 들어가야 함
test "$(jq -r '.changed_files[] | select(.=="a.txt")' h.json)" = "a.txt"
```

기준
- handoff 재실행 후 work-item.json.changed_files가 collected(git 결과)와 일치
- 가짜 entry가 사라짐 (union이 아니라 replace)
- 회귀: `tests/core/work-item-handoff.test.ts`에 첫 handoff 후 가짜 entry 박고 두 번째 handoff 결과 확인

## ac-3: wi_v02doctor changed_files 정정

검증
```
# wi_v02doctor 시작 commit 직전 sha 식별 (git log로)
# 예: ef9ffab가 wi_v02doctor 마지막 docs commit 직전, e75c7bf가 P-0~P-5 묶음 commit.
# wi_v02doctor 시작은 plan.md에 따르면 2026-05-23 새 세션. 실제 commit log로 확인:
git log --oneline --grep="wi_v02doctor" | tail
# wi_v02doctor seed는 2ee498a (docs(ditto): draft wi_v02doctor plan ...).
# 그 직전 sha를 base로.
BASE=$(git rev-parse 2ee498a^)

# wi_v02doctor work-item.json reset + handoff 재실행
jq '.changed_files = []' .ditto/work-items/wi_v02doctor/work-item.json > /tmp/wi.json
mv /tmp/wi.json .ditto/work-items/wi_v02doctor/work-item.json
"$DITTO_SRC"/dist/ditto work handoff wi_v02doctor --base $BASE --output json > h.json

# 정정 결과 확인
COMPLETION=$(jq -r '.changed_files | length' .ditto/work-items/wi_v02doctor/completion.json)
GIT_DIFF=$(git diff --name-only $BASE..0a6177d | wc -l)
# COMPLETION이 GIT_DIFF와 합리적 범위에서 일치 (정확히 같을 필요는 없음 — handoff 시점 status도 포함)
test $COMPLETION -lt 99  # 99개에서 줄어듦
test $COMPLETION -ge 30  # 너무 적지도 않음

# wi_v02harden은 이미 정정됨 — 확인만
test "$(jq -r '.changed_files | length' .ditto/work-items/wi_v02harden/completion.json)" = "34"
```

기준
- wi_v02doctor completion.json/handoff.md/work-item.json의 changed_files가 99 → 합리적 범위로 줄어듦
- wi_v02harden은 34 entries 유지
- 정정 commit은 docs commit 한 개로 묶음

## 전체 done 조건

- ac-1 ~ ac-3 모두 verdict=pass
- 공통 게이트 3 명령 exit 0
- D-1 ~ D-3 모두 [DECIDED] (이미 박힘)
- schemas/work-item.schema.json export 갱신이 같은 work item commit에 포함
- `tests/schemas/repo-self-validation.test.ts`가 wi_v02handoff 산출물 + 정정된 wi_v02doctor 포함해서 통과
