export const meta = {
  name: 'build-foundation',
  description:
    'Track B — deterministic multi-agent Workflow that ORCHESTRATES the build of the redesigned ditto foundation (12 architecture invariants as schemas/gates · thin drive-loop · native delegation seam · §5 completeness machine) on top of the locked rebuild/ contracts. The workflow collects structured self-reports and drives slice-by-slice; it does NOT itself mint a pass. The deterministic completion authority (real per-slice test execution + Codex maker≠checker) lives in the calling-session guardrails (guardrails/evidence-runner.sh · guardrails/codex-crosscheck.sh), because a Workflow script has no shell/filesystem access. The workflow returns at most provisional-drained.',
  whenToUse:
    'Track B foundation build orchestration. Invoked by a calling session that owns the pure-env scratch tree, deterministic re-verification, Codex preflight, and state persistence. Requires args {goalPath, scratchTree, resumeState?} (see README runbook). Never mints final pass — the calling session does, after the guardrails confirm. Internal orchestrator; not user-invoked directly.',
  phases: [
    { title: 'Intent-Lock', detail: 'Freeze the closed build-slice set (the completion denominator) from the frozen goal + locked contracts. No later discovery may shrink it.' },
    { title: 'Drive', detail: 'Bounded loop-until-dry. Per round: orchestrate ONE pending in-scope slice (plan→implement) then N independent fresh verifiers (advisory consensus), merge structured boundaries, classify discoveries, detect escape, emit re-passable state.' },
    { title: 'Terminate', detail: 'Emit the provisional termination diagnosis + the exact guardrail commands the calling session must run to reach a real verdict. Absent that confirmation, verdict is unverified (fail-closed).' },
  ],
}

// ── Track B control map ───────────────────────────────────────────────
// Layer 2 (drive-loop) = the bounded top-level `for` loop below = loop-until-dry.
//   Fixpoint = openCount reaches 0 (a COUNT, not an LLM judgement).
// Layer 1 (orchestration) = runSlice(): a gated per-slice pipeline plan→implement→verify.
//   IMPLEMENT is serialized (one slice per round) — the slices share the rebuild/ island
//   and a shared test tree, so concurrent writers are NOT disjoint (charter §4-9; the
//   code-modernization uplift-migrate workflow only fans out over DISJOINT unit dirs).
//   VERIFY fans out N independent read-only verifiers over the now-quiescent tree — a
//   consensus panel that dilutes a single verifier's mis-report/hack (the N-of-M pattern
//   from the code-modernization P0 panel), not a write race.
// The queue is read ONLY from schema-validated structured boundaries; subagent free text is
//   never parsed as the queue oracle.
// HONEST LIMIT: a Workflow harness has NO shell/filesystem access (confirmed: the shipping
//   code-modernization workflows delegate all file IO + resume to the calling session). So the
//   verifier test-counts here are LLM SELF-REPORTS — advisory, not the deterministic gate that
//   Track A's OS-level Stop hook provides. The real gate is the calling-session guardrail that
//   RE-RUNS the test and RE-HASHES evidence outside model control. Therefore this workflow never
//   returns final_verdict:'pass' — the best it asserts is 'provisional-drained', and the calling
//   session mints 'pass' only after guardrails/evidence-runner.sh + guardrails/codex-crosscheck.sh
//   independently confirm. This is the deliberate retraction of the false "Stop-hook parity" claim.
// Determinism: no Date.now / Math.random. Ids derive from round+index; termination derives from
//   queue counts → replay-safe. Gates reuse the locked contracts' semantics; no new gate kinds.

// ── Bounds (유계) ──
const MAX_ROUNDS = 12          // outer budget; escalate/handoff before infinite drive
const VERIFIER_PANEL = 3       // independent fresh verifiers per slice; consensus = majority
const VERIFY_QUORUM = 2        // ⌈3/2⌉ — resolved needs ≥2 concurring pass reports
const STAGNATION_K = 2         // K rounds with 0 dispositions → emergent escape (정체)
const DIVERGENCE_WINDOW = 2    // queue-size not shrinking over 2×window → productive-divergence
const BUDGET_FLOOR = 60000     // token-budget escape floor (mirrors code-modernization guard)

