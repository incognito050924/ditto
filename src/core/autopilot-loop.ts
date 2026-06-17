import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { collectTidyDiffStat, writeTidyClassification } from '~/acg/tidy/classifier';
import { atomicWriteText, ensureDir, writeJson } from '~/core/fs';
import { type Diagnostic, getDiagnostics, resolveServer } from '~/core/lsp/client';
import { lspLanguageForPath } from '~/core/provision/lsp-detect';
import { type AutopilotNode, nodeProposal } from '~/schemas/autopilot';
import { evidenceRef, relativePath, verdict } from '~/schemas/common';
import { decisionConflict, decisionConflictCarrier } from '~/schemas/decision-conflict-carrier';
import { ActiveNodeLeaseStore } from './active-node-lease';
import { loadVariantCatalog, selectVariantCandidates } from './agent-variants';
import { forwardRound, planForwardReexpansion } from './autopilot-converge';
import {
  type DelegationPacket,
  type FailureClass,
  type FailureDecision,
  buildDelegationPacket,
  decideOnFailure,
  guardChildResult,
  guardMutatingEvidence,
  isMutatingOwner,
} from './autopilot-dispatch';
import { allNodesTerminal, mutationGate, rollbackOnRejection } from './autopilot-driver';
import {
  fileOverlapGate,
  nodeTransition,
  proposalsToNodes,
  selectReadyNodes,
  supersededByPromotion,
} from './autopilot-graph';
import { AutopilotStore } from './autopilot-store';
import { planTidyOnImplementPass } from './autopilot-tidy';
import { producePlanGate } from './coverage-manager';
import { CoverageStore } from './coverage-store';
import { localDir } from './ditto-paths';
import { decisionConflictRequiresApproval } from './gates';
import { IntentStore } from './intent-store';
import { warmStartMemoryContext } from './memory-warmstart';
import { computeSpecDigest } from './tech-spec';
import { WorkItemStore } from './work-item-store';

/**
 * Autopilot loop step glue (G9) — surfaces the deterministic per-round steps of
 * the orchestrator loop so the `autopilot` skill calls them through the CLI
 * instead of re-describing the logic in prose. `nextNode` = loop steps 1–5
 * (re-read → approval → select → dispatch → packet); `recordResult` = step 6
 * (collect → G7 guard → classify → decide → persist). The *judgment* (pass/fail,
 * fixable vs wrong_approach, when to escalate) stays with the caller and arrives
 * as the `recordResult` payload; this module only enforces the deterministic
 * floor (charter §3.1: judgment in the agent, state in the schema).
 *
 * A node mutates files only when its owner is the implementer; every other
 * SUBAGENT owner is read-only, so the approval gate blocks only a mutating node
 * (contract §5.3 — design/research may run before approval). One deliberate
 * exception sits outside this dichotomy: a `main-session` (e2e-author) node
 * writes journey/spec files inline in the main session — its user dialogue is
 * the approval, it is excluded from waves (single-node handling, no clobber),
 * and its changed_files arrive via record-result like a mutating node's
 * (dialectic-1 O-10). A rejected plan invalidates the whole graph and rolls
 * back in-flight work regardless of which node is next.
 */
function isMutatingNode(node: AutopilotNode): boolean {
  return isMutatingOwner(node.owner);
}

export type WaveSpawn = {
  node_id: string;
  owner: AutopilotNode['owner'];
  packet: DelegationPacket;
};

export type NextNodeResult =
  | { action: 'spawn'; node_id: string; owner: AutopilotNode['owner']; packet: DelegationPacket }
  // 2+ independent ready nodes (file-overlap-gate-admitted, non-driver, and
  // either non-mutating or already past the approval gate). The driver spawns
  // them in parallel. The single-ready path keeps the `spawn` shape unchanged.
  | { action: 'spawn_wave'; spawns: WaveSpawn[] }
  | { action: 'present_plan'; reason: string }
  | { action: 'rollback'; reason: string; rolled_back_node_ids: string[] }
  | { action: 'waiting'; reason: string }
  // A `driver`-owned node (cleanup): deterministic engine step, no LLM to spawn.
  // The caller runs `autopilot cleanup` to execute the gated teardown.
  | { action: 'cleanup'; node_id: string; reason: string }
  // A `main-session`-owned node (e2e-author): needs a user dialogue, so there is
  // no subagent to spawn. The driver runs the skill inline in the main session
  // and records the outcome via record-result as usual.
  | { action: 'main_session'; node_id: string; reason: string }
  // A blocked (escalated) node with nothing else runnable is a user-owned
  // decision, not a transient wait (§4.3). Surfaced distinctly so the driver
  // yields to the user instead of polling `waiting` forever.
  | { action: 'blocked'; reason: string; blocked_node_ids: string[] }
  // Graph terminal. `all_passed` is the completion *disposition*, not a verdict:
  // graph done ≠ acceptance closed (§6.8). Completion still judges each AC with
  // evidence; this only tells the driver completion is owed and whether it can
  // pass. It never auto-closes an AC.
  | { action: 'done'; reason: string; all_passed: boolean };

/** Non-null when intent.source_digest no longer matches the spec document (ac-6). */
async function specDigestStale(
  repoRoot: string,
  workItemId: string,
): Promise<Extract<NextNodeResult, { action: 'blocked' }> | null> {
  const intentStore = new IntentStore(repoRoot);
  if (!(await intentStore.exists(workItemId))) return null;
  const intent = await intentStore.get(workItemId);
  if (!intent.source_digest) return null; // interview-finalized intent — no spec doc to track
  const { doc_path, sha256 } = intent.source_digest;
  let doc: string | null;
  try {
    doc = await readFile(join(repoRoot, doc_path), 'utf8');
  } catch {
    doc = null;
  }
  if (doc !== null && computeSpecDigest(doc) === sha256) return null;
  return {
    action: 'blocked',
    blocked_node_ids: [],
    reason:
      doc === null
        ? `spec document ${doc_path} is missing but intent.json was compiled from it — restore the document or re-run \`ditto tech-spec finalize\` (ac-6)`
        : `spec document ${doc_path} changed after finalize (source_digest mismatch) — re-run \`ditto tech-spec finalize\` to re-compile intent.json before executing (ac-6)`,
  };
}

