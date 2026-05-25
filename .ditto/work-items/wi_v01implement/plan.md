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

`verify` 명령은 임의의 사용자 명령을 그대로 실행해야 한다. 현재 골격은 인자가 정의되지 않았으므로 다음 중 하나로 확장한다.

- (A) `process.argv` 직접 처리: citty `run`에 `rawArgs`/`process.argv`에서 `--` 이후 슬라이스를 받아 실행. 명령에 공백/특수문자가 자연스럽게 들어감.
- (B) `--command` 플래그: `ditto verify $WI --criterion ac-1 --command "echo smoke ok"`. citty 표준 args로 정의 가능. shell escape 필요.

본 work item은 (A)를 채택한다. 이유: 사용자가 평소 사용하는 명령 그대로 verify에 붙일 수 있어 인지 비용이 가장 낮다. citty가 처리하지 않는 `--` 이후 args는 `process.argv.slice(process.argv.indexOf('--') + 1)`로 추출하고, `--`가 없으면 인자 부족으로 exit 65를 낸다. CLI 골격의 `src/cli/commands/verify.ts`는 `args` 정의 외에 별도 tail extractor를 둔다.

`exit_code`가 0이면 해당 acceptance criterion verdict를 `pass`로, 0이 아니면 `fail`로 기록한다. `--criterion`이 생략되면 모든 acceptance에 동일 결과를 적용하지 않고, 단순히 evidence/commands.jsonl에만 append하고 verdict는 갱신하지 않는다(악의적/광범위한 일괄 pass 방지).

### P-7. 자체 검증 테스트 보강 (`tests/schemas/repo-self-validation.test.ts`)
- **이 파일은 wi_v01bootstrap에서 이미 생성되었다. 본 단계는 기존 파일에 케이스를 추가하는 확장 작업이며, 삭제 대상이 아니다.**
- 기존: `.ditto/work-items/*/work-item.json`, `completion.json`, `language-ledger.json`, `.ditto/runs/*/manifest.json`, `.ditto/knowledge/glossary.json` 검증과 ditto-src identity describe, `DITTO_REPO_ROOT` env 지원이 이미 들어 있다.
- 추가할 케이스: 새 store가 만드는 모든 파일이 schema에 부합하는지 검증. 특히 `evidence/commands.jsonl`은 줄별로 `commandLogEntry.parse`로 검증한다(이미 추가됨, 케이스 보강 한정).
- 단위 테스트 신규: `tests/core/*.test.ts` (store별 1개 이상).

### P-8. 사용자 manual smoke
plan 합의 후 사용자에게 다음을 실행 안내:

```
bun run dev work start "..." --request "..."
bun run dev work status <wi_id> --output json
bun run dev run record <wi_id> --provider claude-code
bun run dev verify <wi_id> --criterion ac-1 -- echo "smoke ok"
bun run dev work handoff <wi_id>
```

## 의존성과 실행 순서
P-1 → P-2 → P-3 → P-4 → P-5 → P-6 → P-7 → P-8
P-3, P-4, P-5는 P-1, P-2 위에서만 동작. CLI 레이어(P-6)는 P-3~P-5 모두 필요.

## 예상 변경 파일

신규 생성 (rollback 시 본 파일 목록만 정리한다):
- `src/core/fs.ts`
- `src/core/id.ts`
- `src/core/work-item-store.ts`
- `src/core/run-store.ts`
- `src/core/evidence-store.ts`
- `tests/core/fs.test.ts`
- `tests/core/id.test.ts`
- `tests/core/work-item-store.test.ts`
- `tests/core/run-store.test.ts`
- `tests/core/evidence-store.test.ts`

기존 파일 수정 (절대 삭제 금지, `git restore <file>`만):
- `src/cli/commands/work.ts`
- `src/cli/commands/run.ts`
- `src/cli/commands/verify.ts`
- `src/cli/util.ts`
- `tests/schemas/repo-self-validation.test.ts` (케이스 보강 한정)

본 work item이 만들거나 갱신하는 `.ditto/` repo-local 파일:
- `.ditto/work-items/wi_v01implement/{work-item.json, progress.md, completion.json, handoff.md, language-ledger.json}`
- 사용자 manual smoke 결과로 생기는 `.ditto/work-items/<smoke-wi-id>/...`와 `.ditto/runs/<smoke-run-id>/...`는 사용자 실험 자산이므로 자동 삭제 대상 아님.

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
