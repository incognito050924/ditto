# Plan: wi_v01implement

본 문서는 코드 작성 전에 합의받기 위한 plan이다. 사용자가 합의(또는 수정 요청)한 뒤에만 execute로 들어간다.

## 작업 분해

### P-1. core 파일 I/O 유틸 (`src/core/fs.ts`)
- atomic write: temp 파일 → rename
- JSON read/write with zod 검증
- 디렉터리 보장(mkdir recursive)
- repo 루트 탐지: 현재 cwd부터 위로 올라가며 `.ditto/` 또는 `.git/`를 찾는다. 둘 다 없으면 현재 cwd에 새 `.ditto/`를 만들 후보로 본다. ditto 소스 repo 경로에 종속되지 않아야 한다(DoD ac-1~ac-5의 temp repo 검증을 위해 필수).

### P-2. id generator (`src/core/id.ts`)
- `wi_`, `run_`, `rv_` 접두어
- 시간 기반(YYMMDD) + random 4자 이상으로 8자 이상 보장
- 충돌 시 재시도

### P-3. WorkItemStore (`src/core/work-item-store.ts`)
- `create(input) → WorkItem`
- `get(id) → WorkItem`
- `update(id, mutator) → WorkItem`
- `list() → WorkItemSummary[]`
- 모든 read/write에 zod 검증 강제

### P-4. RunStore (`src/core/run-store.ts`)
- `create(input) → RunManifest`
- `get(id) → RunManifest`
- `update(id, mutator)`
- 부속 파일(prompt.md, stdout.log, stderr.log, diff.patch, result.md) 경로 helper

### P-5. EvidenceStore (`src/core/evidence-store.ts`)
- `appendCommand(workItemId, entry)` → `evidence/commands.jsonl`에 한 줄 append
- entry는 ts, kind, command, exit_code, duration_ms, sha256 필드를 가짐

### P-6. CLI 5개 명령 실제 구현
- 골격은 이미 존재. `run` 함수 내부를 not_implemented에서 실제 동작으로 교체.
- 각 명령은 P-1 ~ P-5만 호출한다. CLI 레이어는 인자 변환, 출력 포맷, exit code만 책임.

| 명령 | 사용하는 store | 결과 파일 |
|---|---|---|
| `work start` | WorkItemStore.create | `.ditto/work-items/<id>/work-item.json` + `language-ledger.json` + 빈 `evidence/` |
| `work status` | WorkItemStore.get/list | (출력만) |
| `work handoff` | WorkItemStore.update + 새 파일 작성 | `handoff.md`, `completion.json` |
| `run record` | RunStore.create + WorkItemStore.update | `.ditto/runs/<id>/manifest.json`, work item의 runs 배열 갱신 |
| `verify` | EvidenceStore.appendCommand + WorkItemStore.update | `evidence/commands.jsonl`, work item의 acceptance verdict 갱신 |

### P-7. 자체 검증 테스트 (`tests/schemas/repo-self-validation.test.ts`)
- `.ditto/work-items/*/work-item.json`, `completion.json`, `language-ledger.json`을 모두 읽어 schema 검증
- `.ditto/runs/*/manifest.json`도 검증
- `.ditto/knowledge/glossary.json` 검증

### P-8. 사용자 manual smoke
plan 합의 후 사용자에게 다음을 실행 안내:

```
bun run dev work start "..." --request "..."
bun run dev work status <wi_id> --output json
bun run dev run record <wi_id> --provider claude-code
bun run dev verify <wi_id> --criterion ac-1
bun run dev work handoff <wi_id>
```

## 의존성과 실행 순서
P-1 → P-2 → P-3 → P-4 → P-5 → P-6 → P-7 → P-8
P-3, P-4, P-5는 P-1, P-2 위에서만 동작. CLI 레이어(P-6)는 P-3~P-5 모두 필요.

## 예상 변경 파일

- 신규: `src/core/{fs,id,work-item-store,run-store,evidence-store}.ts`
- 수정: `src/cli/commands/work.ts`, `src/cli/commands/run.ts`, `src/cli/commands/verify.ts`, `src/cli/util.ts`
- 신규: `tests/schemas/repo-self-validation.test.ts`, `tests/core/*.test.ts`(store별 1개 이상)

## 범위 밖

- provider CLI 실행 wrapper(codex/claude spawn) → wi_v02doctor 또는 v0.3
- doctor 명령 → v0.2
- hook 통합 → Phase 8
- 동시성/락 → 후속 phase
- multi-repo workspace → Phase 11

## 추정 작업량

- core 5개: 약 1.5~2시간
- CLI 실구현: 약 1~1.5시간
- 자체 schema 검증 + 단위 테스트: 약 0.5~1시간
- 총: 약 3~5시간(중단/검토 시간 제외)
