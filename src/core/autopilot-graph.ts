import type { AutopilotNode, NodeProposal } from '~/schemas/autopilot';

/**
 * kind → owner mapping (autopilot §2.2). The node kind names the activity; the
 * owner names the subagent role that runs it. Kept as a total map so an unknown
 * kind fails loudly rather than silently picking a default.
 */
const KIND_TO_OWNER: Record<AutopilotNode['kind'], AutopilotNode['owner']> = {
  research: 'researcher',
  design: 'planner',
  implement: 'implementer',
  review: 'reviewer',
  verify: 'verifier',
  fix: 'implementer',
  e2e: 'playwright-e2e',
  docs: 'implementer',
  knowledge: 'knowledge-curator',
  // [VERIFY] lifecycle owners (contract §2.2).
  security: 'security-reviewer',
  refactor: 'refactorer',
  retro: 'retrospective',
  // `cleanup` maps to the `driver` pseudo-owner: deterministic git/worktree work
  // the engine runs in-process (intercepted before spawn), not an LLM subagent.
  cleanup: 'driver',
  // `e2e-author` maps to the `main-session` pseudo-owner: journey authoring needs
  // a user dialogue, so the driver runs the skill inline (intercepted before spawn).
  'e2e-author': 'main-session',
  // `test` (settled-tree barrier) maps to the `driver` pseudo-owner (wi_260708ds9):
  // it is a DETERMINISTIC engine step the loop RUNS in-process (recipe barrier command
  // → exit code → verdict), NOT an LLM `tester` subagent — an LLM tester could
  // rationalize a red result into a green claim, the false-green this WI closes. Its
  // verdict is derived from the command exit code, never a subagent's read. (The
  // `tester` owner + OWNER_TOOLS.tester entry the plumbing added are now vestigial but
  // kept — `tester` is still in the nodeOwner enum, so OWNER_TOOLS must stay total.)
  test: 'driver',
  // `test-author` (pre-approval red-test authoring, wi_2607105qy) maps to the
  // `implementer` owner: it is a spawnable MUTATING owner (Edit/Write) that authors
  // the failing red tests. Reusing `implementer` (rather than a new owner) keeps the
  // OWNER_TOOLS/nodeOwner totals unchanged — the distinctness that matters lives on the
  // KIND, which drives the barrier hold, seedTestBarrier no-op guard, and the approval
  // carve-out. The per-node delegation packet (test-author vs implement) tells the same
  // owner which stage it is running.
  'test-author': 'implementer',
};

export function kindToOwner(kind: AutopilotNode['kind']): AutopilotNode['owner'] {
  return KIND_TO_OWNER[kind];
}

/**
 * The promoted IMPLEMENT frontier for the settled-tree test barrier re-attachment
 * (wi_260708ds9 ac-1 part c). The barrier is seeded on the seed implement node, which
 * a planner promotion supersedes; so on promotion the barrier must track the PROMOTED
 * implement frontier instead — the retro-node re-attachment analogue. Doing this
 * BEFORE supersede also frees the seed implement to be removed (else the barrier, a
 * survivor depending on the seed implement, would keep it — a regression). Frontier =
 * the implement-kind promoted nodes no OTHER promoted implement depends on (the last
 * implements); falls back to all promoted implements when none is a clean leaf. Empty
 * when the promoted subgraph carries no implement work (nothing to re-anchor on — the
 * caller then leaves the barrier on its seed anchor, which owns the implement).
 */
export function promotedImplementFrontier(promoted: AutopilotNode[]): string[] {
  const implementIds = promoted.filter((n) => n.kind === 'implement').map((n) => n.id);
  const leaves = implementIds.filter(
    (id) => !promoted.some((m) => m.kind === 'implement' && m.depends_on.includes(id)),
  );
  return leaves.length > 0 ? leaves : implementIds;
}

/**
 * Explicit node transition table (W4-1 / G3). The node lifecycle is no longer an
 * implicit set of rules scattered across the driver: every legal status change
 * is an (status × event) → status entry here, and an event with no entry for the
 * current status is an illegal transition that fails loudly. `rollback` undoes a
 * speculative dispatch (running/failed → pending) — used when a plan is rejected.
 */
