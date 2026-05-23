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

- **D-3. doctor의 권한 범위**
  - (a) read-only 진단만. drift 발견 시 출력만 하고 종료.
  - (b) `--fix` 옵션으로 자동 수정 허용 (단, dry-run 기본).
  - 추천: (a) — v0.2 기본은 진단만. fix는 v0.3+로 분리.

- **D-4. MCP inventory 수집 방법**
  - (a) `claude mcp list` 같은 host CLI 호출(실시간).
  - (b) `~/.claude/.../mcp-config.json`, `.codex/config.toml` 등 설정 파일 직접 파싱.
  - (c) 둘 다 시도하고 합집합.
  - 추천: (b) — host CLI 안정성에 덜 의존. 단 (a)도 후속 phase에서 보강.

- **D-5. skill manifest 형식과 위치**
  - (a) `.ditto/skills/<skill>/manifest.json`에 zod schema 적용.
  - (b) `~/.claude/skills/`나 plugin manifest를 그대로 읽고 ditto는 검증만.
  - (c) Phase 9 skill catalog가 정의될 때까지 mock fixture만.
  - 추천: (c) — v0.2 surface 명령은 mock fixture에 대한 lint로 우선 구현, 실제 manifest와의 연동은 Phase 9 합의 후.

- **D-6. drift 정의(diff 알고리즘)**
  - (a) sha256 비교 (정확하나 공백 변경에도 trigger).
  - (b) 정규화(LF/trailing whitespace) 후 sha256.
  - (c) managed block 내부만 비교.
  - 추천: (b) + (c)의 조합 — managed block 내부를 정규화 후 sha256.

- **D-7. exit code 규약**
  - (a) drift 0건 → 0, drift 발견 → 1, 사용 오류 → 65, 명령 자체 실패 → 70.
  - (b) drift는 항상 0(advisory). 오류만 비-0.
  - 추천: (a) — CI 통합 시 drift가 빌드를 실패시키는 게 자연스러움. `--advisory` 플래그로 (b) 동작 옵트인.

- **D-8. v0.2가 다룰 host 범위**
  - (a) Claude Code 단독.
  - (b) Claude Code + Codex.
  - (c) Claude Code + Codex + OpenCode.
  - 추천: (a) — v0.2는 단일 host로 시작, Codex/OpenCode는 v0.3+에서 adapter 추가.

## 작업 분해 (D-1, D-2는 [DECIDED]; D-3~D-8 결정 후 확정)

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
- `.claude/settings.json`, `.codex/config.toml` 위험 표면 식별.
- 위험 표면 enum: `dangerous_mode | network_on | secrets_read | write_outside_workspace`.
- 파일 미존재는 missing으로, fail이 아님.

### P-3. McpInventory core (`src/core/mcp-inventory.ts`)
- D-4 결정 기반. 추천 (b)면 설정 파일 직접 파싱.
- 출력: `{ servers: [{ name, source_file, side_effect_label }] }`.
- 수집 불가 시 정확한 unavailable 사유 반환.

### P-4. SurfaceInventory core (`src/core/surface-inventory.ts`)
- D-5 결정 기반. 추천 (c)면 mock fixture에 대한 lint만.
- manifest와 실제 파일 차이를 missing/extra/renamed로 분류.

### P-5. doctor CLI 명령 4개 (`src/cli/commands/doctor.ts`)
- `ditto doctor instructions`
- `ditto doctor permissions`
- `ditto doctor mcp`
- `ditto doctor surface`
- 모두 `--output human|json` 지원.
- D-7 exit code 규약 적용.

### P-5b. bridge CLI 명령 (`src/cli/commands/bridge.ts`)
- `ditto bridge sync` — D-1/D-2에 따른 AGENTS.md → projection managed block 동기화.
- 옵션:
  - `--host claude-code` (기본값; D-8에 따라 v0.2는 claude-code만 지원)
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

P-1, P-1b, P-2, P-3, P-4는 독립적으로 진행 가능(각각 다른 core 파일). 단 P-1b는 P-1의 추출/정규화 함수를 공유 — `src/core/instruction-bridge.ts`에서 helper로 export하고 P-1b가 import.
P-5는 P-1~P-4 모두 필요.
P-5b는 P-1, P-1b 필요.
P-6은 P-5, P-5b 이후.
P-7은 P-6 후 추가.
P-8은 사용자가 수행.

## 예상 변경 파일

신규 생성 (rollback 시 본 파일 목록만 정리):
- `src/core/instruction-bridge.ts`
- `src/core/bridge-sync.ts`
- `src/core/permission-inventory.ts`
- `src/core/mcp-inventory.ts`
- `src/core/surface-inventory.ts`
- `src/cli/commands/doctor.ts`
- `src/cli/commands/bridge.ts`
- `tests/core/instruction-bridge.test.ts`
- `tests/core/bridge-sync.test.ts`
- `tests/core/permission-inventory.test.ts`
- `tests/core/mcp-inventory.test.ts`
- `tests/core/surface-inventory.test.ts`
- `tests/doctor/*.test.ts` (명령별 1개 이상)
- `tests/bridge/sync.test.ts`
- `tests/fixtures/doctor/<scenario>/` (정상/drift 시나리오별)
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
