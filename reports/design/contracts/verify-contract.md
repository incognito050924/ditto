---
title: "`ditto run with --verify` Contract (상세 설계)"
kind: design-detail
last_updated: 2026-06-07 KST
status: implemented (v0.3)
parent: reports/design/contracts/run-with-contract.md
owns: "`--verify` 옵션의 'how' (옵션 의미론 · verification entry shape · 실패 모드 · CLI exit 비간섭 정책)"
inputs:
  - src/core/run-with.ts        # runVerifyStep + verify_command 흐름 (authoritative)
  - src/cli/commands/run.ts     # --verify 플래그 정의
  - src/schemas/run-manifest.ts # Verification entry schema
  - reports/design/contracts/run-with-contract.md  # 상위 CLI 표면
---

# `ditto run with --verify` Contract (상세 설계)

> **이 문서의 위치.** `ditto run with`의 `--verify` 옵션 — provider run 종료 직후 검증 명령 하나를 끼워 그 결과를 manifest evidence로 남기는 단계 — 의 *how*를 소유한다. 상위 CLI 표면은 [`run-with-contract.md`](run-with-contract.md)가 소유한다. 이 계약은 work-item 노트(`wi_v03verify`)에서 설계됐고, 본 문서는 **현재 코드(`src/core/run-with.ts` `runVerifyStep`)에 맞춰 재정합한 durable 권위 문서**다.

## 0. 결정 요약

`--verify`는 wrapper(`runWithProvider`)와 enforcement를 그대로 재사용하면서 흐름 끝에 verification 단계 하나를 끼워 넣는다.

- CLI 플래그: `ditto run with ... --verify "<command>"`. 단일 string, whitespace로 word-split.
- 호출 시점: provider run 종료 직후, work item linkage **직전**(`runWithProvider`에서 manifest update 뒤, linkage 앞).
- 산출물: `.ditto/runs/<run_id>/verify.log`(stdout + stderr 합본) + `runManifest.verifications`에 entry 1건.
- CLI exit: provider exit_code만 반영. verify 결과는 manifest로만 surface.

## 1. `--verify` 옵션 의미론

- **Flag shape**: `--verify <command-string>` (citty `type: 'string'`, `required: false`).
- **Single occurrence**: v0.3은 run당 single verify. 복수 verify는 후속.
- **Word splitting**: 단순 whitespace 분리(`command.split(/\s+/).filter(Boolean)`). quoted args나 shell expansion은 미지원 — 복잡하면 `--verify ./scripts/verify.sh`로 script 위임.
- **Empty / whitespace-only**: split 후 빈 배열이면 entry를 `exit_code: -1` + `notes: 'verify spawn failed: empty command after whitespace split'`로 기록한다(빈 `verify.log` 작성). **Reconciled.** source 노트는 "USAGE error로 거부"라고 적었으나, 현재 코드는 USAGE 에러를 던지지 않고 spawn-실패 entry로 기록한다 — `--verify`가 RunWithRuntimeError/UsageError를 발생시키지 않는다는 §3 불변과 일관된다.

## 2. Verification Entry Shape

`runWithProvider`가 verify 단계 종료 후 `runManifest.verifications`에 entry 1건 append:

```ts
{
  command: <원본 command-string>, // split 전 raw, 사용자 가독성
  exit_code: <int>,               // Bun.spawnSync exitCode; spawn 실패/빈 명령 시 -1
  duration_ms: <int>,             // started ~ ended
  output_path: '.ditto/runs/<run_id>/verify.log', // 항상 기록(빈 파일이라도)
  ...(spawnFailed ? { notes: 'verify spawn failed: ...' } : {})
}
```

`verifications`는 default `[]`. 단일 entry append → 기존 배열 길이 + 1. verify 명령은 `runRoot`(isolated profile이면 worktree, 아니면 repoRoot)에서 spawn된다.

## 3. 실패 모드

| case | verifications entry | manifest.exit_code | CLI exit |
|---|---|---|---|
| verify spawn 성공, exit 0 | `{exit_code: 0, ...}` | provider exit | provider exit |
| verify spawn 성공, exit non-zero | `{exit_code: <code>, ...}` | provider exit | provider exit |
| verify spawn 실패 (ENOENT 등) | `{exit_code: -1, notes: 'verify spawn failed: ...'}` | provider exit | provider exit |
| verify 명령 비어있음(whitespace-only) | `{exit_code: -1, notes: 'verify spawn failed: empty command ...'}` | provider exit | provider exit |
| verify hang (timeout 없음) | wrapper도 hang | — | — |
| user가 `--verify` 안 줌 | 변화 없음 (verifications=[]) | provider exit | provider exit |

verify는 `RunWithRuntimeError`를 발생시키지 않는다. wrapper의 best-effort manifest update는 verify가 어떻게 끝나든 끝까지 수행된다.

## 4. CLI Exit 정책

- `ditto run with` CLI exit_code는 provider exit_code만 반영(상위 `run-with-contract.md` §4 결정 유지).
- verify 결과로 CLI exit이 바뀌지 않는다. 이유: verify는 evidence layer이고, run capture가 성공했으면 그 자체로 wrapper 임무 완료. verify 결과 기반 gating은 호출자(CI/사용자 script)의 책임.

## 5. 범위 밖 (v0.3)

- verify timeout 옵션.
- 복수 `--verify` 플래그.
- shell interpretation(`bash -c` 자동 wrap 등) — 사용자가 script로 위임.
- `ditto verify` 명령과의 evidence ledger 통합 — 별도 경로 유지.
- verify 결과 기반 AC verdict 자동 update.
- verify 결과 기반 CLI exit gating — 호출자 책임.
- streaming / chunked output — single buffer write로 충분.
