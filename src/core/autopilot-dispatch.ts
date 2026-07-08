import type { Autopilot, AutopilotNode } from '~/schemas/autopilot';
import { type OwnerReturnEnvelope, ownerReturnEnvelope } from '~/schemas/owner-return-envelope';
import type { AcOracle, WorkItem } from '~/schemas/work-item';
import type { MemoryWarmStartContext } from './memory-warmstart';
import type { RetroMetrics, RetroNarrative } from './retro-measure';

/**
 * Retro presentation context (ADR-0024 결정4): the assembled metrics + the
 * projection-only narrative the retrospective agent PRESENTS (it does not invent
 * them). Carried only on a retro node's packet. The two metrics are KEPT SEPARATE
 * by `RetroMetrics`; the narrative is a pure projection of run records.
 */
export interface RetroContext {
  metrics: RetroMetrics;
  narrative: RetroNarrative;
}

/**
 * Pre-computed change surface for a read-only review node (AC1). The orchestrator
 * computes the diff ONCE per dispatch and injects it here so reviewer/verifier/
 * security-reviewer do not each re-run `git diff` and re-Read the changed files.
 * This carries only the MECHANICAL "what changed" — never a judgment — so the
 * reviewers' independent verdicts stay independent (charter §4-9). Present only on
 * a review-owner packet; absent ⇒ the packet is byte-for-byte the no-surface path.
 */
export interface ChangeSurface {
  changed_files: string[];
  diff: string;
}

/**
 * An addressed acceptance criterion resolved for the packet (ADR-0024 ac-3, ②
 * DELIVER): the implementer needs the AC's STATEMENT TEXT and its assigned ORACLE
 * (what to satisfy + how it is judged), not just the id. `oracle` is omitted for a
 * legacy AC that carries none — additive, no breakage.
 */
export interface ResolvedAcceptance {
  id: string;
  statement: string;
  oracle?: AcOracle;
}

/**
 * Node dispatch + failure classification (M2.4). The 6-section delegation packet
 * is what the orchestrator sends to an owner subagent. Context Isolation: the
 * packet carries the task and scope, never the driver's hypotheses or other
 * nodes' internal state.
 */
export interface DelegationPacket {
  task: string;
  expected_outcome: string;
  required_tools: string[];
  must_do: string[];
  must_not_do: string[];
  context: {
    work_item_id: string;
    file_scope: string[];
    done_when: string;
    acceptance_refs: string[];
    // ADR-0024 ac-3 (② DELIVER): each addressed AC resolved to its statement text
    // + assigned oracle. Additive alongside `acceptance_refs` (ids), which existing
    // consumers still read. Empty when the work item carries no matching criteria
    // (e.g. a node whose acceptance_refs point nowhere, or a legacy fixture).
    acceptance: ResolvedAcceptance[];
    // Warm-start memory push (§5-1 / §10-6 #1): related serving-graph context for
    // researcher/planner nodes. Optional & non-invasive — the loop queries the
    // memory graph fail-open and injects the result here; absent/stale/no-coverage
    // ⇒ undefined ⇒ the packet is byte-for-byte what it was without memory.
    memory?: MemoryWarmStartContext;
    // Retro presentation context (ADR-0024 결정4): the assembled SEPARATED metrics
    // + projection-only narrative the retrospective agent presents (it does not
    // invent them). Present only on a retro node's packet; absent ⇒ packet is
    // byte-for-byte the no-retro path.
    retro?: RetroContext;
    // Pre-computed change surface (AC1): the diff + changed files computed ONCE by
    // the orchestrator for a review-owner node, so reviewer/verifier/security do not
    // each re-run git. Present only on a review packet; absent ⇒ byte-for-byte the
    // no-surface path. Mechanical fact only — does not touch verdict independence.
    change_surface?: ChangeSurface;
  };
  // Variant routing: deterministically filtered specialized-subagent candidates
  // (role + file_scope match). The driver picks a `subagent_type` from these
  // instead of the fixed owner; [] means no variant catalog applied.
  variant_candidates: { name: string; description: string }[];
}

