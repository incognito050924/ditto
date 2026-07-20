# Track B — Open questions & finding dispositions

Nothing here is silently dropped. Part A records how each review finding was reflected in the
artifacts; Part B records what remains open and why; Part C records assumptions I could not verify.

## Part A — review findings reflected in the artifacts

**All HIGH findings are reflected.** (Charter: high findings must be reflected.)

| Finding (source) | Severity | How reflected |
|---|---|---|
| Evidence gate can't port Track A's OS-level guarantee; counts are LLM self-reports (opponent #1 / completeness #4) | high | Workflow never returns `pass` — only `provisional-drained`. N-of-M (3) independent read-only verifiers, quorum 2/3. **Deterministic authority moved to the calling session**: `guardrails/evidence-runner.sh` re-runs each per-slice test outside model control. Parity claim retracted (README "load-bearing correction"). |
| Contract-field loss bug: `queue.map` drops `test_command`/`invariant_ref`/oracle → `runSlice` interpolates `undefined` (opponent #2) | high | Fixed: the loop joins `pending[0].id` back to `FROZEN.slices` and passes the **full frozen slice** to `runSlice`. Queue holds only bookkeeping; contract fields are read from `FROZEN`. |
| Codex authority unverifiable + fail-closed trap (opponent #3) | high | Preflight (`preflight.sh`) checks codex reachability **up front** (no multi-hour surprise). The **authoritative** codex call is `guardrails/codex-crosscheck.sh` in the calling session's real shell — not an agent self-report. The in-workflow codex role is explicitly **advisory**. |
| Shared `bun test rebuild/` + parallel fanout doubly defeat the gate (opponent #4 / completeness #3) | high | (a) Per-slice `test_command` required by `intent-lock` schema + prompts; `evidence-runner.sh` **refuses** the whole-island command (`exit 2`, verified). (b) `orphan_free` promoted to **required**. (c) Implement **serialized** (one slice/round — shared island isn't disjoint); only read-only verifiers fan out. |
| Roles not wired: no `agentType`, tools unenforced; false "options = {label,phase,schema}" (completeness #1) | high | Every `agent()` call passes `agentType` (`vehicle-b:*`). 6 `roles/*.md` with least-privilege tools. The false observation is corrected in the workflow header + README (confirmed against `code-modernization/*.js`: `agentType` is a first-class option; `FanoutTask` in `rebuild/seam` also carries `agentType`). |
| No FS access → restart invariant not harness-ownable (completeness #2) | high | Resume made an **external boundary**: `resume_state` returned untruncated; calling session persists + re-passes as `args.resumeState`. `roles/state-persistence.md` documents it; runbook owns it. |
| Pure-env is prose, not implemented; behavioral interference (opponent #5 / completeness #8) | med | `bootstrap-scratch-tree.sh` implements FS/VCS isolation (verified: green isolated tree + in-repo refusal). `ENV_GUARD` injects behavioral isolation into every contract. Config confound disclosed in README + AC table. |
| Single-source state delegated to LLM + `slice(0,4000)` truncation + unchecked return (opponent #6) | med | State-Writer subagent **removed**. No truncation; full `resume_state` returned. F4 single-source is clarified as a property of the **built** foundation, not the harness. |
| Restart invariant partial — escape state volatile (opponent #7) | med | `openHist`, `noProgress`, `round` included in `resume_state` and restored on resume, so bounded+escape survives restart. |
| FROZEN denominator grows at runtime; discovered items undrivable (opponent #8) | low | Discoveries go to a **backlog only** (`recordDiscoveries`), never turned into drivable slices, never grow the denominator. |
| `deriveFinalVerdict` mirror duplicates locked SoT; "QueueItem reuse" false (completeness #5) | med | Mirror renamed `deriveProvisionalVerdict`, disclosed as a tested duplication (a script can't import repo TS — see B4). `schemas/queue-item.json` explicitly labeled **harness-adjacent, NOT** the locked `.strict()` schema; only the kind/exit enums are reused. |
| No token-budget escape (completeness #6) | med | `budget.remaining() < BUDGET_FLOOR` is a 5th escape → framed handoff (mirrors `extract-rules.js:193`). |
| Missing companion deliverables (completeness #7) | med | Authored: 6 role files, `bootstrap-scratch-tree.sh`, `preflight.sh`, both guardrail gates. **Still missing:** the dry-run smoke (needs the Workflow runtime — B1) and the authored `agentType` agent-definition files (B6). |

## Part B — still open (with reasons)

**B1. The workflow is UNVERIFIED at runtime.** `build-foundation.workflow.js` is syntax-validated
(wrapped-parse clean; top-level `return`/`await`/`export`/`parallel` all confirmed against the shipping
`code-modernization` workflows) but **never executed** — the Workflow runtime is not available in this
shell. So: does the runtime support a **dynamic-count top-level `for`-await loop** (not just a fixed DAG),
and is it **replay/resume-deterministic**? `extract-rules.js` does use a bounded round `for`-loop with
`await` inside, which is strong evidence the shape works; replay-safety on resume is still unconfirmed.
A minimal dry-run smoke (one trivial slice, stubbed agents, prove `agent()`/`parallel()`/`phase()`/schema
wiring) is the needed spike — it is a listed-but-unbuilt deliverable for exactly this reason.

**B2. Can `agent()` children take a per-child `CLAUDE_CONFIG_DIR`/cwd?** Observed options are
`{agentType, label, phase, schema}` — no config/cwd slot. If confirmed impossible, the pure-env decision
(user-scope not isolable in-session) stands. If a slot exists, an isolated per-child config would
strengthen the design and this decision would change. Not spiked.

**B3. Codex in a subagent sandbox.** The **authoritative** codex gate now runs in the **calling session**
(a real shell that certainly can run codex — verified present + invokable here), which sidesteps the
sandbox question for correctness. The **advisory** in-workflow codex-opponent may still be blocked from
shelling out inside a subagent sandbox; if so it simply returns `available:false` and the run leans
entirely on the calling-session gate — non-fatal, but the advisory early-carve signal is lost. Unverified.

**B4. Can a Workflow script import repo TS (`rebuild/schemas`)?** `grep` shows **zero** `import`/`require`
of repo modules across all shipping workflows — strong evidence a script **cannot** import repo TS, which
forces the `deriveProvisionalVerdict` mirror and the inlined JSON schemas. Disclosed as a tested
duplication (the built slice's own test asserts the mirror matches the locked contract), but not confirmed.

**B5. AC 2-facet: extend `rebuild/schemas` acVerdict in place, or a sibling schema?** Draft §5.8 says
"separate + require"; the workflow recommends an in-place extension as `slice[0]`. This is a locked-contract
owner decision that shapes the first slice — left to the build's intent-lock, not decided here.

**B6. The 6 `agentType` agent-definition files are not authored.** `roles/*.md` specify each role's
tools/contract, but the actual host agent definitions that `agentType: 'vehicle-b:*'` resolves to (with
the enforced tool allowlist) are not written — that is build-time work under the chosen host's agent
convention, deferred to execution.

**B7. Codex carve batching timing (design open #6).** Carves are adjudicated once at Terminate; a
mid-run carve could change later rounds' discoveries. Cost↔coherence trade-off, unresolved.

**B8. Strategic: is Track B worth building over Track A?** Because a Workflow harness has no shell, Track
B's deterministic guarantee lives in **calling-session guardrails**, not in the vehicle itself — the
Workflow contributes orchestration, not the completion guarantee. Track A gets both (user-scope isolation
+ OS-level Stop hook) inside its vehicle. Whether Track B's native multi-agent orchestration earns its
keep given the weaker-sourced guarantee is a value/intent judgment for the user — surfaced, not decided
(charter §4-8).

## Part C — unverified assumptions (fact gate)

- **Workflow runtime globals** (`agent`, `parallel`, `phase`, `log`, `args`, `budget`) exist as used —
  grounded in shipping `code-modernization` workflows, but this file was not run against the live runtime.
- **`codex exec` output shape** — `codex-crosscheck.sh` greps the first `CONCUR|DISSENT|UNVERIFIED` token;
  the exact non-interactive `codex exec` stdout format was not exercised here (a full model call was
  avoided to keep this fast). The absent-codex fail-closed path (`exit 3`) **was** verified.
- **Dependency provisioning in the scratch tree** — `bootstrap-scratch-tree.sh` runs `bun install`
  (verified green here); a first run on a cold cache needs network. It fails closed (`exit 6`) if deps
  can't be provisioned.
- **Guardrails verified**: bootstrap (green tree, in-repo refusal `exit 3`), preflight (go/no-go),
  evidence-runner (PASS `0` / whole-island REFUSE `2` / fail `1`), codex-crosscheck (absent→`3`) were all
  run for real. The full `codex exec` concurrence path and the Workflow script itself were not.
