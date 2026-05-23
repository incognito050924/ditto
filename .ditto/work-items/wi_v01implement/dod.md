# Definition of Done: wi_v01implement

각 acceptance criterion이 다음 검증 명령을 통과해야 done으로 본다. 검증 명령 없이 done을 주장하지 않는다.

## 공통 게이트

다음 셋 중 하나라도 실패하면 어떤 ac도 pass로 표시하지 않는다.

```
bun x tsc --noEmit
bun run lint
bun test
```

## DITTO_REPO_ROOT 환경변수

각 ac 검증은 temp 디렉터리(`$TMP`)를 별도 `.ditto` 저장소로 사용한다. self-validation 테스트는 환경변수 `DITTO_REPO_ROOT`로 검증 대상 repo 루트를 받는다. 기본값은 ditto 소스 repo이므로, temp repo를 검증하려면 명시적으로 지정해야 한다.

```
DITTO_REPO_ROOT="$TMP" bun --cwd /Users/incognito/dev/projects/ditto test tests/schemas/repo-self-validation.test.ts
```

`cd "$TMP"` 후 `bun --cwd /Users/incognito/dev/projects/ditto run dev ...`로 호출하면 ditto 소스 repo에서 실행되어 그 cwd로 `.ditto`를 만들게 된다. ac-1~ac-5에서는 work start 자체도 `--workspace "$TMP"`를 받게 하거나 cwd를 `$TMP`로 두고 직접 binary를 실행해야 한다. v0.1 구현은 cwd 기반 repo 루트 탐지를 채택한다(P-1 core fs).

## ac-1: work start

검증
```
DITTO_SRC=/Users/incognito/dev/projects/ditto
TMP=$(mktemp -d)
cd "$TMP" && git init -q
"$DITTO_SRC"/dist/ditto work start \
  "사용자 등록 API 비밀번호 강도 검증" \
  --request "비밀번호 강도 검증 추가" \
  --output json > out.json
# 또는 binary 미생성 시: bun --cwd "$TMP" "$DITTO_SRC/src/cli/index.ts" work start ...

# 1) JSON 출력이 work item id를 포함한다
jq -r '.work_item_id' out.json | grep -E '^wi_[a-z0-9]{8,}$'

# 2) 파일이 temp repo 안에 생성되었고 schema에 부합한다
WI=$(jq -r '.work_item_id' out.json)
test -f "$TMP/.ditto/work-items/$WI/work-item.json"
DITTO_REPO_ROOT="$TMP" bun --cwd "$DITTO_SRC" test tests/schemas/repo-self-validation.test.ts
```

기준
- exit 0
- 생성된 `work-item.json`은 `status=draft`, `acceptance_criteria.length >= 1`
- 동일 명령 두 번째 실행 시 새 id가 생성된다(id 충돌 회피)
- 검증 테스트가 본 ditto 소스 repo가 아니라 `$TMP/.ditto`를 본다(DITTO_REPO_ROOT 지정)

## ac-2: work status

검증
```
# work start 결과의 WI 사용. cwd가 $TMP에 있어야 ditto가 $TMP/.ditto를 찾는다.
cd "$TMP"
"$DITTO_SRC"/dist/ditto work status $WI --output human    # exit 0, goal/status 표시
"$DITTO_SRC"/dist/ditto work status $WI --output json     # exit 0, work-item.json 내용 반환
"$DITTO_SRC"/dist/ditto work status                        # 인자 생략 시 목록
```

기준
- json 출력이 schema 검증을 통과(stdout을 jq로 받아 workItem.parse 가능)
- 존재하지 않는 id는 exit 65, stderr에 메시지

## ac-3: work handoff

두 별도 temp work item으로 pass 경로와 partial 경로를 각각 검증한다.

### 경로 A: final_verdict=pass

```
cd "$TMP"
# 별도 work item을 만들어 모든 acceptance를 pass로 만든다
"$DITTO_SRC"/dist/ditto work start "all-pass smoke" --request "ac-3 pass path" --output json > a.json
WI_A=$(jq -r '.work_item_id' a.json)
# 모든 ac를 pass로 만든다 (acceptance가 1개라고 가정)
"$DITTO_SRC"/dist/ditto verify $WI_A --criterion ac-1 -- true

"$DITTO_SRC"/dist/ditto work handoff $WI_A
test -f "$TMP/.ditto/work-items/$WI_A/handoff.md"
test -f "$TMP/.ditto/work-items/$WI_A/completion.json"
jq -e '.final_verdict == "pass"' "$TMP/.ditto/work-items/$WI_A/completion.json"
jq -e '[.unverified[] | select(.out_of_scope == false)] | length == 0' \
  "$TMP/.ditto/work-items/$WI_A/completion.json"

DITTO_REPO_ROOT="$TMP" bun --cwd "$DITTO_SRC" test tests/schemas/repo-self-validation.test.ts
```

### 경로 B: final_verdict=partial

```
cd "$TMP"
"$DITTO_SRC"/dist/ditto work start "partial smoke" --request "ac-3 partial path" --output json > b.json
WI_B=$(jq -r '.work_item_id' b.json)
"$DITTO_SRC"/dist/ditto verify $WI_B --criterion ac-1 -- sh -c "exit 1" || true

"$DITTO_SRC"/dist/ditto work handoff $WI_B
test -f "$TMP/.ditto/work-items/$WI_B/handoff.md"
test -f "$TMP/.ditto/work-items/$WI_B/completion.json"
jq -e '.final_verdict != "pass"' "$TMP/.ditto/work-items/$WI_B/completion.json"
jq -e '.next_handoff_path != null' "$TMP/.ditto/work-items/$WI_B/completion.json"

DITTO_REPO_ROOT="$TMP" bun --cwd "$DITTO_SRC" test tests/schemas/repo-self-validation.test.ts
```