export type NodeEvent = 'dispatch' | 'pass' | 'fail' | 'block' | 'rollback' | 'retry' | 'reopen';

const NODE_TRANSITIONS: Record<
  AutopilotNode['status'],
  Partial<Record<NodeEvent, AutopilotNode['status']>>
> = {
  // `retry` re-arms a running node to pending so the pending-only selector
  // (`selectReadyNodes`) re-picks it next round — a retryable/switch failure is
  // not terminal. Terminal failure (cap exceeded) uses `fail` → failed.
  pending: { dispatch: 'running', block: 'blocked' },
  running: {
    pass: 'passed',
    fail: 'failed',
    block: 'blocked',
    rollback: 'pending',
    retry: 'pending',
  },
  failed: { dispatch: 'running', rollback: 'pending' }, // retry re-dispatches
  blocked: { dispatch: 'running' }, // unblocked → re-dispatch
  // `reopen` re-opens a passed node (80-plan §8, WU-3 ac-4): when a tidy pass
  // uncovers a real defect in the implementation, the implement node is returned
  // to pending so it (and a fresh tidy stage) re-runs — the only legal way out of
  // the otherwise-terminal `passed` state.
  passed: { reopen: 'pending' },
};

export function nodeTransition(
  from: AutopilotNode['status'],
  event: NodeEvent,
): AutopilotNode['status'] {
  const to = NODE_TRANSITIONS[from][event];
  if (!to) throw new Error(`illegal node transition: ${from} --${event}-->`);
  return to;
}

/** A node is runnable/ready when it is pending and every dependency has passed. */
export function isNodeReady(node: AutopilotNode, byId: Map<string, AutopilotNode>): boolean {
  if (node.status !== 'pending') return false;
  return node.depends_on.every((dep) => byId.get(dep)?.status === 'passed');
}

/**
 * All ready nodes (the candidate concurrent wave), not just the first. The
 * orchestrator runs one owner at a time in v0, but a wave of independent ready
 * nodes must still pass the file-overlap gate before any are dispatched together.
 */
export function selectReadyNodes(nodes: AutopilotNode[]): AutopilotNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  // Implement-frontier guard (B3): an append-only planner can splice further
  // `implement` nodes that the seed verify's `depends_on` cannot reference. Hold
  // every `verify` node while ANY `implement` node is still non-terminal, so
  // verify never fires ahead of the implement frontier. No-op when no implement
  // node is in flight (pure seed: the single implement node is terminal).
  const nonTerminalImplements = nodes.filter(
    (n) => n.kind === 'implement' && n.status !== 'passed' && n.status !== 'failed',
  );
  const implementPending = nonTerminalImplements.length > 0;
  // BUG1 exemption (wi_2606144ta): a verify that an in-flight implement DEPENDS ON
  // is that implement's PRECONDITION, not a post-condition — holding it deadlocks
  // (the implement waits on the verify, the guard holds the verify). So a verify is
  // exempt from the frontier hold when some non-terminal implement (transitively)
  // depends on it. The B3 case (seed verify nothing depends on) is unaffected.
  const isImplementPrecondition = (verifyId: string): boolean =>
    nonTerminalImplements.some((impl) => dependsOnNode(impl, verifyId, byId));
  // Settled-tree barrier hold set (wi_260708ds9 review-fix): the barrier runs the FULL
  // suite, so it must fire only on a tree with NO mutating work in flight. `implementPending`
  // above counts `implement` kinds ONLY, but converge forward-splices `fix` nodes (owner
  // implementer = MUTATING) when review/verify find defects — a fix subagent editing the
  // tree while the barrier runs yields a false RED or a STALE GREEN (the barrier passes
  // before the fix lands and never re-runs). Count every non-terminal node whose kind maps
  // to the mutating `implementer` owner (implement + fix, plus any future implementer kind),
  // derived from this file's KIND_TO_OWNER classification rather than a hardcoded kind list.
  const mutatingInFlight = nodes.some(
    (n) => kindToOwner(n.kind) === 'implementer' && n.status !== 'passed' && n.status !== 'failed',
  );
  return nodes.filter((n) => {
    if (!isNodeReady(n, byId)) return false;
    if (n.kind === 'verify' && implementPending && !isImplementPrecondition(n.id)) return false;
    // Settled-tree hold (wi_260708ds9 ac-1 part c): the `test` BARRIER runs the FULL
    // suite, so it must fire only on a SETTLED tree — hold it while ANY mutating (implementer-
    // owned: implement/fix) node is still non-terminal, the same B3 protection the verify hold
    // gives. Unlike verify, a barrier is never a mutating node's precondition (it runs strictly
    // after; nothing depends_on the barrier), so it takes no precondition exemption — a plain
    // unconditional hold that cannot deadlock.
    if (n.kind === 'test' && mutatingInFlight) return false;
    return true;
  });
}

