# Track B — Workflow vehicle for the ditto foundation rebuild

Track B builds the **same target as Track A** — the redesigned ditto foundation
(`docs/redesign/ditto-rebuild-draft.md`: 12 architecture invariants as schemas/gates · thin
drive-loop · native delegation seam · §5 completeness machine, on top of the locked `rebuild/schemas`
+ `rebuild/seam` contracts, 51 tests green) — but with Claude Code's **Workflow** primitive
(deterministic multi-agent orchestration) instead of Track A's pure `/goal` prompt + dispatcher.

work item: `wi_260720v4m`. Sibling of Track A at `../vehicle/`.
(Directory name assumption: Track A is `vehicle/`; this is authored as `vehicle-b/`. Rename both
consistently if a different convention is chosen — nothing outside this folder references the name yet.)

## The load-bearing correction (read first)

A **Workflow script has no shell and no filesystem access.** This is confirmed against the shipping
`code-modernization` workflows: `portfolio-assess.js` states "workflow scripts have no filesystem
access … the calling session writes/renders", and `uplift-migrate.js` returns re-passable unit lists
for "the next invocation's `args`" (resume is external). Every tool run goes through `agent()`.

Consequence: the workflow **cannot itself run the tests** that gate completion. The per-slice test
counts an in-workflow verifier reports are therefore **LLM self-reports** — they cannot, on their own,
match Track A's OS-level Stop hook (a non-LLM shell that runs the real test and blocks red with `exit 2`
outside model control). So this vehicle splits the work:

| Layer | Who | Role | Authority |
|---|---|---|---|
| Orchestration | the **Workflow** (`build-foundation.workflow.js`) | intent-lock · thin drive-loop · plan/implement/verify fan-out · classify · bookkeep | **advisory** — returns at most `provisional-drained`, never `pass` |
| Deterministic gate | the **calling session** (`guardrails/*.sh`, real shell) | RE-RUN each per-slice test · re-hash evidence · call `codex exec` directly | **authoritative** — only this can mint `pass` |

This is the honest analog of Track A's guarantee: the piece that makes completion **not self-scored**
is `guardrails/evidence-runner.sh` (real execution, outside model control) + `guardrails/codex-crosscheck.sh`
(maker ≠ checker, absent codex → fail-closed). The workflow orchestrates; the guardrails adjudicate.
The "Stop-hook parity" claim from the draft is deliberately **retracted** — see OPEN-QUESTIONS.md.

## Contents