// ── Agent identities (agentType selects the authored role def + its tool allowlist) ──
// These MUST correspond to authored agent definition files carrying least-privilege tools.
// Without agentType, a "role" is just a prompt string with no tool-scoping or identity
// separation — so invariant #4 (verifier is a DIFFERENT identity, read-only) would be prose only.
const A = {
  intentLocker: 'vehicle-b:intent-locker',
  planner: 'vehicle-b:planner',
  implementer: 'vehicle-b:implementer',
  verifier: 'vehicle-b:live-verifier',
  codexOpponent: 'vehicle-b:codex-opponent',
}

// ── Schemas (JSON Schema at the harness boundary; kept in sync with schemas/*.json,
//    inlined because a Workflow script cannot read files) ──
const INTENT_SCHEMA = {
  type: 'object', required: ['intent_id', 'slices'], additionalProperties: false,
  properties: {
    intent_id: { type: 'string' },
    slices: { type: 'array', minItems: 1, items: {
      type: 'object', additionalProperties: false,
      required: ['id', 'invariant_ref', 'gate_kind', 'planned_application_oracle', 'test_command', 'done_state'],
      properties: {
        id: { type: 'string' },
        invariant_ref: { type: 'string' },
        gate_kind: { enum: ['schema', 'fail-closed-gate'] },
        planned_application_oracle: { type: 'string' },
        test_command: { type: 'string' },   // per-slice, targets THIS slice's added test — never the whole 51-green island
        done_state: { type: 'string' },
        touches_intent: { type: 'boolean' },
      },
    }},
  },
}
const PLAN_SCHEMA = {
  type: 'object', required: ['failing_test', 'minimal_change', 'files'], additionalProperties: false,
  properties: {
    failing_test: { type: 'string' },
    minimal_change: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
  },
}
const IMPL_SCHEMA = {
  type: 'object', required: ['changed_files', 'test_command', 'summary'], additionalProperties: false,
  properties: {
    changed_files: { type: 'array', items: { type: 'string' } },
    test_command: { type: 'string' },       // the narrowed command that targets the test this slice added
    summary: { type: 'string' },
  },
}
const VERIFY_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['test_command', 'exit_code', 'pass', 'fail', 'evidence', 'observed_application_evidence', 'orphan_free', 'discovered'],
  properties: {
    test_command: { type: 'string' },
    exit_code: { type: 'integer' },
    pass: { type: 'integer' },
    fail: { type: 'integer' },
    evidence: { type: 'array', minItems: 1, items: {
      type: 'object', additionalProperties: false, required: ['ref'],
      properties: { ref: { type: 'string' }, preview: { type: 'string' } },
    }},
    observed_application_evidence: { type: 'string' },
    orphan_free: { type: 'boolean' },        // REQUIRED (not optional) — an unwired addition is a completeness violation
    discovered: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['kind', 'summary', 'classification'],
      properties: {
        kind: { enum: ['found-defect', 'in-scope-residual', 'unverified-ac'] },
        summary: { type: 'string' },
        classification: { enum: ['current-scope', 'new-scope', 'blocking'] },
        change_kind: { enum: ['method', 'intent'] },
      },
    }},
  },
}
const CODEX_SCHEMA = {
  type: 'object', required: ['available', 'termination_verdict', 'carves'], additionalProperties: false,
  properties: {
    available: { type: 'boolean' },
    termination_verdict: { enum: ['concur', 'dissent', 'unverified'] },
    grounds: { type: 'string' },
    carves: { type: 'array', items: {
      type: 'object', additionalProperties: false, required: ['id', 'verdict'],
      properties: { id: { type: 'string' }, verdict: { enum: ['concur', 'dissent'] }, grounds: { type: 'string' } },
    }},
  },
}

// ── Shared behavioral guard (pure-env: FS isolation is the calling session's scratch tree;
//    BEHAVIORAL isolation must be injected here because the global CLAUDE.md/charter reach every
//    subagent regardless of cwd and would otherwise pull the build back into the ditto lifecycle) ──
const ENV_GUARD = (scratchTree) =>
  '\n\n## Build-environment guard (non-negotiable)\n' +
  '- Work ONLY inside the rebuild/ island under `' + scratchTree + '`. All Bash runs cwd there.\n' +
  '- Do NOT invoke any ditto CLI, ditto skill, or ditto autopilot/work/memory command during this build. This is a pure, from-contracts build; the ditto product surface is the thing being rebuilt, not a tool to use.\n' +
  '- Do NOT commit outside the scratch tree; do NOT touch the ditto repo working tree.\n'

