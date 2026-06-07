---
title: "HostAdapter Execution Contract (상세 설계)"
kind: design-detail
last_updated: 2026-06-07 KST
status: implemented (v0.3 — codex·claude-code runnable)
parent: reports/design/ditto-claude-code-harness-design.md
owns: "provider 실행 계층의 'how' (HostAdapter spawn 인터페이스 · HostRunInput/HostRunEnv/HostRunProcess/HostRunCompletion · env set/unset · 실패 분류 taxonomy · provider narrowing · 책임 분리)"
inputs:
  - src/core/hosts/types.ts        # HostAdapter / HostRun* 인터페이스, registry, parseHostId (authoritative)
  - src/core/hosts/codex.ts        # codex 어댑터 + buildCodexSpawnArgs
  - src/core/hosts/claude-code.ts  # claude-code 어댑터 + buildClaudeCodeSpawnArgs
  - src/core/hosts/spawn.ts        # spawnProviderProcess 공용 spawn glue
  - src/core/run-with.ts           # wrapper(create→spawn→pipe→diff→update→linkage)
  - src/schemas/run-manifest.ts    # provider enum · evidence 필드 (authoritative)
---

# HostAdapter Execution Contract (상세 설계)

> **이 문서의 위치.** 이것은 provider 실행 계층 — DITTO가 외부 coding agent(`codex`·`claude-code`)를 spawn해 한 run을 capture하는 경로 — 의 *how*를 소유한다. 메인 설계문서가 "무엇(provider 슬롯으로 stack-agnostic 실행을 capture한다)"을 두면, 이 문서가 그 어댑터 인터페이스·spawn 계약·실패 분류·책임 분리를 소유한다. 이 계약은 work-item 노트(`wi_260524qi9`)에서 처음 설계됐고, 본 문서는 **현재 코드(`src/core/hosts/*`)에 맞춰 재정합한 durable 권위 문서**다.

## 0. 권위 규칙 (코드 ↔ 본 문서)

| 층위 | 소유 대상 | 충돌 시 |
|---|---|---|
| 실제 인터페이스 (`src/core/hosts/types.ts`) | 필드명, 메서드 시그니처 | **최우선.** 본 문서 예시 TS와 다르면 코드가 이긴다. |
| `src/schemas/run-manifest.ts` | `provider` enum, manifest 필드 | manifest 표현은 스키마가 이긴다. |
| 본 상세문서 | "how" — 책임 분리·실패 taxonomy·narrowing 정책 | 코드와 모순되면 코드 쪽으로 본 문서를 갱신한다. |

규칙: v0.3은 `RunStore`/`runManifest`를 바꾸지 않고 provider 실행을 추가했다. 어댑터는 manifest를 쓰지 않고 stdout/stderr 스트림과 completion만 낸다. 오케스트레이션은 `ditto run with` wrapper(`src/core/run-with.ts`)가 소유한다.

## 1. 재사용 경계 (다시 만들지 않는 것)

- `src/core/run-store.ts`: run id, manifest create/update, 고정 artifact 경로.
- `src/schemas/run-manifest.ts`: evidence 필드 보유. 어댑터는 schema를 바꾸지 않는다.
- `src/core/hosts/types.ts`: adapter registry(`registerHostAdapter`/`getHostAdapter`/`listHostAdapters`/`unregisterHostAdapter`)가 provider lookup 표면.
- `src/core/hosts/spawn.ts`: `spawnProviderProcess` — 두 어댑터가 공유하는 실제 spawn glue. 어댑터별로 binary/args만 다르다.

## 2. 어댑터 표면 (`HostAdapter`)

doctor 로더와 실행을 **같은 어댑터 객체**가 갖되, 실행 메서드(`spawnRun`)는 optional로 분리한다. 현재 코드 형태:

```ts
export interface HostAdapter {
  id: HostId;
  capabilities: HostCapabilities;
  loadInstructions(repoRoot: string): Promise<InstructionSurface>;
  loadPermissions(repoRoot: string): Promise<PermissionInventory[]>;
  loadMcpServers(repoRoot: string): Promise<McpInventory>;
  loadSurfaceInventory(repoRoot: string): Promise<SurfaceInventory>;
  spawnRun?(input: HostRunInput): Promise<HostRunProcess>;
}
```

