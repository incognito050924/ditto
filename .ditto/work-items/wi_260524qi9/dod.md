# Definition Of Done

- `ditto run with` exists and records both successful and failing provider invocations as run manifests.
- Codex and Claude Code adapters implement the same execution contract.
- Profile policy is covered by tests, including at least one blocked or unverified case.
- `ditto context build` produces a repo-relative markdown packet and `run with` can attach it as `prompt_path`.
- Manual `run record` and automatic `run with` manifests both validate against `runManifest`.
- DITTO self-validation tests pass for `.ditto` state and schemas.
