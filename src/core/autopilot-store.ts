import { join } from 'node:path';
import { type Autopilot, type AutopilotNode, autopilot } from '~/schemas/autopilot';
import { validateNodeAddition } from './autopilot-graph';
import { localDir } from './ditto-paths';
import { atomicWriteText, ensureDir, readJson, writeJson } from './fs';

/**
 * AutopilotStore (M2.1) — the ONLY path that mutates the autopilot graph.
 * Callers never write `autopilot.json` directly; they go through `write` /
 * `updateNode` so every mutation is schema-validated and atomic. Driver
 * decisions are appended to an append-only `autopilot-decisions.jsonl`.
 */
export interface AutopilotDecision {
  ts: string;
  node_id: string;
  /** Absent for proposal decisions (e2e_accept/e2e_decline) — there is no failure. */
  failure_class?: 'fixable' | 'wrong_approach' | 'blocked_external' | 'user_decision_needed';
  // `e2e_accept`/`e2e_decline` record the user's answer to the driver's E2E
  // authoring proposal (propose-e2e, wi_260610p9h ac-6); `loop_terminated` records
  // the whole-graph loop termination disposition (ADR-0024 Decision 7 — 의사결정
  // 투명성, ac-6) so the loop close is an explicit recorded decision, not a silent
  // return value (charter §4-10); the other three are the failure-pipeline decisions.
  decision:
    | 'retry'
    | 'switch_approach'
    | 'escalate'
    | 'e2e_accept'
    | 'e2e_decline'
    | 'loop_terminated';
  reason: string;
  // ADR-0024 Decision 7 (ac-6): the whole-graph loop-termination disposition,
  // present ONLY on a `loop_terminated` decision. `converged` = the loop closed on
  // oracle satisfaction; `capped` = a loop-level iteration cap forced the close
  // (capped ≠ converged); `blocked` = the loop closed WITHOUT convergence (a
  // partial/failed run or a node blocked on a user-owned decision). The vocabulary
  // is the SAME three-way fact convergence.json's `exit.reason` records per-target
  // (cap_reached ≡ capped), so the per-target sidecar and this whole-graph record
  // never disagree on the meaning of a close. This decision log is the SoT for the
  // whole-graph loop termination; convergence.json is the per-target sidecar.
  disposition?: 'converged' | 'capped' | 'blocked';
  /** Absent for proposal decisions — no retry/switch budget is consumed. */
  attempts?: { fix: number; switch: number };
  // ADR-0024 Decision 6 (mechanism 5, wi_260624kcv): the acceptance-criterion id(s)
  // an `oracle-unsatisfied` failure was recorded against. Present ONLY on same-oracle
  // failure decisions; lets the K counter (`sameOracleFailureCount`) tally per
  // (node, criterion) instead of per node, so a multi-AC node's failures on one
  // criterion never push a DIFFERENT criterion toward `oracle_failures_to_block`.
  // Additive + optional (same convention as `failure_class?`/`attempts?` — backward
  // compatible, no schema_version bump): legacy entries lack it and fall back to
  // node-scoped counting.
  criterion_ids?: string[];
}

export class AutopilotStore {
  constructor(public readonly repoRoot: string) {}

  private dir(workItemId: string): string {
    return localDir(this.repoRoot, 'work-items', workItemId);
  }

  private graphPath(workItemId: string): string {
    return join(this.dir(workItemId), 'autopilot.json');
  }

  private decisionsPath(workItemId: string): string {
    return join(this.dir(workItemId), 'autopilot-decisions.jsonl');
  }

  async exists(workItemId: string): Promise<boolean> {
    return Bun.file(this.graphPath(workItemId)).exists();
  }

  async get(workItemId: string): Promise<Autopilot> {
    return readJson(this.graphPath(workItemId), autopilot);
  }

  /** Initial create / full replace (used by bootstrap). Validated against the schema. */
  async write(workItemId: string, graph: Autopilot): Promise<Autopilot> {
    await ensureDir(this.dir(workItemId));
    return writeJson(this.graphPath(workItemId), autopilot, graph);
  }