export const OWNER_TOOLS: Record<AutopilotNode['owner'], string[]> = {
  researcher: ['Read', 'Grep', 'Glob', 'Bash', 'WebSearch', 'WebFetch'],
  planner: ['Read', 'Grep', 'Glob'],
  implementer: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
  reviewer: ['Read', 'Grep', 'Glob', 'Bash'],
  verifier: ['Read', 'Grep', 'Glob', 'Bash'],
  architect: ['Read', 'Grep', 'Glob'],
  'playwright-e2e': ['Read', 'Grep', 'Glob', 'Bash'],
  'knowledge-curator': ['Read', 'Grep', 'Glob', 'Write'],
  // [VERIFY] lifecycle owners (§2.2). security-reviewer/retrospective are read-only
  // analysis (run checks, no mutation); refactorer mutates code (Tidy First) so it
  // carries Edit/Write — which is also what marks it approval-gated (isMutatingOwner).
  'security-reviewer': ['Read', 'Grep', 'Glob', 'Bash'],
  refactorer: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
  retrospective: ['Read', 'Grep', 'Glob', 'Bash'],
  // The driver pseudo-owner is never spawned (nextNode intercepts it), so it has
  // no LLM toolset. Its irreversible git work is gated by a dedicated explicit
  // approval gate in autopilot-cleanup, not the Edit-derived mutation gate.
  driver: [],
  // The main-session pseudo-owner is never spawned either (nextNode intercepts
  // it): an e2e-author node needs a user dialogue, so the driver runs the
  // ditto:e2e-author skill inline in the main session. No Edit here — the node
  // is non-mutating for the approval gate (isMutatingOwner).
  'main-session': [],
  // The settled-tree test barrier owner (wi_260708ds9): it RUNS the full suite and
  // reports GREEN/RED/degrade. Read/Grep/Glob/Bash ONLY — deliberately NO Edit/Write.
  // If Edit leaked in, isMutatingOwner(tester) would be true and guardMutatingEvidence
  // would reject every 0-changed-file GREEN barrier as a bogus mutation → completion
  // deadlock. A barrier changes no files; it only judges the suite.
  tester: ['Read', 'Grep', 'Glob', 'Bash'],
};

/**
 * An owner mutates the workspace iff its toolset grants Edit. Deriving the
 * mutating signal from the one toolset table keeps the approval gate and the
 * packet's tools from ever drifting apart (gate ↔ tools consistency): adding a
 * mutating owner is a single edit here, not two lists to keep in sync.
 */
export function isMutatingOwner(owner: AutopilotNode['owner']): boolean {
  return OWNER_TOOLS[owner].includes('Edit');
}

/**
 * A read-only review owner judges an already-made change (AC1): it needs the diff
 * but produces no edit. These are exactly the owners that would otherwise each
 * re-run `git diff` — so the loop pre-computes the change surface once for them.
 */
export function isReviewOwner(owner: AutopilotNode['owner']): boolean {
  return owner === 'reviewer' || owner === 'verifier' || owner === 'security-reviewer';
}

// Planner-intelligence contract (계약 우선 · §2.4): a planner node is the graph
// generator, so its packet *requests* a `generated_nodes` lifecycle subgraph.
// DITTO supplies the deterministic request + the validation floor (addNodes /
// validateNodeAddition on splice); the LLM planner supplies which §2.2 stages the
// task needs. The acceptance side is already wired (A-3 recordResult promotion).
const PLANNER_GENERATE_DIRECTIVE =
  'Emit a `generated_nodes` subgraph: pick the §2.2 lifecycle stages this task ' +
  'actually needs (research·design·implement·review·verify·…), each node ' +
  '{id, kind, purpose, depends_on, acceptance_refs, file_scope} mapped to its ' +
  'acceptance criteria; scale to task size (small tasks stay minimal — do not ' +
  'force a stage). For each MUTATING node declare `file_scope` (the repo-relative ' +
  'paths it will edit) as precisely and DISJOINTLY as you can: non-overlapping ' +
  'scopes let independent mutators run in parallel, while leaving it off forces the ' +
  'engine to serialize that node conservatively (one scope-unknown mutator at a ' +
  'time). Omit it ONLY when the scope is genuinely unknown — never guess a scope ' +
  'that might overlap another node (a wrong disjoint claim risks a clobber).';

/**
 * Cite-or-abstain directive (memory-librarian §8 inc.2, ac-2): when the packet
 * carries governing decisions, the agent must not silently ignore them — for
 * each it relied on, cite it; if none apply, say so. Turns warm-start from mere
 * injection into enforced consumption (the §7 "inject ≠ consume" risk).
 */
const CITE_OR_ABSTAIN_DIRECTIVE =
  'Consult the governing decisions in context.memory.decision_briefs: cite the ' +
  'ones you relied on (follow them or justify any deviation), and if none apply ' +
  'to this task, state that explicitly (cite-or-abstain).';

