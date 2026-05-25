# HostAdapter Execution Contract

## Decision Summary

v0.3 adds provider execution without changing `RunStore` or `runManifest`.

- Keep the existing `HostAdapter` doctor methods intact.
- Add a narrow execution capability on the same adapter object.
- Keep manifest paths and writes in `RunStore`.
- Keep provider process details in the adapter.
- Put orchestration in the `ditto run with` command layer.
- Express profile policy as wrapper-owned policy plus optional provider-native flags.

## Current Reuse Boundary

Do not rebuild these pieces:

- `src/core/run-store.ts`: create/get/update, run directory, fixed artifact paths.
- `src/schemas/run-manifest.ts`: already contains v0.3 evidence fields.
- `src/cli/commands/run.ts`: `run record` remains the manual baseline.
- `src/core/hosts/types.ts`: existing adapter registry remains the provider lookup surface.

## 1. Adapter Surface

Use the same adapter object for doctor and execution, but keep the execution methods logically separate.

Preferred shape:

```ts
export interface HostAdapter {
  id: HostId;
  loadInstructions(repoRoot: string): Promise<InstructionSurface>;
  loadPermissions(repoRoot: string): Promise<PermissionInventory[]>;
  loadMcpServers(repoRoot: string): Promise<McpInventory>;
  loadSurfaceInventory(repoRoot: string): Promise<SurfaceInventory>;
  spawnRun?(input: HostRunInput): Promise<HostRunProcess>;
}
```

Rationale:

- The registry can continue returning one adapter per host.
- v0.3 can support only `codex` and `claude-code` without pretending all hosts are runnable.
- Tests can register mock adapters with `spawnRun`.

## 2. Spawn Contract

Prefer stream injection over returning collected strings. The wrapper owns artifact files, so it needs stdout/stderr streams rather than opaque output.

Candidate:

```ts
export interface HostRunInput {
  repoRoot: string;
  cwd: string;
  profile: ProfileName;
  args: string[];
  env: HostRunEnv;
}

export interface HostRunEnv {
  set: Record<string, string>;
  unset: string[];
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
}
```

The adapter maps DITTO input to provider-native invocation. It does not write manifests or artifact files.

Contract details:

- `args` means only the user arguments after `ditto run with ... --`; the adapter prepends provider-specific binary/subcommand flags.
- `env.set` adds or overrides environment keys, and `env.unset` removes keys before spawn. Do not use `undefined` as an unset sentinel.
- Adapter failures after `RunStore.create` should resolve `completion` with `exit_code: null` and `error`, not reject. A rejected `completion` promise is a contract bug; the wrapper still makes a best-effort manifest update.
- `model_reported` is part of completion, not the initial process handle, because some providers only reveal model information after startup output or process completion.

## 3. Responsibility Split

| Layer | Owns | Does not own |
|---|---|---|
| `RunStore` | run id, manifest create/update, artifact paths | process spawning, profile semantics |
| `HostAdapter` | provider command, provider-native flags, stdout/stderr process streams | manifest writes, git diff, work item mutation |
| `run with` wrapper | create -> spawn -> pipe -> git_after snapshot -> diff against git_before -> update -> work item run linkage | provider-specific command construction beyond adapter |
| profile policy | allowed cwd/env/network/write policy decisions | provider schema or manifest schema changes |

## 4. Failure Taxonomy

| Failure mode | Manifest representation | Notes |
|---|---|---|
| provider exits 0 | `exit_code: 0`, `ended_at`, stdout/stderr/diff paths as applicable | successful captured run |
| provider exits non-zero | `exit_code: <code>`, `ended_at`, stdout/stderr/diff paths as applicable | provider failure, not DITTO runtime crash |
| spawn ENOENT or command unavailable | `exit_code: null`, `ended_at`, `stderr_path` if available, `unverified[]` or `notes` explains unavailable provider | manifest should still be created if RunStore create succeeded |
| killed by signal | `exit_code: null`, `ended_at`, `notes` includes signal | capture partial stdout/stderr when possible |
| mid-pipe or artifact write failure | `exit_code: null`, `ended_at` if known, `unverified[]` names failed artifact capture | wrapper reports runtime error after best-effort manifest update |
| RunStore create fails before id exists | no run manifest | DITTO runtime failure outside provider run evidence |

`ditto run with` CLI exit is wrapper-level status, not provider-level status. Provider non-zero exits should make the CLI return the provider exit code after evidence capture. DITTO runtime failures such as artifact write failure should return a DITTO runtime error code after best-effort manifest update, even if the provider had a different status.

## 5. Profile Policy Attachment

Use two layers:

- Wrapper policy: validates repo-relative cwd, blocks parent traversal, decides whether a profile may request network/write behavior, and records unverified policy gaps.
- Adapter policy: maps the already-approved profile to provider-native flags when available.

Enforcement means pre-spawn validation plus post-run git/diff inspection. v0.3 does not claim to stop every in-flight provider escape; anything DITTO cannot directly prevent must be surfaced as `manifest.unverified` or a verification failure.

Minimum v0.3 fixture split:

- Enforced fixture: read-only/reviewer deny workspace writes through DITTO-controlled test command.
- Enforced fixture: workspace-write denies cwd outside repo.
- Unverified fixture: provider/OS network or sandbox guarantees that DITTO cannot enforce locally are written to `manifest.unverified`.

## 6. Provider Narrowing

`HostId` is intentionally open-ended, but `runManifest.provider` is the fixed enum `codex|claude-code|opencode|openagent|other`. The wrapper must narrow the adapter id before manifest creation. v0.3 fail-fast behavior:

- `codex` and `claude-code` are accepted.
- `opencode` and `openagent` remain schema-valid but have no shipped runnable adapter.
- unknown custom adapters are rejected for `run with` until a manifest mapping policy exists.

## 7. Mock Boundary

Mock adapters first. Avoid a broad process abstraction until the wrapper logic proves it needs one.

The fixture adapter should expose `spawnRun` with deterministic stdout/stderr/completion streams. Real Codex/Claude adapters can use `Bun.spawn` behind the same contract.

If tests need to simulate stream failures independently of adapter behavior, introduce a thin `SpawnRunner` later. Do not add it up front.