// ── Prompt builders ──
const INTENT_PROMPT = (goalPath, scratchTree) =>
  '## Intent-Lock (frozen denominator)\n' +
  'Read the frozen goal at `' + goalPath + '` and docs/redesign/ditto-rebuild-draft.md §3.3 (12 invariants) + §5.4–5.10.\n' +
  'Locked contracts already exist and pass 51 tests: rebuild/schemas (verdict·evidence·gate-result decideGate·queue-item 3-exit·completion-contract deriveFinalVerdict) + rebuild/seam (HostAdapter·BoundaryEnvelope·FakeHost·isQueueDrained). Invariants #1,#3,#5,#7 already exist as code.\n\n' +
  '## Task\n' +
  'Emit the CLOSED, ordered set of build slices that REMAIN (F1 invariants #2,#4,#6,#8–#12 · F2 thin drive-loop · F3 live adapter behind the seam · F4 completeness machine: park·AC 2-facet·re-lock·single-source disk state). This set is FROZEN — the completion denominator; nothing discovered later may shrink OR grow it.\n' +
  'Each slice = ONE fail-closed invariant gate (or one schema) + the realized-state AC it satisfies. Order smallest-fail-closed-gate first. slice[0] MUST be a single fail-closed gate + its passing step — recommended: extend acVerdict with planned_application_oracle (write-time) / observed_application_evidence (verify-time) facets and a write-time gate that REJECTS a capability-change AC missing the application facet (§5.8).\n' +
  'CRITICAL: give each slice a PER-SLICE test_command that targets ONLY the test file this slice adds (e.g. `bun test rebuild/schemas/ac-verdict-2facet.test.ts`), NEVER the whole `bun test rebuild/` island — that suite is already 51-green, so a whole-island command would pass regardless of the slice. AC describes REALIZED STATE (\'entrypoint call yields improved behavior · no orphan\'), never build activity (\'add function · unit green\'). Set touches_intent=true only if the slice needs a user-owned intent decision.\n' +
  ENV_GUARD(scratchTree) + '\nStructured output only.'

const PLAN_PROMPT = (slice, scratchTree) =>
  '## Plan (Layer 1) — slice ' + slice.id + '\n' +
  'Invariant: ' + slice.invariant_ref + '\nRealized-state AC: ' + slice.done_state + '\n' +
  'Application oracle (how to check live): ' + slice.planned_application_oracle + '\n' +
  'Per-slice test command: ' + slice.test_command + '\n\n' +
  'Produce the smallest TDD step: the ONE failing test to write first, the minimal change to pass it, files touched. Prefer existing rebuild/ patterns; new abstraction only if it removes real complexity.\n' +
  ENV_GUARD(scratchTree) + '\nStructured output only.'

const IMPL_PROMPT = (slice, plan, scratchTree) =>
  '## Implement (Layer 1) — slice ' + slice.id + '\n' +
  'Follow the plan: ' + JSON.stringify(plan) + '\n\n' +
  'Write the failing test FIRST, then the minimal code to pass it, in the rebuild/ island. Do NOT wire into src/ unless the slice application oracle requires a live entrypoint. Keep the change surgical. Report changed_files, the NARROWED test_command that targets the test you added (must equal the slice test_command `' + slice.test_command + '` unless you justify a tighter one), and a one-line summary. Do NOT run the full suite or claim pass — separate fresh verifiers do that.\n' +
  ENV_GUARD(scratchTree) + '\nStructured output only.'