/** Does `node` transitively depend on `targetId`? Guarded DFS over depends_on. */
function dependsOnNode(
  node: AutopilotNode,
  targetId: string,
  byId: Map<string, AutopilotNode>,
): boolean {
  const seen = new Set<string>();
  const visit = (id: string): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const cur = byId.get(id);
    if (!cur) return false;
    for (const dep of cur.depends_on) {
      if (dep === targetId) return true;
      if (visit(dep)) return true;
    }
    return false;
  };
  return visit(node.id);
}

/**
 * Transitive DEPENDENTS of `forkNodeId` — every node that (directly or
 * transitively) `depends_on` the fork. This is the reverse-reachability of
 * `supersededByPromotion`'s `dependsOnGenerator`: there we ask "does X reach the
 * generator upstream?", here we collect every X that reaches `forkNodeId`. Pure,
 * read-only; the fork node is never in its own downstream set. Output preserves
 * input node order. `revise` (ac-5) uses this to name the subgraph to tear down
 * and re-drive from a direction fork.
 */
export function computeDownstream(nodes: AutopilotNode[], forkNodeId: string): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return nodes
    .filter((n) => n.id !== forkNodeId && dependsOnNode(n, forkNodeId, byId))
    .map((n) => n.id);
}

/**
 * Pending nodes DOOMED by a terminal-`failed` dependency (wi_260710vzu ac-3). A node
 * is ready only when EVERY dependency has `passed` (`isNodeReady`); a `failed` node's
 * only out-edges are dispatch/rollback (NODE_TRANSITIONS), and the autonomous loop never
 * re-dispatches a terminal node (`selectReadyNodes` picks `pending` only), so a `failed`
 * dependency never reaches `passed`. Thus any still-`pending` node that transitively
 * depends on a `failed` node can never be ready — it is DOOMED, not legitimately waiting. Returns those ids so the
 * loop can transition them `pending --block--> blocked`, turning an otherwise-infinite
 * `waiting` into a clean `blocked` landing (an honest non-pass) instead of stalling for
 * a user who is not coming. A node waiting only on pending/running deps (no `failed`
 * ancestor) is NOT returned — legitimate waiting is never over-blocked. Output
 * preserves input node order.
 */
export function pendingDoomedByFailure(nodes: AutopilotNode[]): string[] {
  const failed = nodes.filter((n) => n.status === 'failed');
  if (failed.length === 0) return [];
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return nodes
    .filter((n) => n.status === 'pending' && failed.some((f) => dependsOnNode(n, f.id, byId)))
    .map((n) => n.id);
}

/**
 * file-overlap serialization gate (W4-1). Two owners that write the same file
 * must not run concurrently or they clobber each other. Greedily admit nodes
 * whose `file_scope` is disjoint from every already-admitted node's scope;
 * defer (serialize) the rest to a later wave. Deterministic in input order.
 * A node with an empty scope (read-only) claims nothing and is never deferred.
 */
export interface ScopedNode {
  id: string;
  file_scope: string[];
}

export function fileOverlapGate<T extends ScopedNode>(
  wave: T[],
): {
  dispatch: T[];
  serialized: T[];
} {
  const claimed = new Set<string>();
  const dispatch: T[] = [];
  const serialized: T[] = [];
  for (const node of wave) {
    const overlaps = node.file_scope.some((f) => claimed.has(f));
    if (overlaps) {
      serialized.push(node);
    } else {
      dispatch.push(node);
      for (const f of node.file_scope) claimed.add(f);
    }
  }
  return { dispatch, serialized };
}

