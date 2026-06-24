import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { collectTidyDiffStat, writeTidyClassification } from '~/acg/tidy/classifier';
import { atomicWriteText, ensureDir, writeJson } from '~/core/fs';
import { type Diagnostic, getDiagnostics, resolveServer } from '~/core/lsp/client';
import { lspLanguageForPath } from '~/core/provision/lsp-detect';
import { type Autopilot, type AutopilotNode, nodeProposal } from '~/schemas/autopilot';
import { evidenceRef, relativePath, verdict } from '~/schemas/common';
import { isFarFieldEscape } from '~/schemas/coverage';
import { decisionConflict, decisionConflictCarrier } from '~/schemas/decision-conflict-carrier';
import { type AcOracle, acOracle } from '~/schemas/work-item';
import { ActiveNodeLeaseStore } from './active-node-lease';
import { loadVariantCatalog, selectVariantCandidates } from './agent-variants';
import { assembleCompletionFromGraph } from './autopilot-complete';
import { forwardRound, planForwardReexpansion, totalForwardRounds } from './autopilot-converge';
import {
  type DelegationPacket,
  type FailureClass,
  type FailureDecision,
  type RetroContext,
  buildDelegationPacket,
  decideOnFailure,
  guardAcClosingEvidence,
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
import { countUnitOnlyClosures, isClosed } from './completion-coverage-doctor';
import { CompletionStore } from './completion-store';
import { CoverageFeedbackLedger } from './coverage-feedback';
import { assertOracleFrozen, producePlanGate, validateAcOracle } from './coverage-manager';
import { CoverageStore } from './coverage-store';
import { localDir } from './ditto-paths';
import { decisionConflictRequiresApproval, oracleSatisfaction } from './gates';
import { HandoffStore } from './handoff-store';
import { IntentStore } from './intent-store';
import { MemoryEventStore } from './memory-store';
import { warmStartMemoryContext } from './memory-warmstart';
import {
  type RetroMetricInputs,
  type RetroNarrativeRecords,
  absorbRetroMemory,
  assembleRetroMetrics,
  projectRetroNarrative,
} from './retro-measure';
import { RetroMetricLedger } from './retro-metric-ledger';
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
  // pass. It never auto-closes an AC. `disposition` (ADR-0024 Decision 6,
  // mechanism 1) refines an all-passed done: `converged` = the loop closed on
  // oracle satisfaction; `capped` = a loop-level iteration cap was hit during the
  // run (capped ≠ converged), so the close is not a genuine convergence. Absent
  // (`null`) when not all passed (the run is partial/failed, not a fixpoint at all).
  | {
      action: 'done';
      reason: string;
      all_passed: boolean;
      disposition: 'converged' | 'capped' | null;
    };

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

/**
 * Assemble the retro presentation context (ADR-0024 Decision 4, ac-4 & ac-5 live
 * wiring) for a `retro` node's packet. The retro node PRESENTS what this assembles;
 * it never invents the metrics or the narrative. PURE-of-judgment, fail-open: every
 * grounding read is best-effort and a missing artifact yields an UNGROUNDED slot
 * (null → the assembler OMITS it, never zeroes it — anti-SLOP), so the absence of a
 * sidecar degrades the slot, never the dispatch (§4.4 / ADR-0018). Two SEPARATED
 * metrics are kept apart by `assembleRetroMetrics`; the narrative is a copy-only
 * projection of records the run already wrote.
 *
 * Groundings (each omitted when its source is absent):
 *   ① outcome_floor.coverage  ← completion.json (evidence-CLOSED acceptance / total,
 *      the SAME `isClosed` rule `ditto doctor completion-coverage` uses — pass with
 *      no evidence is a claim, not a close).
 *   ① outcome_floor.unit_only_closures ← the `isUnitOnlyClosure` aggregate over the
 *      SAME completion.json (count of falsely-green closures: pass closed on
 *      command-only evidence with no runtime/artifact). Grounded whenever completion
 *      exists (a real 0 is a measurement); omitted when completion is absent.
 *   ① outcome_floor.escape_recurrence ← the cross-WI coverage-feedback ledger rows
 *      for THIS work item, counting only FAR-FIELD escapes (depth/breadth; residual
 *      rows are excluded by `isFarFieldEscape`, matching the far-field cost stats).
 *   ② process_health.post_cost ← the SAME formula `ditto doctor intent-quality`
 *      uses (drift events + rework attempts + retry/switch decisions + handoff
 *      rounds), derived from the graph + decisions + metrics + handoffs this loop
 *      already reads. Always grounded once a graph exists (a real 0 is a measurement).
 */
async function collectRetroContext(
  repoRoot: string,
  workItemId: string,
  graph: Autopilot,
): Promise<RetroContext> {
  // ① coverage + unit_only_closures — from completion.json when present. Both stay
  // ungrounded (null → omitted) when completion is absent (anti-SLOP, never zeroed).
  let coverage: number | null = null;
  let unitOnlyClosures: number | null = null;
  const unverifiedItems: string[] = [];
  const residualRisks: string[] = [];
  const evidenceRefs: string[] = [];
  try {
    const completion = new CompletionStore(repoRoot);
    const persisted = (await completion.exists(workItemId))
      ? await completion.get(workItemId)
      : null;
    // The contract the outcome floor measures: the PERSISTED completion when
    // `autopilot complete` already wrote it, else one assembled in-memory from the
    // SAME (graph, workItem) the complete path uses — because the standard flow runs
    // the retro node BEFORE `autopilot complete` writes completion.json, so coverage +
    // unit_only would otherwise be omitted in every normal run (ADR-0024 Decision 4
    // gap). Assembling is PURE — it never writes completion.json (CompletionStore.write
    // is the only writer), so it cannot race the later real complete; the still-running
    // retro node carries no acceptance_refs, so it does not affect either metric.
    // Grounded only when the graph holds AC-addressing work (some non-retro node has
    // acceptance_refs); a graph with none has no closing signal, so the slots stay
    // ungrounded (omitted) — anti-SLOP, a real 0 is a measurement but a no-op graph is
    // not. The two metrics align with their escape_recurrence/post_cost siblings, which
    // already compute from live state rather than waiting for completion.json.
    const hasAcWork = graph.nodes.some((n) => n.kind !== 'retro' && n.acceptance_refs.length > 0);
    const floorSource =
      persisted ??
      (hasAcWork
        ? assembleCompletionFromGraph(graph, await new WorkItemStore(repoRoot).get(workItemId))
        : null);
    if (floorSource) {
      const total = floorSource.acceptance.length;
      if (total > 0) {
        // evidence-CLOSED / total — the SAME `isClosed` rule `ditto doctor
        // completion-coverage` uses (verdict=pass AND ≥1 evidence ref), NOT a bare
        // pass-ratio. A pass with no evidence is a claim, not proof, so it does not
        // count (ADR-0024 결정4 anti-SLOP; claim ≠ proof). On the graph path a pass
        // always carries evidence (deriveAcVerdicts is evidence-gated), so this only
        // changes the PERSISTED-completion path — where an external pass-without-
        // evidence could otherwise inflate the floor away from the doctor's value.
        coverage = floorSource.acceptance.filter(isClosed).length / total;
      }
      // ① unit_only_closures — count of falsely-green closures (pass closed on
      // command-only evidence, no runtime/artifact). The count uses the SAME
      // isUnitOnlyClosure probe the completion-coverage doctor uses, so the two never
      // drift.
      unitOnlyClosures = countUnitOnlyClosures(floorSource);
    }
    // Narrative records come ONLY from a PERSISTED completion: the in-memory assembled
    // contract's remaining_risks would name the still-running retro node, and the
    // narrative is out of this metrics-grounding fix's scope (absent completion ⇒ these
    // stay empty, as before).
    if (persisted) {
      for (const u of persisted.unverified) unverifiedItems.push(u.item);
      for (const r of persisted.remaining_risks) residualRisks.push(r);
      for (const a of persisted.acceptance)
        for (const e of a.evidence) evidenceRefs.push(`${e.kind}: ${e.path}`);
    }
  } catch {
    // completion absent/unreadable ⇒ coverage + unit_only_closures stay ungrounded
    // (omitted), no throw.
  }

  // ① escape_recurrence — far-field escape rows for THIS work item in the cross-WI
  // ledger (residual rows excluded). Ungrounded (null) when the ledger has no row
  // for this work item, so the slot is omitted rather than asserting "zero escapes".
  let escapeRecurrence: number | null = null;
  try {
    const rows = (await new CoverageFeedbackLedger(repoRoot).readAll()).filter(
      (r) => r.work_item_id === workItemId,
    );
    if (rows.length > 0) {
      escapeRecurrence = rows.filter((r) => isFarFieldEscape(r.fault_kind)).length;
    }
  } catch {
    // ledger absent/corrupt ⇒ escape_recurrence stays ungrounded (omitted).
  }

  // close_reason narrative rows from the coverage map (skip/deferral justifications).
  const closeReasons: string[] = [];
  try {
    const cov = new CoverageStore(repoRoot);
    if (await cov.exists(workItemId)) {
      for (const n of (await cov.getMap(workItemId)).nodes)
        if (n.close_reason) closeReasons.push(n.close_reason);
    }
  } catch {
    // coverage map absent ⇒ no close_reason rows.
  }

  // intent-drift narrative rows from the persisted metrics ledger.
  const intentDrift: string[] = [];
  try {
    for (const m of await new WorkItemStore(repoRoot).readMetrics(workItemId))
      for (const reason of m.blocking_reasons) intentDrift.push(reason);
  } catch {
    // metrics absent ⇒ no drift rows.
  }

  // ② post_cost — the doctor's formula, from the data the loop already reads. The
  // graph is in hand (passed in); decisions/metrics/handoffs are best-effort 0.
  const reworkAttempts = graph.nodes.reduce((sum, n) => sum + (n.attempts?.fix ?? 0), 0);
  let retrySwitch = 0;
  let driftEvents = 0;
  let handoffRounds = 0;
  try {
    const decisions = await new AutopilotStore(repoRoot).readDecisions(workItemId);
    retrySwitch = decisions.filter(
      (d) => d.decision === 'retry' || d.decision === 'switch_approach',
    ).length;
  } catch {
    /* decisions absent ⇒ 0 */
  }
  try {
    driftEvents = (await new WorkItemStore(repoRoot).readMetrics(workItemId)).length;
  } catch {
    /* metrics absent ⇒ 0 */
  }
  try {
    handoffRounds = (await new HandoffStore(repoRoot).listActive()).filter(
      (h) => h.handoff.work_item_id === workItemId,
    ).length;
  } catch {
    /* handoffs absent ⇒ 0 */
  }
  const postCost = driftEvents + reworkAttempts + retrySwitch + handoffRounds;

  const inputs: RetroMetricInputs = {
    coverage,
    unit_only_closures: unitOnlyClosures,
    escape_recurrence: escapeRecurrence,
    post_cost: postCost,
  };
  const records: RetroNarrativeRecords = {
    work_item_id: workItemId,
    unverified: unverifiedItems,
    residual_risks: residualRisks,
    close_reasons: closeReasons,
    intent_drift: intentDrift,
    evidence_refs: evidenceRefs,
    // Process-health context kept next to the narrative for the live retro view but
    // FILTERED OUT of durable cross-WI absorption (post_cost noise must not pollute
    // the warm-start prior).
    process_health_note: `post_cost churn: ${postCost}`,
  };
  return {
    metrics: assembleRetroMetrics(inputs),
    narrative: projectRetroNarrative(records),
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
      // ADR-0024 Decision 4 (ac-3): a `retro` node is NON-BLOCKING — its failed/
      // blocked status must NOT flip all_passed to false (which would degrade the
      // work-item to partial/fail at completion). Exclude `retro` from the gate the
      // same way allNodesTerminal does; every other node still counts as before.
      const all_passed = graph.nodes.every((n) => n.kind === 'retro' || n.status === 'passed');
      // ADR-0024 Decision 6 (mechanism 1) — converged vs capped disposition. Only
      // meaningful on an all-passed done (else the run is partial/failed, not a
      // fixpoint): `capped` when a loop-level iteration cap was hit during the run
      // (recorded in the append-only decision log), else `converged`. Graph/log-
      // derived, never a stored flag — the deterministic floor reads the recorded
      // escalations. capped ≠ converged (ADR-0024:38): a cap-forced close is not a
      // genuine oracle convergence, so completion is told to treat it as such.
      const decisions = await aps.readDecisions(workItemId);
      let disposition: 'converged' | 'capped' | null = null;
      if (all_passed) {
        const loopCapped = decisions.some((d) =>
          d.reason.includes('loop-level iteration cap reached'),
        );
        disposition = loopCapped ? 'capped' : 'converged';
      }
      const reason = all_passed
        ? 'all nodes passed — completion judgment owed: graph done ≠ acceptance criteria closed; run completion to close each AC with the collected evidence (§6.8)'
        : 'all nodes terminal but ≥1 node failed — completion will judge partial/fail; run completion judgment (§6.8)';
      // ADR-0024 Decision 7 (ac-6): the loop termination is an EXPLICIT recorded
      // decision, not a silent return value (charter §4-10). Record the SAME
      // disposition through the convergence vocabulary in the append-only decision
      // log — the one SoT (`capped` is already derived from this very log, so the
      // record and the derivation cannot drift). A partial/failed close (all_passed
      // false) is NOT a fixpoint, so the returned `disposition` stays null, but the
      // loop still terminated — recorded as `blocked` (the convergence term for
      // "closed without convergence"), since a failure-termination is exactly when
      // the record matters most.
      await recordLoopTermination(aps, workItemId, decisions, {
        disposition: disposition ?? 'blocked',
        reason,
        now: new Date(),
      });
      return { action: 'done', all_passed, disposition, reason };
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
        const reason = `blocked on a user-owned decision (§4.3): ${detail}`;
        // ADR-0024 Decision 7 (ac-6): a blocked-escalation IS a loop termination —
        // record it explicitly (disposition=blocked) in the same decision-log SoT,
        // not just as a return value (charter §4-10). Idempotent (append-once).
        await recordLoopTermination(aps, workItemId, decisions, {
          disposition: 'blocked',
          reason,
          now: new Date(),
        });
        return {
          action: 'blocked',
          blocked_node_ids: blocked.map((n) => n.id),
          reason,
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
        // A node without its own `file_scope` uses the shared (mixed) changed_files
        // fallback; that scope must not narrow by glob (it mis-routes a specialist).
        { scopeDeclared: node.file_scope !== undefined },
      );
      // Warm-start memory push (§5-1 / §10-6 #1): fail-open query in the loop, the
      // builder stays pure. researcher/planner only; undefined ⇒ packet unchanged.
      const memory = await warmStartMemoryContext(repoRoot, node, workItem, { now });
      // Retro presentation context (ADR-0024 Decision 4, ac-4): a `retro` node's
      // packet carries the assembled SEPARATED metrics + projection-only narrative;
      // every other node passes nothing (packet byte-for-byte unchanged).
      const retro =
        node.kind === 'retro' ? await collectRetroContext(repoRoot, workItemId, graph) : undefined;
      spawns.push({
        node_id: node.id,
        owner: node.owner,
        packet: buildDelegationPacket(node, workItem, candidates, scopeOf(node), memory, retro),
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
    // A node without its own `file_scope` uses the shared (mixed) changed_files
    // fallback; that scope must not narrow by glob (it mis-routes a specialist).
    { scopeDeclared: chosen.file_scope !== undefined },
  );
  // Warm-start memory push (§5-1 / §10-6 #1): fail-open query in the loop, the
  // builder stays pure. researcher/planner only; undefined ⇒ packet unchanged.
  const memory = await warmStartMemoryContext(repoRoot, chosen, workItem, { now });
  // Retro presentation context (ADR-0024 Decision 4, ac-4): a `retro` node's packet
  // carries the assembled SEPARATED metrics + projection-only narrative; every other
  // node passes nothing (packet byte-for-byte the no-retro path).
  const retro =
    chosen.kind === 'retro' ? await collectRetroContext(repoRoot, workItemId, graph) : undefined;
  return {
    action: 'spawn',
    node_id: chosen.id,
    owner: chosen.owner,
    packet: buildDelegationPacket(chosen, workItem, candidates, scopeOf(chosen), memory, retro),
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
      .array(
        z.object({
          criterion_id: z.string().min(1),
          verdict,
          notes: z.string().optional(),
          // Per-AC evidence for *this* criterion (optional + additive). A pass
          // verdict may carry its own evidence here instead of (or alongside) the
          // top-level evidence_refs; the AC-closing guard accepts either path.
          evidence_refs: z.array(evidenceRef).optional(),
        }),
      )
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
    // Per-AC oracle ASSIGNMENT — the design node's LLM judgment of the verification
    // method per criterion (ADR-0024 §3, ac-2). On a contentful design pass the loop
    // writes each oracle onto the work-item acceptance_criteria[].oracle (the SoT
    // decision: oracle assigned ON the AC) and runs a DETERMINISTIC presence-check:
    // when assignment is in play (non-empty), every in-play AC (the node's
    // acceptance_refs) must carry an oracle or the plan stage cannot auto-close
    // (producePlanGate forced to pending). Absent/empty ⇒ assignment not in play ⇒
    // legacy path unchanged (no oracle requirement retro-imposed). Ignored for
    // non-design nodes.
    ac_oracles: z
      .array(
        z.object({
          criterion_id: z.string().min(1),
          oracle: acOracle,
        }),
      )
      .optional()
      .describe(
        "A design node's per-AC oracle assignments (ADR-0024 ac-2). Written onto the " +
          'work-item AC and gated for completeness over the in-play set on a contentful design pass.',
      ),
    // ADR-0024 Decision 6 (loop discipline, mechanism 4 — wrong-fixpoint reopen). A
    // re-checking node may report that an ALREADY-PASSED node closed a criterion
    // whose oracle is in fact NOT met (oracle marked closed yet evidence mismatch).
    // On a contentful pass the engine returns that passed node to pending via the
    // `reopen` transition — SILENTLY (no user interrupt), recorded append-only. It
    // shares the same-oracle K counter with the in-loop downgrade (mechanism 3/5):
    // the K-th wrong-fixpoint on the target blocks it instead of reopening. GUARDED:
    // the transition runs only when the target is still `passed` (the forward loop
    // may have moved it to blocked / spliced a successor — an illegal reopen would
    // throw), so a collision is a no-op. Absent ⇒ no reopen (backward compat).
    oracle_fixpoint_reopen: z
      .object({
        target_node_id: z.string().min(1),
        criterion_id: z.string().min(1),
      })
      .optional()
      .describe(
        'A wrong-fixpoint signal (ADR-0024 Decision 6): the passed node whose oracle is marked ' +
          'closed but whose evidence mismatches, to reopen (or block at K). Guarded on passed status.',
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

// ── ADR-0024 Decision 6 (loop discipline): in-loop oracle authority ──────────
//
// Stable decision-log marker for a same-oracle failure on a node. The K counter
// (mechanism 5) is derived by counting these markers in the append-only decision
// log — it is kept SEPARATE from `node.attempts.fix` (the node-internal retry
// budget), so the convergence layer never folds into the retry layer
// (autopilot-converge.ts §forbids mixing). The reopen path (mechanism 4) records
// the SAME marker, so a wrong-fixpoint reopen and an in-loop downgrade share the
// one K counter.
const ORACLE_UNSATISFIED_MARKER = 'oracle-unsatisfied';

/** Decision-log reason line a same-oracle failure records (carries the AC id, K-countable). */
function oracleUnsatisfiedReason(unmet: string[]): string {
  return `${ORACLE_UNSATISFIED_MARKER}: ${unmet.join('; ')}`;
}

/**
 * Same-oracle failure count for a (node, criterion) pair, derived from the append-only
 * decision log (NOT a driver-trusted stored counter, NOT `attempts.fix`). One entry per
 * prior in-loop oracle downgrade / wrong-fixpoint reopen on this node. K failures → the
 * caller blocks instead of re-opening (mechanism 5).
 *
 * PER-AC counting (wi_260624kcv): a multi-AC node must NOT conflate failures across
 * DIFFERENT criteria toward one K threshold. So a prior `oracle-unsatisfied` decision
 * counts toward `criterionIds` only when it concerns one of those criteria:
 *  - decisions WITH a structured `criterion_ids` field count iff that field intersects
 *    `criterionIds` (read the structured field — never parse the criterion out of the
 *    free-text reason, which can itself contain `:`/`;` and may carry several ACs);
 *  - LEGACY decisions WITHOUT `criterion_ids` (recorded before this change) fall back to
 *    node-scoped counting — they ALWAYS count, so an in-flight multi-AC run mid-count is
 *    never silently reset below threshold.
 */
function sameOracleFailureCount(
  decisions: { node_id: string; reason: string; criterion_ids?: string[] }[],
  nodeId: string,
  criterionIds: string[],
): number {
  const target = new Set(criterionIds);
  return decisions.filter((d) => {
    if (d.node_id !== nodeId) return false;
    if (!d.reason.startsWith(ORACLE_UNSATISFIED_MARKER)) return false;
    // Legacy entry (no structured criterion_ids) → node-scoped fallback: always count.
    if (d.criterion_ids === undefined) return true;
    // Structured entry → count iff it concerns one of the target criteria.
    return d.criterion_ids.some((id) => target.has(id));
  }).length;
}

/**
 * In-loop oracle authority (ADR-0024 Decision 6, mechanism 3 — reuses
 * `oracleSatisfaction` from gates.ts; the SAME function the completion stage runs
 * via `nodeVerdictFor`, so completion stays the closing judge — ADR-0024:28). For
 * each in-play AC the node judged `pass`, if that AC carries an oracle and the
 * node's recorded closing evidence does NOT meet it, the AC is unmet. The closing
 * evidence is the same union the completion stage reads (top-level ∪ per-AC).
 * Returns the unmet criterion ids alongside their "acId: reason" strings (both empty ⇒
 * every oracle satisfied / none assigned → legacy path unchanged, presence-gated). The
 * structured `criterionIds` are recorded on the decision (`criterion_ids`) so the K
 * counter tallies per criterion — the reason text is NOT re-parsed for them.
 */
function unmetOracles(
  node: AutopilotNode,
  payload: RecordResultPayload,
  oracleById: Map<string, AcOracle | undefined>,
): { criterionIds: string[]; reasons: string[] } {
  const inPlay = new Set(node.acceptance_refs);
  const topLevel = payload.evidence_refs ?? [];
  const verdicts = payload.ac_verdicts ?? [];
  // Which ACs did the node judge pass? A judging node uses ac_verdicts; a node
  // without per-AC verdicts that passes implicitly closes its in-play refs.
  const passedAcs =
    verdicts.length > 0
      ? verdicts.filter((v) => v.verdict === 'pass').map((v) => v.criterion_id)
      : [...inPlay];
  const criterionIds: string[] = [];
  const reasons: string[] = [];
  for (const acId of passedAcs) {
    if (!inPlay.has(acId)) continue;
    const oracle = oracleById.get(acId);
    if (oracle === undefined) continue; // presence-gated: no oracle → legacy
    const perAc = verdicts
      .filter((v) => v.criterion_id === acId)
      .flatMap((v) => v.evidence_refs ?? []);
    const closing = [...topLevel, ...perAc];
    const sat = oracleSatisfaction(acId, oracle, closing);
    if (!sat.pass) {
      criterionIds.push(acId);
      reasons.push(sat.reasons[0] ?? `${acId}: oracle unsatisfied`);
    }
  }
  return { criterionIds, reasons };
}

/**
 * ADR-0024 Decision 7 (ac-6) — record the whole-graph loop termination as an
 * EXPLICIT decision in the append-only decision log (the one SoT), not a silent
 * return value (charter §4-10). The disposition uses the convergence vocabulary
 * (`converged|capped|blocked`, cap_reached ≡ capped) so the whole-graph record and
 * convergence.json's per-target `exit.reason` never disagree on the meaning of a
 * close; the per-target sidecar stays the per-target SoT, this log stays the
 * whole-graph SoT.
 *
 * Idempotent re-poll, but NOT a one-shot append: `nextNode` is polled and re-enters
 * a terminal/blocked branch every call. A node can transition `blocked → running`
 * (autopilot-graph), so a run that recorded `blocked` can later unblock and converge
 * — keying the guard ONLY on "a loop_terminated exists" would freeze the STALE
 * `blocked` record forever (the recorded disposition would no longer match the
 * actual termination). So the guard keys on the DISPOSITION too: if the LATEST
 * loop_terminated entry's disposition EQUALS the new one, this is an idempotent
 * re-poll → skip; if it DIFFERS, append the new entry so the LATEST entry is the
 * authoritative final disposition (append-only log, latest wins — consistent with
 * how `capped` is derived from this same log). The caller passes the decisions it
 * already read — no extra I/O.
 */
async function recordLoopTermination(
  aps: AutopilotStore,
  workItemId: string,
  decisions: { decision: string; disposition?: 'converged' | 'capped' | 'blocked' }[],
  spec: { disposition: 'converged' | 'capped' | 'blocked'; reason: string; now: Date },
): Promise<void> {
  const lastTermination = decisions.filter((d) => d.decision === 'loop_terminated').at(-1);
  // Same disposition as the latest record ⇒ idempotent re-poll, nothing to add. A
  // DIFFERENT disposition (e.g. blocked → converged after an unblock) appends a new
  // entry so the latest one is the authoritative final disposition.
  if (lastTermination?.disposition === spec.disposition) return;
  await aps.appendDecision(workItemId, {
    ts: spec.now.toISOString(),
    // Graph-wide event, not tied to a single node — the convention used elsewhere
    // for non-node-scoped decisions (e.g. e2e proposal) is the work item id.
    node_id: workItemId,
    decision: 'loop_terminated',
    disposition: spec.disposition,
    reason: `loop terminated (${spec.disposition}): ${spec.reason}`,
  });
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
  // G7 확장 (wi_260619zqa): a judging node that closes an acceptance criterion to
  // `pass` must carry evidence. A pass-verdict with empty evidence_refs would lock
  // the node `passed` and leave `complete` reading that criterion as
  // pass-with-no-proof forever (asymmetry: irrecoverable). Downgrade to fixable so
  // the node stays running. Placed BEFORE the `outcome==='pass'` block so it gates
  // BOTH the normal pass path AND the review/security forward-re-expansion
  // early-return (which lives inside that block) — there is no bypass. Owner/kind
  // agnostic; nodes that judged only partial/fail/unverified are exempt (per-AC
  // granularity preserved), and design/planner bare passes carry no pass-verdict.
  if (contentful && outcome === 'pass') {
    const acGuard = guardAcClosingEvidence({
      outcome: input.payload.outcome,
      ac_verdicts: input.payload.ac_verdicts ?? [],
      evidence_refs: input.payload.evidence_refs ?? [],
    });
    if (!acGuard.contentful) {
      contentful = false;
      outcome = 'fail';
      failureClass = 'fixable';
      guardReason = acGuard.reason;
    }
  }

  // ADR-0024 Decision 6 (mechanism 3) — in-loop oracle authority. A node may claim
  // an AC `pass`, but if that AC carries an oracle the recorded evidence does NOT
  // meet (e.g. a static_scan with only a note), the in-loop check downgrades the
  // pass: the node does NOT close, it stays open. This is the SAME `oracleSatisfaction`
  // the completion stage runs (nodeVerdictFor) — completion remains the closing
  // judge (ADR-0024:28); this only stops the loop from declaring a fixpoint the
  // oracle does not back. Presence-gated: no oracle on any in-play AC ⇒ no-op
  // (legacy pass path unchanged). The downgrade is recorded with the K-countable
  // ORACLE_UNSATISFIED marker; once the same oracle fails K times the node blocks
  // (mechanism 5) instead of re-opening.
  //
  // Excludes `design` nodes: a design/planner pass ASSIGNS oracles (ac_oracles →
  // work-item AC, handled by the design-pass block below), it does not CLOSE an AC
  // to pass — so its bare pass must not be held to an oracle it is in the act of
  // setting (ADR-0024 §3 ① assign vs ③ judge are different stages on the same node
  // pass, but only the judging stage is gated here).
  if (contentful && outcome === 'pass' && node.kind !== 'design') {
    const wi = await new WorkItemStore(repoRoot).get(input.workItemId);
    const oracleById = new Map<string, AcOracle | undefined>(
      wi.acceptance_criteria.map((c) => [c.id, c.oracle]),
    );
    const unmet = unmetOracles(node, input.payload, oracleById);
    if (unmet.reasons.length > 0) {
      const reason = oracleUnsatisfiedReason(unmet.reasons);
      const decisions = await aps.readDecisions(input.workItemId);
      // Per-AC K counter (mechanism 5, wi_260624kcv): tally PRIOR failures only for the
      // criteria THIS attempt left unmet, so a different AC's failures never count here.
      const priorFailures = sameOracleFailureCount(decisions, node.id, unmet.criterionIds);
      // K boundary (mechanism 5): K failures → blocked. `priorFailures` counts the
      // PRIOR same-oracle decisions; this attempt is the (priorFailures+1)-th. So
      // `priorFailures + 1 >= K` (i.e. the cap counts attempts, not gaps) blocks.
      const k = graph.caps.oracle_failures_to_block;
      const blockNow = priorFailures + 1 >= k;
      const event = blockNow ? 'block' : 'retry';
      await aps.updateNode(input.workItemId, node.id, (n) => ({
        ...n,
        status: nodeTransition(n.status, event),
      }));
      await aps.appendDecision(input.workItemId, {
        ts: (input.now ?? new Date()).toISOString(),
        node_id: node.id,
        failure_class: blockNow ? 'user_decision_needed' : 'fixable',
        decision: blockNow ? 'escalate' : 'retry',
        reason: blockNow
          ? `${reason} (criterion ${unmet.criterionIds.join(', ')} failed its oracle ${priorFailures + 1}≥${k} times — blocked, user decision needed)`
          : reason,
        attempts: node.attempts,
        criterion_ids: unmet.criterionIds,
      });
      return {
        node_id: node.id,
        status: blockNow ? 'blocked' : 'pending',
        outcome: 'fail',
        guard_contentful: true,
        decision: blockNow ? 'escalate' : 'retry',
        failure_class: blockNow ? 'user_decision_needed' : 'fixable',
        cap_exceeded: blockNow,
        reason,
        promoted_node_ids: [],
        superseded_node_ids: [],
      };
    }
  }

  if (outcome === 'pass') {
    // ADR-0024 Decision 6 (mechanism 4) — wrong-fixpoint reopen. A re-checking node
    // may report that an ALREADY-PASSED node closed a criterion whose oracle is in
    // fact not met. Return that passed node to pending via the `reopen` transition,
    // SILENTLY (no user interrupt), recorded append-only. GUARDED on passed status:
    // the forward loop can have moved the same node to blocked / spliced a successor,
    // and `nodeTransition(blocked,'reopen')` is illegal (throws) — so a collision is
    // a no-op. Shares the same-oracle K counter (mechanism 5): the K-th wrong-fixpoint
    // on the target blocks it instead of reopening. Runs as a side-effect BEFORE the
    // recording node's own pass-handling (mirrors the tidy-bug reopen of a passed
    // implement node). Absent signal ⇒ no-op (backward compat).
    const fixpoint = input.payload.oracle_fixpoint_reopen;
    if (fixpoint !== undefined) {
      const target = graph.nodes.find((n) => n.id === fixpoint.target_node_id);
      if (target !== undefined && target.status === 'passed') {
        const reason = oracleUnsatisfiedReason([
          `${fixpoint.criterion_id}: oracle marked closed but evidence mismatch (wrong-fixpoint reopen of ${target.id})`,
        ]);
        const decisions = await aps.readDecisions(input.workItemId);
        // Per-AC K counter (mechanism 5, wi_260624kcv): the wrong-fixpoint reopen
        // concerns a SINGLE criterion (fixpoint.criterion_id) — tally only that one,
        // sharing the same per-(node, criterion) counter as the in-loop downgrade.
        const priorFailures = sameOracleFailureCount(decisions, target.id, [fixpoint.criterion_id]);
        const k = graph.caps.oracle_failures_to_block;
        const blockTarget = priorFailures + 1 >= k;
        // reopen takes passed → pending (the only legal exit from passed); a block
        // then needs a pending→blocked hop, since `passed` has no direct `block`
        // edge (the transition table is explicit, autopilot-graph.ts:64,72).
        await aps.updateNode(input.workItemId, target.id, (n) => ({
          ...n,
          status: nodeTransition(n.status, 'reopen'),
        }));
        if (blockTarget) {
          await aps.updateNode(input.workItemId, target.id, (n) => ({
            ...n,
            status: nodeTransition(n.status, 'block'),
          }));
        }
        await aps.appendDecision(input.workItemId, {
          ts: (input.now ?? new Date()).toISOString(),
          node_id: target.id,
          failure_class: blockTarget ? 'user_decision_needed' : 'fixable',
          decision: blockTarget ? 'escalate' : 'retry',
          reason: blockTarget
            ? `${reason} (criterion ${fixpoint.criterion_id} failed its oracle ${priorFailures + 1}≥${k} times — blocked, user decision needed)`
            : reason,
          attempts: target.attempts,
          criterion_ids: [fixpoint.criterion_id],
        });
      }
    }
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
      // ADR-0024 Decision 6 (mechanism 2) — loop-level iteration cap. The per-chain
      // convergence budget (converge_rounds) bounds ONE review chain; this is the
      // GRAPH-WIDE floor: when the total forward rounds already spliced across the
      // whole graph reach caps.loop_rounds, a further re-expansion is refused even if
      // the per-chain budget remains. The total is graph-derived (forward-review node
      // ids), never a stored counter, so it cannot be defeated by a lost counter.
      // capped ≠ converged: this escalates (blocks), never closes to pass.
      const loopRoundsSoFar = totalForwardRounds(graph.nodes.map((n) => n.id));
      const loopCapHit = loopRoundsSoFar >= graph.caps.loop_rounds;
      const plan: ReturnType<typeof planForwardReexpansion> = loopCapHit
        ? {
            decision: 'escalate',
            reason: `loop-level iteration cap reached (${loopRoundsSoFar} forward rounds ≥ loop_rounds ${graph.caps.loop_rounds}) with findings still open on ${node.id}; capped ≠ converged, escalate rather than expand`,
          }
        : planForwardReexpansion({
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
    // D-lite materialization (wi_260619zqa): when a `design` node closes the plan
    // stage (plan_brief + coverage.json on disk), project the REAL on-disk
    // coverage.json path into evidence_refs as a file evidenceRef. A legitimate
    // design pass produces no caller evidence_refs, so without this `complete`
    // reads it as evidence-less; pointing at the artifact it actually produced
    // makes that pass carry proof. No synthesis — only added when the file exists.
    let designEvidenceRefs: typeof input.payload.evidence_refs;
    if (node.kind === 'design' && input.payload.plan_brief !== undefined) {
      const pb = input.payload.plan_brief;
      // ADR-0020 D3: an intent-level ADR conflict declared by the planner
      // front-loads the approval gate, so mutating nodes do not run before the
      // user resolves it — the prevention layer paired with the Stop-hook catch.
      const requireApproval = await planRequiresDecisionApproval(repoRoot, input.workItemId);
      // ADR-0024 ac-2: per-AC oracle ASSIGNMENT (LLM judgment) is carried in the
      // payload and WRITTEN here onto the work-item acceptance_criteria[].oracle (the
      // SoT). Presence-gated: only engages when the design pass actually carried
      // assignments (non-empty); absent/empty leaves every AC and the gate untouched
      // (legacy round-trips). The completeness CHECK below then reads the post-write
      // state over the in-play AC set (the node's acceptance_refs).
      const assignments = input.payload.ac_oracles ?? [];
      let oracleAssignmentIncomplete = false;
      if (assignments.length > 0) {
        const byCriterion = new Map(assignments.map((a) => [a.criterion_id, a.oracle]));
        // ADR-0024 ac-5: BEFORE writing, reject fake/tautological oracles and
        // changes to a frozen forward oracle. Validation runs against the current
        // (pre-write) ACs so the freeze compares against the design-assigned value.
        const current = await new WorkItemStore(repoRoot).get(input.workItemId);
        const currentById = new Map(current.acceptance_criteria.map((ac) => [ac.id, ac]));
        for (const [criterionId, candidate] of byCriterion) {
          // (A) adversarial mismatch — a hard method anchored to prose re-runs nothing.
          const mismatch = validateAcOracle({ id: criterionId }, candidate);
          if (!mismatch.ok) {
            throw new Error(mismatch.reasons.join('; '));
          }
          // (B) forward-AC freeze — once design-assigned, a different value is rejected.
          const existing = currentById.get(criterionId)?.oracle;
          if (existing !== undefined) {
            const frozen = assertOracleFrozen(existing, candidate);
            if (!frozen.ok) {
              throw new Error(frozen.reasons.join('; '));
            }
          }
        }
        const updated = await new WorkItemStore(repoRoot).update(input.workItemId, (w) => ({
          ...w,
          acceptance_criteria: w.acceptance_criteria.map((ac) => {
            const assigned = byCriterion.get(ac.id);
            return assigned !== undefined ? { ...ac, oracle: assigned } : ac;
          }),
        }));
        // Deterministic presence-check over the in-play set: every AC the design node
        // covers (acceptance_refs) must now carry an oracle, else the plan stage may
        // not auto-close (producePlanGate forced to pending below).
        const inPlay = new Set(node.acceptance_refs);
        oracleAssignmentIncomplete = updated.acceptance_criteria.some(
          (ac) => inPlay.has(ac.id) && ac.oracle === undefined,
        );
      }
      const patch = producePlanGate({
        changeSurface: pb.change_surface,
        brief: {
          interface_changes: pb.interface_changes,
          dod: pb.dod,
          test_scenarios: pb.test_scenarios,
        },
        tierInputs: pb.tier_inputs,
        requireApproval,
        oracleAssignmentIncomplete,
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
      const coverageStore = new CoverageStore(repoRoot);
      if (await coverageStore.exists(input.workItemId)) {
        const caller = input.payload.evidence_refs ?? [];
        const coverageRel = coverageStore.relMapPath(input.workItemId);
        if (!caller.some((e) => e.path === coverageRel)) {
          designEvidenceRefs = [
            ...caller,
            {
              kind: 'file',
              path: coverageRel,
              summary: 'pre-mortem coverage sweep artifact (plan-stage close)',
            },
          ];
        }
      }
      // ADR-0024 Decision 4 (ac-2) — retro bootstrap at design-close. Every work
      // item's graph must include a `retro` node AFTER the final verify. It is NOT
      // in the static seed: a seed retro depending on the seed verify makes
      // supersede KEEP the seed verify (a survivor depends on it) while removing the
      // seed verify's own dependency, so removeNodes throws `dangling depends_on` on
      // every planner-EXPANDED work item. Adding it HERE — after promotion+supersede
      // have settled — attaches it to the FINAL terminal verify (a verify node
      // nothing else depends on), so there is no dangling edge and no crash. The
      // retro carries no acceptance_refs (it measures the run, it covers no
      // criterion → never a supersede candidate) and is NON-BLOCKING (the retro-exempt
      // gates in autopilot-driver/loop keep its status from holding the work item
      // open). Append-once: re-recording the design node finds the existing retro and
      // skips. Splice via addNodes — the same integrity-gated path as promotion.
      const grownAfterSupersede = await aps.get(input.workItemId);
      const retroId = `${node.id}-retro`;
      const retroExists = grownAfterSupersede.nodes.some((n) => n.id === retroId);
      const terminalVerifyIds = grownAfterSupersede.nodes
        .filter((n) => n.kind === 'verify')
        .filter((v) => !grownAfterSupersede.nodes.some((m) => m.depends_on.includes(v.id)))
        .map((v) => v.id);
      if (!retroExists && terminalVerifyIds.length > 0) {
        const [retroNode] = proposalsToNodes([
          {
            id: retroId,
            kind: 'retro',
            purpose: 'Retrospect on the run and record measurements',
            depends_on: terminalVerifyIds,
            acceptance_refs: [],
          },
        ]);
        if (retroNode) await aps.addNodes(input.workItemId, [retroNode], allowedAcceptanceIds);
      }
    }
    await aps.updateNode(input.workItemId, node.id, (n) => ({
      ...n,
      status: nodeTransition(n.status, 'pass'),
      evidence_refs: designEvidenceRefs ?? input.payload.evidence_refs ?? n.evidence_refs,
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
    // Retro absorption (ADR-0024 Decision 4, ac-5): a contentful `retro` PASS
    // absorbs the projection's DURABLE part into cross-WI memory. The narrative is
    // re-projected from the SAME records the dispatch context was built from (a pure
    // copy-only projection — the run already wrote them), and only `memory_eligible`
    // items are absorbed (process-health noise is filtered by absorbRetroMemory).
    // IDEMPOTENT: the event id is `retroMemoryEventId(work_item_id)` (a stable key),
    // so re-driving the retro never double-appends (the immutable append rejects the
    // duplicate → no-op). Fail-open — a memory-store hiccup must not undo the pass it
    // annotates, so the absorb is best-effort (§4.4 / ADR-0018).
    if (node.kind === 'retro') {
      try {
        const ctx = await collectRetroContext(repoRoot, input.workItemId, graph);
        const now = (input.now ?? new Date()).toISOString();
        await absorbRetroMemory(new MemoryEventStore(repoRoot), ctx.narrative, {
          createdAt: now,
          actorRole: node.owner,
        });
        // ADR-0024 Decision 4 trend preservation: capture this WI's retro metrics in
        // the cross-WI ledger (one row per WI, idempotent) so the floor trend can be
        // measured later. The numbers are ephemeral — a past WI's coverage cannot be
        // rebuilt after the run — so they must be logged AT retro time, not derived
        // on demand. Same fail-open try as the memory absorption (§4.4 / ADR-0018).
        await new RetroMetricLedger(repoRoot).append(
          { work_item_id: input.workItemId, metrics: ctx.metrics },
          now,
        );
      } catch {
        // durable absorption + trend capture are non-authoritative — swallow and keep
        // the pass path
      }
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
