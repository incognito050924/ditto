# Definition of Done: wi_v02doctor

각 acceptance criterion은 다음 검증 명령을 통과해야 done으로 본다. 검증 명령 없이 done을 주장하지 않는다. D-1~D-8 결정에 따라 일부 명령이 변경될 수 있으며, 변경 시 본 문서를 갱신해야 한다.

## 공통 게이트

다음 셋 중 하나라도 실패하면 어떤 ac도 pass로 표시하지 않는다.

```
bun x tsc --noEmit
bun run lint
bun test
```

## DITTO_REPO_ROOT 환경변수

doctor가 검사하는 대상 repo는 cwd 기반으로 자동 탐지. self-validation 테스트는 `DITTO_REPO_ROOT`로 검증 대상 repo 루트를 받음(기본은 ditto 소스 repo). temp repo 시나리오에서는 명시적으로 지정한다.

## ac-1: doctor instructions (D-1, D-2, D-6 결정 의존)

검증
```
DITTO_SRC=/Users/incognito/dev/projects/ditto
TMP=$(mktemp -d)
cd "$TMP" && git init -q

# 정상 fixture 복사 (source=projection 일치)
cp -r "$DITTO_SRC/tests/fixtures/doctor/instructions-ok/." .

# 1) 일치 시 exit 0
"$DITTO_SRC"/dist/ditto doctor instructions --output json > out.json
test "$(jq -r '.drift_count' out.json)" = "0"
test $? -eq 0

# 2) 의도적 drift 만든 후
echo "drift" >> CLAUDE.md
"$DITTO_SRC"/dist/ditto doctor instructions --output json > out.json
test "$(jq -r '.drift_count' out.json)" != "0"
# exit code는 D-7 결정에 따라 1 또는 0(--advisory)
```

기준
- 일치 시 exit 0, drift_count=0
- drift 시 [DECISION D-7] 결정된 exit code, drift_count>0
- json 출력에 각 projection별 위치/source/diff hash 포함

## ac-2: doctor permissions

검증
```
cd "$TMP"
# 정상 fixture (.claude/settings.json 안전 구성)
cp -r "$DITTO_SRC/tests/fixtures/doctor/permissions-safe/." .
"$DITTO_SRC"/dist/ditto doctor permissions --output json > out.json
test "$(jq -r '.dangerous_count' out.json)" = "0"

# 위험 fixture
cp -r "$DITTO_SRC/tests/fixtures/doctor/permissions-dangerous/." . -f
"$DITTO_SRC"/dist/ditto doctor permissions --output json > out.json
test "$(jq -r '[.findings[] | select(.label=="dangerous_mode")] | length' out.json)" -ge 1
```

기준
- 위험 표면 enum별로 발견을 분류 출력
- 파일 미존재는 missing(fail 아님), 정상 exit 0
- 명시적 위험 발견 시 stderr 경고 + exit code D-7 결정 적용

## ac-3: doctor mcp (D-4 결정 의존)

검증
```
cd "$TMP"
# D-4=(b) 설정 파일 파싱 가정
cp -r "$DITTO_SRC/tests/fixtures/doctor/mcp-config-only/." .
"$DITTO_SRC"/dist/ditto doctor mcp --output json > out.json
test "$(jq -r '.servers | length' out.json)" -ge 1

# inventory 수집 불가 fixture (설정 파일 없음)
cd "$TMP" && rm -rf "$TMP"/*
"$DITTO_SRC"/dist/ditto doctor mcp --output json > out.json
test "$(jq -r '.status' out.json)" = "unverified"
test "$(jq -r '.unavailable_reason' out.json | wc -c)" -gt 1
```

기준
- 수집 결과에 각 server의 source_file과 side_effect_label 포함
- 수집 불가 시 unverified + 사유 명시(fail 아님)

## ac-4: doctor surface (D-5 결정 의존)

검증
```
cd "$TMP"
# D-5=(c) mock fixture만 lint
cp -r "$DITTO_SRC/tests/fixtures/doctor/surface-ok/." .
"$DITTO_SRC"/dist/ditto doctor surface --output json > out.json
test "$(jq -r '.mismatch_count' out.json)" = "0"

# manifest와 파일 불일치 fixture
cp -r "$DITTO_SRC/tests/fixtures/doctor/surface-mismatch/." . -f
"$DITTO_SRC"/dist/ditto doctor surface --output json > out.json
test "$(jq -r '[.findings[] | select(.kind=="missing_file")] | length' out.json)" -ge 1
```

기준
- missing_file/extra_file/renamed/manifest_invalid 종류별 분류
- 종류별 개수가 json 출력에 명시

## ac-5: 출력 형식과 exit code 회귀

검증
```
# 모든 doctor 명령이 --output json|human 두 형식 지원
for cmd in instructions permissions mcp surface; do
  "$DITTO_SRC"/dist/ditto doctor $cmd --output xml; test $? -eq 65
  "$DITTO_SRC"/dist/ditto doctor $cmd --output json | jq . > /dev/null
done

# read-only 보장 (D-3)
cd "$TMP"
cp -r "$DITTO_SRC/tests/fixtures/doctor/instructions-ok/." .
HASH_BEFORE=$(find . -type f -name "*.md" -exec sha256sum {} \; | sort)
"$DITTO_SRC"/dist/ditto doctor instructions
HASH_AFTER=$(find . -type f -name "*.md" -exec sha256sum {} \; | sort)
test "$HASH_BEFORE" = "$HASH_AFTER"
```

기준
- 모든 doctor 명령이 invalid --output 값을 exit 65로 reject
- json 출력은 항상 valid JSON
- read-only: doctor 실행 후 파일/디렉터리 sha256 동일

## ac-6: 자체 검증 테스트

```
bun --cwd /Users/incognito/dev/projects/ditto test tests/schemas/repo-self-validation.test.ts
bun test tests/doctor/
```

기준
- repo-self-validation 통과 (기존 케이스 + wi_v02doctor 추가 산출물)
- doctor 명령별 fixture 회귀 테스트 모두 pass

## 전체 done 조건

- ac-1 ~ ac-6 모두 verdict=pass
- 공통 게이트 3개 exit 0
- D-1~D-8 결정 사항이 plan.md에 [DECIDED: <값>]로 명시
- 새 ADR이 필요한 결정이 있었다면 ADR-NNNN 추가