export async function nextNode(repoRoot: string, workItemId: string): Promise<NextNodeResult> {
  const aps = new AutopilotStore(repoRoot);
  const graph = await aps.get(workItemId);

  // A rejected plan invalidates everything: undo speculative (running) work and
  // stop. Idempotent — a second call finds no running nodes and rolls back none.
  // (Runs before the digest gate: rejection invalidates the graph regardless of
  // the spec document's state.)
  if (graph.approval_gate.status === 'rejected') {
    const rb = rollbackOnRejection(graph);
    const rolledBack = graph.nodes.filter((n) => n.status === 'running').map((n) => n.id);
    await aps.write(workItemId, { ...graph, nodes: rb.nodes });
    return { action: 'rollback', reason: rb.reason, rolled_back_node_ids: rolledBack };
  }

  // ac-6 digest freshness gate: an intent compiled from a spec document carries
  // source_digest. If a compile-input section changed after finalize (or the doc
  // is gone) the agreed source is stale — fail closed and require re-finalize
  // instead of executing against a contract the document no longer states.
  const staleSpec = await specDigestStale(repoRoot, workItemId);
  if (staleSpec) return staleSpec;

  // Select the next dispatchable node (first ready, after the file-overlap gate
  // serializes any same-scope wave). v0 runs one owner at a time.
  const ready = selectReadyNodes(graph.nodes);
  if (ready.length === 0) {
    // Terminal: every node passed/failed. Surface the completion disposition —
    // graph done is not acceptance closing (§6.8); completion judges with evidence.
    if (allNodesTerminal(graph)) {
      const all_passed = graph.nodes.every((n) => n.status === 'passed');
      return {
        action: 'done',
        all_passed,
        reason: all_passed
          ? 'all nodes passed — completion judgment owed: graph done ≠ acceptance criteria closed; run completion to close each AC with the collected evidence (§6.8)'
          : 'all nodes terminal but ≥1 node failed — completion will judge partial/fail; run completion judgment (§6.8)',
      };
    }
    // Not terminal and nothing ready: a running node is transient (still working);
    // a blocked node with nothing else runnable is an escalated, user-owned
    // decision (§4.3) — surface it distinctly with the decision-log reason.
    const running = graph.nodes.some((n) => n.status === 'running');
    if (!running) {
      const blocked = graph.nodes.filter((n) => n.status === 'blocked');
      if (blocked.length > 0) {
        const decisions = await aps.readDecisions(workItemId);
        const lastReason = (id: string): string | undefined =>
          decisions.filter((d) => d.node_id === id).at(-1)?.reason;
        const detail = blocked
          .map((n) => {
            const why = lastReason(n.id);
            return why ? `${n.id} — ${why}` : n.id;
          })
          .join('; ');
        return {
          action: 'blocked',
          blocked_node_ids: blocked.map((n) => n.id),
          reason: `blocked on a user-owned decision (§4.3): ${detail}`,
        };
      }
    }
    return {
      action: 'waiting',
      reason: 'no ready node: dependencies unmet or a node is still running',
    };
  }
  const workItem = await new WorkItemStore(repoRoot).get(workItemId);
  // Per-node file scope: each node uses its OWN `file_scope` when declared,
  // falling back to the shared work-item changed_files when absent (B2 ac-2).
  const scopeOf = (n: AutopilotNode): string[] => n.file_scope ?? workItem.changed_files;
  // Cross-call overlap guard (B2 ac-3): files claimed by a currently-RUNNING
  // mutating node are already taken. Seed the gate with those claims (as
  // synthetic, filtered-out wave entries that run first in admit order) so a
  // ready mutating node whose scope overlaps a running mutating node is NOT
  // dispatched — it serializes to a later next-node call.
  const runningClaims = graph.nodes
    .filter((n) => n.status === 'running' && isMutatingNode(n))
    .map((n) => ({ id: `__running__${n.id}`, file_scope: scopeOf(n) }));
  const { dispatch } = fileOverlapGate([
    ...runningClaims,
    ...ready.map((n) => ({ id: n.id, file_scope: scopeOf(n) })),
  ]);
  // The file-overlap-gate-admitted wave (nodes whose file_scope is mutually
  // disjoint), mapped back to graph nodes in admit order. Synthetic running
  // claims are dropped here — `ready.find` returns undefined for them.
  const admitted = dispatch
    .map((d) => ready.find((n) => n.id === d.id))
    .filter((n): n is AutopilotNode => n !== undefined);
  if (admitted.length === 0) {
    return { action: 'waiting', reason: 'all ready nodes deferred by the file-overlap gate' };
  }

  // A node may run in a *parallel* wave only if it neither needs special
  // single-node handling (the `driver` cleanup and `main-session` e2e-author
  // pseudo-owners, which have no LLM to spawn) nor is gated (a mutating node
  // still behind the approval gate). When in doubt, fall back to the
  // conservative single-node path.
  const gate = mutationGate(graph);
  const isWaveEligible = (n: AutopilotNode): boolean =>
    n.owner !== 'driver' && n.owner !== 'main-session' && (!isMutatingNode(n) || gate.allowed);
  // F1 conservative cap (the unknown-scope fallback): a mutating node WITHOUT a
  // declared `file_scope` falls back to the shared workItem.changed_files (often
  // empty at implement time), so the file-overlap gate can't actually keep two
  // such nodes off the same real files. To preserve the no-same-file-concurrency
  // invariant, the wave admits AT MOST ONE scope-unknown mutating node; further
  // ones stay pending for a later next-node call. A mutating node that DECLARES
  // its own file_scope is handled precisely by the file-overlap gate above (the
  // two layers compose — per-node scope is precise, the cap covers the unknown
  // case), so it is not subject to this cap.
  let unknownMutatingAdmitted = false;
  const waveEligible = admitted.filter((n) => {
    if (!isWaveEligible(n)) return false;
    if (!isMutatingNode(n)) return true;
    if (n.file_scope !== undefined) return true;
    if (unknownMutatingAdmitted) return false;
    unknownMutatingAdmitted = true;
    return true;
  });

  const leases = new ActiveNodeLeaseStore(repoRoot);
  const now = new Date();
  if (waveEligible.length >= 2) {
    const catalog = await loadVariantCatalog(repoRoot);
    const spawns: WaveSpawn[] = [];
    for (const node of waveEligible) {
      // Dispatch each admitted node: pending → running via the explicit
      // transition table, persisted — same as the single-node path.
      await aps.updateNode(workItemId, node.id, (n) => ({
        ...n,
        status: nodeTransition(n.status, 'dispatch'),
      }));
      // Active-node lease (wi_26060678y): a node is in flight while it runs; the
      // lease is the FLOW signal PreToolUse reads to allow only in-scope edits.
      await leases.set({
        node_id: node.id,
        work_item_id: workItemId,
        file_scope: scopeOf(node),
        scope_source: node.file_scope !== undefined ? 'declared' : 'derived',
        created_at: now.toISOString(),
      });
      const candidates = selectVariantCandidates(
        catalog,
        node.owner,
        scopeOf(node),
        node.agent_hint,
      );
      // Warm-start memory push (§5-1 / §10-6 #1): fail-open query in the loop, the
      // builder stays pure. researcher/planner only; undefined ⇒ packet unchanged.
      const memory = await warmStartMemoryContext(repoRoot, node, workItem, { now });
      spawns.push({
        node_id: node.id,
        owner: node.owner,
        packet: buildDelegationPacket(node, workItem, candidates, scopeOf(node), memory),
      });
    }
    return { action: 'spawn_wave', spawns };
  }

  // Single-node path (byte-for-byte unchanged): the first admitted node.
  const chosen = admitted[0];
  if (!chosen) {
    return { action: 'waiting', reason: 'all ready nodes deferred by the file-overlap gate' };
  }

  // A `driver`-owned node (cleanup, §2.2) is a deterministic engine step, not an
  // LLM owner: there is nothing to spawn. Dispatch it to running and signal the
  // caller to run `autopilot cleanup` (which clears the explicit irreversible-git
  // gate and tears down the run worktrees), keeping the no-LLM step off the spawn
  // path entirely.
  if (chosen.owner === 'driver') {
    await aps.updateNode(workItemId, chosen.id, (n) => ({
      ...n,
      status: nodeTransition(n.status, 'dispatch'),
    }));
    return {
      action: 'cleanup',
      node_id: chosen.id,
      reason: `deterministic cleanup step (${chosen.kind}): run \`autopilot cleanup\` (irreversible git → explicit approval)`,
    };
  }

  // A `main-session`-owned node (e2e-author) is run by the driver inline in the
  // main session — scenario authoring needs a user dialogue, so there is no
  // subagent to spawn (session rooting). Dispatch it to running and signal the
  // caller to execute the ditto:e2e-author skill, then record-result as usual.
  if (chosen.owner === 'main-session') {
    await aps.updateNode(workItemId, chosen.id, (n) => ({
      ...n,
      status: nodeTransition(n.status, 'dispatch'),
    }));
    return {
      action: 'main_session',
      node_id: chosen.id,
      reason: `main-session step (${chosen.kind}): run the ditto:e2e-author skill inline (user dialogue), then record-result`,
    };
  }

  // Approval gate applies only before a mutating node (contract §5.3). Reuses the
  // `gate` computed above for the wave-eligibility check (same `graph`).
  if (isMutatingNode(chosen) && !gate.allowed) {
    return { action: 'present_plan', reason: gate.reason };
  }

  // Dispatch: pending → running through the explicit transition table, persisted.
  await aps.updateNode(workItemId, chosen.id, (n) => ({
    ...n,
    status: nodeTransition(n.status, 'dispatch'),
  }));
  // Active-node lease (wi_26060678y): created at LLM-owner dispatch (the driver
  // cleanup pseudo-owner above is excluded — it is an in-process engine step, not
  // a spawned subagent that edits files). record-result removes it on terminal.
  await leases.set({
    node_id: chosen.id,
    work_item_id: workItemId,
    file_scope: scopeOf(chosen),
    scope_source: chosen.file_scope !== undefined ? 'declared' : 'derived',
    created_at: now.toISOString(),
  });
  // Variant routing (ac-3): filter specialized-subagent candidates by the chosen
  // owner (role) and file scope so the driver can pick a `subagent_type` instead
  // of the fixed owner. With no `.ditto/agents/` the catalog is empty, so
  // candidates is [] and behavior is unchanged (ac-4).
  const catalog = await loadVariantCatalog(repoRoot);
  const candidates = selectVariantCandidates(
    catalog,
    chosen.owner,
    scopeOf(chosen),
    chosen.agent_hint,
  );
  // Warm-start memory push (§5-1 / §10-6 #1): fail-open query in the loop, the
  // builder stays pure. researcher/planner only; undefined ⇒ packet unchanged.
  const memory = await warmStartMemoryContext(repoRoot, chosen, workItem, { now });
  return {
    action: 'spawn',
    node_id: chosen.id,
    owner: chosen.owner,
    packet: buildDelegationPacket(chosen, workItem, candidates, scopeOf(chosen), memory),
  };
}