/**
 * Minimal initial node chain for a ready intent: design (plan) → implement →
 * verify. The verify node carries every acceptance criterion as its refs so the
 * graph terminates only when all criteria are addressed.
 */
export function buildInitialNodes(acceptanceIds: string[]): AutopilotNode[] {
  const mk = (
    id: string,
    kind: AutopilotNode['kind'],
    purpose: string,
    depends_on: string[],
    acceptance_refs: string[],
  ): AutopilotNode => ({
    id,
    kind,
    owner: kindToOwner(kind),
    purpose,
    status: 'pending',
    depends_on,
    acceptance_refs,
    evidence_refs: [],
    ac_verdicts: [],
    attempts: { fix: 0, switch: 0 },
  });

  return [
    mk('N1', 'design', 'Plan the change against the acceptance criteria', [], acceptanceIds),
    mk('N2', 'implement', 'Implement the planned change', ['N1'], acceptanceIds),
    mk('N3', 'verify', 'Verify every acceptance criterion with evidence', ['N2'], acceptanceIds),
  ];
}

/**
 * Promote intent-level proposals to full nodes (A-3 "planner 콘텐츠 승격"). A
 * planner emits *what* (kind/purpose/edges/AC); the mechanical fields are derived
 * here — owner from `kindToOwner`, plus the fresh-node defaults — so the planner
 * never hand-supplies redundant state. The caller splices the result through
 * `AutopilotStore.addNodes`, whose `validateNodeAddition` is the integrity gate.
 */
export function proposalsToNodes(proposals: NodeProposal[]): AutopilotNode[] {
  return proposals.map((p) => ({
    id: p.id,
    kind: p.kind,
    owner: kindToOwner(p.kind),
    purpose: p.purpose,
    status: 'pending',
    depends_on: p.depends_on,
    acceptance_refs: p.acceptance_refs,
    evidence_refs: [],
    ac_verdicts: [],
    attempts: { fix: 0, switch: 0 },
    // Carry the optional planner variant hint through promotion (omit when absent
    // so the field stays undefined rather than an explicit `undefined`).
    ...(p.agent_hint !== undefined ? { agent_hint: p.agent_hint } : {}),
    // Carry the optional per-node file scope through promotion, same way.
    ...(p.file_scope !== undefined ? { file_scope: p.file_scope } : {}),
  }));
}

/**
 * Node generation seam (A-1). The bootstrap no longer hardcodes a node literal;
 * it calls a `NodeGenerator`. The default keeps the current 3-node seed so the
 * observable autopilot behavior is unchanged — the seam only removes the
 * structural ceiling (no way to grow the graph), not the default shape.
 */
export type NodeGenerator = (acceptanceIds: string[]) => AutopilotNode[];
export const defaultNodeGenerator: NodeGenerator = buildInitialNodes;

/**
 * Seed supersession on planner promotion (wi_260610iex): when a node's
 * `generated_nodes` are spliced in, still-PENDING successors of the generator
 * whose acceptance_refs the promoted subgraph fully covers are redundant — the
 * planner refined their work into dedicated nodes (the 3-node seed's N2/N3 are
 * the canonical case). Returns the ids safe to remove under a conservative
 * fixpoint closure:
 *  - candidate: pending ∧ transitively depends on the generator ∧ not promoted
 *    ∧ acceptance_refs non-empty and ⊆ the promoted union;
 *  - a candidate a SURVIVOR depends on is kept (the planner wove it in);
 *  - a candidate whose own dependency (other than the generator) survives is
 *    kept (never orphan a chain behind live work — conservative duplication
 *    beats a hole).
 */