/**
 * Red-first directive (wi_2606264rm ac-1): an implementer node addressing a
 * code-behavior AC must write the failing test FIRST, confirm the failure is the
 * AC assertion (not a phantom compile/import red), then make the smallest change
 * to green. The trigger is a design-assigned `dynamic_test` oracle, which is the
 * heavy-path signal: oracles are assigned at the design (plan) stage, so a
 * lightweight node carries none and this directive never fires for it. The other
 * oracle classes are red-first-EXEMPT by construction — `soft_judgment` is a
 * non-code (doc/prompt/config) AC judged by review, and `static_scan` is
 * re-scanned, not driven by a failing unit test. refactorer mutates too but does
 * Tidy-First behavior-preserving work (no new failing test), so the trigger is the
 * implementer owner specifically.
 */
const RED_FIRST_DIRECTIVE =
  'Red-first discipline (code-behavior AC): write the failing test that asserts ' +
  'this criterion FIRST and run it; confirm it fails on the AC assertion itself, ' +
  'not on a compile/import error (no phantom red), then make the smallest change ' +
  'to turn it green. Report both the red run and the green run (command + exit code).';

/**
 * Scope-local-unit directive (wi_260708ds9 ac-2). The implementer full-suite pressure is
 * NOT in this packet — it is the GLOBAL CHARTER ('매 단계 전체 테스트 실행') the subagent
 * inherits. Mid-wave, though, running the FULL/cross suite is wrong: other implementers may
 * be editing in parallel (a transiently-red cross-module suite), and re-running the whole
 * suite per node is wasteful. So this ADDS (never removes — RED_FIRST stays for ac-3) a
 * directive to run ONLY the node's own file_scope mock-unit subset mid-wave. The whole-suite
 * GREEN is proven ONCE, after the wave settles, by the DETERMINISTIC settled-tree test
 * barrier (autopilot-loop.executeTestBarrier) — not by the implementer. Implementer-only:
 * the barrier owns the full-suite proof, and read-only roles run no unit subset.
 */
const SCOPE_LOCAL_UNIT_DIRECTIVE =
  'Scope-local unit tests (mid-wave): run ONLY the mock-unit tests for your own ' +
  'file_scope — do NOT run the full or cross-module suite while other implementers may ' +
  'be editing in parallel. The whole-suite GREEN is proven ONCE after the wave settles by ' +
  'the deterministic settled-tree test barrier, not by you. Report the command + exit code ' +
  'of your scoped unit run.';

/**
 * True when this node should carry the red-first directive: an implementer node
 * whose resolved acceptance includes at least one code-behavior AC (a
 * design-assigned `dynamic_test` oracle). Derived purely from the node owner +
 * already-resolved acceptance, so the builder stays pure and the loop carries the
 * directive by passing the work item it already passes.
 */
function isRedFirstImplement(
  owner: AutopilotNode['owner'],
  acceptance: ResolvedAcceptance[],
): boolean {
  return (
    owner === 'implementer' &&
    acceptance.some((a) => a.oracle?.verification_method === 'dynamic_test')
  );
}