export const recordResultPayload = z
  .object({
    node_id: z.string().min(1),
    result_text: z.string().describe("The owner subagent's full final text (fed to the G7 guard)"),
    outcome: z
      .enum(['pass', 'fail'])
      .describe('Caller judgment; pass is overridden if non-contentful'),
    failure_class: z
      .enum(['fixable', 'wrong_approach', 'blocked_external', 'user_decision_needed'])
      .optional()
      .describe('Required when outcome=fail; the caller-supplied classification'),
    evidence_refs: z.array(evidenceRef).optional().describe('Evidence pointers gathered on pass'),
    ac_verdicts: z
      .array(z.object({ criterion_id: z.string().min(1), verdict, notes: z.string().optional() }))
      .optional()
      .describe(
        "A judging node's per-AC verdicts (verifier/e2e). The node still records a single " +
          'pass/fail outcome, but a verify node can pass *as a node* while judging one criterion ' +
          'partial/fail; persisting the per-AC verdicts here keeps `autopilot complete` from ' +
          'over-closing that criterion to pass (false-green; claim ≠ proof).',
      ),
    changed_files: z
      .array(relativePath)
      .optional()
      .describe(
        'Repo-relative paths this node changed (#1). On a contentful pass they are unioned ' +
          'into the work item changed_files so `autopilot complete` reads them without a manual ' +
          'pin. The expected reporter is a mutating node (implementer/refactorer).',
      ),
    reason: z.string().optional().describe('2–3 line rationale recorded in the decision log'),
    generated_nodes: z
      .array(nodeProposal)
      .optional()
      .describe(
        'Subgraph this node generated (A-3). Promoted to the graph via addNodes on a ' +
          'contentful pass; a planner/design node uses this to grow the graph past the seed.',
      ),
    has_findings: z
      .boolean()
      .optional()
      .describe(
        'Reviewer/security verdict that findings remain (A-2). On a contentful review- or ' +
          'security-node pass, true splices a forward fix+re-check round (§2.4) under the ' +
          'convergence budget, false/absent closes the loop. Ignored for other node kinds.',
      ),
    tidy_bug_found: z
      .boolean()
      .optional()
      .describe(
        'Tidy failure policy (80-plan §8, WU-3 ac-4). On a `refactor` (tidy) node FAIL, ' +
          'true means the tidy pass uncovered a real defect in the implementation. The ' +
          'engine then returns the implement node the tidy stage roots on to pending — it ' +
          'does NOT fix the bug here and does NOT retry the tidy node in place (the fix ' +
          'belongs to the implement node). Ignored for non-refactor nodes / on pass.',
      ),
    // Pre-mortem coverage engine plan-stage output (§3.1/§7.2/§12). A design
    // (planner) node returns the brief it produced from the coverage sweep; on a
    // contentful design pass `producePlanGate` turns it into the approval_gate
    // patch (change_surface presence = brief regime ON; tier → status). Optional +
    // additive: absent ⇒ approval_gate is left untouched (backward compat — the
    // legacy seed path). Ignored for non-design nodes.
    plan_brief: z
      .object({
        change_surface: z.array(relativePath),
        interface_changes: z.array(z.string()).default([]),
        dod: z.array(z.string()).default([]),
        test_scenarios: z.array(z.string()).default([]),
        tier_inputs: z.object({
          changedFileCount: z.number().int().nonnegative(),
          interfaceChanged: z.boolean(),
          risk: z.object({
            non_local: z.boolean(),
            irreversible: z.boolean(),
            unaudited: z.boolean(),
          }),
          large: z.boolean(),
        }),
      })
      .optional()
      .describe(
        "A plan-stage (design/planner) node's pre-mortem coverage brief + tier inputs. On a " +
          'contentful design pass it populates approval_gate.{plan_brief,change_surface,status} ' +
          'via producePlanGate (brief hard-gate, §7.2). Ignored for non-design nodes.',
      ),
    decision_conflicts: z
      .array(decisionConflict)
      .optional()
      .describe(
        "The planner's declared ADR conflicts (ADR-0020 D3 producer). On a contentful design " +
          'pass a non-empty list is written to the decision-conflict carrier so an intent ' +
          'conflict front-loads the approval gate (prevention) and the Stop hook re-checks it ' +
          '(catch). Absent/empty ⇒ no carrier written (backward compat). Ignored for non-design.',
      ),
  })
  .superRefine((value, ctx) => {
    if (value.outcome === 'fail' && value.failure_class === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['failure_class'],
        message: 'failure_class is required when outcome=fail',
      });
    }
  })
  .describe('One node result — caller judgment that the deterministic floor then enforces');