const VERIFY_PROMPT = (slice, scratchTree) =>
  '## Live-Verify (FRESH context — you did NOT write this code; you are a different identity)\n' +
  'Slice ' + slice.id + '. Contract only: AC=\'' + slice.done_state + '\', application oracle=\'' + slice.planned_application_oracle + '\', test_command=\'' + slice.test_command + '\'.\n\n' +
  '## Task\n' +
  '1. Run the REAL, PER-SLICE test command via Bash: `' + slice.test_command + '`. Report its exact exit_code, pass count, fail count. Running the whole island instead is a protocol violation — report fail if you cannot run the narrowed command.\n' +
  '2. Record evidence as REFERENCES (file path or content hash + short preview ≤2000 chars), never inline dumps. At least one evidence ref is required — it must be re-runnable by the calling-session guardrail (a path/hash the guardrail can re-execute/re-hash).\n' +
  '3. observed_application_evidence: confirm the improvement is reached through the LIVE path (reachable entrypoint + real effect), not a unit-isolated call.\n' +
  '4. orphan_free: false if ANY added symbol is unwired/unreachable (wire-or-drop). This field is required.\n' +
  '5. discovered[]: any found-defect / in-scope-residual / unverified-ac. Classify each current-scope / new-scope / blocking, and change_kind method|intent (intent = an existing AC\'s meaning or live-path expectation changes → forces escalation).\n' +
  'Return RAW FACTS ONLY — no verdict; the harness decides resolved by consensus count, and the calling-session guardrail re-runs your evidence deterministically.\n' +
  ENV_GUARD(scratchTree) + '\nStructured output only.'

const CODEX_PROMPT = (frozen, carves, escaped, round, scratchTree) =>
  '## Codex cross-check ADVISORY (maker≠checker — you are a DIFFERENT provider)\n' +
  'Invoke the `codex` CLI DIRECTLY via Bash (NOT any plugin). If `codex` is unavailable/unauthenticated, return available=false.\n' +
  'NOTE: this in-workflow call is ADVISORY. The AUTHORITATIVE maker≠checker gate is the calling-session guardrail guardrails/codex-crosscheck.sh, which the calling session runs directly on the evidence files and whose exit code gates the real verdict — because this workflow cannot itself prove it shelled out to codex.\n\n' +
  '## Adversarially review\n' +
  'Frozen intent: ' + frozen.intent_id + ', ' + frozen.slices.length + ' slices. Round ' + round + '. Escape=' + JSON.stringify(escaped) + '.\n' +
  '(1) Carve decisions — for each item the loop proposes moving to new-scope, decide concur (truly out of current intent AND the increment stays coherent without it) or dissent (an in-scope residual being laundered out): ' + JSON.stringify(carves.map((c) => ({ id: c.id, summary: c.summary }))) + '\n' +
  '(2) Termination diagnosis — concur ONLY if the current-intent queue is genuinely drained to fixpoint with live evidence; dissent if anything is undecided/unwired; unverified if you cannot adjudicate.\n' +
  ENV_GUARD(scratchTree) + '\nStructured output only.'

// ── Helpers (hoisted) ──
function blocked(slice, why) { return { slice_id: slice.id, resolution: 'unresolved', grounds: why, discovered: [] } }

// deriveFinalVerdict — THIN mirror of the locked rebuild/schemas contract (SoT stays the schema;
// the built slice's own test asserts this mirror matches — disclosed as a tested duplication, since
// a Workflow script cannot import repo TS). Invariant #1: pass only if every criterion is pass AND
// carries evidence. Even a full pass here is only PROVISIONAL until the calling-session guardrails
// re-confirm; this function never upgrades a self-report into an authoritative pass on its own.
function deriveProvisionalVerdict(criteria) {
  if (criteria.length === 0) return 'unverified'
  if (criteria.some((c) => c.verdict === 'fail')) return 'unverified'
  const ok = criteria.every((c) => c.verdict === 'pass' && c.evidence.length > 0)
  return ok ? 'provisional-drained' : 'unverified'
}

// productive-divergence: over the last window the min openCount did not improve on the window before.
function divergent(hist, window) {
  if (hist.length < window * 2) return false
  const recentMin = Math.min(...hist.slice(-window))
  const priorMin = Math.min(...hist.slice(-window * 2, -window))
  return recentMin >= priorMin
}

function keyOf(it) { return it.kind + '|' + it.summary.trim().toLowerCase().slice(0, 120) }

