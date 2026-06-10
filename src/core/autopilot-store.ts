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
  failure_class: 'fixable' | 'wrong_approach' | 'blocked_external' | 'user_decision_needed';
  decision: 'retry' | 'switch_approach' | 'escalate';
  reason: string;
  attempts: { fix: number; switch: number };
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
