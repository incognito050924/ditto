# Definition of Done: wi_v02harden

각 ac는 회귀 테스트와 (필요 시) manual smoke로 검증한다. D-1 ~ D-5는 모두 [DECIDED] 상태이므로 본 dod는 결정 분기 없이 단일 경로로 작성된다.

## 공통 게이트

다음 셋 중 하나라도 실패하면 어떤 ac도 pass로 표시하지 않는다.

```
bun run tsc --noEmit
bun run lint
bun test
```

## ac-1: Codex TOML 정확도 (D-1=(a) 외부 lib)

검증
```
DITTO_SRC=/Users/incognito/dev/projects/ditto
TMP=$(mktemp -d)
cd "$TMP" && git init -q

# 1) nested section: codex repo config에 [sandbox_workspace_write].network_access=true
mkdir -p .codex
cat > .codex/config.toml <<'TOML'
sandbox_mode = "workspace-write"
[sandbox_workspace_write]
network_access = true
TOML
"$DITTO_SRC"/dist/ditto doctor permissions --host codex --output json > out.json
test "$(jq -r '[.findings[] | select(.label=="network_on")] | length' out.json)" -ge 1

# 2) inline table: ~/.codex/config.toml의 [mcp_servers.fetch] env = { TOKEN = "x", REGION = "kr" }
HOME_MOCK=$(mktemp -d)
mkdir -p "$HOME_MOCK/.codex"
cat > "$HOME_MOCK/.codex/config.toml" <<'TOML'
[mcp_servers.fetch]
command = "npx"
args = ["mcp-fetch"]
env = { TOKEN = "x", REGION = "kr" }
TOML
HOME="$HOME_MOCK" "$DITTO_SRC"/dist/ditto doctor mcp --host codex --output json > out.json
test "$(jq -r '.servers[0].env_keys | length' out.json)" = "2"
test "$(jq -r '.servers[0].env_keys | sort | .[0]' out.json)" = "REGION"
```

기준
- nested section의 위험 필드를 정확히 finding으로 보고
- inline table `env`의 키가 `env_keys`로 정확히 추출 (정렬 포함)
- 회귀: `tests/doctor/permissions.test.ts`, `tests/doctor/mcp.test.ts`에 위 fixture가 자동 검증으로 들어감
- ADR-0001 보강 patch 또는 ADR-0003가 같은 P-1 commit에 포함

## ac-2: Claude permissions allow 분류 (D-2=(b) wildcard + destructive 분리)

검증
```
cd "$TMP" && rm -rf .codex
mkdir -p .claude

# (a) wildcard만 있는 경우 → dangerous_mode + approval_bypass
cat > .claude/settings.json <<'JSON'
{ "permissions": { "allow": ["Bash(*)"] } }
JSON
"$DITTO_SRC"/dist/ditto doctor permissions --host claude-code --output json > out.json
test "$(jq -r '[.findings[] | select(.label=="dangerous_mode")] | length' out.json)" -ge 1
test "$(jq -r '[.findings[] | select(.label=="approval_bypass")] | length' out.json)" -ge 1

# (b) 명시 destructive → write_outside_workspace만, dangerous_mode 아님
cat > .claude/settings.json <<'JSON'
{ "permissions": { "allow": ["Write(*)", "Bash(rm *)", "Bash(sudo *)"] } }
JSON
"$DITTO_SRC"/dist/ditto doctor permissions --host claude-code --output json > out.json
test "$(jq -r '[.findings[] | select(.label=="write_outside_workspace")] | length' out.json)" -ge 1
test "$(jq -r '[.findings[] | select(.label=="dangerous_mode")] | length' out.json)" = "0"

# (c) 보수적 entry는 finding 0
cat > .claude/settings.json <<'JSON'
{ "permissions": { "allow": ["Bash(ls)", "Bash(cat -n)", "Read(*)"] } }
JSON
"$DITTO_SRC"/dist/ditto doctor permissions --host claude-code --output json > out.json
test "$(jq -r '.findings | length' out.json)" = "0"
```

기준
- 세 fixture 모두 `tests/doctor/permissions.test.ts`에서 회귀
- 분류표가 `src/core/permission-inventory.ts`에 모듈 상수로 박혀 있음
- Read(*) 같은 broad read는 write_outside_workspace로 분류되지 않음 (v0.2 label 체계에서 과도 차단 회피)

## ac-3: Surface catalog scope 분리 (D-3=(b) adapter API 분리)

검증
```
cd "$TMP" && rm -rf .claude
HOME_MOCK=$(mktemp -d)
mkdir -p "$HOME_MOCK/.claude/skills/extra-a" "$HOME_MOCK/.claude/skills/extra-b" "$HOME_MOCK/.claude/skills/extra-c"
mkdir -p .ditto .claude/commands
cat > .claude/commands/hello.md <<'MD'
# hello
MD
cat > .ditto/surfaces.json <<'JSON'
{ "schema_version": "0.1.0", "surfaces": [
  { "host": "claude-code", "kind": "command", "id": "hello", "path": ".claude/commands/hello.md" }
] }
JSON
HOME="$HOME_MOCK" "$DITTO_SRC"/dist/ditto doctor surface --host claude-code --output json > out.json
test "$(jq -r '.mismatch_count' out.json)" = "0"
# home-scope skill은 inventory에는 포함되어야 함
test "$(jq -r '[.surfaces[] | select(.id=="extra-a")] | length' out.json)" -ge 1
# 그러나 mismatch 분류 대상은 아니어야 함
test "$(jq -r '[.findings[] | select(.id=="extra-a")] | length' out.json)" = "0"
```