export type RecordResultPayload = z.infer<typeof recordResultPayload>;

export interface RecordResultInput {
  workItemId: string;
  payload: RecordResultPayload;
  now?: Date;
}

export interface RecordResultOutcome {
  node_id: string;
  status: AutopilotNode['status'];
  outcome: 'pass' | 'fail';
  /** false when the G7 guard overrode a claimed pass (empty/ack-only result). */
  guard_contentful: boolean;
  decision: FailureDecision | null;
  failure_class: FailureClass | null;
  cap_exceeded: boolean;
  reason: string;
  /** Ids of nodes promoted from `generated_nodes` on this pass; [] otherwise (A-3). */
  promoted_node_ids: string[];
  /** Pending successors superseded by the promoted subgraph; [] otherwise (wi_260610iex). */
  superseded_node_ids: string[];
  /**
   * ADVISORY (ac-2): error-severity LSP diagnostics found on a contentful
   * mutating pass over `changed_files`, surfaced for the downstream verify node.
   * Non-blocking — never read by any gate / completion path; absent (undefined)
   * on every non-mutating / no-server / no-TS-file path (no-op SKIP).
   */
  lsp_advisory?: { file: string; diagnostics: Diagnostic[] }[];
}

/**
 * WU-3 ac-1 seam: on a green `implement` pass, classify the just-made diff and
 * (on ENTER) splice the tidy subgraph. Returns the promoted node ids ([] on SKIP).
 * Fail-open: any precondition gap (no base sha, not a git work tree, empty diff)
 * yields a SKIP classification — never a throw — so the absence of a base never
 * hard-blocks the loop (§4.4 / OBJ-02). The classifier verdict is always written.
 */
async function spliceTidyStage(
  repoRoot: string,
  workItemId: string,
  implementNode: AutopilotNode,
  aps: AutopilotStore,
): Promise<string[]> {
  const wi = await new WorkItemStore(repoRoot).get(workItemId);
  // The just-made diff is base…HEAD where base = the work item's started_at_sha.
  // Absent base ⇒ empty diff-stat ⇒ classifier SKIPs (collectTidyDiffStat returns
  // {files: []} when git fails, so no separate guard is needed here).
  const diffStat = wi.started_at_sha
    ? collectTidyDiffStat(repoRoot, wi.started_at_sha)
    : { files: [] };
  const graph = await aps.get(workItemId);
  const plan = planTidyOnImplementPass({
    implementNodeId: implementNode.id,
    diffStat,
    acceptanceIds: implementNode.acceptance_refs,
    existingNodeIds: graph.nodes.map((n) => n.id),
  });
  // Persist the SKIP/ENTER verdict as an artifact (G3 — 축소는 드러낸다).
  await writeTidyClassification(repoRoot, workItemId, plan.classification);
  if (plan.nodes.length === 0) return [];
  // Splice via addNodes (the integrity gate) — same path as planner promotion.
  await aps.addNodes(workItemId, plan.nodes);
  return plan.nodes.map((n) => n.id);
}

