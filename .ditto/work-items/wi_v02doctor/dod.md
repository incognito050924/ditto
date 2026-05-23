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

## ac-1: doctor instructions (D-1, D-2, D-8 적용, D-6/D-10 의존)

두 host를 모두 검사한다. `--host` 미지정 시 양쪽, `--host codex|claude-code`로 좁힘.

검증 (claude-code 경로)
```
DITTO_SRC=/Users/incognito/dev/projects/ditto
TMP=$(mktemp -d)
cd "$TMP" && git init -q

# 정상 fixture: AGENTS.md + CLAUDE.md (managed block에 AGENTS.md 본문 + 올바른 sha256)
cp -r "$DITTO_SRC/tests/fixtures/doctor/codex/instructions-ok/." .
cp -r "$DITTO_SRC/tests/fixtures/doctor/claude-code/instructions-ok/." .

# 1) marker sha256 일치 + 내용 일치 → ok (claude-code)
"$DITTO_SRC"/dist/ditto doctor instructions --host claude-code --output json > out.json
test "$(jq -r '.findings | length' out.json)" = "0"
test $? -eq 0

# 2) managed block 내용 변경 → content_mismatch
sed -i.bak 's/원본 줄/변조된 줄/' CLAUDE.md
"$DITTO_SRC"/dist/ditto doctor instructions --output json > out.json
test "$(jq -r '[.findings[] | select(.kind=="content_mismatch")] | length' out.json)" -ge 1

# 3) AGENTS.md 변경 → sha256_mismatch (marker는 옛 sha256을 들고 있음)
mv CLAUDE.md.bak CLAUDE.md
echo "new line" >> AGENTS.md
"$DITTO_SRC"/dist/ditto doctor instructions --output json > out.json
test "$(jq -r '[.findings[] | select(.kind=="sha256_mismatch")] | length' out.json)" -ge 1

# 4) marker 자체가 없는 projection
echo "no marker" > CLAUDE.md
"$DITTO_SRC"/dist/ditto doctor instructions --output json > out.json
test "$(jq -r '[.findings[] | select(.kind=="marker_missing")] | length' out.json)" -ge 1

# 5) projection 파일 자체가 없음 (claude-code)
rm -f CLAUDE.md
"$DITTO_SRC"/dist/ditto doctor instructions --host claude-code --output json > out.json
test "$(jq -r '[.findings[] | select(.kind=="projection_missing")] | length' out.json)" -ge 1
```

검증 (codex 경로)
```
cd "$TMP" && rm -rf "$TMP"/*

# 1) AGENTS.md만 있고 marker 없음 → ok
cat > AGENTS.md <<'A'
# AGENTS
shared instruction
A
"$DITTO_SRC"/dist/ditto doctor instructions --host codex --output json > out.json
test "$(jq -r '.findings | length' out.json)" = "0"

# 2) AGENTS.md에 marker가 박혀 있음 → marker_in_source 경고
cat > AGENTS.md <<'A'
<!-- ditto:managed:start source=AGENTS.md sha256=abc -->
oops
<!-- ditto:managed:end -->
A
"$DITTO_SRC"/dist/ditto doctor instructions --host codex --output json > out.json
test "$(jq -r '[.findings[] | select(.kind=="marker_in_source")] | length' out.json)" -ge 1

# 3) AGENTS.md 없음 → source_missing
rm AGENTS.md
"$DITTO_SRC"/dist/ditto doctor instructions --host codex --output json > out.json
test "$(jq -r '[.findings[] | select(.kind=="source_missing")] | length' out.json)" -ge 1
```

기준
- 일치 시 exit 0, findings=0
- claude-code drift 종류 4가지(content_mismatch / sha256_mismatch / marker_missing / projection_missing)
- codex drift 종류 2가지(marker_in_source / source_missing)
- drift 발생 시 exit code는 D-7 결정. 정해지면 본 dod의 `test $? -eq <N>` 확인 추가.
- json 출력 필드: host, path, markerSource, markerSha256, actualSha256, sourceSha256, kind, message
- `--host` 미지정 시 두 host 모두 검사하고 findings를 합산

## ac-2: doctor permissions

검증
```
cd "$TMP"
# 정상 fixture (.claude/settings.json 안전 구성)
mkdir -p .codex .claude
cp "$DITTO_SRC/tests/fixtures/doctor/codex/permissions-safe/config.toml" .codex/config.toml
cp "$DITTO_SRC/tests/fixtures/doctor/claude-code/permissions-safe/settings.json" .claude/settings.json
"$DITTO_SRC"/dist/ditto doctor permissions --output json > out.json
test "$(jq -r '.dangerous_count' out.json)" = "0"

# 위험 fixture
cp "$DITTO_SRC/tests/fixtures/doctor/codex/permissions-dangerous/config.toml" .codex/config.toml
cp "$DITTO_SRC/tests/fixtures/doctor/claude-code/permissions-dangerous/settings.json" .claude/settings.json
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
# D-4=(a) 설정 파일 파싱 가정
cp -r "$DITTO_SRC/tests/fixtures/doctor/claude-code/mcp-config-only/." .
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
# D-5=(a) mock fixture만 lint
mkdir -p .ditto .claude/commands
cp "$DITTO_SRC/tests/fixtures/doctor/claude-code/surface-ok/surfaces.json" .ditto/surfaces.json
cp "$DITTO_SRC/tests/fixtures/doctor/claude-code/surface-ok/hello.md" .claude/commands/hello.md
"$DITTO_SRC"/dist/ditto doctor surface --output json > out.json
test "$(jq -r '.mismatch_count' out.json)" = "0"

# manifest와 파일 불일치 fixture
cp "$DITTO_SRC/tests/fixtures/doctor/claude-code/surface-mismatch/surfaces.json" .ditto/surfaces.json
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
cp -r "$DITTO_SRC/tests/fixtures/doctor/codex/instructions-ok/." .
cp -r "$DITTO_SRC/tests/fixtures/doctor/claude-code/instructions-ok/." .
HASH_BEFORE=$(find . -type f -name "*.md" -exec sha256sum {} \; | sort)
"$DITTO_SRC"/dist/ditto doctor instructions
HASH_AFTER=$(find . -type f -name "*.md" -exec sha256sum {} \; | sort)
test "$HASH_BEFORE" = "$HASH_AFTER"
```

