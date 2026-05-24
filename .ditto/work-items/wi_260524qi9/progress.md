# Progress

- 2026-05-24: Phase 3 and v0.3 priority bundle checked against current implementation. Seed created because v0.3 spans provider execution, profile policy, artifact capture, and context packet linkage.
- 2026-05-24: Refined AC-2 to distinguish provider non-zero exits from DITTO runtime failures, refined AC-4 to separate enforceable policy fixtures from unverified provider/OS limits, and expanded rollback notes for runManifest/schema compatibility.
- 2026-05-24: Phase 3 entered. Started HostAdapter execution contract design note while keeping RunStore and run-manifest schema unchanged.
- 2026-05-24: Sharpened HostAdapter execution contract around completion resolve policy, model reporting timing, args/env semantics, wrapper git/diff responsibility, profile enforcement limits, provider narrowing, and wrapper exit behavior.
- 2026-05-24: Added wrapper UX note for `ditto run with`, requiring explicit `--work-item`, optional repo-relative `--prompt`, and forwarded provider args after `--`.
- 2026-05-24: Sharpened `run with` CLI note with linkage failure policy and `--prompt` pre-spawn existence check.
- 2026-05-24: Added HostAdapter run execution types and optional `spawnRun` to `src/core/hosts/types.ts`.
- 2026-05-24: Extracted shared git state, changed-files, and diff helpers into `src/core/git.ts` and applied them to `run record`.
- 2026-05-24: Implemented first `run with` happy-path with mock adapter fixture, manifest artifact capture, diff capture covering staged changes via `git diff HEAD`, work item run linkage, schema-validated provider/profile, and CLI runtime-error exit on null capture.
- 2026-05-24: Closed v0.3 implementation scope: AC-2 failure fixtures, AC-5 context build, AC-4 profile policy, and Codex/Claude spawn adapters are implemented and verified.