// Discoveries are BACKLOG-ONLY. A discovered item is never turned into a drivable slice (it has no
// test_command/oracle, so it could never be verified — and the FROZEN denominator must not grow).
// current-scope discoveries surface as escalation candidates; nothing here silently expands the loop.
function recordDiscoveries(backlog, obs) {
  const existing = new Set(backlog.map(keyOf))
  ;(obs.discovered || []).forEach((d, i) => {
    const item = { id: obs.slice_id + '-d' + i, kind: d.kind, summary: d.summary, classification: d.classification, change_kind: d.change_kind }
    if (existing.has(keyOf(item))) return
    existing.add(keyOf(item))
    backlog.push(item)
  })
}

// Consensus over the N-of-M verifier panel. Each verifier is a raw-facts self-report; the harness
// decides resolved by COUNT of concurring passes (never by any single verifier's word), and only up
// to 'provisional' — the calling-session guardrail is the deterministic authority above this.
function consensus(slice, panel) {
  const reports = panel.filter(Boolean)
  const intentChange = reports
    .flatMap((v) => v.discovered || [])
    .find((d) => d.change_kind === 'intent' || d.classification === 'blocking')
  if (intentChange) return { slice_id: slice.id, resolution: 'escape-intent', grounds: intentChange.summary, discovered: reports.flatMap((v) => v.discovered || []) }
  const passVotes = reports.filter(
    (v) => v.exit_code === 0 && v.fail === 0 && v.pass > 0 &&
      v.evidence.length > 0 && !!v.observed_application_evidence && v.orphan_free === true,
  )
  const resolved = passVotes.length >= VERIFY_QUORUM
  const winner = passVotes[0] || reports[0]
  return {
    slice_id: slice.id,
    resolution: resolved ? 'resolved' : 'unresolved',
    grounds: resolved ? undefined : passVotes.length + '/' + reports.length + ' pass votes (< quorum ' + VERIFY_QUORUM + ')',
    evidence: (winner && winner.evidence) || [],
    discovered: reports.flatMap((v) => v.discovered || []),
  }
}

// Layer 1 — gated per-slice pipeline: plan → implement (serialized) → N-of-M fresh verifiers.
async function runSlice(slice, scratchTree) {
  const plan = await agent(PLAN_PROMPT(slice, scratchTree), { agentType: A.planner, label: 'plan:' + slice.id, phase: 'Drive', schema: PLAN_SCHEMA })
  if (!plan) return blocked(slice, 'plan skipped/errored')
  const impl = await agent(IMPL_PROMPT(slice, plan, scratchTree), { agentType: A.implementer, label: 'impl:' + slice.id, phase: 'Drive', schema: IMPL_SCHEMA })
  if (!impl) return blocked(slice, 'implement skipped/errored')
  // N independent FRESH verifiers (different identity from the implementer, invariant #4), read-only,
  // fanned out over the now-quiescent tree. Consensus, not any single report, decides resolved — and
  // only provisionally (calling-session guardrail re-runs the evidence deterministically).
  const panel = await parallel(
    Array.from({ length: VERIFIER_PANEL }, (_unused, i) => () =>
      agent(VERIFY_PROMPT(slice, scratchTree), { agentType: A.verifier, label: 'verify:' + slice.id + ':v' + i, phase: 'Drive', schema: VERIFY_SCHEMA }),
    ),
  )
  return consensus(slice, panel)
}

