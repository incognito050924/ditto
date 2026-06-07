---
title: "`ditto run with` CLI Contract (상세 설계)"
kind: design-detail
last_updated: 2026-06-07 KST
status: implemented (v0.3)
parent: reports/design/ditto-claude-code-harness-design.md
owns: "`ditto run with` 명령 표면의 'how' (필수/선택 플래그 · `--` 인자 forwarding · work item/prompt 선택 · exit-code 정책 · JSON 출력 · profile 정책)"
inputs:
  - src/core/run-with.ts        # runWithProvider orchestration (authoritative)
  - src/cli/commands/run.ts     # `ditto run with` citty 정의 (authoritative)
  - reports/design/contracts/host-adapter-contract.md  # spawn 계약(어댑터 측)
  - src/schemas/run-manifest.ts # provider/profile enum, manifest 필드
---

# `ditto run with` CLI Contract (상세 설계)

> **이 문서의 위치.** `ditto run with` — 기존 수동 `ditto run record`의 자동 짝 — 의 CLI 표면 *how*를 소유한다. provider를 실제 spawn하고 run을 capture하는 사용자 진입점이다. spawn 계약(어댑터 측)은 [`host-adapter-contract.md`](host-adapter-contract.md)가 소유하고, 본 문서는 그 위의 CLI/wrapper 표면을 소유한다. 이 계약은 work-item 노트(`wi_260524qi9`)에서 설계됐고, 본 문서는 **현재 코드(`src/core/run-with.ts`·`src/cli/commands/run.ts`)에 맞춰 재정합한 durable 권위 문서**다.

## 0. 명령 형태

```sh
ditto run with --provider <provider> --work-item <id> [--profile <profile>] [--prompt <path>] [--verify <command>] [--output human|json] -- <provider args...>
```

**Reconciled (source 노트 대비).** source 노트는 플래그를 `--profile <profile> --work-item <id>`로 적었으나, 현재 CLI는:
- `--provider` (required, string): runnable provider `codex|claude-code`.
- `--work-item` (required, string): 이 run을 attach할 work item id (citty arg key `workItem`).
- `--profile` (선택, default `workspace-write`): 실행 profile.
- `--prompt` (선택): repo-relative prompt/context packet 경로.
- `--verify` (선택): provider 종료 후 실행할 명령 — [`verify-contract.md`](verify-contract.md) 참조.
- `--output` (선택, default `human`): `human|json`.

`cwd`/`env`는 v0.3에서 CLI 플래그가 **아니다** — `runWithProvider` 입력으로만 받는 프로그래매틱 표면이며, CLI는 `--`-뒤 인자만 forward한다.

## 1. Work Item 선택

규칙:
- `--work-item <id>`는 required.
- id는 `WorkItemStore.get`으로 resolve돼야 한다.
- run id는 `RunStore.create` 성공 **이후에만** `workItem.runs`에 append된다.
- `RunStore.create` 이후 work item linkage가 실패하면 run manifest는 유지하고, DITTO 런타임 에러(`RunWithRuntimeError`)를 반환한다. 복구는 후속 명시 명령에 맡긴다.
- v0.3은 암묵적 active-work-item 추론을 추가하지 않는다(여러 work item이 있을 때 hidden behavior가 됨).

## 2. Prompt 경로

규칙:
- `--prompt <path>`는 선택.
- 경로는 repo-relative path schema 제약(`relativePath`)을 만족해야 한다.
- 주어지면 spawn **전에** 존재해야 한다 — 없으면 provider run을 만들지 않고 fail-fast(`RunWithUsageError`, `assertExistingPrompt`).
- `run with`는 prompt 자체를 생성하지 않는다(`ditto context build`의 책임).
- 생략하면 manifest `prompt_path`는 부재.

## 3. Provider 인자 (`--` forwarding)

`--` 뒤의 모든 것은 `HostRunInput.args`로 변경 없이 전달된다(`extractDashDashTail`). 어댑터가 provider binary와 provider-native 고정 플래그를 앞에 붙인다.

```sh
ditto run with --provider codex --profile read-only --work-item wi_... -- exec --help
ditto run with --provider claude-code --profile reviewer --work-item wi_... -- --print "review this diff"
```

`--` 뒤 인자가 없으면(`tail === null || tail.length === 0`) USAGE 에러로 거부한다.

## 4. 출력과 Exit

`--output human|json` 규약을 지원한다. JSON 출력(`RunWithResult`)은 다음을 포함한다:
- `run_id`
- `work_item_id`
- `manifest_path`
- `provider`
- `profile`
- `exit_code`

**Exit-code 정책:**
- provider exit 0 → CLI exit 0.
- provider non-zero exit → evidence capture 후 그 provider exit code를 CLI process exit으로 반환(`process.exit(result.exit_code)`).
- `exit_code === null`(DITTO 런타임 실패/spawn 부재 등) → DITTO 런타임 에러 코드(`RUNTIME_ERROR_EXIT`).
- `RunWithUsageError` → USAGE 에러 코드. `RunWithRuntimeError` → 런타임 에러 코드(`--output json`이면 부분 `result`도 출력).
- **Reconciled.** `--verify` 결과는 CLI exit을 바꾸지 않는다 — manifest `verifications`로만 surface([`verify-contract.md`](verify-contract.md) §4).

## 5. Profile 정책 (wrapper 측)

- cwd는 repo-relative여야 하고 repo root를 벗어나면 거부(`resolveRepoCwd`).
- 비-`networked` profile은 network proxy env(`HTTP_PROXY/HTTPS_PROXY/NO_PROXY/ALL_PROXY`)를 unset(`policyEnv`).
- post-run 변경 파일을 검사해 정책 위반을 `manifest.unverified`로 surface(`profileUnverified`): repo 밖 변경, 또는 read-only/reviewer profile에서의 write.
- **Reconciled.** `isolated` profile은 source 노트에 없던 동작을 한다 — run 전용 git worktree를 만들어(`createWorktreeForRun`) 그 안에서 spawn하고, `manifest.worktree_path`에 기록한다. worktree 생성 실패는 best-effort manifest update 후 `RunWithRuntimeError`.

## 6. 범위 밖 (v0.3)

- active work item 자동 선택.
- `run with` 안에서 context packet 생성.
- `--` forwarding 이상의 provider-specific 고수준 subcommand.
- `runManifest.provider` enum 밖 provider 실행.