| Path | What |
|---|---|
| `build-foundation.workflow.js` | The Workflow script — thin drive-loop (Layer 2 bounded `for`) over a serialized per-slice pipeline (Layer 1). Emits `provisional-drained` + `resume_state` + the exact guardrail commands to run. |
| `schemas/*.json` | Structured agent-return contracts (intent-lock · plan · impl · slice-observation · ac-verdict-2facet · codex-crosscheck · queue-item). Mirrored inline in the workflow (a script can't read files). |
| `roles/*.md` | The 6 subagent role contracts. Each is bound by an `agentType` (not just a prompt) that must map to an authored agent definition carrying the listed least-privilege tools. `state-persistence.md` documents why State-Writer was removed. |
| `guardrails/bootstrap-scratch-tree.sh` | Pure-env FS/VCS isolation: repo-OUTSIDE `git init` tree seeded with only the locked contracts; fails closed if not isolated + green. |
| `guardrails/preflight.sh` | Up-front fail-closed check (bun · git · **codex reachable** · tree isolated) so a multi-hour run doesn't end in a structural `unverified` surprise. |
| `guardrails/evidence-runner.sh` | **The deterministic gate.** Re-runs each per-slice `test_command` in the isolated tree, refuses the whole-island command, derives resolved/blocked from real exit + counts. |
| `guardrails/codex-crosscheck.sh` | **The authoritative maker≠checker gate.** Calls `codex exec` on the build diff/evidence; absent/unauth codex → `exit 3` fail-closed. |
| `OPEN-QUESTIONS.md` | Unresolved items — especially unverified runtime assumptions and the pure-env residue. |

## Pure-environment decision (reflecting both reviews)

Two isolation layers, treated separately (the reviews showed conflating them hides the residue):

1. **FS / VCS (project-scope) — SOLVED, and now implemented (was prose-only in the draft).**
   `bootstrap-scratch-tree.sh` builds a repo-OUTSIDE `git init` tree with no `.claude/`, `.mcp.json`,
   `CLAUDE.md`, or ditto `.githooks`. All build agents `cwd` there, so ditto's `core.hooksPath=.githooks`
   pre-commit (the whole-repo biome ratchet, a known failure surface) never fires and the project
   `.claude/` never loads. The script asserts isolation and a green baseline, fail-closed.

2. **User-scope config (global `CLAUDE.md` + charter + ditto plugin) — NOT isolable in-session, ACCEPTED.**
   Workflow `agent()` children inherit this session's process-level config; the observed `agent()`
   options (`{agentType, label, phase, schema}`) have no per-child `CLAUDE_CONFIG_DIR`/cwd slot. Track A
   escapes this by launching a fresh `claude` under an isolated `CLAUDE_CONFIG_DIR`; Track B is in-session
   and cannot. So we do NOT claim user-scope isolation. Two mitigations instead:
   - **Correctness** is protected by the charter-independent deterministic gates (real test exec + external
     codex). A biased-by-charter agent cannot produce a false `pass`, because the gate is executed test
     exit codes + a different provider — not the agent's word.
   - **Behavioral** interference (the charter nudging agents to "process this via the ditto lifecycle") is
     blunted by an explicit `ENV_GUARD` injected into every agent contract: *no ditto CLI/skill/autopilot
     during the build; rebuild/ island only.* This is enforcement-by-instruction, not by sandbox — a real
     residual, disclosed here and in the run output (charter §4-10 disclose).

3. **§5.3 net-efficacy baseline ("bare Claude Code", charter OFF) — OUT OF SCOPE.** Track B *builds* the
   foundation; it does not *measure* net efficacy. The config-injection confound is a measurement issue,
   not a correctness one, so it does not block the build.

## Runbook (calling session owns the shell + state + resume)

```
REPO=<ditto repo root>;  PARENT=<some repo-OUTSIDE dir>
# 1. Isolate
TREE=$(sh vehicle-b/guardrails/bootstrap-scratch-tree.sh "$PARENT" "$REPO")   # → prints scratch tree
# 2. Fail-closed preflight (codex reachable? tree isolated?)
sh vehicle-b/guardrails/preflight.sh "$TREE"   || exit 1
# 3. Drive (Workflow tool). resumeState omitted on first run.
#    args = { goalPath: "vehicle/goal.md", scratchTree: "$TREE" }        (or resumeState from a prior run)
#    → returns { final_verdict: 'provisional-drained'|'unverified', criteria, resume_state, required_guardrails, ... }
# 4. Persist state yourself (workflow has no FS): write resume_state → state/queue.json + append state/log.jsonl.
#    Build a slices manifest (TSV: id<TAB>test_command) from the frozen intent-lock slices.
# 5. DETERMINISTIC gate — the only thing that upgrades provisional-drained → pass:
sh vehicle-b/guardrails/evidence-runner.sh "$TREE" state/slices.tsv   || exit 1   # real re-run
sh vehicle-b/guardrails/codex-crosscheck.sh "$TREE" state/evidence-summary.txt || exit 1   # maker≠checker
# 6. Only if BOTH exit 0 → mint pass. Any escape/unverified → framed handoff (re-invoke step 3 with resume_state).
```

## AC status (Track B rendition of Track A's guardrail ACs)

Same guardrail intents as Track A's `vehicle/README.md`; status is for **Track B's** artifacts.

| AC (guardrail intent) | Track B artifact | Status |
|---|---|---|
| ac-4 · frozen goal/AC | intent-lock freezes the closed slice set; denominator never shrinks/grows | **DONE (design+schema)** — enforced in workflow + `schemas/intent-lock.schema.json`; unverified at runtime |
| ac-2 · evidence gate (not self-scored) | `guardrails/evidence-runner.sh` real re-run + whole-island refusal; workflow never mints `pass` | **DONE (verified)** — PASS/REFUSE(2)/FAIL(1) paths exercised against a real isolated tree |
| ac-3 · Codex cross-check (maker≠checker, absent→fail-closed) | `guardrails/codex-crosscheck.sh` + `preflight.sh` | **DONE (verified)** — fail-closed (exit 3) confirmed with codex hidden; full `codex exec` path not run here |
| ac-7 · runtime isolation (pure env) | `guardrails/bootstrap-scratch-tree.sh` + `ENV_GUARD` in contracts | **PARTIAL (verified FS layer)** — isolated green tree + in-repo refusal(3) confirmed; user-scope residue accepted/disclosed |
| ac-5 · single-source disk state + restart | `resume_state` (untruncated) returned; calling session persists; escape-carry (`openHist`/`noProgress`/`round`) included | **DONE (design)** — `roles/state-persistence.md`; unverified at runtime |
| ac-6 · isolated worker subagents | 6 `roles/*.md` with `agentType` + least-privilege tools; verifier is a fresh, different identity | **DONE (design)** — agent definition files themselves not yet authored (see OPEN-QUESTIONS) |
| ac-1 · self-contained integration smoke | one trivial slice driven stub→pass to prove wiring | **NOT DONE** — needs the Workflow runtime, unavailable here (OPEN-QUESTIONS) |

## Relation to Track A

Same frozen goal (`vehicle/goal.md`), same locked contracts, same completeness intents. They differ only
in the vehicle: Track A = pure `/goal` + dispatcher with true user-scope isolation and an OS-level Stop
hook; Track B = in-session Workflow with project-scope-only isolation and a calling-session guardrail gate.
**Track B's deterministic guarantee is weaker-sourced** (it lives in the calling-session guardrails, not
inside the vehicle), which raises a strategic question about whether Track B adds value over Track A — left
open for the user (OPEN-QUESTIONS.md), not decided here.