function report(frozen, verdict, escaped, queue, backlog, round, note, scratchTree) {
  const criteria = frozen.slices.map((s) => {
    const q = queue.find((x) => x.id === s.id)
    return { criterion_id: s.id, verdict: q && q.exit === 'resolved' ? 'pass' : 'unverified', evidence: (q && q.evidence) || [] }
  })
  return {
    intent_id: frozen.intent_id,
    final_verdict: verdict,        // never 'pass' — 'pass' is minted only by the calling session
    note, round, escaped: escaped || null,
    criteria,
    // Re-passable state so the calling session can persist queue.json/log.jsonl and resume via args
    // (the workflow has no filesystem; resume is an EXTERNAL boundary, mirroring code-modernization).
    resume_state: {
      queue: queue.map((q) => ({ id: q.id, kind: q.kind, exit: q.exit || null, classification: q.classification, proposed: q.proposed || null, evidence: q.evidence || [] })),
      backlog,
      round,
      openHist: frozen.__openHist || [],
      noProgress: frozen.__noProgress || 0,
    },
    // The exact deterministic gates the calling session MUST run to upgrade provisional-drained → pass.
    required_guardrails: [
      { cmd: 'sh vehicle-b/guardrails/evidence-runner.sh ' + scratchTree, purpose: 'Deterministically RE-RUN each slice test_command + re-hash evidence outside model control (the real gate).' },
      { cmd: 'sh vehicle-b/guardrails/codex-crosscheck.sh ' + scratchTree, purpose: 'maker≠checker external authority; absent codex → nonzero exit → fail-closed to unverified.' },
    ],
    open: queue.filter((q) => q.exit === undefined).map((q) => ({ id: q.id, kind: q.kind, summary: q.summary })),
    backlog,
    stats: { rounds: round + 1, slices: frozen.slices.length, resolved: queue.filter((q) => q.exit === 'resolved').length },
  }
}

// ── Args (may arrive as raw JSON string or parsed object; normalize — as the shipping workflows do) ──
const ARGS = typeof args === 'string'
  ? (() => { try { return JSON.parse(args) } catch (_e) { return { goalPath: args } } })()
  : (args || {})
const GOAL_PATH = (ARGS && ARGS.goalPath) || 'vehicle/goal.md'
const SCRATCH_TREE = (ARGS && ARGS.scratchTree) || '<scratch-tree>'
const RESUME = (ARGS && ARGS.resumeState) || null

// ── Phase Intent-Lock — freeze the closed slice set (denominator) ──
phase('Intent-Lock')
const lock = await agent(INTENT_PROMPT(GOAL_PATH, SCRATCH_TREE), { agentType: A.intentLocker, label: 'intent-lock', phase: 'Intent-Lock', schema: INTENT_SCHEMA })
if (!lock) return { error: 'Intent-lock failed — cannot freeze the build-slice set; refusing to drive (fail-closed).', final_verdict: 'unverified' }
log('Intent locked: ' + lock.slices.length + ' frozen slices; slice[0]=' + lock.slices[0].id)

// FROZEN denominator — never re-derived, never shrunk, never grown; discoveries are classified
// against it into a separate backlog, never folded back into the drivable set.
const FROZEN = Object.freeze({ intent_id: lock.intent_id, slices: lock.slices })

// Restart: prefer resumed state (calling-session-owned durability) over a fresh queue.
const queue = RESUME && Array.isArray(RESUME.queue) && RESUME.queue.length > 0
  ? RESUME.queue.map((q) => ({ ...q, exit: q.exit || undefined }))
  : FROZEN.slices.map((s) => ({
      id: s.id, kind: 'unverified-ac',
      summary: s.invariant_ref + ': ' + s.done_state,
      classification: 'current-scope', escalate: s.touches_intent === true, exit: undefined,
    }))
const backlog = (RESUME && Array.isArray(RESUME.backlog)) ? RESUME.backlog.slice() : []