export function buildDelegationPacket(
  node: AutopilotNode,
  workItem: WorkItem,
  variantCandidates: { name: string; description: string }[] = [],
  // The actual dispatch scope for this node (V2). Defaults to the shared
  // work-item changed_files so existing callers are unchanged, but the
  // orchestrator passes `scopeOf(node)` (node.file_scope ?? changed_files) so the
  // packet the subagent receives matches the active-node lease PreToolUse
  // enforces — otherwise a node that declares its own file_scope gets a packet
  // scoped to a different (often empty) file set.
  fileScope: string[] = workItem.changed_files,
  // Warm-start memory context (§10-6 #1). The builder stays PURE & SYNCHRONOUS:
  // it never queries the memory graph — the loop does that fail-open and passes
  // the result here, or `undefined` (then `context.memory` is omitted entirely).
  memoryContext?: MemoryWarmStartContext,
  // Retro presentation context (ADR-0024 결정4). Same purity contract as memory:
  // the loop assembles the SEPARATED metrics + projection-only narrative fail-open
  // and passes it here for a retro node; `undefined` ⇒ `context.retro` is omitted.
  retroContext?: RetroContext,
  // Pre-computed change surface (AC1). Same purity contract as memory/retro: the
  // builder NEVER runs git — the loop computes the diff once (fail-open) and passes
  // it here for a review node, or `undefined` (then `context.change_surface` is
  // omitted entirely, keeping the packet identical to the no-surface path).
  changeSurface?: ChangeSurface,
): DelegationPacket {
  const isPlanner = node.owner === 'planner';
  // ADR-0024 ac-3 (② DELIVER): resolve each addressed AC id to its statement +
  // assigned oracle so the implementer receives what to satisfy + how it is judged,
  // not just the id (the intent-loss point). PURE & SYNCHRONOUS: read only from the
  // passed workItem — no store calls, no async. Order follows node.acceptance_refs;
  // ids with no matching criterion are skipped (legacy / mis-pointed refs).
  const acceptance: ResolvedAcceptance[] = node.acceptance_refs.flatMap((id) => {
    const ac = workItem.acceptance_criteria?.find((c) => c.id === id);
    if (!ac) return [];
    return [{ id: ac.id, statement: ac.statement, ...(ac.oracle ? { oracle: ac.oracle } : {}) }];
  });
  // Human-readable so the agent knows what + how-judged (not just ids). Falls back
  // to the bare-id form when no criterion resolved (no statements to show).
  const doneWhen =
    acceptance.length > 0
      ? `acceptance criteria satisfied with evidence: ${acceptance
          .map((a) => {
            const how = a.oracle ? ` [oracle: ${a.oracle.verification_method}]` : '';
            return `${a.id} — ${a.statement}${how}`;
          })
          .join('; ')}`
      : node.acceptance_refs.length > 0
        ? `acceptance criteria satisfied with evidence: ${node.acceptance_refs.join(', ')}`
        : node.purpose;
  // A planner closes on a generated subgraph, not just prose; surface it in the
  // expected outcome so done_when reflects the graph-generation responsibility.
  const expectedOutcome = isPlanner
    ? `${doneWhen} (return the plan as a generated_nodes subgraph)`
    : doneWhen;
  return {
    task: node.purpose,
    expected_outcome: expectedOutcome,
    required_tools: OWNER_TOOLS[node.owner],
    must_do: [
      'Work only from this packet.',
      'Return a single result with evidence (command + exit code, file:line).',
      ...(isPlanner ? [PLANNER_GENERATE_DIRECTIVE] : []),
      ...(isRedFirstImplement(node.owner, acceptance) ? [RED_FIRST_DIRECTIVE] : []),
      // ac-2 (additive): an implementer runs only its own scope's mock-unit tests mid-wave;
      // the full-suite GREEN is proven once by the settled-tree barrier, not per-node.
      ...(node.owner === 'implementer' ? [SCOPE_LOCAL_UNIT_DIRECTIVE] : []),
      ...(memoryContext?.decisions?.length || memoryContext?.decision_briefs?.length
        ? [CITE_OR_ABSTAIN_DIRECTIVE]
        : []),
      `Stop when done_when is met: ${doneWhen}.`,
    ],
    must_not_do: [
      "Do not assume the orchestrator's hypotheses or other nodes' internal state (Context Isolation).",
      'Do not grow or shrink the goal scope; no unrequested refactors or extra features.',
      ...(isMutatingOwner(node.owner) ? [] : ['Do not mutate files (read-only role).']),
    ],
    context: {
      work_item_id: workItem.id,
      file_scope: fileScope,
      done_when: doneWhen,
      acceptance_refs: node.acceptance_refs,
      acceptance,
      // Only present when the loop supplied a non-empty warm-start context; an
      // omitted field keeps the packet identical to the no-memory path.
      ...(memoryContext ? { memory: memoryContext } : {}),
      // Only present on a retro node (loop assembles + passes it); omitted ⇒ the
      // packet is byte-for-byte the no-retro path.
      ...(retroContext ? { retro: retroContext } : {}),
      // Only present when the loop supplied a pre-computed surface for a review
      // node; omitted ⇒ packet is byte-for-byte the no-surface path.
      ...(changeSurface ? { change_surface: changeSurface } : {}),
    },
    variant_candidates: variantCandidates,
  };
}

export type FailureClass =
  | 'fixable'
  | 'wrong_approach'
  | 'blocked_external'
  | 'user_decision_needed';

/**
 * Guard a child subagent's returned result before it can be counted as PASS
 * (G7: a completion *signal* is not completion *proof*). A native Task returns
 * the subagent's final text synchronously, but that text can be empty or a bare
 * acknowledgement ("done") carrying no evidence of the work. Such a result is
 * non-contentful and must be treated as inconclusive — routed back through the
 * failure pipeline as `fixable` (respawn, typically smaller), never as PASS.
 *
 * This is a deterministic floor on the orchestrator's collect step; it does not
 * judge evidence *depth* (that is the verifier's job) — only that there is
 * something to judge at all.
 */