근거:
- registry는 host당 어댑터 하나를 반환한다.
- v0.3은 `codex`·`claude-code`만 실제로 runnable하다. 모든 host가 spawn 가능한 척하지 않는다.
- 테스트는 mock 어댑터를 `spawnRun`과 함께 등록한다.

**Reconciled (source 노트 대비 추가됨).** `capabilities: HostCapabilities`는 source 노트에 없던 **필수 필드**다(`hooks: HookEventId[]` / `instructions` / `permissions` / `mcp` / `surface` 능력 선언). doctor가 능력별로 fail-closed 판정하는 capability parity 게이트가 이를 읽는다. codex는 `hooks: []`, claude-code는 5개 hook event 전부를 선언한다.

## 3. Spawn 계약 (`HostRunInput` → `HostRunProcess`)

collected string을 반환하지 않고 **스트림 주입**을 쓴다. wrapper가 artifact 파일을 소유하므로 opaque output이 아니라 stdout/stderr 스트림이 필요하다. 현재 코드 형태:

```ts
export interface HostRunEnv {
  set: Record<string, string>;
  unset: string[];
}

export interface HostRunInput {
  repoRoot: string;
  cwd: string;
  profile: RunManifest['profile'];
  args: string[];
  env: HostRunEnv;
}

export interface HostRunProcess {
  entrypoint: string;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  completion: Promise<HostRunCompletion>;
}

export interface HostRunCompletion {
  exit_code: number | null;
  model_reported: string | null;
  signal?: string;
  error?: string;
  unverified?: string[];
}
```

어댑터는 DITTO 입력을 provider-native invocation으로 매핑한다. manifest나 artifact 파일은 쓰지 않는다.

계약 세부:
- `args`는 `ditto run with ... --` 뒤의 **사용자 인자만** 의미한다. 어댑터가 provider 고정 플래그를 앞에 붙인다. codex: `--sandbox <mode>`(profile별, `buildCodexSpawnArgs`). claude-code: `--permission-mode <mode>`(profile별, `buildClaudeCodeSpawnArgs`).
- `env.set`은 환경 키를 추가/덮어쓰고, `env.unset`은 spawn 전에 키를 제거한다. `undefined`를 unset sentinel로 쓰지 않는다(`spawnProviderProcess`가 set/unset을 명시 적용).
- **Reconciled.** `profile`은 source 노트의 두 값이 아니라 `run-manifest`의 5-값 enum이다: `read-only | workspace-write | reviewer | networked | isolated`. 각 어댑터는 5개 모두에 대한 매핑 테이블을 가진다(미지원 조합은 `unverified[]`로 surface, 예: codex `networked`는 "sandbox restricts outbound" 노트).
- **Reconciled.** `HostRunCompletion.unverified?: string[]`는 source 노트에 없던 추가 필드다. 어댑터가 강제할 수 없는 정책(provider/OS network·sandbox 보장 등)을 wrapper의 manifest `unverified`로 흘려보낸다.
- `RunStore.create` 이후의 어댑터 실패는 `completion`을 reject하지 말고 `exit_code: null` + `error`로 resolve해야 한다. reject된 `completion` promise는 계약 버그이며 wrapper는 그래도 best-effort manifest update를 한다(`run-with.ts` `captureArtifacts`).
- `model_reported`는 초기 process handle이 아니라 completion에 둔다. 일부 provider는 startup 이후에야 모델 정보를 노출한다.

## 4. 책임 분리

| 층위 | 소유 | 비소유 |
|---|---|---|
| `RunStore` | run id, manifest create/update, artifact 경로 | process spawn, profile 의미 |
| `HostAdapter` | provider command, provider-native 플래그, stdout/stderr 스트림 | manifest write, git diff, work item mutation |
| `spawnProviderProcess` (`spawn.ts`) | 실제 `Bun.spawn`, env set/unset 적용, 스트림 노출 | provider별 플래그 결정(어댑터가 함) |
| `run with` wrapper (`run-with.ts`) | create → spawn → pipe → git_after → git_before 대비 diff → update → work item run linkage | 어댑터 밖 provider-specific 명령 구성 |
| profile policy | 허용 cwd/env/network/write 정책 결정 | provider/manifest schema 변경 |

