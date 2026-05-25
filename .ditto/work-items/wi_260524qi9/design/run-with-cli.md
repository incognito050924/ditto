# `ditto run with` CLI Surface

## Decision Summary

v0.3 adds `ditto run with` as an automatic counterpart to the existing manual `ditto run record`.

The command surface is:

```sh
ditto run with --provider <provider> --profile <profile> --work-item <id> [--prompt <path>] -- <provider args...>
```

`--work-item` is required in v0.3. DITTO will not infer an active work item from "the only in_progress item" yet, because that creates hidden behavior when multiple work items exist.

`--prompt` is optional. When present, it must be a repo-relative path and is passed directly to `RunStore.create({ prompt_path })`. `ditto context build` is responsible for creating a suitable markdown packet; `run with` only attaches the path.

## Work Item Selection

Rules:

- `--work-item <id>` is required.
- The id must resolve through `WorkItemStore.get`.
- The run id is appended to `workItem.runs` only after `RunStore.create` succeeds.
- If work item linkage fails after `RunStore.create`, keep the run manifest, return a DITTO runtime error, and leave repair to a later explicit recovery command.
- v0.3 does not add implicit active-work-item discovery.

Rationale:

- `RunStore.create` requires `work_item_id`.
- Existing `.ditto/work-items` can contain several `in_progress` or historical items.
- Explicit selection makes fixture setup deterministic.

## Prompt Path

Rules:

- `--prompt <path>` is optional.
- The path must satisfy the existing repo-relative path schema constraints.
- When provided, the path must exist before spawn; missing prompt files fail fast without creating a provider run.
- `run with` does not generate the prompt itself.
- If `--prompt` is omitted, manifest `prompt_path` remains absent.

Expected flow:

```sh
ditto context build --work-item wi_... --output .ditto/work-items/wi_.../context-packet.md
ditto run with --provider codex --profile workspace-write --work-item wi_... --prompt .ditto/work-items/wi_.../context-packet.md -- exec ...
```

## Provider Arguments

Everything after `--` is passed to `HostRunInput.args` unchanged. The adapter prepends provider binary and provider-native fixed flags.

Examples:

```sh
ditto run with --provider codex --profile read-only --work-item wi_... -- exec --help
ditto run with --provider claude-code --profile reviewer --work-item wi_... -- --print "review this diff"
```

## Output And Exit

The command should support the existing `--output human|json` convention.

JSON output should include at minimum:

- `run_id`
- `work_item_id`
- `manifest_path`
- `provider`
- `profile`
- `exit_code`

Provider non-zero exit is returned as the CLI process exit code after evidence capture. Wrapper/runtime failure returns DITTO runtime error after best-effort manifest update.

## Out Of Scope

- Auto-selecting the active work item.
- Generating context packets inside `run with`.
- Provider-specific high-level subcommands beyond forwarding `--` args.
- Running providers outside the existing `runManifest.provider` enum.
