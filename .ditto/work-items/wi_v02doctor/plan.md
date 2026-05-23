# Plan: wi_v02doctor

본 문서는 코드 작성 전에 합의받기 위한 plan이다. 사용자가 **[DECISION NEEDED]** 항목을 모두 결정한 뒤에만 execute로 들어간다.

## 사용자 결정 필요 (선결 항목)

다음 결정이 plan/dod/rollback 전반에 영향을 준다. 결정 전에는 execute 금지.

- **D-1. AGENTS.md projection의 source of truth**
  - **[DECIDED: (4a) full 복사]** `AGENTS.md`가 source. host별 projection(`CLAUDE.md`)은 managed block 안에 AGENTS.md 본문을 그대로 복사하는 방식으로 동기화. managed block 밖은 사용자 자유 영역.
  - 동기화는 별도 명령 `ditto bridge sync`로 수행(v0.2 범위에 포함). doctor는 read-only 검사만.

- **D-2. managed block 마커 형식**
  - **[DECIDED: (a) HTML comment]** 마커 형식:
    ```
    <!-- ditto:managed:start source=AGENTS.md sha256=<64hex> -->
    [AGENTS.md 본문]
    <!-- ditto:managed:end -->
    ```
  - `source` 속성은 projection이 어느 파일을 source로 두는지 표기. 현재는 `AGENTS.md`만.
  - `sha256` 속성은 source 파일의 정규화된(LF/trailing ws 정규화 후) sha256. bridge sync가 박고 doctor가 검증.
  - 근거: HTML comment는 Markdown 렌더링 결과에 표시되지 않아 사용자 시각 부담이 없고, model이 마커를 메타로 인식해 행동에 영향 적으며, DITTO parser는 결정적 regex로 추출 가능. front-matter는 블록 묶기에 부적합, 섹션 헤더는 사용자가 텍스트 깨면 마커 손상.

- **D-8. v0.2가 다룰 host 범위**
  - **[DECIDED: Codex + Claude Code]** 사용자 운영 환경상 Codex가 기본, Claude Code가 보조. v0.2는 두 host를 모두 1급으로 지원.
  - host adapter 구조가 필요해짐 → D-9 신규.
  - 두 host가 instruction/permission/MCP/skill을 어떻게 갖는지가 ac에 모두 반영되어야 함.

본 결정의 다음 영향:

| 표면 | Codex가 읽는 곳 | Claude Code가 읽는 곳 |
|---|---|---|
| instructions(공유 system prompt) | `AGENTS.md` 직접 | `CLAUDE.md` managed block 안 (sync로 동기화) |
| permissions / sandbox | `.codex/config.toml` (예: `approval_policy`, `sandbox_mode`, `network_access`) | `.claude/settings.json` (예: `permissions`, `defaultMode`) |
| MCP | `~/.codex/config.toml`의 `[mcp_servers.*]` 섹션 | `~/.claude/...mcp.json` 또는 `.claude/settings.json`의 `mcpServers` |
| skill / agent / command manifest | `~/.codex/plugins/`, `.codex/plugins/` (정확한 구조는 Codex 버전 의존, D-5 확정 시 결정) | `~/.claude/skills/<id>/SKILL.md`, `.claude/agents/`, `.claude/commands/` |

- **D-3 [DECIDED: read-only]** doctor는 진단만. destructive 영역은 `ditto bridge sync`로 분리. `--fix` 옵션은 v0.3+ 별도 ADR.