### 경로 C: 잘못된 pass 주장 거부 (회귀)

```
# completion contract의 cross-field 룰이 동작함을 직접 확인
cat > /tmp/bad-completion.json <<'JSON'
{ "schema_version":"0.1.0","work_item_id":"wi_badpass1","declared_by":"x","declared_at":"2026-05-24T00:00:00+09:00","summary":"x","changed_files":[],"acceptance":[{"criterion_id":"ac-1","verdict":"fail","evidence":[]}],"verifications":[],"unverified":[],"remaining_risks":[],"final_verdict":"pass" }
JSON
bun --cwd "$DITTO_SRC" -e "import {completionContract} from './src/schemas/completion-contract'; import {readFileSync} from 'node:fs'; try { completionContract.parse(JSON.parse(readFileSync('/tmp/bad-completion.json','utf8'))); console.error('FAIL: should have thrown'); process.exit(1); } catch { process.exit(0); }"
```

기준
- 경로 A: 모든 acceptance pass + in-scope unverified 0건 → `final_verdict=pass` completion.json + handoff.md
- 경로 B: 비-pass acceptance가 있으면 `next_handoff_path`가 채워진 completion.json + handoff.md
- 경로 C: final_verdict=pass인데 비-pass acceptance가 섞인 completion contract는 schema parse에서 reject
- 세 경로 모두에서 self-validation 테스트가 통과

## ac-4: run record

검증
```
cd "$TMP"
"$DITTO_SRC"/dist/ditto run record $WI --provider claude-code --profile workspace-write --output json > run.json
RUN=$(jq -r '.run_id' run.json)
test -f "$TMP/.ditto/runs/$RUN/manifest.json"
DITTO_REPO_ROOT="$TMP" bun --cwd "$DITTO_SRC" test tests/schemas/repo-self-validation.test.ts

# work item의 runs 배열이 갱신되었는지
jq '.runs | length' "$TMP/.ditto/work-items/$WI/work-item.json"
```

기준
- manifest.json이 `runManifest.parse`를 통과
- work item의 `runs` 배열 길이가 1 증가
- 같은 work item에 두 번째 run을 기록해도 첫 run을 덮지 않음

## ac-5: verify

검증
```
cd "$TMP"

# 1) 정상 pass 경로: -- 이후 명령 실행, exit 0 → verdict=pass
"$DITTO_SRC"/dist/ditto verify $WI --criterion ac-1 -- echo "smoke ok"
grep -q '"command":"echo smoke ok"' "$TMP/.ditto/work-items/$WI/evidence/commands.jsonl"
jq -e '.acceptance_criteria[] | select(.id=="ac-1") | .verdict == "pass"' \
  "$TMP/.ditto/work-items/$WI/work-item.json"

# 2) 실패 경로: exit 1 → verdict=fail
"$DITTO_SRC"/dist/ditto verify $WI --criterion ac-2 -- sh -c "exit 1" || true
jq -e '.acceptance_criteria[] | select(.id=="ac-2") | .verdict == "fail"' \
  "$TMP/.ditto/work-items/$WI/work-item.json"

# 3) --criterion 생략: evidence만 append, verdict 변경 없음
PREV=$(jq '.acceptance_criteria[] | select(.id=="ac-1") | .verdict' \
  "$TMP/.ditto/work-items/$WI/work-item.json")
"$DITTO_SRC"/dist/ditto verify $WI -- echo "no criterion"
NEW=$(jq '.acceptance_criteria[] | select(.id=="ac-1") | .verdict' \
  "$TMP/.ditto/work-items/$WI/work-item.json")
test "$PREV" = "$NEW"

# 4) -- 누락: exit 65
"$DITTO_SRC"/dist/ditto verify $WI --criterion ac-1; test $? -eq 65

# 5) schema 검증
DITTO_REPO_ROOT="$TMP" bun --cwd "$DITTO_SRC" test tests/schemas/repo-self-validation.test.ts
```

기준
- commands.jsonl이 한 줄 추가됨(commandLogEntry schema 부합: ts, kind=command, command, exit_code, duration_ms?, sha256?)
- exit code 0이면 지정 criterion의 verdict가 pass, 0이 아니면 fail
- `--criterion` 생략 시 evidence만 append, 어떤 verdict도 변경되지 않음(광범위 일괄 pass 방지)
- `--` 누락 시 exit 65 + stderr 메시지

## ac-6: 자체 검증 테스트

본 ditto 소스 repo의 `.ditto`도 schema에 부합해야 한다.

```
bun --cwd /Users/incognito/dev/projects/ditto test tests/schemas/repo-self-validation.test.ts
# DITTO_REPO_ROOT 미지정 시 기본값(ditto 소스 repo)로 동작
```

기준
- `.ditto/work-items/wi_v01bootstrap/work-item.json`, `completion.json`, `language-ledger.json` 모두 통과
- `.ditto/work-items/wi_v01implement/work-item.json`, `completion.json`, `language-ledger.json` 모두 통과
- `.ditto/work-items/*/evidence/commands.jsonl`이 있으면 줄별 `commandLogEntry` 검증 통과
- `.ditto/runs/*/manifest.json`이 있으면 모두 통과
- `.ditto/knowledge/glossary.json` 통과
- 테스트 실패 0건
- ac-1~ac-5의 temp repo 검증도 `DITTO_REPO_ROOT="$TMP"`로 동일 테스트를 통과

## 전체 done 조건

- ac-1 ~ ac-6 모두 verdict=pass
- 위 공통 게이트 3개 모두 exit 0
- ADR 변경이 필요한 결정이 있었다면 ADR-NNNN 추가 commit