/** One file's error-severity diagnostics, surfaced for the advisory artifact. */
interface LspFileDiagnostics {
  file: string;
  diagnostics: Diagnostic[];
}

/**
 * Edit-then-diagnostics gate budget (review #1 — the gate must not stall the pass
 * path). The gate is ADVISORY, so a slow / non-responding server is bounded by a
 * short per-file timeout (vs the 8s client default — a responsive server answers
 * in <1s), and the files are checked in bounded-parallel batches so wall-clock is
 * ~ceil(n/CONCURRENCY)·timeout, not n·timeout serial. A file CAP bounds how many
 * servers a sweeping change spawns; the overflow is disclosed in the artifact
 * (`truncated`) — a silent cap would read as "checked everything".
 */
const GATE_TIMEOUT_MS = 3000;
const GATE_CONCURRENCY = 4;
const GATE_FILE_CAP = 24;

/**
 * ADVISORY edit-then-diagnostics gate (ac-2). On a contentful mutating pass, run
 * the n2 LSP client over the node's just-reported `changed_files` and SURFACE
 * error-severity diagnostics as feedback for the downstream verify node. Each
 * file is routed to its language by extension via the SHARED `lsp-detect`
 * taxonomy that `ditto setup` also uses — so the gate checks exactly the languages
 * setup can install servers for, in lock-step (no TS-only assumption).
 *
 * MONOTONIC — adds no completion-blocking. This is a pure SURFACE step on the
 * pass path, modelled on {@link spliceTidyStage}: it never alters the node's
 * pass/fail outcome, never certifies clean (the test run remains authoritative),
 * and is fail-open. No source file with a mapped language, or no installed server
 * for that language (`resolveServer` → null), ⇒ no-op SKIP (return []) — per-file
 * degrade (ADR-0018). `getDiagnostics` itself degrades to [] on
 * absence/spawn-failure/timeout and never throws, so the diagnostics loop needs
 * no guard; the artifact WRITE can throw on a broken FS, so it is wrapped to
 * degrade too — nothing in this gate may abort the pass it annotates. The
 * diagnostics are persisted as a NON-authoritative advisory artifact
 * (`lsp-diagnostics.json`) and returned for the outcome's advisory note — they
 * are never read by any gate / completion path (ac-3 keeps completion LSP-free).
 */
async function surfaceLspDiagnostics(
  repoRoot: string,
  workItemId: string,
  changedFiles: string[],
): Promise<LspFileDiagnostics[]> {
  // Route each changed file to its LSP language by extension (shared lsp-detect
  // taxonomy). Files with no mapped language (docs, configs) are dropped.
  const targets = changedFiles
    .map((file) => ({ file, language: lspLanguageForPath(file) }))
    .filter((t): t is { file: string; language: string } => t.language !== null);
  // Keep only files whose language server is actually installed; the rest are a
  // no-op SKIP (ADR-0018 per-file degrade, never a hard-block). resolveServer is
  // the dynamic source of truth (env → PATH → ditto-managed) — probe once per
  // language and memoize, so a sweeping change does not re-probe per file.
  const serverByLang = new Map<string, boolean>();
  const checkable = targets.filter(({ language }) => {
    let ok = serverByLang.get(language);
    if (ok === undefined) {
      ok = resolveServer(language) !== null;
      serverByLang.set(language, ok);
    }
    return ok;
  });
  if (checkable.length === 0) return [];

  // Bound the server-spawn count on a sweeping change; disclose the overflow below.
  const checked = checkable.slice(0, GATE_FILE_CAP);
  const truncated = checkable.length - checked.length;

  const surfaced: LspFileDiagnostics[] = [];
  // Bounded-parallel batches with a short per-file timeout: a slow server stalls
  // only its own batch, not the whole pass path (review #1 — latency).
  // NOTE: getDiagnostics resolves on the FIRST publishDiagnostics. typescript
  // emits one complete publish, but progressive-diagnostic servers (e.g.
  // rust-analyzer) may publish empty-then-populated → a possible false-clean for
  // those languages. Tolerated here: the gate is advisory/monotonic, so a missed
  // diagnostic never blocks; a settle window is deferred (would re-add latency).
  for (let i = 0; i < checked.length; i += GATE_CONCURRENCY) {
    const batch = await Promise.all(
      checked.slice(i, i + GATE_CONCURRENCY).map(async ({ file, language }) => {
        const diags = await getDiagnostics(join(repoRoot, file), {
          language,
          timeoutMs: GATE_TIMEOUT_MS,
        });
        const errors = diags.filter((d) => d.severity === 'error');
        return errors.length > 0 ? { file, diagnostics: errors } : null;
      }),
    );
    for (const r of batch) if (r) surfaced.push(r);
  }
  // Persist the advisory verdict as an artifact (mirrors writeTidyClassification —
  // G3: the surfaced findings are left as a non-authoritative record). Written
  // even when empty so the run shows the gate ran and found nothing. `checked` /
  // `truncated` disclose how many files the cap let through (G3 — no silent cap).
  // Best-effort: a broken local dir degrades the advisory RECORD, never the pass
  // it annotates (fail-open) — so the FS write is wrapped like getDiagnostics.
  try {
    await ensureDir(localDir(repoRoot, 'work-items', workItemId));
    await atomicWriteText(
      localDir(repoRoot, 'work-items', workItemId, 'lsp-diagnostics.json'),
      `${JSON.stringify(
        {
          schema_version: '0.1.0',
          advisory: true,
          checked: checked.length,
          truncated,
          files: surfaced,
        },
        null,
        2,
      )}\n`,
    );
  } catch {
    // advisory persistence is non-authoritative — swallow and keep the pass path
  }
  return surfaced;
}