기준
- 모든 doctor 명령이 invalid --output 값을 exit 65로 reject
- json 출력은 항상 valid JSON
- read-only: doctor 실행 후 파일/디렉터리 sha256 동일

## ac-7: bridge sync (D-1, D-2 결정 적용)

검증
```
DITTO_SRC=/Users/incognito/dev/projects/ditto
TMP=$(mktemp -d)
cd "$TMP" && git init -q

# 1) marker 없는 CLAUDE.md → bridge sync가 marker block을 append
cat > AGENTS.md <<'AGENTS'
# AGENTS
shared instruction line 1
shared instruction line 2
AGENTS

cat > CLAUDE.md <<'CLAUDE'
## Claude 자유 영역
사용자 자유 편집
CLAUDE

USER_AREA_BEFORE=$(sha256sum CLAUDE.md | awk '{print $1}')
"$DITTO_SRC"/dist/ditto bridge sync --host claude-code --output json 2>/tmp/sync.err
grep -q "appended new managed block" /tmp/sync.err
# marker가 추가됐는지
grep -q "ditto:managed:start" CLAUDE.md
# managed block 안에 AGENTS.md 본문 포함
grep -q "shared instruction line 1" CLAUDE.md
# 자유 영역은 보존됨
grep -q "사용자 자유 편집" CLAUDE.md

# 2) sync 후 doctor instructions가 ok로 통과
"$DITTO_SRC"/dist/ditto doctor instructions --output json > out.json
test "$(jq -r '.findings | length' out.json)" = "0"

# 3) AGENTS.md 변경 후 --check는 차이 보고 + 파일 미수정
echo "new line" >> AGENTS.md
HASH_BEFORE=$(sha256sum CLAUDE.md | awk '{print $1}')
"$DITTO_SRC"/dist/ditto bridge sync --host claude-code --check --output json > check.json
test "$(jq -r '.action' check.json)" = "would-update"
HASH_AFTER=$(sha256sum CLAUDE.md | awk '{print $1}')
test "$HASH_BEFORE" = "$HASH_AFTER"

# 4) --check 없이 실행하면 managed block만 갱신, 자유 영역 보존
"$DITTO_SRC"/dist/ditto bridge sync --host claude-code --output json > sync.json
test "$(jq -r '.action' sync.json)" = "updated"
grep -q "new line" CLAUDE.md
grep -q "사용자 자유 편집" CLAUDE.md

# 5) sync 후 doctor 다시 ok
"$DITTO_SRC"/dist/ditto doctor instructions --output json > out.json
test "$(jq -r '.findings | length' out.json)" = "0"

# 6) 자유 영역만 수정한 경우 sync는 unchanged (managed block 동일)
echo "사용자 추가 줄" >> CLAUDE.md
"$DITTO_SRC"/dist/ditto bridge sync --host claude-code --output json > sync.json
test "$(jq -r '.action' sync.json)" = "unchanged"
grep -q "사용자 추가 줄" CLAUDE.md

# 7) --host codex는 sync 대상이 아님 → usage error (D-11)
"$DITTO_SRC"/dist/ditto bridge sync --host codex; test $? -eq 65
```

기준
- managed block 외 영역은 어떤 경우에도 sha256 변경 없음
- `--check`는 read-only(파일 sha256 변경 없음), 결과만 보고
- action enum: `created | updated | unchanged | would-create | would-update | would-be-unchanged`
- sync 후 doctor instructions --host claude-code가 일치 보고
- `--host codex`는 exit 65 + stderr 메시지(codex는 AGENTS.md를 source로 직접 읽으므로 sync 불필요)

## ac-8: HostAdapter 확장성 (mock host 회귀)

검증 (단위 테스트)
```
bun test tests/core/hosts/registry.test.ts
```

테스트 내용:
- 기본 registry에 codex, claude-code 두 host가 등록되어 있음
- mock host adapter(id='mock')를 등록 후 doctor 명령이 mock도 호출
- mock에서 의도된 finding을 반환하면 합산된 findings에 포함

## ac-6: 자체 검증 테스트

```
bun --cwd /Users/incognito/dev/projects/ditto test tests/schemas/repo-self-validation.test.ts
bun test tests/doctor/
```

기준
- repo-self-validation 통과 (기존 케이스 + wi_v02doctor 추가 산출물)
- doctor 명령별 fixture 회귀 테스트 모두 pass

## 전체 done 조건

- ac-1 ~ ac-8 모두 verdict=pass
- 공통 게이트 3개 exit 0
- D-1, D-2, D-8 [DECIDED] 박힘, D-3~D-7, D-9~D-11 모두 [DECIDED]로 채택되어 있음
- 새 ADR이 필요한 결정이 있었다면 ADR-NNNN 추가 (특히 D-9 host adapter 구조는 ADR 후보)