기준
- home-scope surface가 inventory에 포함되되 mismatch 분류 대상에서 제외
- `HostAdapter.loadSurfaceInventory` 결과 schema에 `localSurfaces`/`homeSurfaces` 구분 노출
- 회귀: `tests/doctor/surface.test.ts`에 home mock + repo-local 1개 fixture

## ac-4: Multiple managed block (D-4=(b) bridge sync 거부)

검증
```
cd "$TMP" && rm -rf .claude .ditto
cat > AGENTS.md <<'A'
# AGENTS
line
A
cat > CLAUDE.md <<'C'
<!-- ditto:managed:start source=AGENTS.md sha256=0000000000000000000000000000000000000000000000000000000000000000 -->
old block 1
<!-- ditto:managed:end -->

free area

<!-- ditto:managed:start source=AGENTS.md sha256=1111111111111111111111111111111111111111111111111111111111111111 -->
old block 2
<!-- ditto:managed:end -->
C

# doctor: multiple_markers finding + exit 1
"$DITTO_SRC"/dist/ditto doctor instructions --host claude-code --output json > out.json; DOCTOR=$?
test "$DOCTOR" = "1"
test "$(jq -r '[.findings[] | select(.kind=="multiple_markers")] | length' out.json)" -ge 1

# bridge sync: 갱신 거부, exit 1, free area 보존
FREE_BEFORE=$(grep -c "free area" CLAUDE.md)
"$DITTO_SRC"/dist/ditto bridge sync --host claude-code --output json 2>err.txt; SYNC=$?
test "$SYNC" = "1"
grep -q "marker" err.txt
test "$(grep -c "free area" CLAUDE.md)" = "$FREE_BEFORE"
# managed block 두 개 모두 그대로
grep -c "ditto:managed:start" CLAUDE.md | grep -q "^2$"
```

기준
- finding kind `multiple_markers`가 `InstructionFindingKind` enum에 추가
- bridge sync는 multiple_markers 상태에서 어떤 파일도 수정하지 않음 (자유 영역 + 두 marker block 모두 그대로)
- stderr에 정리 경로 안내 메시지
- 회귀: `tests/doctor/instructions.test.ts`, `tests/bridge/sync.test.ts`, `tests/core/instruction-bridge.test.ts`

## ac-5: Advisory 회귀 + bridge free-area + mcp advisory 제거 (D-5=(a))

검증
```
# permissions --advisory: 위험 발견에도 exit 0
cd "$TMP" && rm -rf .codex .claude && mkdir -p .claude
cat > .claude/settings.json <<'JSON'
{ "permissions": { "allow": ["Bash(*)"] } }
JSON
"$DITTO_SRC"/dist/ditto doctor permissions --host claude-code --advisory --output json; test $? -eq 0

# surface --advisory: mismatch에도 exit 0
mkdir -p .ditto
cat > .ditto/surfaces.json <<'JSON'
{ "schema_version": "0.1.0", "surfaces": [
  { "host": "claude-code", "kind": "command", "id": "missing", "path": ".claude/commands/missing.md" }
] }
JSON
"$DITTO_SRC"/dist/ditto doctor surface --host claude-code --advisory --output json; test $? -eq 0

# mcp --advisory: 옵션 자체가 제거되었으므로 usage error
"$DITTO_SRC"/dist/ditto doctor mcp --advisory --output json; test $? -eq 65

# bridge free-area-only 회귀: 자유 영역만 수정해도 action=unchanged + 자유 영역 보존
cd "$TMP" && rm -rf * .ditto .claude .codex
cat > AGENTS.md <<'A'
# AGENTS
shared
A
"$DITTO_SRC"/dist/ditto bridge sync --host claude-code --output json > /dev/null
echo "사용자 추가 줄" >> CLAUDE.md
"$DITTO_SRC"/dist/ditto bridge sync --host claude-code --output json > sync.json
test "$(jq -r '.action' sync.json)" = "unchanged"
grep -q "사용자 추가 줄" CLAUDE.md
```

기준
- doctor permissions/surface에 `--advisory` 회귀 각 1건
- doctor mcp는 `--advisory` 전달 시 usage error(exit 65, stderr에 unknown flag 안내)
- bridge sync free-area-only 시나리오 회귀가 `tests/bridge/sync.test.ts` 또는 `tests/core/bridge-sync.test.ts`에 들어감
- 자유 영역의 추가 줄이 sync 후에도 보존됨 (grep 또는 sha256)

## 전체 done 조건

- ac-1 ~ ac-5 모두 verdict=pass
- 공통 게이트 3 명령 exit 0
- D-1 ~ D-5 모두 [DECIDED] (이미 박힘)
- ADR-0001 보강 patch 또는 ADR-0003가 같은 작업 묶음에 포함
- `tests/schemas/repo-self-validation.test.ts`가 `wi_v02harden` 산출물 포함해서 통과
