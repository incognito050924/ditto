import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Autopilot, type AutopilotNode, autopilot } from '~/schemas/autopilot';
import { validateNodeAddition } from './autopilot-graph';
import { localDir } from './ditto-paths';
import { ensureDir, readJson, writeJson } from './fs';

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
    | 'loop_terminated'
    // T1 (wi_2606266az) auto-resolve ledger vocabulary: `auto_fix` = the loop
    // auto-routed an agent_resolvable risk to a forward fix round (ac-3); `surface`
    // = the loop surfaced a residual IN-FLOW to the user without terminating (ac-3
    // 4-reason surface, or R5 optional-tool blocked_external); `batch_escalate` =
    // the loop emitted the single out-of-scope follow-up batch signal (ac-4, the
    // signal n1i-followup-batch materializes — loop only signals, R9).
    | 'auto_fix'
    | 'surface'
    | 'batch_escalate';
  reason: string;
  // T1 (wi_2606266az, ac-3): the structured reason-category for an `auto_fix` /
  // `surface` / `batch_escalate` decision — the resolvability class the route was
  // chosen from (machine-attributable, NOT parsed from `reason`). Present only on
  // those auto-resolve decisions; the resolvability label space is the SAME enum
  // the completion contract uses (one label space, R11). Additive + optional.
  resolvability?:
    | 'agent_resolvable'
    | 'blocked_external'
    | 'user_decision'
    | 'accepted_tradeoff'
    | 'decision_or_adr_conflict'
    | 'multiple_comparable_solutions'
    | 'out_of_scope'
    | 'genuinely_dangerous';
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
    // Atomic O_APPEND (flag 'a'): a single append write is positioned-and-written
    // atomically relative to other appenders, so two concurrent `record-result`
    // calls cannot lose-update each other (the prior read-then-rewrite raced).
    // Every record is newline-terminated, so the log stays line-delimited JSON.
    // (idiom: memory-warmstart.ts:116)
    await appendFile(this.decisionsPath(workItemId), `${JSON.stringify(decision)}\n`, 'utf8');
  }

  /**
   * Returns the full ordered `AutopilotDecision[]` — byte-identical to a fresh
   * full parse of the append-only log. The PARSE is incrementalized: a parsed
   * prefix (up to the last complete newline-terminated line) is cached per file,
   * and a subsequent read parses only the appended tail. The cache is re-validated
   * (size + hash of the prefix bytes it already parsed) every read and FAILS CLOSED
   * to a full re-read on any mismatch — file shrank, prefix bytes changed, or no
   * cache — so correctness always beats speed. The contract is unchanged.
   */
  async readDecisions(workItemId: string): Promise<AutopilotDecision[]> {
    const path = this.decisionsPath(workItemId);
    const file = Bun.file(path);
    if (!(await file.exists())) {
      decisionCache.delete(path);
      return [];
    }
    const text = await file.text();
    return parseDecisionsIncremental(path, text);
  }
}

/** Cache of the parsed complete-line prefix, keyed by the absolute log path. */
interface DecisionPrefixCache {
  /** Byte length of the prefix (ends exactly at a newline) we already parsed. */
  size: number;
  /** Hash of those prefix bytes — re-validated each read to detect any change. */
  hash: string;
  /** Parsed decisions for that prefix, in order. */
  decisions: AutopilotDecision[];
}

const decisionCache = new Map<string, DecisionPrefixCache>();

function hashPrefix(bytes: string): string {
  return createHash('sha1').update(bytes).digest('hex');
}

/** Parse newline-delimited JSON decisions; a corrupt line throws (fail-closed). */
function parseLines(block: string): AutopilotDecision[] {
  return block
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as AutopilotDecision);
}

/**
 * Incremental parse with prefix re-validation. The complete-line prefix is the
 * text up to (and including) the last '\n'; any trailing partial line is parsed
 * for the return value but NOT cached (it may be mid-write — and a corrupt partial
 * line throws, exactly as the full read did).
 */
function parseDecisionsIncremental(path: string, text: string): AutopilotDecision[] {
  const prefixEnd = text.lastIndexOf('\n') + 1; // 0 when there is no newline yet
  const prefix = text.slice(0, prefixEnd);
  const remainder = text.slice(prefixEnd);

  const cached = decisionCache.get(path);
  let decisions: AutopilotDecision[];
  if (
    cached !== undefined &&
    prefixEnd >= cached.size &&
    hashPrefix(text.slice(0, cached.size)) === cached.hash
  ) {
    // Cache hit: reuse the parsed prefix, parse only the appended complete-line tail.
    decisions = cached.decisions.concat(parseLines(text.slice(cached.size, prefixEnd)));
  } else {
    // Fail closed to a FULL re-read: no cache, file shrank, or prefix bytes changed.
    decisions = parseLines(prefix);
  }
  decisionCache.set(path, { size: prefixEnd, hash: hashPrefix(prefix), decisions });

  // Trailing partial line (if any) is included in the return but never cached.
  const tail = parseLines(remainder);
  return tail.length > 0 ? decisions.concat(tail) : decisions;
}