export function supersededByPromotion(
  nodes: AutopilotNode[],
  generatorId: string,
  promoted: AutopilotNode[],
): string[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const promotedIds = new Set(promoted.map((n) => n.id));
  const covered = new Set(promoted.flatMap((n) => n.acceptance_refs));

  const dependsOnGenerator = (start: AutopilotNode): boolean => {
    const seen = new Set<string>();
    const visit = (id: string): boolean => {
      if (seen.has(id)) return false;
      seen.add(id);
      const cur = byId.get(id);
      if (!cur) return false;
      for (const dep of cur.depends_on) {
        if (dep === generatorId || visit(dep)) return true;
      }
      return false;
    };
    return visit(start.id);
  };

  const removal = new Set(
    nodes
      .filter(
        (n) =>
          n.status === 'pending' &&
          !promotedIds.has(n.id) &&
          n.acceptance_refs.length > 0 &&
          n.acceptance_refs.every((ac) => covered.has(ac)) &&
          dependsOnGenerator(n),
      )
      .map((n) => n.id),
  );

  let changed = true;
  while (changed) {
    changed = false;
    for (const id of [...removal]) {
      const candidate = byId.get(id);
      if (!candidate) continue;
      const survivorDependsOnIt = nodes.some(
        (n) => !removal.has(n.id) && n.depends_on.includes(id),
      );
      const ancestorSurvives = candidate.depends_on.some(
        (dep) => dep !== generatorId && !removal.has(dep),
      );
      if (survivorDependsOnIt || ancestorSurvives) {
        removal.delete(id);
        changed = true;
      }
    }
  }
  return [...removal];
}

/**
 * Integrity gate for a node-add (A-1). Pure, no I/O — `addNodes` calls this
 * before any write. Throws on a duplicate id (against the existing graph or
 * within the batch), a dangling `depends_on` reference, or a `depends_on` edge
 * that introduces a cycle. Error messages carry stable markers so callers/tests
 * can assert on them: `duplicate node id` / `dangling depends_on` / `cycle`.
 *
 * `allowedAcceptanceIds` (optional, the frozen intent's AC id set) moves the
 * axis-2 scope-grow check UPSTREAM (dialectic P2): a planner-generated node that
 * references an `acceptance_refs` id not in the intent is rejected the moment it
 * is introduced — fail-fast — instead of being caught only at Stop (intentDrift
 * H2 stays as the backstop). Omitted → no check (legacy / no-intent path), so a
 * caller without the intent set keeps the prior behavior. Stable marker:
 * `acceptance_ref not in intent`.
 */
export function validateNodeAddition(
  existing: AutopilotNode[],
  newNodes: AutopilotNode[],
  allowedAcceptanceIds?: ReadonlySet<string>,
): void {
  const seen = new Set<string>();
  for (const node of existing) seen.add(node.id);
  for (const node of newNodes) {
    if (seen.has(node.id)) throw new Error(`duplicate node id: ${node.id}`);
    seen.add(node.id);
  }

  if (allowedAcceptanceIds) {
    for (const node of newNodes) {
      for (const ref of node.acceptance_refs) {
        if (!allowedAcceptanceIds.has(ref)) {
          throw new Error(
            `acceptance_ref not in intent: node ${node.id} references unknown criterion ${ref} (scope grow)`,
          );
        }
      }
    }
  }

  // NOTE (wi_260624fe0): an earlier guard here rejected any read-only owner with
  // a non-empty `file_scope`, but `file_scope` is dual-meaning — on a read-only
  // node it is a READ/focus signal (and drives dispatch variant routing per
  // agents/planner.md:24), not a write claim. `nodeProposal` carries no
  // write-intent field, so no structured signal at splice time distinguishes
  // read-focus from write-intent; a file_scope-keyed reject is the wrong
  // mechanism. The rule "mutating work (test authoring, new files) goes to a
  // mutating owner, not a read-only one" is carried by planner guidance
  // (planner.md), not a deterministic splice guard.

  const merged = [...existing, ...newNodes];
  const byId = new Map(merged.map((n) => [n.id, n]));
  for (const node of newNodes) {
    for (const dep of node.depends_on) {
      if (!byId.has(dep)) {
        throw new Error(`dangling depends_on: node ${node.id} references unknown ${dep}`);
      }
    }
  }

  // Cycle detection over the merged depends_on edges (DFS with a recursion
  // stack). The pre-existing graph is acyclic by construction, but a new edge
  // can close a loop, so we check the whole merged graph.
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): void => {
    const status = state.get(id);
    if (status === 'done') return;
    if (status === 'visiting') throw new Error(`cycle introduced over depends_on at node ${id}`);
    state.set(id, 'visiting');
    for (const dep of byId.get(id)?.depends_on ?? []) visit(dep);
    state.set(id, 'done');
  };
  for (const node of merged) visit(node.id);
}
