# DITTO v0.3 Context Packet Seed

## Entry Point

- Plan source: `reports/harnesses/ditto-application-plan.md`
- Phase 3: provider wrapper and profile
- v0.3 priority bundle: provider wrapper and context packet
- Current base commit at seed creation: `82fe6ab`

## Reuse, Do Not Rebuild

- `src/core/run-store.ts`: run directory, artifact path helper, manifest create/get/update.
- `src/schemas/run-manifest.ts`: schema already has provider/profile/git/artifact/verification fields needed by v0.3.
- `src/cli/commands/run.ts`: `ditto run record` is the manual baseline.
- `src/core/hosts/types.ts` and built-ins under `src/core/hosts/`: host registry and adapter foundation.

## v0.3 Scope

- Add `ditto run with --provider codex|claude-code --profile <name> -- <args...>`.
- Extend host adapters with provider execution/capture contract while preserving doctor behavior.
- Capture stdout, stderr, diff, exit code, git before/after, changed files, and prompt path into the run manifest.
- Add minimal `ditto context build` that generates a markdown context packet from current work item and git/evidence state.
- Express profile policy with enforceable tests and explicit unverified entries where enforcement is outside DITTO control.

## Out Of Scope

- OpenCode/OpenAgent provider implementation.
- Phase 5 `ditto explore`, `ditto codemap`, and standalone `ditto evidence add`.
- Expensive multi-provider review/evaluator lane.
- Full OS/container isolation if not available locally; document as unverified rather than silently claiming enforcement.