/**
 * Read the decision-conflict carrier (ADR-0020) and decide whether a declared
 * intent conflict must front-load the approval gate (D3 prevention layer) — so a
 * `light`/auto-waivable plan cannot run mutating nodes while the request
 * contradicts a recorded decision the user has not resolved. Absent/malformed
 * carrier → false: the deterministic Stop-hook catch (`decisionConflictForcesContinuation`)
 * still fail-closes at the boundary, so this layer fails open by design.
 */
async function planRequiresDecisionApproval(
  repoRoot: string,
  workItemId: string,
): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(
      localDir(repoRoot, 'work-items', workItemId, 'decision-conflict.json'),
      'utf8',
    );
  } catch {
    return false;
  }
  try {
    const parsed = decisionConflictCarrier.safeParse(JSON.parse(text));
    return parsed.success && decisionConflictRequiresApproval(parsed.data.conflicts);
  } catch {
    return false;
  }
}

export async function recordResult(
  repoRoot: string,
  input: RecordResultInput,
): Promise<RecordResultOutcome> {
  const aps = new AutopilotStore(repoRoot);
  const graph = await aps.get(input.workItemId);
  // Frozen intent AC id set — passed to addNodes so a planner-generated node that
  // invents an acceptance_ref not in the intent is rejected at introduction time
  // (fail-fast scope-grow guard, dialectic P2), not only at Stop. Best-effort: a
  // work item with no intent.json (legacy / non-finalize path) yields undefined,
  // which addNodes treats as "no check" — preserving prior behavior.
  const intents = new IntentStore(repoRoot);
  const allowedAcceptanceIds = (await intents.exists(input.workItemId))
    ? new Set((await intents.get(input.workItemId)).acceptance_criteria.map((c) => c.id))
    : undefined;
  const node = graph.nodes.find((n) => n.id === input.payload.node_id);
  if (!node) {
    throw new Error(
      `node ${input.payload.node_id} not found in autopilot graph for ${input.workItemId}`,
    );
  }
  if (node.status !== 'running') {
    throw new Error(
      `node ${node.id} is not running (status=${node.status}); call next-node first to dispatch it`,
    );
  }

  // Active-node lease release (wi_26060678y): every recordResult exit path moves
  // the node OUT of `running` (pass→passed, block→blocked, fail→failed,
  // retry→pending — see autopilot-graph transition table), so the in-flight lease
  // is always released here. A retry re-creates a fresh lease at re-dispatch. This
  // single removal guarantees the active-lease count returns to 0 on any exit,
  // with no leak on the findings-expand / escalate / pass / fail branches below.
  await new ActiveNodeLeaseStore(repoRoot).removeByNode(input.workItemId, node.id);

  // G7 floor: a completion *signal* is not completion *proof*. An empty or
  // ack-only result is non-contentful and is forced to a fixable failure even if
  // the caller claimed pass — acknowledgement is not evidence.
  const guard = guardChildResult(input.payload.result_text);
  let contentful = guard.contentful;

  // Effective outcome/class after the guard override.
  let outcome: 'pass' | 'fail' = input.payload.outcome;
  let failureClass: FailureClass | undefined = input.payload.failure_class;
  let guardReason = input.payload.reason ?? '';
  if (!guard.contentful) {
    outcome = 'fail';
    failureClass = 'fixable';
    guardReason = guard.reason;
  }
  // G7 확장 (wi_260606h9q): mutating 노드는 pass 주장 시 changed_files 증거가 필수.
  // 변경 0인 pass 는 fixable 로 강등 — spawn 없이 지어낸 빈 결과를 차단(claim ≠ proof).
  if (contentful && outcome === 'pass') {
    const mut = guardMutatingEvidence(
      node.owner,
      input.payload.outcome,
      input.payload.changed_files ?? [],
    );
    if (!mut.contentful) {
      contentful = false;
      outcome = 'fail';
      failureClass = 'fixable';
      guardReason = mut.reason;
    }
  }
  // Plan-stage coverage precondition (premortem-coverage §9, ac-3). A `design`
  // (planner) pass that carries a plan_brief is closing the plan stage — that is
  // only legitimate AFTER a real pre-mortem coverage sweep ran (coverage.json on
  // disk). If the sidecar is absent the brief was produced without the 6-axis
  // sweep + loop-until-dry, so force the pass to a fixable failure (same mechanism
  // as guardMutatingEvidence). Non-design / no-brief paths are untouched (backward
  // compat — the legacy seed plan stage).
  if (
    contentful &&
    outcome === 'pass' &&
    node.kind === 'design' &&
    input.payload.plan_brief !== undefined
  ) {
    const coverageRan = await new CoverageStore(repoRoot).exists(input.workItemId);
    if (!coverageRan) {
      contentful = false;
      outcome = 'fail';
      failureClass = 'fixable';
      guardReason =
        'design pass carried plan_brief but no coverage.json exists — run the pre-mortem coverage sweep (coverage-next → coverage-round until dry) before closing the plan stage (claim ≠ proof)';
    }
  }

  if (outcome === 'pass') {
    // ADR-0020 D3 producer (wi_260616eu8): on a contentful `design` pass the
    // planner declares any ADR conflicts it detected; persist them as the carrier
    // BEFORE the plan-gate consults it (planRequiresDecisionApproval, below), so an
    // intent conflict front-loads the approval gate in this SAME call (prevention)
    // and the Stop hook re-checks the same file (catch). Written regardless of
    // plan_brief; empty/absent ⇒ no carrier (backward compat — legacy design pass).
    if (
      node.kind === 'design' &&
      input.payload.decision_conflicts !== undefined &&
      input.payload.decision_conflicts.length > 0
    ) {
      await ensureDir(localDir(repoRoot, 'work-items', input.workItemId));
      await writeJson(
        localDir(repoRoot, 'work-items', input.workItemId, 'decision-conflict.json'),
        decisionConflictCarrier,
        {
          schema_version: '0.1.0',
          mode: 'autopilot',
          conflicts: input.payload.decision_conflicts,
        },
      );
    }
    // Forward re-expansion (A-2 · §2.4): a contentful findings-bearing node that
    // still has findings does NOT close the loop — it splices a fix+re-check round
    // *forward* (a new pair of nodes, not a back-edge, governed by the convergence
    // budget §4.3). This is the node-*between* loop, kept distinct from
    // generated_nodes (free-form planner growth) and attempts (node-internal
    // retry). Both `review` and `security` opt in — each produces a findings list
    // that needs fix-then-recheck; the splice keeps the originating kind so a
    // security finding is re-verified by security, not a generic review.
    if (
      (node.kind === 'review' || node.kind === 'security') &&
      input.payload.has_findings === true
    ) {
      const plan = planForwardReexpansion({
        reviewNode: node,
        hasFindings: true,
        round: forwardRound(node.id),
        budget: graph.caps.converge_rounds,
      });
      if (plan.decision === 'expand') {
        // Splice the fix+review pair before marking the review passed, mirroring
        // A-3: a rejected splice (addNodes throws) leaves the node still running.
        await aps.addNodes(input.workItemId, plan.nodes, allowedAcceptanceIds);
        await aps.updateNode(input.workItemId, node.id, (n) => ({
          ...n,
          status: nodeTransition(n.status, 'pass'),
          evidence_refs: input.payload.evidence_refs ?? n.evidence_refs,
        }));
        return {
          node_id: node.id,
          status: 'passed',
          outcome: 'pass',
          guard_contentful: true,
          decision: null,
          failure_class: null,
          cap_exceeded: false,
          reason: guardReason,
          promoted_node_ids: plan.nodes.map((n) => n.id),
          superseded_node_ids: [],
        };
      }
      // escalate: convergence budget exhausted with findings still open. STOP
      // without closing — block the node and log user_decision_needed
      // (cap-reached ≠ converged; never a pass, §4.3). hasFindings=true rules out
      // `close`, so this branch is the escalate case.
      const reason = plan.decision === 'escalate' ? plan.reason : guardReason;
      await aps.updateNode(input.workItemId, node.id, (n) => ({
        ...n,
        status: nodeTransition(n.status, 'block'),
      }));
      await aps.appendDecision(input.workItemId, {
        ts: (input.now ?? new Date()).toISOString(),
        node_id: node.id,
        failure_class: 'user_decision_needed',
        decision: 'escalate',
        reason,
        attempts: node.attempts,
      });
      return {
        node_id: node.id,
        status: 'blocked',
        outcome: 'fail',
        guard_contentful: true,
        decision: 'escalate',
        failure_class: 'user_decision_needed',
        cap_exceeded: true,
        reason,
        promoted_node_ids: [],
        superseded_node_ids: [],
      };
    }

    // Node promotion (A-3): a contentful pass may carry the subgraph this node
    // generated. Splice it *before* marking pass so a rejected splice (cycle /
    // dup / dangling — addNodes throws) leaves the node still running and
    // re-recordable, rather than passed-with-no-graph-growth. validateNodeAddition
    // is status-agnostic, so depending on the still-running node id is valid.
    const proposals = input.payload.generated_nodes ?? [];
    let promotedNodeIds: string[] = [];
    let supersededNodeIds: string[] = [];
    if (proposals.length > 0) {
      const promoted = proposalsToNodes(proposals);
      await aps.addNodes(input.workItemId, promoted, allowedAcceptanceIds);
      promotedNodeIds = promoted.map((n) => n.id);
      // Seed supersession (wi_260610iex): the promoted subgraph refines the work
      // of still-pending successors it fully covers (the seed N2/N3 overlap) —
      // remove them under the conservative closure so the graph carries one
      // owner per responsibility instead of a redundant parallel chain.
      const grown = await aps.get(input.workItemId);
      supersededNodeIds = supersededByPromotion(grown.nodes, node.id, promoted);
      if (supersededNodeIds.length > 0) {
        await aps.removeNodes(input.workItemId, supersededNodeIds);
      }
    }
    // Plan-stage coverage wiring (premortem-coverage §3.1/§7.2/§12 — the
    // design→review seam). A contentful `design` (planner) pass that ran the
    // pre-mortem coverage sweep carries the brief it produced. The deterministic
    // Manager (`producePlanGate`) turns the brief + tier inputs into the
    // approval_gate patch: change_surface PRESENCE turns the brief hard-gate ON
    // (mutationGate, §7.2) and the tier sets the status (light auto-waives,
    // standard/full → pending for user approval). This is the engine replacing the
    // legacy seed plan stage — it runs on the SAME design pass that promotes
    // generated_nodes and supersedes the seed N2/N3 (above). Absent plan_brief
    // (legacy path / non-design node) ⇒ approval_gate untouched (backward compat).
    if (node.kind === 'design' && input.payload.plan_brief !== undefined) {
      const pb = input.payload.plan_brief;
      // ADR-0020 D3: an intent-level ADR conflict declared by the planner
      // front-loads the approval gate, so mutating nodes do not run before the
      // user resolves it — the prevention layer paired with the Stop-hook catch.
      const requireApproval = await planRequiresDecisionApproval(repoRoot, input.workItemId);
      const patch = producePlanGate({
        changeSurface: pb.change_surface,
        brief: {
          interface_changes: pb.interface_changes,
          dod: pb.dod,
          test_scenarios: pb.test_scenarios,
        },
        tierInputs: pb.tier_inputs,
        requireApproval,
      });
      const current = await aps.get(input.workItemId);
      await aps.write(input.workItemId, {
        ...current,
        approval_gate: {
          ...current.approval_gate,
          status: patch.status,
          change_surface: patch.change_surface,
          plan_brief: patch.plan_brief,
        },
      });
    }
    await aps.updateNode(input.workItemId, node.id, (n) => ({
      ...n,
      status: nodeTransition(n.status, 'pass'),
      evidence_refs: input.payload.evidence_refs ?? n.evidence_refs,
      // Persist a judging node's per-AC verdicts so the completion bridge consumes
      // them directly (a node-level pass cannot absorb a per-AC partial/fail).
      ac_verdicts: input.payload.ac_verdicts ?? n.ac_verdicts,
    }));
    // changed_files accumulation (#1): a mutating node reports the files it
    // changed; union them into the work item so `autopilot complete` reads
    // changed_files from the graph run instead of a manual pin. Union is
    // pass-only (a failed attempt's partial edits are reported on the eventual
    // pass) and dedup-preserves existing order.
    const reported = input.payload.changed_files ?? [];
    if (reported.length > 0) {
      await new WorkItemStore(repoRoot).update(input.workItemId, (w) => {
        const existing = new Set(w.changed_files);
        const additions = reported.filter((p) => !existing.has(p));
        return additions.length > 0
          ? { ...w, changed_files: [...w.changed_files, ...additions] }
          : w;
      });
    }
    // Edit-then-diagnostics ADVISORY gate (ac-2): on a contentful mutating pass,
    // surface LSP error diagnostics over the just-reported changed_files BEFORE
    // the downstream verify node — same pass-path seam as spliceTidyStage. Fail-
    // open & MONOTONIC: it never touches `outcome`/the pass return below, only
    // attaches a non-blocking advisory note (no server / no TS file ⇒ no-op SKIP).
    let lspAdvisory: { file: string; diagnostics: Diagnostic[] }[] | undefined;
    if (isMutatingNode(node) && reported.length > 0) {
      const surfaced = await surfaceLspDiagnostics(repoRoot, input.workItemId, reported);
      if (surfaced.length > 0) lspAdvisory = surfaced;
    }
    // Tidy stage wiring (80-plan §8/§10, WU-3 ac-1): a green `implement` pass
    // triggers the ⓪ classifier on the just-made diff (base = work item
    // started_at_sha … HEAD). On ENTER the ④/⑦ tidy subgraph is spliced through
    // the SAME addNodes path as planner generated_nodes. Fail-open by design — no
    // base ref / not a git work tree ⇒ empty diff-stat ⇒ SKIP, never a throw
    // (provider/precondition absence degrades, never hard-blocks: §4.4 / OBJ-02).
    // The classifier verdict is persisted as an artifact regardless (G3).
    if (node.kind === 'implement') {
      const tidyPromoted = await spliceTidyStage(repoRoot, input.workItemId, node, aps);
      promotedNodeIds = [...promotedNodeIds, ...tidyPromoted];
    }
    return {
      node_id: node.id,
      status: 'passed',
      outcome: 'pass',
      guard_contentful: true,
      decision: null,
      failure_class: null,
      cap_exceeded: false,
      reason: guardReason,
      promoted_node_ids: promotedNodeIds,
      superseded_node_ids: supersededNodeIds,
      // Advisory only — surfaced for the downstream verify node; never affects the
      // pass/fail outcome above or any completion gate (ac-2 monotonic, ac-3).
      ...(lspAdvisory ? { lsp_advisory: lspAdvisory } : {}),
    };
  }

  // Tidy bug-found policy (80-plan §8, WU-3 ac-4). A `refactor` (tidy) node that
  // FAILS because it uncovered a real defect in the implementation does NOT get
  // fixed or retried in place — the fix belongs to the implement node. Return the
  // implement node the tidy stage roots on to pending (so it, and a fresh tidy
  // stage, re-runs) and mark the tidy node failed (terminal, no retry/attempt
  // increment). This runs BEFORE the generic decision policy so a tidy bug never
  // burns the tidy node's retry budget. Guarded to a contentful refactor fail with
  // the explicit signal; otherwise the normal policy below applies.
  if (contentful && node.kind === 'refactor' && input.payload.tidy_bug_found === true) {
    const implementDep = graph.nodes.find(
      (n) => node.depends_on.includes(n.id) && n.kind === 'implement',
    );
    const reason =
      implementDep !== undefined
        ? `tidy found a bug — returning implement node ${implementDep.id} to pending (not fixing here, not retrying the tidy node in place) (ac-4)`
        : 'tidy found a bug but no implement node found in depends_on — tidy node failed without reopening (ac-4)';
    // Tidy node → failed (terminal): do NOT retry it in place.
    await aps.updateNode(input.workItemId, node.id, (n) => ({
      ...n,
      status: nodeTransition(n.status, 'fail'),
    }));
    if (implementDep !== undefined) {
      // Implement node passed → pending via the explicit `reopen` transition.
      await aps.updateNode(input.workItemId, implementDep.id, (n) => ({
        ...n,
        status: nodeTransition(n.status, 'reopen'),
      }));
    }
    await aps.appendDecision(input.workItemId, {
      ts: (input.now ?? new Date()).toISOString(),
      node_id: node.id,
      failure_class: 'fixable',
      decision: 'escalate',
      reason,
      attempts: node.attempts,
    });
    return {
      node_id: node.id,
      status: 'failed',
      outcome: 'fail',
      guard_contentful: contentful,
      decision: 'escalate',
      failure_class: 'fixable',
      cap_exceeded: false,
      reason,
      promoted_node_ids: [],
      superseded_node_ids: [],
    };
  }

  // outcome === 'fail': map the (caller-supplied or guard-forced) class through
  // the deterministic decision policy.
  const klass = failureClass as FailureClass;
  // attempts are incremented for the consumed retry/switch before evaluating the
  // cap so the log reflects the attempt just spent.
  const { decision, cap_exceeded } = decideOnFailure(klass, node.attempts, graph.caps);

  let event: 'retry' | 'block' | 'fail';
  let attempts = node.attempts;
  switch (decision) {
    case 'retry':
      event = 'retry';
      attempts = { ...node.attempts, fix: node.attempts.fix + 1 };
      break;
    case 'switch_approach':
      event = 'retry';
      attempts = { ...node.attempts, switch: node.attempts.switch + 1 };
      break;
    default: // escalate
      event = cap_exceeded ? 'fail' : 'block';
      break;
  }

  const nextStatus = nodeTransition(node.status, event);
  await aps.updateNode(input.workItemId, node.id, (n) => ({
    ...n,
    status: nodeTransition(n.status, event),
    attempts,
  }));
  await aps.appendDecision(input.workItemId, {
    ts: (input.now ?? new Date()).toISOString(),
    node_id: node.id,
    failure_class: klass,
    decision,
    reason: guardReason || `${klass} → ${decision}`,
    attempts,
  });

  return {
    node_id: node.id,
    status: nextStatus,
    outcome: 'fail',
    guard_contentful: contentful,
    decision,
    failure_class: klass,
    cap_exceeded,
    reason: guardReason,
    promoted_node_ids: [],
    superseded_node_ids: [],
  };
}
