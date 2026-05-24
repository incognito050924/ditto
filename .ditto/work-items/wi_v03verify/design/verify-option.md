# `ditto run with --verify` Design

## Decision Summary

wi_v03verify는 wi_260524qi9의 wrapper와 wi_v03sandbox의 enforcement를 그대로 재사용하면서 `runWithProvider` 흐름 끝에 verification 단계 한 개를 끼워 넣는다.

- 새 CLI flag: `ditto run with ... --verify "<command>"`. 단일 string, whitespace로 word-split.
- 호출 시점: provider run 종료 직후, work item linkage 직전.
- 산출물: `.ditto/runs/<run_id>/verify.log` (stdout + stderr 합본) + `runManifest.verifications`에 entry 1건.
- CLI exit: provider exit_code만 반영. verify 결과는 manifest로만 surface.
- 단일 design note로 마감.

## Current Reuse Boundary

손대지 않는 것:
- `runWithProvider` orchestration의 전체 골격(`src/core/run-with.ts`) — RunStore.create → spawn → pipe → git_after/diff → manifest update → work item linkage. verify 단계는 update와 linkage 사이에 끼움.
- `runManifest.verifications` schema(`src/schemas/run-manifest.ts`) — 이미 `Verification = {command, exit_code, duration_ms?, output_path?, notes?}` 보유. 추가/수정 없음.
- 기존 `ditto verify` CLI(`src/cli/commands/verify.ts`) — evidence ledger + AC verdict update 경로 그대로. 본 work item과 독립.
- profile sandbox enforcement(wi_v03sandbox) — verify는 sandbox 밖에서 wrapper가 직접 spawn하므로 sandbox flag 영향 없음.

확장 한 군데:
- `RunStore.pathFor`의 kind union에 `'verify.log'` 추가. structural 한 줄.

## 1. `--verify` Option Semantics

- **Flag shape**: `--verify <command-string>` (citty `type: 'string'`, `required: false`).
- **Single occurrence**: v0.3은 single verify per run. 복수 verify는 후속 work item.
- **Word splitting**: 단순 whitespace 분리(`command.split(/\s+/).filter(Boolean)`). quoted args나 shell expansion은 미지원. 복잡한 경우 `--verify ./scripts/verify.sh` 형태로 script 위임.
- **Empty / whitespace-only**: split 후 빈 배열이면 USAGE error로 거부.

## 2. Verification Entry Shape

`runWithProvider`가 verify 단계 종료 후 `runManifest.verifications`에 entry 1건 append.

```ts
{
  command: <원본 command-string>, // split 전 raw, 사용자 가독성
  exit_code: <int>, // Bun.spawnSync exitCode; spawn 실패 시 -1
  duration_ms: <int>, // started ~ ended
  output_path: '.ditto/runs/<run_id>/verify.log', // 항상 기록(빈 파일이라도)
  // notes는 spawn 실패 시에만
  ...(spawnFailed ? { notes: 'verify spawn failed: ...' } : {})
}
```

`verifications`는 default `[]`. 본 work item이 단일 entry append하므로 기존 배열 길이 + 1.

## 3. Failure Modes

| case | verifications entry | manifest.exit_code | CLI exit |
|---|---|---|---|
| verify spawn 성공, exit 0 | `{exit_code: 0, ...}` | provider exit | provider exit |
| verify spawn 성공, exit non-zero | `{exit_code: <code>, ...}` | provider exit | provider exit |
| verify spawn 실패 (ENOENT 등) | `{exit_code: -1, notes: 'verify spawn failed: ...'}` | provider exit | provider exit |
| verify hang (timeout 없음) | wrapper도 hang | — | — |
| user가 `--verify` 안 줌 | 변화 없음 (verifications=[]) | provider exit | provider exit |

verify가 RunWithRuntimeError를 발생시키지 않음을 명시. wrapper의 best-effort manifest update는 verify가 어떻게 끝나든 끝까지 수행됨.

## 4. CLI Exit Policy

- `ditto run with` CLI exit_code는 provider exit_code만 반영(wi_260524qi9의 결정 유지).
- verify 결과로 CLI exit이 바뀌지 않음. 이유: verify는 evidence layer이고, run capture가 성공했으면 그 자체로 wrapper 임무 완료. verify 결과 기반 gating은 호출자(CI/사용자 script)의 책임.

## 5. Test Surface

신규 fixture(`tests/core/run-with.test.ts`):
- verify pass: 단순 `echo ok` 형태 command → exit_code 0, verifications에 entry, output_path에 'ok' 포함.
- verify fail: `sh -c "exit 7"` 형태 → exit_code 7, manifest에 entry, run capture는 완료.
- verify spawn fail: 존재하지 않는 binary → exit_code -1, notes 'verify spawn failed' surface.
- `--verify` 미지정: verifications 빈 배열 유지(기존 happy path와 충돌 없음 확인).

기존 schema round-trip(`tests/schemas/repo-self-validation.test.ts`)은 verifications가 schema에 이미 있으므로 자동 통과.

## Out Of Scope (재확인)

- verify timeout 옵션 — 후속.
- 복수 `--verify` flag — 후속.
- shell interpretation (`bash -c` 자동 wrap 등) — 사용자가 script로 위임.
- `ditto verify` 명령과의 evidence ledger 통합 — 별도 경로 유지.
- verify 결과 기반 AC verdict 자동 update — `ditto verify --criterion`이 별도 경로.
- verify 결과 기반 CLI exit gating — 호출자 책임.
- streaming / chunked output — single buffer write로 충분.