export type ChildResultGuard =
  | { contentful: true }
  | { contentful: false; failure_class: 'fixable'; reason: string };

// The whole trimmed message is one short acknowledgement token — a claim of
// completion with no accompanying work or evidence.
const ACK_ONLY =
  /^(done|ok|okay|complete|completed|finished|fixed|pass|passed|success|succeeded|yes|ack|acknowledged|✓|✅|👍)[\s.!]*$/i;

export function guardChildResult(text: string): ChildResultGuard {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { contentful: false, failure_class: 'fixable', reason: 'empty child result' };
  }
  if (ACK_ONLY.test(trimmed)) {
    return {
      contentful: false,
      failure_class: 'fixable',
      reason: `ack-only child result ("${trimmed}") — acknowledgement is not evidence`,
    };
  }
  return { contentful: true };
}

/**
 * G7 floor 확장 (wi_260606h9q): a mutating node (implementer/refactorer) that
 * claims `pass` must carry actual change evidence — at least one `changed_files`
 * entry. A mutation that touched zero files is a completion *claim* with no
 * *proof* (prime directive), which is exactly the shape a spawn-skipping or
 * fabricated result takes. Force it back through the failure pipeline as fixable.
 *
 * This does NOT verify that a Task subagent actually ran (that is a main-agent
 * behaviour the harness owns and code cannot observe) — it only refuses to let a
 * mutating node close as pass with no file-change evidence at all.
 */
export function guardMutatingEvidence(
  owner: AutopilotNode['owner'],
  outcome: 'pass' | 'fail',
  changedFiles: string[],
): ChildResultGuard {
  if (outcome === 'pass' && isMutatingOwner(owner) && changedFiles.length === 0) {
    return {
      contentful: false,
      failure_class: 'fixable',
      reason: `mutating node (${owner}) claimed pass with no changed_files — a mutation with zero file changes is not evidence of work (claim ≠ proof)`,
    };
  }
  return { contentful: true };
}

/**
 * G7 floor 확장 (wi_260619zqa): the mirror of guardMutatingEvidence for *judging*
 * nodes. A node that judges at least one acceptance criterion `pass` but carries
 * NO evidence_refs is closing that criterion to pass on a bare claim — and once
 * the node locks `passed`, `autopilot complete` reads that pass-verdict with an
 * empty evidence set forever (the criterion is stuck unverified with no recovery
 * path). Refuse it at the point it is recorded: force the pass back through the
 * failure pipeline as fixable so the node stays running and re-recordable.
 *
 * Triggers only on a pass verdict (`verdict==='pass'`). A node that already judged
 * its criteria partial/fail/unverified is NOT downgraded — per-AC granularity is
 * preserved (it never over-closed anything). Owner/kind agnostic: verifier,
 * reviewer, security-reviewer, playwright-e2e, and any manual graph node are all
 * covered. design/planner bare passes carry no pass-verdict, so they never trigger.
 */
export function guardAcClosingEvidence(args: {
  outcome: 'pass' | 'fail';
  ac_verdicts: { criterion_id: string; verdict: string; evidence_refs?: unknown[] }[];
  evidence_refs: unknown[];
}): ChildResultGuard {
  if (args.outcome !== 'pass') return { contentful: true };
  const passVerdicts = args.ac_verdicts.filter((v) => v.verdict === 'pass');
  if (passVerdicts.length === 0) return { contentful: true };
  // A pass-verdict is proved if there is top-level evidence OR that verdict
  // carries its own non-empty evidence_refs. Either path counts; both empty for
  // any pass criterion is a bare claim. Refuse if at least one pass criterion is
  // unevidenced by both paths.
  const topLevelEvidence = args.evidence_refs.length > 0;
  const unevidenced = passVerdicts.filter(
    (v) => !topLevelEvidence && (v.evidence_refs?.length ?? 0) === 0,
  );
  if (unevidenced.length > 0) {
    const ids = unevidenced.map((v) => v.criterion_id).join(', ');
    const criteria = unevidenced.length === 1 ? 'criterion' : 'criteria';
    const head = `node judged acceptance ${criteria} \`pass\` (${ids}) but carried no evidence`;
    return {
      contentful: false,
      failure_class: 'fixable',
      reason: `${head} — closing a criterion to pass on a bare claim is not proof (claim ≠ proof). Attach the evidence (test/build/run output, artifact) at the top-level \`evidence_refs\`, or on the matching \`ac_verdict\` entry's \`evidence_refs\`, before passing`,
    };
  }
  return { contentful: true };
}

