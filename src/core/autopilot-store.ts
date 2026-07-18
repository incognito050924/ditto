import { createHash } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type Autopilot, type AutopilotNode, autopilot } from '~/schemas/autopilot';
import { validateNodeAddition } from './autopilot-graph';
import { localDir } from './ditto-paths';
import { ensureDir, readJson, writeJson } from './fs';
import type { GateId } from './gates';

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
    | 'batch_escalate'
    // wi_260707loq autonomy vocabulary. `direction` = the loop took an autonomous
    // direction fork with a clear advantage on the frozen purpose (ac-3) — recorded
    // with the structured `direction_record` below so the completion report exposes
    // it (ac-4) and `revise` can re-drive from its fork point (ac-5).
    // `procedure_punt_continued` = the Stop hook force-continued a procedure-punt
    // pause (진행확인/플랜승인/AB선택) instead of yielding (ac-1). Both are in-flow
    // progress, NOT user-owned escalations: `isDecisivePost` is false for both by
    // construction (no failure_class:'user_decision_needed', no decision∈{escalate,
    // batch_escalate}, no disposition:'blocked'), so neither is posted to GitHub.
    | 'direction'
    | 'procedure_punt_continued'
    // wi_260713wxq (#31): the USER-ACTION reopen of a passed implement node (the
    // `ditto autopilot reopen` entrypoint). This single append-only entry is BOTH the
    // durable audit record (actor + feedback) AND ac-7's counting substrate — the
    // per-node reopen cap is derived by counting these entries, never a stored counter
    // (the same decision-log-derived discipline `sameOracleFailureCount` uses). Scoped
    // to this `reopen` decision kind so the user-reopen cap never collides with the
    // wrong-fixpoint `oracle-unsatisfied` count on the same node.
    | 'reopen'
    // wi_2607148yg (ac-1): a discovered real-behavior DEFECT that the loop
    // MATERIALIZED into its own work item AND chain-drove to done in the same run.
    // This is the materialize-AND-drive fact — deliberately DISTINCT from
    // `batch_escalate`, which is signal-only (materialize≠drive: the loop only emits
    // the out-of-scope follow-up signal and never drives it). Recorded so the ac-8
    // disclosure projection and the ac-1 loop can attest "this defect was materialized
    // AND driven" (not merely mentioned/surfaced). Like `direction`/`auto_fix` it is
    // autonomous IN-FLOW progress, NOT a user-owned escalation: `isDecisivePost` is
    // false for it by construction (it is absent from the decisive-post predicate), so
    // it never posts to GitHub — it is disclosed in the completion digest + retro
    // instead. The materialized child carries its OWN commit (ac-3, two intents never
    // merge into one commit); classification/drive/gates land in later nodes.
    | 'defect_chain_driven';
  reason: string;
  // wi_260713wxq (#31): present ONLY on a `reopen` decision. `actor` = who triggered the
  // reopen (the user-action origin), `feedback` = the user's free-text correction, threaded
  // into the re-dispatched implementer's delegation packet as DATA (never executed).
  // Additive + optional (same convention as `attempts?`/`criterion_ids?` — backward
  // compatible, no schema_version bump): every in-flight autopilot.json / decision log
  // still parses.
  actor?: string;
  feedback?: string;
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
    | 'genuinely_dangerous'
    // wi_2607148yg (ac-1/ac-2): the resolvability class of a re-run-REPRODUCED
    // real-behavior defect discovered mid-run — agent-resolvable AND in-scope to
    // DRIVE (the class routed to `defect_chain_driven`, materialize+drive). Kept
    // DISTINCT from `out_of_scope` (which routes latent bugs / tech-debt / unrelated
    // pre-existing failures to backlog-only materialization, no drive) so the ac-8
    // disclosure can tell a driven defect from a backlog-parked one. This inline
    // union stays the SAME one label space as `completion-contract.ts`'s
    // `resolvability` zod enum (R11) — the value is added to BOTH so they never drift.
    | 'discovered_defect';
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
  // wi_260707loq (ac-3/ac-4): the autonomous direction-fork record, present ONLY on
  // a `direction` decision. The exact ac-4 disclosure fields — 무엇때문에 (`trigger`),
  // 선택지 (`options`), 선택+의도근거 (`choice` + `intent_basis`), 파급·되돌리기비용
  // (`blast_radius` + `reverse_cost`) — plus `fork_node_id`, the anchor `revise`
  // re-drives from (ac-5). Additive + optional (same convention as `disposition?`/
  // `criterion_ids?` — backward compatible, NO schema_version bump): legacy readers
  // and the JSON.parse-only `parseLines` path ignore it.
  direction_record?: {
    fork_node_id: string;
    trigger: string;
    options: string[];
    choice: string;
    intent_basis: string;
    blast_radius: string;
    reverse_cost: string;
  };
  // wi_260718srh (n3): the stable identity of the deterministic gate whose verdict drove
  // this decision-log entry (gates.ts `GATE_ID`). Present ONLY on a gate-TRIGGERED append
  // (e.g. the in-loop `oracleSatisfaction` downgrade), NOT on owner-result retry/surface
  // entries — so a catch-rate denominator built from gate_id-stamped entries stays clean.
  // Additive + optional (same convention as `criterion_ids?`/`direction_record?` — backward
  // compatible, NO schema_version bump): `JSON.stringify` omits the undefined key, so a
  // legacy line without it hashes byte-identically under `synthesizeDecisionId` (posted_
  // decision_ids idempotency is preserved); only a stamped line takes a new hash.
  gate_id?: GateId;
}

/**
 * Synthesize a stable-yet-per-occurrence id for one decision-log entry (G8 progress
 * post idempotency, wi_260628d79). The decision shape carries NO `decision_id`, so we
 * derive one — but NOT a pure content-hash: two genuinely distinct decisions with
 * identical content (e.g. two escalations on the same node for the same reason) must
 * get DIFFERENT ids, or the second is silently dropped (under-post). The discriminator
 * is the decision's APPEND-POSITIONAL index in the log: it is unique per occurrence and
 * stable across re-reads of the same append-only log (readDecisions returns
 * append-positional order). Re-reading the SAME persisted line at the SAME index yields
 * the SAME id (so a revisit dedups correctly). The index is mixed with the full content
 * so the id also changes if a line is ever rewritten (fail-loud, not silent reuse).
 */
export function synthesizeDecisionId(decision: AutopilotDecision, index: number): string {
  return createHash('sha1')
    .update(`${index} ${JSON.stringify(decision)}`)
    .digest('hex');
}

/**
 * The G8 decisive-post predicate (wi_260628d79). True for the decision classes worth
 * posting to the linked GitHub issue, evaluated on the REAL decision-log fields:
 *   - `failure_class === 'user_decision_needed'` (a user-owned escalation),
 *   - `decision ∈ {escalate, batch_escalate}` (an escalation / out-of-scope batch),
 *   - `disposition === 'blocked'` (a loop terminated WITHOUT convergence).
 * Routine churn (retry / auto_fix / surface / a converged loop_terminated) is EXCLUDED —
 * it is in-flow progress, not a decision the issue's followers need surfaced.
 */
export function isDecisivePost(decision: AutopilotDecision): boolean {
  return (
    decision.failure_class === 'user_decision_needed' ||
    decision.decision === 'escalate' ||
    decision.decision === 'batch_escalate' ||
    decision.disposition === 'blocked'
  );
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