  /** Mutate exactly one node by id. The node id cannot change. */
  async updateNode(
    workItemId: string,
    nodeId: string,
    mutator: (node: AutopilotNode) => AutopilotNode,
  ): Promise<Autopilot> {
    const graph = await this.get(workItemId);
    let found = false;
    const nodes = graph.nodes.map((node) => {
      if (node.id !== nodeId) return node;
      found = true;
      const next = mutator(node);
      if (next.id !== node.id) {
        throw new Error(`updateNode mutator changed node id from ${node.id} to ${next.id}`);
      }
      return next;
    });
    if (!found) throw new Error(`node ${nodeId} not found in autopilot graph for ${workItemId}`);
    return writeJson(this.graphPath(workItemId), autopilot, { ...graph, nodes });
  }

  /**
   * Append one or more schema-valid nodes to the graph (A-1). The integrity gate
   * (`validateNodeAddition`) rejects duplicate id / dangling depends_on / cycle
   * *before* any write, so existing node ids stay byte-identical. The final
   * `writeJson` re-validates the whole merged graph against the schema.
   */
  async addNodes(
    workItemId: string,
    newNodes: AutopilotNode[],
    allowedAcceptanceIds?: ReadonlySet<string>,
  ): Promise<Autopilot> {
    const graph = await this.get(workItemId);
    validateNodeAddition(graph.nodes, newNodes, allowedAcceptanceIds);
    return writeJson(this.graphPath(workItemId), autopilot, {
      ...graph,
      nodes: [...graph.nodes, ...newNodes],
    });
  }

  /**
   * Remove superseded nodes (wi_260610iex). Defensive guards re-assert what
   * `supersededByPromotion` already guarantees — every removed node is PENDING
   * and no surviving node depends on it — so a buggy caller cannot orphan the
   * graph. Throws with stable markers: `not pending` / `dangling depends_on`.
   */
  async removeNodes(workItemId: string, ids: string[]): Promise<Autopilot> {
    if (ids.length === 0) return this.get(workItemId);
    const graph = await this.get(workItemId);
    const removal = new Set(ids);
    for (const id of ids) {
      const node = graph.nodes.find((n) => n.id === id);
      if (!node) throw new Error(`cannot remove unknown node: ${id}`);
      if (node.status !== 'pending') throw new Error(`cannot remove node not pending: ${id}`);
    }
    const survivors = graph.nodes.filter((n) => !removal.has(n.id));
    for (const n of survivors) {
      for (const dep of n.depends_on) {
        if (removal.has(dep)) {
          throw new Error(`removal would leave dangling depends_on: ${n.id} -> ${dep}`);
        }
      }
    }
    return writeJson(this.graphPath(workItemId), autopilot, { ...graph, nodes: survivors });
  }

  /**
   * Mutate the approval gate in place (wi_260615xby A — approve/reject CLI). Only
   * the gate object is replaced; nodes and every other field stay byte-identical.
   * The write re-validates the whole graph against the schema.
   */
  async updateApprovalGate(
    workItemId: string,
    mutator: (gate: Autopilot['approval_gate']) => Autopilot['approval_gate'],
  ): Promise<Autopilot> {
    const graph = await this.get(workItemId);
    return writeJson(this.graphPath(workItemId), autopilot, {
      ...graph,
      approval_gate: mutator(graph.approval_gate),
    });
  }

  async appendDecision(workItemId: string, decision: AutopilotDecision): Promise<void> {
    await ensureDir(this.dir(workItemId));
    const path = this.decisionsPath(workItemId);
    const file = Bun.file(path);
    const existing = (await file.exists()) ? await file.text() : '';
    const prefix = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
    await atomicWriteText(path, `${prefix}${JSON.stringify(decision)}\n`);
  }

  async readDecisions(workItemId: string): Promise<AutopilotDecision[]> {
    const file = Bun.file(this.decisionsPath(workItemId));
    if (!(await file.exists())) return [];
    const text = await file.text();
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as AutopilotDecision);
  }
}