## 5. 실패 분류 (Failure Taxonomy)

| 실패 모드 | manifest 표현 | 비고 |
|---|---|---|
| provider exit 0 | `exit_code: 0`, `ended_at`, stdout/stderr/diff 경로 | 정상 capture run |
| provider non-zero exit | `exit_code: <code>`, `ended_at`, 경로들 | provider 실패이지 DITTO 런타임 crash 아님 |
| spawn ENOENT / command 부재 | `exit_code: null`, `ended_at`, 가능하면 `stderr_path`, `notes`/`unverified[]`에 부재 설명 | RunStore create 성공했으면 manifest는 그래도 생성 |
| signal kill | `exit_code: null`, `ended_at`, `notes`에 signal | 가능한 부분 stdout/stderr capture |
| mid-pipe / artifact write 실패 | `exit_code: null`, 가능하면 `ended_at`, `unverified[]`에 실패한 capture 명시 | wrapper가 best-effort update 후 런타임 에러 보고 |
| RunStore create 실패(id 부재) | run manifest 없음 | provider run 밖의 DITTO 런타임 실패 |

`ditto run with` CLI exit은 wrapper-level status이지 provider-level status가 아니다 — 단, provider non-zero exit은 evidence capture 후 그 provider exit code로 CLI가 반환한다(`run.ts` `runWith`). artifact write 실패 등 DITTO 런타임 실패는 best-effort update 후 DITTO 런타임 에러 코드로 반환한다.

## 6. Profile Policy 부착

두 층:
- **Wrapper policy** (`run-with.ts`): repo-relative cwd 검증(`resolveRepoCwd` — parent traversal 차단), 비-`networked` profile은 `HTTP_PROXY/HTTPS_PROXY/NO_PROXY/ALL_PROXY`를 unset(`policyEnv`), 변경 파일 검사로 정책 위반을 `profileUnverified`로 surface(read-only/reviewer가 write하면 위반, repo 밖 변경이면 위반).
- **Adapter policy** (`codex.ts`/`claude-code.ts`): 승인된 profile을 provider-native 플래그로 매핑.

집행 = pre-spawn 검증 + post-run git/diff 검사. v0.3은 in-flight provider escape를 전부 막는다고 주장하지 않는다 — DITTO가 직접 막을 수 없는 것은 `manifest.unverified`나 verification 실패로 surface한다.

## 7. Provider Narrowing

`HostId`는 의도적으로 open-ended(`BuiltinHostId | (string & {})`)지만, `runManifest.provider`는 고정 enum `codex|claude-code|opencode|openagent|other`다. wrapper는 manifest 생성 전에 어댑터 id를 narrow한다(`run-with.ts` `parseRunnableProvider`). v0.3 fail-fast:
- `codex`·`claude-code`는 accept.
- `opencode`·`openagent`는 schema-valid지만 shipped runnable 어댑터가 없다 → `run with`에서 거부.
- unknown custom 어댑터는 manifest 매핑 정책이 생기기 전까지 `run with`에서 거부.

`parseHostId`(`types.ts`)는 doctor/CLI 경로에서 `codex|claude-code`만 허용하고 그 외엔 `InvalidHostError`를 던진다.

## 8. Mock 경계

mock 어댑터를 우선한다. wrapper 로직이 필요하다고 입증하기 전까지 광범위한 process 추상화를 만들지 않는다(MVP). fixture 어댑터는 결정적 stdout/stderr/completion 스트림으로 `spawnRun`을 노출한다. 실제 codex/claude 어댑터는 같은 계약 뒤에서 `spawnProviderProcess`(→ `Bun.spawn`)를 쓴다. 스트림 실패를 어댑터 동작과 독립적으로 흉내내야 하면 thin `SpawnRunner`를 나중에 도입한다 — 처음부터 넣지 않는다.
