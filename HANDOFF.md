# HANDOFF — GitHub #31 autopilot mid-run reopen (wi_260713wxq)

Cross-PC handoff. **Design + plan + user-approval done; NO code written yet.** Continue by implementing the 8 ACs. This doc is guidance — **re-confirm every code anchor fresh (grep/read) on the new PC** (§4-11 code is authority).

## Propagation state (read first)
- **Resume from:** `origin/main` at the SHA of the commit that carries this file. Plain `git pull` — no history rewrite.
- **Branch:** main (this handoff + the WI Record committed to main; additive, non-code).
- **Travels (git-tracked):** this `HANDOFF.md` + `.ditto/work-items/wi_260713wxq/record.json` (the WI Record — status `in_progress`, the 8 ACs, GitHub #31 link).
- **Does NOT travel (gitignored `.ditto/local/`):** `intent.json` (locked IntentContract), `autopilot.json` (bootstrapped graph — seed-only, the 6-node plan below was never spliced), the local handoff. So THIS doc is the authoritative resume source for the plan; the ACs also live in the committed Record.
- Issue #31 is claimed (assignee @me).

## Landed this session
- **No code commits.** Only this handoff + the WI Record. The autopilot design phase (deep-interview) completed; execution did not start.

## What this fixes (2 parts)
- **#2 (guard-correctness):** `src/hooks/pre-tool-use.ts` `checkAutopilotLease` (~675-748) treats a read-only node's EMPTY `file_scope` lease as a deny-all → blocks every edit mid-run (the derived-scope fail-open at ~:713 is the sibling; empty-scope is the missing case). Fix: exclude empty-scope leases from the enforcement set.
- **#1 (reopen):** a NEW user-action CLI verb reopens a passed `implement` node → re-dispatch its owner with feedback under a fresh lease (auto re-implement) → re-arm downstream verify → no false-green → mid-run only → conserve frozen AC set → per-node K-cap.

## Design decisions (from a full deep-interview incl. intent-dissent; user-confirmed)
1. **Fix mode = AUTO RE-IMPLEMENT** (reopen re-dispatches the implement owner with feedback under a fresh scoped lease). #2 is a narrow guard-predicate fix, NOT a hand-edit mode.
2. **Boundary:** feedback that changes the AC set is NOT a reopen — surface it for FRESH approval as a new unit. Reuse the existing `intentDriftGate`/`purposePreserving` invariant (src/core/autopilot-loop.ts ~3244); no new classifier.
3. **Downstream:** re-arm ALL transitive downstream verify/review to re-verify (comprehensive) WITHOUT destructive teardown (preserve node ids); rebuild only what breaks via the existing forward fix→recheck re-expansion (autopilot-loop.ts ~2215-2295). NOT `revise`'s teardown (autopilot.ts ~898-1044, which discards passed downstream).
4. **Window = MID-RUN ONLY** (narrowed by the intent-dissent opponent: a fully-terminal graph already fail-opens at `!hasNonTerminal`, pre-tool-use.ts ~700-703, so post-completion is NOT the #31 block). Post-completion reopen + completion-honesty after a fully-terminal edit = OUT OF SCOPE (follow-up).

## The 8 frozen acceptance criteria (also in the committed Record)
- **ac-1:** empty-`file_scope` lease no longer blocks an edit; a concurrent mutating node's non-empty declared scope is STILL enforced.
- **ac-2:** a user-action CLI verb reopens a passed implement node (passed→pending) + re-grants a fresh scoped lease so the re-edit passes the guard without `DITTO_AUTOPILOT_BYPASS`; trigger is NOT an autonomous record-result payload flag.
- **ac-3:** the reopened node re-dispatches its implement owner with the user's feedback carried into the delegation packet.
- **ac-4:** reopen re-arms EVERY transitive downstream verify/review to pending (no destructive teardown, ids preserved) AND completion reflects fresh evidence — a pre-reopen stale downstream pass can no longer close an AC over the re-mutated node (no false-green).
- **ac-5:** reopen available only while the graph has a non-terminal node; refused as out-of-scope on a fully-terminal graph.
- **ac-6:** reopen conserves the frozen AC id-set via intentDriftGate; cannot add/alter ACs.
- **ac-7:** repeated reopens of the same node bounded by a per-node reopen K-cap; at cap → stop + report.
- **ac-8:** full `bun test` green (0 regressions) + `bun run build:plugin` and `bun run build:codex-plugin` both exit 0.

## Approved 6-node plan (re-confirm file anchors fresh)
```
impl-schema-reopen-cap  [ac-7]  deps: []            src/schemas/autopilot.ts (+ tests/schemas/autopilot-reopen-cap.test.ts)
    reopen K-cap in caps (additive .default, no schema_version bump) + per-node reopen counter field
impl-hook-lease-emptyscope [ac-1] deps: []          src/hooks/pre-tool-use.ts (+ tests/hooks/lease-empty-scope.test.ts)
    exclude empty file_scope lease from enforcement; concurrent mutating non-empty scope still enforced
impl-core-reopen-engine [ac-2,3,4,5,6,7] deps: [schema]  src/core/autopilot-graph.ts, autopilot-loop.ts, autopilot-complete.ts, autopilot-dispatch.ts (+ tests/core/autopilot-reopen.test.ts)
    reuse reopen transition (autopilot-graph.ts:100) + computeDownstream (:196) to re-arm downstream (no teardown);
    refuse when fully-terminal (ac-5); intentDriftGate conserve AC set (ac-6); K-cap stop+report (ac-7);
    re-dispatch owner w/ feedback in packet + fresh lease (ac-2/3); harden deriveAcVerdicts (autopilot-complete.ts:254-316) vs stale-downstream false-green (ac-4)
impl-cli-reopen-verb    [ac-2]  deps: [core]        src/cli/commands/autopilot.ts (+ tests/cli/autopilot-reopen-cli.test.ts)
    new user-action `reopen` verb (sibling to revise), explicit arg = target node id + feedback, NOT a payload flag
review-reopen           [all]   deps: [3 mutators]
verify-reopen           [all + ac-8 barrier] deps: [review]
```
Serialization: schema→core→cli (hard); hook independent (parallel). Test files disjoint per mutator. TDD: red-first test per AC.

## TWO implementer constraints that MUST NOT be lost (surfaced by the coverage relevance gate — high value)
1. **empty-scope-MUTATING containment (ac-1, CRITICAL):** excluding empty-scope leases is safe ONLY for READ-ONLY owners. A MUTATING node mis-authored with `file_scope:[]` must NOT fail-open — that flips the old deny-all into write-anywhere (the exact `[]`-vs-omit trap the #31 issue's "부수 학습" names). Gate the exclusion on the owning node being read-only (look up node kind via the graph), or otherwise keep a mutating owner with empty scope contained. impl-hook + review MUST cover this.
2. **time-clock lease reap (ac-2):** reopen mints a fresh lease with a new `created_at`; the 24h leaked-lease reap window (`src/core/active-node-lease.ts:44-96`, `LEAKED_LEASE_MAX_AGE_MS`) interacts with it — ensure the re-dispatch's fresh lease is not spuriously reaped and the mid-run predicate is coherent.

## ADR alignment (confirmed, no intent conflict)
ADR-20260627 (reopen is a user-action, not an autonomous payload flag) · ADR-20260710 (conserve frozen AC id-set, re-arm in place, no slice/phase teardown) · ADR-0024 (K-cap mirrors `fix_per_node`/`oracle_failures_to_block` in src/schemas/autopilot.ts ~260-301) · ADR-20260628 (feedback rides the append-only decision-log free-text channel, no new typed field).

## Resume path on the new PC
1. `git pull` on main. `bun install` if needed. `bun run build:bin` → use `./bin/ditto` (dogfood; PATH copy may be stale).
2. Re-confirm the code anchors above (grep the file:line refs — they may have drifted).
3. Execution path (recommended): implement the 8 ACs per the plan via **TDD under the work item** (schema+hook parallel → core → cli → review → verify). Carry the 2 constraints into the impl-hook + impl-core work. This sidesteps re-bootstrapping autopilot (intent.json/autopilot.json didn't travel).
   - Alternatively re-run `ditto deep-interview finalize` from the Record's ACs to re-bootstrap the autopilot graph, then drive it. NOTE: the plan-stage coverage sweep was judged disproportionate for this bounded change (relevance judge kept 16/24 categories → ~100+ subagents); prefer `--coverageIntensity light` or the direct-TDD path.
4. Gate before done: ac-8 = `bun test` green + both plugin builds exit 0. Then `ditto work done wi_260713wxq`.

## Gotchas
- Build/invoke: `bun run build:bin` then `./bin/ditto` (working-tree). Commit hook is `core.hooksPath=.githooks` and rebuilds bin/ditto + auto-stages — for a non-code commit or to isolate, `git add <yours>` then `git commit --no-verify`.
- Board sync / gh: `GITHUB_TOKEN` shadows the project-scoped account → run gh/board ops as `env -u GITHUB_TOKEN gh …` (else board move silently degrades; issue still assignable).
- Session pointer: the pre-tool-use guard attributes edits via the session→WI pointer, which the CLI can't set — reference `wi_260713wxq` in a prompt so the hook binds it (else lease enforcement fail-opens during the run — benign for dev, but no self-dogfooding of the guard).