// ── Phase Drive — bounded loop-until-dry (Layer 2). First iteration drives slice[0] =
//    fail-closed invariant gate #1 + its passing step; loops until the queue drains. ──
phase('Drive')
const startRound = (RESUME && Number.isInteger(RESUME.round)) ? RESUME.round : 0
let round = startRound
let escaped = null
const openHist = (RESUME && Array.isArray(RESUME.openHist)) ? RESUME.openHist.slice() : []
let noProgress = (RESUME && Number.isInteger(RESUME.noProgress)) ? RESUME.noProgress : 0
for (round = startRound; round < MAX_ROUNDS; round++) {
  // token-budget escape — park with a framed handoff instead of a hard truncation mid-build.
  if (typeof budget !== 'undefined' && budget.total && budget.remaining() < BUDGET_FLOOR) {
    escaped = { kind: 'budget-exhausted', grounds: 'token budget below floor; parking with framed handoff' }
    break
  }

  const pending = queue.filter((it) => it.exit === undefined && it.classification === 'current-scope' && !it.proposed)
  if (pending.length === 0) break

  // upfront escape — an item plainly touching intent/design/ADR/irreversible: escalate now, no loop waste.
  const up = pending.find((it) => it.escalate)
  if (up) { escaped = { kind: 'upfront', item: up.id, grounds: up.summary }; break }

  // Layer 1 — SERIALIZED implement (shared island = not disjoint → no concurrent writers).
  const slice = FROZEN.slices.find((s) => s.id === pending[0].id)   // join by id → carry the FULL contract (fixes field-loss)
  const obs = await runSlice(slice, SCRATCH_TREE)

  const target = queue.find((q) => q.id === obs.slice_id)
  if (obs.resolution === 'resolved' && target) { target.exit = 'resolved'; target.evidence = obs.evidence }
  else if (target) { target.lastGrounds = obs.grounds || 'unresolved' }
  recordDiscoveries(backlog, obs)   // discoveries → backlog only (denominator stays FROZEN)

  if (obs.resolution === 'escape-intent') { escaped = { kind: 'intent-change', item: obs.slice_id, grounds: obs.grounds }; break }

  const disposed = obs.resolution === 'resolved' ? 1 : 0
  const open = queue.filter((it) => it.exit === undefined && it.classification === 'current-scope' && !it.proposed).length
  openHist.push(open)
  noProgress = disposed > 0 ? 0 : noProgress + 1
  log('round ' + round + ': ' + disposed + ' resolved, ' + open + ' open, ' + backlog.length + ' backlog')

  // emergent escape — 정체(stagnation) OR 생산적 발산(productive-divergence).
  if (noProgress >= STAGNATION_K) { escaped = { kind: 'stagnation', grounds: STAGNATION_K + ' rounds with 0 dispositions' }; break }
  if (divergent(openHist, DIVERGENCE_WINDOW)) { escaped = { kind: 'productive-divergence', grounds: 'queue size not shrinking over window' }; break }

  if (open === 0) break   // provisional drain → confirmed only by the calling-session guardrails
}
// stash loop-durable escape signals on the frozen carrier so report() can hand them back for resume.
FROZEN.__openHist = openHist
FROZEN.__noProgress = noProgress

// ── Phase Terminate — advisory Codex + emit provisional verdict and the required guardrail commands ──
phase('Terminate')
const carves = queue.filter((it) => it.proposed === 'new-scope' && it.exit === undefined)
const codex = await agent(CODEX_PROMPT(FROZEN, carves, escaped, round, SCRATCH_TREE), { agentType: A.codexOpponent, label: 'codex-crosscheck-advisory', phase: 'Terminate', schema: CODEX_SCHEMA })

// Only Codex-concurred carves leave the queue (advisory here; the calling-session codex guardrail is
// authoritative). If codex is unavailable in-workflow we simply carry carves as still-open.
if (codex && codex.available !== false) {
  carves.forEach((c) => {
    const adj = (codex.carves || []).find((x) => x.id === c.id)
    if (adj && adj.verdict === 'concur') c.exit = 'new-scope-deferral'
  })
}

if (escaped) {
  return report(FROZEN, 'unverified', escaped, queue, backlog, round,
    'Escalated (' + escaped.kind + ') — framed handoff, not done. ' + (escaped.grounds || '') +
    ' Resume by re-invoking with args.resumeState = this run\'s resume_state after the owner resolves the blocker.', SCRATCH_TREE)
}

// Provisional completion contract over the frozen slices. Even a full drain returns
// 'provisional-drained', NOT 'pass' — the calling session mints 'pass' only after
// evidence-runner.sh + codex-crosscheck.sh independently confirm (see required_guardrails).
const criteria = FROZEN.slices.map((s) => {
  const q = queue.find((x) => x.id === s.id)
  return { criterion_id: s.id, verdict: q && q.exit === 'resolved' ? 'pass' : 'unverified', evidence: (q && q.evidence) || [] }
})
const provisional = deriveProvisionalVerdict(criteria)
return report(FROZEN, provisional, null, queue, backlog, round,
  provisional === 'provisional-drained'
    ? 'Queue drained to fixpoint by consensus (advisory). NOT done — calling session must run required_guardrails; only their deterministic confirmation upgrades this to pass.'
    : 'Not drained — open/unverified criteria remain (fail-closed).', SCRATCH_TREE)