/**
 * Guard an owner-return ENVELOPE (ac-1, wi_260627jhh). The envelope formalizes the
 * human return while keeping the structured machine slots distinct; this is a SHAPE
 * gate (not SIZE — oversized verbatim_detail is fine). A non-conforming envelope is
 * non-contentful and routed back as `fixable`. It NEVER throws — a throw on the
 * record-result path would crash the orchestrator, the exact bug this work closes —
 * so it `safeParse`s and returns a Result either way.
 */
export function guardOwnerEnvelope(raw: unknown): ChildResultGuard {
  const parsed = ownerReturnEnvelope.safeParse(raw);
  if (!parsed.success) {
    const reason = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return {
      contentful: false,
      failure_class: 'fixable',
      reason: `owner-return envelope does not conform: ${reason}`,
    };
  }
  return { contentful: true };
}

/**
 * Cross-check that the envelope's self-declared `owner_kind` matches the role the
 * node was ACTUALLY dispatched to (wi_2606274be). `guardOwnerEnvelope` only checks
 * shape, and the schema's reachability exemption (superRefine) lets an
 * `owner_kind: 'retrospective'` envelope pass with an empty `verbatim_detail`.
 * Without this match, any owner could relabel itself `retrospective` to claim that
 * exemption and slip a bare summary through — defeating the lossless-detail
 * guarantee the envelope exists to enforce. The owner_kind is authored by the
 * subagent; the dispatched `nodeOwner` is engine-controlled, so it is the
 * authority. Never throws (pure comparison) — same orchestrator-safety contract as
 * the sibling guards.
 */
export function guardEnvelopeOwnerMatch(
  env: { owner_kind: string },
  nodeOwner: string,
): ChildResultGuard {
  if (env.owner_kind !== nodeOwner) {
    return {
      contentful: false,
      failure_class: 'fixable',
      reason: `owner-return envelope owner_kind="${env.owner_kind}" does not match the dispatched node owner="${nodeOwner}" — the role (and its reachability exemption) cannot be self-relabeled`,
    };
  }
  return { contentful: true };
}

/**
 * Guard that an envelope's `artifact_location`, when present, resolves to a
 * NON-EMPTY artifact (a pointer to nothing is not evidence). Async (it reads the
 * file via the injected `readFile`) but NEVER throws — an unresolvable or empty
 * pointer is caught and returned as a non-contentful Result, never propagated.
 * No `artifact_location` ⇒ no-op pass (the read is never attempted).
 */
export async function guardEnvelopeArtifact(
  env: OwnerReturnEnvelope,
  readFile: (path: string) => Promise<string>,
): Promise<ChildResultGuard> {
  if (env.artifact_location === undefined) return { contentful: true };
  try {
    const content = await readFile(env.artifact_location);
    if (content.trim().length === 0) {
      return {
        contentful: false,
        failure_class: 'fixable',
        reason: `envelope artifact_location (${env.artifact_location}) resolves to an empty artifact — a pointer to nothing is not evidence`,
      };
    }
    return { contentful: true };
  } catch (err) {
    return {
      contentful: false,
      failure_class: 'fixable',
      reason: `envelope artifact_location (${env.artifact_location}) is unresolvable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export type FailureDecision = 'retry' | 'switch_approach' | 'escalate';

/**
 * Deterministic failure-decision policy (the *classification* is a judgment made
 * upstream; this maps a class + attempts + caps to an action). retry/switch are
 * automatic within caps; escalate/user-decision go to the user. Hitting a cap is
 * non-pass (≠ converged), surfaced via `cap_exceeded`.
 */
export function decideOnFailure(
  failureClass: FailureClass,
  attempts: AutopilotNode['attempts'],
  caps: Autopilot['caps'],
): { decision: FailureDecision; cap_exceeded: boolean } {
  switch (failureClass) {
    case 'fixable':
      return attempts.fix < caps.fix_per_node
        ? { decision: 'retry', cap_exceeded: false }
        : { decision: 'escalate', cap_exceeded: true };
    case 'wrong_approach':
      return attempts.switch < caps.switch_per_node
        ? { decision: 'switch_approach', cap_exceeded: false }
        : { decision: 'escalate', cap_exceeded: true };
    case 'blocked_external':
    case 'user_decision_needed':
      return { decision: 'escalate', cap_exceeded: false };
  }
}