- **D-4 [DECIDED: 두 host 설정 파일 직접 파싱, Claude는 공식 scope 순서]**
  - Codex adapter:
    - 1차: `~/.codex/config.toml`의 `[mcp_servers.*]` 섹션
    - 2차(later): repo-local Codex 설정이 있다면 (`.codex/config.toml`); v0.2 범위에서는 unverified로 표기하고 후속 phase에서 보강.
  - Claude Code adapter (탐색 순서, 공식 https://code.claude.com/docs/en/mcp 기준):
    1. **project scope**: repo 루트의 `.mcp.json` (commit 대상; 팀 전체에 공유되는 MCP 정의)
    2. **local + user scope**: `~/.claude.json`을 읽어
       - 현재 cwd에 매칭되는 project entry의 mcpServers (local scope)
       - top-level user entry의 mcpServers (user scope)
    3. **plugin/managed MCP**: 공식 처리 경로가 v0.2에서 결정되지 않음 → `unverified`로 표기하고 v0.3+에서 보강.
  - `.claude/settings.json`의 `mcpServers`는 **주 경로 아님** (출처 문서에서 명시되지 않음; 임의 추론은 위험). 단 만약 존재한다면 unverified로 보고하되 합산 대상에서 제외.
  - 공통 schema: `{ host, scope: 'project'|'local'|'user'|'unverified', name, source_file, command?, args?, env_keys?, side_effect_label }`.
  - 같은 server name이 여러 scope에 있으면 별개 entry로 출력하고 scope 필드로 구분 (덮어쓰기 안 함).

- **D-5 [DECIDED: 두 host 디렉터리 인벤토리만, schema 검증은 Phase 9]** v0.2는 발견과 missing/extra/renamed 분류만. SKILL.md frontmatter 같은 manifest 검증은 Phase 9 skill catalog 확정 후.

- **D-6 [DECIDED: 정규화 + sha256]**
  - 정규화: LF 통일 + 줄 끝 trailing whitespace 제거.
  - managed block 내부 정규화 sha256 ↔ marker의 `sha256=` 속성 ↔ source(AGENTS.md) 정규화 sha256, 셋 모두 일치 시 ok.
  - Codex는 source 자체를 읽으므로 별도 비교 불필요. 단 AGENTS.md에 marker가 잘못 박혀 있으면 codex가 model에 marker text를 노출 → doctor가 `marker_in_source` finding 발행.

- **D-7 [DECIDED: drift→1, usage→65, runtime→70, `--advisory` 옵션]**
  - drift 0건 → 0
  - drift 발견 → 1
  - `--output` 등 잘못된 인자 → 65 (이미 InvalidOutputFormatError와 일관)
  - 내부 runtime 오류(파일 IO 실패 등) → 70
  - `--advisory` 플래그를 주면 drift도 0으로 마무리 (CI 통합 옵트인).

- **D-9 [DECIDED: HostAdapter interface 추상화]** `src/core/hosts/types.ts`에 interface 정의, `codex.ts`/`claude-code.ts` 구현. OpenCode/OpenAgent는 같은 interface로 v0.3+에서 추가.

- **D-10 [DECIDED: 기본 모든 host, `--host`로 좁힘]** doctor의 모든 subcommand가 `--host codex|claude-code` 옵션을 받음. 미지정 시 등록된 모든 host 검사. invalid 값은 exit 65.

- **D-11 [DECIDED: codex는 sync source일 뿐 target 아님]** `bridge sync --host codex`는 usage error(exit 65, stderr 메시지). doctor instructions --host codex는 marker 부재(`marker_in_source` finding 부재)와 AGENTS.md 존재만 검사.

## D-1 ~ D-11 결정 요약 (모두 [DECIDED])

| 항목 | 결정 |
|---|---|
| D-1 source of truth | AGENTS.md (4a full 복사) + `ditto bridge sync` |
| D-2 marker 형식 | HTML comment + sha256 메타 |
| D-3 doctor 권한 | read-only (bridge sync로 destructive 분리) |
| D-4 MCP 수집 | 두 host 설정 파일 파싱. Claude는 .mcp.json → ~/.claude.json(project entry → user entry) → 그 외는 unverified |
| D-5 surface 검사 | 두 host 디렉터리 인벤토리만, schema 검증은 Phase 9 |
| D-6 drift 정의 | 정규화 + sha256 (D-2와 일관) |
| D-7 exit code | drift→1, usage→65, runtime→70, `--advisory` 옵트인 |
| D-8 host 범위 | Codex + Claude Code |
| D-9 host adapter 구조 | `HostAdapter` interface 추상화 |
| D-10 doctor의 host 인자 | 기본 모든 host, `--host`로 좁힘 |
| D-11 Codex AGENTS.md sync 대상 | sync source만, target 아님. `bridge sync --host codex`는 usage error |

## 작업 분해 (D-1, D-2, D-8 [DECIDED]; D-3~D-7, D-9~D-11 결정 후 확정)

### P-0. HostAdapter interface와 두 host 구현 (`src/core/hosts/`)
- D-8/D-9 결정 기반.
- `src/core/hosts/types.ts`: `HostAdapter` interface 정의.
  - `id: 'codex' | 'claude-code'`
  - `loadInstructions(repoRoot): InstructionSource | InstructionProjection` — Codex는 source 그 자체, Claude Code는 projection.
  - `loadPermissions(repoRoot): PermissionInventory`
  - `loadMcpServers(repoRoot): McpInventory`
  - `loadSurfaceInventory(repoRoot): SurfaceInventory`
- `src/core/hosts/codex.ts`:
  - instructions: `AGENTS.md` 그대로 (marker 부재 검사).
  - permissions: `.codex/config.toml` (`approval_policy`, `sandbox_mode`, `network_access` 등).
  - mcp: `~/.codex/config.toml`의 `[mcp_servers.*]`.
  - surface: `.codex/plugins/` (D-5 결정에 따라 인벤토리만).
- `src/core/hosts/claude-code.ts`:
  - instructions: `CLAUDE.md` managed block + marker.
  - permissions: `.claude/settings.json` (`permissions`, `defaultMode`, `enabledMcpjsonServers` 등).
  - mcp: `.claude/settings.json`의 `mcpServers` 또는 별도 `mcp.json`.
  - surface: `~/.claude/skills/`, `.claude/agents/`, `.claude/commands/`.

### P-1. InstructionBridge core (`src/core/instruction-bridge.ts`)
- D-1=(4a), D-2=(a) 결정 기반.
- 책임:
  - source 파일 읽기: `AGENTS.md` (repo root 기준 고정 경로).
  - host별 projection 파일 읽기: `CLAUDE.md`(claude-code), 향후 `.codex/AGENTS.md`(codex) 등.
  - managed block 추출: 정규식으로 `<!-- ditto:managed:start ... -->` ~ `<!-- ditto:managed:end -->`를 잡고 `source=`, `sha256=` 속성 파싱.
  - 정규화: LF 통일 + trailing whitespace 제거 후 sha256 계산.
  - 비교: source의 정규화 sha256 ↔ marker의 sha256 값 ↔ 실제 managed block 내용의 정규화 sha256. 세 값이 모두 일치해야 OK.
- API:
  - `loadSource(repoRoot): { path, content, normalizedSha256 }`
  - `loadProjection(repoRoot, host): { path, managedBlock, markerSource, markerSha256, freeArea } | { kind: 'missing' } | { kind: 'no_marker' }`
  - `compare(source, projection): DriftReport` (`ok | sha256_mismatch | source_mismatch | content_mismatch | projection_missing | marker_missing`)
- 본 단계는 데이터 모델만. 명령 호출은 P-5와 P-6.

### P-1b. BridgeSync core (`src/core/bridge-sync.ts`)
- AGENTS.md를 읽어 host별 projection의 managed block을 갱신.
- 동작:
  1. AGENTS.md 정규화 + sha256 계산.
  2. projection 파일 읽기 (없으면 새로 생성, marker 영역만 채움).
  3. marker 영역이 있으면 그 안만 교체. marker가 없으면 파일 끝에 marker block을 append하고 사용자에게 stderr로 알림.
  4. marker 속성 갱신: `source=AGENTS.md sha256=<new>`.
  5. atomic write로 projection 파일 저장.
- sync는 read-only 영역(marker 밖 사용자 자유 영역)은 절대 건드리지 않는다.
- API: `syncHost(repoRoot, host): { path, action: 'created' | 'updated' | 'unchanged', oldSha256, newSha256 }`

### P-2. PermissionInventory core (`src/core/permission-inventory.ts`)
- 두 host adapter(P-0)의 `loadPermissions` 결과를 받아 공통 위험 표면 enum으로 정규화.
- 위험 표면 enum: `dangerous_mode | network_on | secrets_read | write_outside_workspace | approval_bypass`.
- 파일 미존재는 missing으로, fail이 아님.
- host별 매핑 표를 모듈 상수로 둠 (예: codex `sandbox_mode=danger-full-access` → `dangerous_mode`).

### P-3. McpInventory core (`src/core/mcp-inventory.ts`)
- D-4 채택: 두 host adapter의 `loadMcpServers` 결과 합집합. host별 scope 정보 보존.
- 출력 schema: `{ servers: [{ host: 'codex'|'claude-code', scope: 'project'|'local'|'user'|'unverified', name, source_file, command?, args?, env_keys?, side_effect_label }] }`.
- 같은 server name이 여러 scope에 있으면 별도 entry로 출력 (host + scope 필드 조합으로 구분, 덮어쓰지 않음).
- 수집 불가 시 정확한 unavailable 사유(파일 미존재/파싱 실패 등)를 반환, host 자체는 skip이 아니라 unverified.

Codex adapter (P-0의 `loadMcpServers`) 탐색 순서:
1. `~/.codex/config.toml`의 `[mcp_servers.*]` → scope='user'
2. (later, v0.2는 unverified) `.codex/config.toml` → scope='project'

Claude Code adapter (P-0의 `loadMcpServers`) 탐색 순서 (공식 https://code.claude.com/docs/en/mcp 기준):
1. repo 루트의 `.mcp.json` → scope='project' (commit 대상; 팀 공유)
2. `~/.claude.json` 읽어:
   - 현재 cwd에 매칭되는 project entry의 `mcpServers` → scope='local'
   - top-level user entry의 `mcpServers` → scope='user'
3. plugin/managed MCP는 공식 처리 경로가 v0.2에서 결정 안 됨 → scope='unverified'로 보고 (서버 자체는 발견되어도 합산 결과에는 unverified 표기, 합산 카운트에서 제외).
4. `.claude/settings.json`의 `mcpServers`는 주 경로가 *아니므로* v0.2 합산 대상 아님. 발견되면 scope='unverified'로 경고만 표기.

### P-4. SurfaceInventory core (`src/core/surface-inventory.ts`)
- D-5 (a) 채택: 두 host adapter의 `loadSurfaceInventory` 결과를 *발견*과 *missing/extra* 분류로만 출력. Phase 9 확정 전엔 schema 검증 없음.
- 출력 schema: `{ surfaces: [{ host, kind: 'skill'|'agent'|'command'|'plugin', id, path, mismatch?: 'missing_file'|'extra_file'|'renamed' }] }`.
- 두 host의 디렉터리 구조 차이는 host adapter가 흡수, surface-inventory는 공통 view만.

### P-5. doctor CLI 명령 4개 (`src/cli/commands/doctor.ts`)
- `ditto doctor instructions`
- `ditto doctor permissions`
- `ditto doctor mcp`
- `ditto doctor surface`
- 모두 `--output human|json` 지원.
- D-10 (a) 채택: `--host codex|claude-code` 옵션. 미지정 시 등록된 모든 host 자동 검사.
- D-7 exit code 규약 적용.

### P-5b. bridge CLI 명령 (`src/cli/commands/bridge.ts`)
- `ditto bridge sync` — D-1/D-2에 따른 AGENTS.md → projection managed block 동기화.
- 옵션:
  - `--host claude-code` (기본값; D-11에 따라 codex는 sync 대상 아님 — `--host codex`는 usage error)
  - `--check`: 실제 쓰기 없이 차이만 보고 (dry-run, exit 0 일치/exit 1 차이)
  - `--output human|json`
- read-only doctor와 분리해 destructive 동작(파일 쓰기)을 명령 단위로 격리.

### P-6. host projection fixture와 회귀 테스트 (`tests/doctor/`)
- 정상 fixture(source=projection 일치): 모든 명령 exit 0.
- 의도적 drift fixture(공백, 내용, managed block 차이): drift exit code.
- D-3에 따라 read-only 보장: doctor 실행 후 파일 변경 0건.

### P-7. self-validation 보강
- 본 work item이 만드는 evidence를 schema 검증에 포함 (기존 `tests/schemas/repo-self-validation.test.ts` 확장).
- **이 파일은 기존이며 삭제 금지, 케이스 추가만.**

### P-8. manual smoke
- 본 ditto 소스 repo에서 4개 doctor 명령 실행해 drift 0건 확인.
- 의도적으로 `CLAUDE.md` 한 줄 수정해 drift 감지 시연.

## 의존성과 실행 순서

P-0(host adapter)이 P-1~P-4의 토대.
P-1, P-1b, P-2, P-3, P-4는 P-0 위에서 독립적으로 진행. P-1b는 P-1의 추출/정규화 함수를 공유.
P-5는 P-1, P-2, P-3, P-4 모두 필요.
P-5b는 P-1, P-1b 필요.
P-6은 P-5, P-5b 이후.
P-7은 P-6 후 추가.
P-8은 사용자가 수행.

## 예상 변경 파일

신규 생성 (rollback 시 본 파일 목록만 정리):
- `src/core/hosts/types.ts`
- `src/core/hosts/codex.ts`
- `src/core/hosts/claude-code.ts`
- `src/core/instruction-bridge.ts`
- `src/core/bridge-sync.ts`
- `src/core/permission-inventory.ts`
- `src/core/mcp-inventory.ts`
- `src/core/surface-inventory.ts`
- `src/cli/commands/doctor.ts`
- `src/cli/commands/bridge.ts`
- `tests/core/hosts/codex.test.ts`
- `tests/core/hosts/claude-code.test.ts`
- `tests/core/instruction-bridge.test.ts`
- `tests/core/bridge-sync.test.ts`
- `tests/core/permission-inventory.test.ts`
- `tests/core/mcp-inventory.test.ts`
- `tests/core/surface-inventory.test.ts`
- `tests/doctor/*.test.ts` (명령별 1개 이상, host별 fixture 분리)
- `tests/bridge/sync.test.ts`
- `tests/fixtures/doctor/<host>/<scenario>/` (host별 정상/drift 시나리오)
- `tests/fixtures/bridge/<scenario>/` (sync 입력/기대 결과 쌍)

기존 파일 수정 (절대 삭제 금지, `git restore <file>`만):
- `src/cli/index.ts` (doctor subCommand 등록)
- `tests/schemas/repo-self-validation.test.ts` (케이스 보강 한정)

본 work item이 만들거나 갱신하는 `.ditto/` repo-local 파일:
- `.ditto/work-items/wi_v02doctor/{work-item.json, progress.md, completion.json, handoff.md, language-ledger.json}`
- 본 repo에 doctor 명령으로 생성될 evidence/commands.jsonl

## 범위 밖

- provider CLI wrapper(`run_with`) → v0.3.
- doctor `--fix` 옵션 → D-3 결정에 따라 v0.3+로 미룸.
- hook 통합 → Phase 8.
- Codex/OpenCode host 어댑터 → D-8에 따라 v0.3+.
- skill manifest 실제 형식 정의 → Phase 9.

## 추정 작업량

- core 4개 + 명령 4개: 약 3~5시간 (D-1~D-8 결정 의존)
- fixture와 테스트: 약 2~3시간
- 자기 검증과 handoff: 약 0.5시간
- 총: 약 5~8시간(D-1~D-8 결정 시간 + 중단/검토 제외)

## 합의 절차

1. 사용자가 D-1 ~ D-8 결정 (이메일/대화/추천 채택).
2. 결정 사항을 본 plan.md에 [DECIDED: <값>]로 박음.
3. 결정에 따라 dod.md와 rollback.md를 확정.
4. work item status를 in_progress로 변경 후 P-1부터 진행.
