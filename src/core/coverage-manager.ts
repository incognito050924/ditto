import type { CoverageMap, CoverageNode } from '~/schemas/coverage';
import type { DialecticVerdict } from '~/schemas/dialectic';
import type { SelfAnswerAttempt } from '~/schemas/question-gate';
import type { AcOracle } from '~/schemas/work-item';
import { type RiskAxes, deterministicFloor, safeDefaultable } from './gates';
import { needsBriefing } from './question-context';

/**
 * Deterministic coverage Manager (premortem-coverage-contract §4.1·§4.5·§5).
 *
 * The Manager is CODE, not an LLM — isomorphic to the autopilot driver's
 * structural selection (`autopilot-graph.ts`). It owns the coverage tree and
 * handles ONLY structural fields (id·parent_id·origin·depth_weight·state·
 * children); it never interprets the natural-language `label`. All semantic
 * judgment (is a scope satisfied? is a new branch admissible?) is made by fresh
 * fan-out judges and handed back to the Manager as structural signals. This
 * module's job is the three deterministic duties the contract reserves for code
 * (§4.1 한계): tree CRUD + append-only growth, structural node scheduling, and
 * termination aggregation via admissible-novelty exhaustion (K, default 2).
 */

const CLOSED_STATES: ReadonlySet<CoverageNode['state']> = new Set([
  'resolved',
  'user_owned',
  'out_of_scope',
]);

/** Default dry threshold K (§4.5): K consecutive admissible-novelty=0 rounds ⇒ dry. */
export const DEFAULT_DRY_K = 2;

/** A node is closed when its state is any of the three §3.3 closure states. */
function isClosed(node: CoverageNode): boolean {
  return CLOSED_STATES.has(node.state);
}

/**
 * Tree CRUD — append a node (append-only growth, §3.2). The new node is linked
 * into its parent's `children`. Pure: returns a fresh map, never mutates input.
 * Rejects a duplicate id (no overwrite — append-only) and a dangling parent_id.
 * A root append (parent_id === null) is allowed only when no parent link is
 * needed; the typical caller adds the root via the initial map.
 */
export function addNode(map: CoverageMap, child: CoverageNode): CoverageMap {
  if (map.nodes.some((n) => n.id === child.id)) {
    throw new Error(`duplicate coverage node id: ${child.id}`);
  }
  if (child.parent_id !== null && !map.nodes.some((n) => n.id === child.parent_id)) {
    throw new Error(`dangling parent_id: node ${child.id} references unknown ${child.parent_id}`);
  }

  const nodes = map.nodes.map((n) =>
    n.id === child.parent_id ? { ...n, children: [...n.children, child.id] } : n,
  );
  nodes.push({ ...child });
  return { ...map, nodes };
}

/**
 * Tree CRUD — close a node by flipping its `state` (§3.3). Append-only: the node
 * count never changes, only the targeted node's structural state. Pure.
 */
export function closeNode(
  map: CoverageMap,
  id: string,
  state: Exclude<CoverageNode['state'], 'open'>,
  reason?: string,
  residualRisk?: string,
): CoverageMap {
  if (!map.nodes.some((n) => n.id === id)) {
    throw new Error(`unknown coverage node id: ${id}`);
  }
  return {
    ...map,
    nodes: map.nodes.map((n) =>
      n.id === id
        ? {
            ...n,
            state,
            ...(reason !== undefined ? { close_reason: reason } : {}),
            ...(residualRisk !== undefined ? { residual_risk: residualRisk } : {}),
          }
        : n,
    ),
  };
}

/**
 * Structural node scheduling (§4.1 `selectReadyNodes`류). A node is schedulable
 * when it is `open` AND every child is closed — the leaf frontier of still-open
 * scope. A parent with any open child is deferred: the §3.2 false-green
 * invariant says a parent cannot close before its whole subtree is dry, so the
 * Manager never advances a parent ahead of its children. Decided purely on
 * structural fields (state + children edges), never on the label.
 */
export function selectReadyCoverageNodes(map: CoverageMap): CoverageNode[] {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  return map.nodes.filter((n) => {
    if (isClosed(n)) return false;
    return n.children.every((childId) => {
      const c = byId.get(childId);
      return c !== undefined && isClosed(c);
    });
  });
}

/**
 * false-green 차단 게이트 (§3.2 invariant, dialectic-review OBJ-7). A node may not
 * be projected to a *closing* state (resolved/user_owned/out_of_scope) while any
 * child is still open — its subtree is not yet dry, so closing it would let a
 * parent pass the gate as done while open children remain (the false-green case).
 * Structural only (state + children edges), never the label (§4.1). Leaves (no
 * children) are trivially dry. Mirrors `selectReadyCoverageNodes` schedulability,
 * applied at projection time as an explicit reject.
 */
export function coverageClosureGate(
  map: CoverageMap,
  id: string,
  state: Exclude<CoverageNode['state'], 'open'>,
): { pass: boolean; reasons: string[] } {
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  const target = byId.get(id);
  if (target === undefined) {
    return { pass: false, reasons: [`unknown coverage node id: ${id}`] };
  }
  const openChildren = target.children.filter((childId) => {
    const c = byId.get(childId);
    return c !== undefined && !isClosed(c);
  });
  if (openChildren.length > 0) {
    return {
      pass: false,
      reasons: [
        `cannot project ${state} onto ${id}: subtree not dry — open child(ren): ${openChildren.join(', ')}`,
      ],
    };
  }
  return { pass: true, reasons: [] };
}

/**
 * Mechanical dry counter step (§4.5 admissible-novelty 소진). Given the prior
 * counter and the structural signal for this round, returns the next counter:
 * an admissible (critical/major) new branch resets to 0; a round that added no
 * admissible branch increments. info/low novelty carries
 * `admissibleBranchesAdded === 0`, so it is recorded elsewhere (dialog) but does
 * NOT reset the counter. Admissible findings are finite, so this is a
 * monotone-decreasing measure ⇒ termination is guaranteed (수렴, not 완벽).
 */
export function recordDryRound(
  counter: number,
  round: { admissibleBranchesAdded: number },
): number {
  return round.admissibleBranchesAdded > 0 ? 0 : counter + 1;
}

/**
 * Termination aggregation (§5) — breadth AND depth:
 *  - breadth: every node in the tree is closed (§3.3);
 *  - depth: the dry counter has reached K (§4.5), i.e. K consecutive rounds with
 *    no admissible new branch.
 * Both axes must hold. K defaults to 2 (configurable, §4.5).
 */
export function isCoverageTerminated(
  map: CoverageMap,
  dryCounter: number,
  k = DEFAULT_DRY_K,
): boolean {
  const allClosed = map.nodes.every(isClosed);
  return allClosed && dryCounter >= k;
}

/**
 * Fresh-judge INPUT builder (§4.1, ac-3). Every semantic judgment in the engine
 * (cross-cutting selection, leading-question review, depth-weight estimation,
 * duplicate detection, completeness-critic) runs as a fresh, STATELESS judge
 * subagent. The contract's hard rule (§4.1, §11): the Manager passes "최소
 * 컨텍스트만 … [해당 노드 + 최초 의도 + 관련 cross-cutting 제약]. 전체 transcript는
 * 주지 않는다." — so there is no persistent accumulated context anywhere.
 *
 * This deterministic builder enforces that structurally: even when handed an
 * accumulated transcript/history, it constructs the judge input from ONLY the
 * three allowed fields and never copies any prior-node transcript content. The
 * `accumulated` argument is accepted only to be deliberately discarded — making
 * the exclusion explicit and testable rather than implicit in a call site.
 */
export interface JudgeInput {
  node: CoverageNode;
  original_intent: string;
  cross_cutting_constraints: string[];
}

export function buildJudgeInput(args: {
  node: CoverageNode;
  originalIntent: string;
  crossCuttingConstraints: string[];
  /** Accumulated history/transcript — DELIBERATELY DROPPED (§4.1 zero persistent context). */
  accumulated?: unknown;
}): JudgeInput {
  return {
    node: { ...args.node },
    original_intent: args.originalIntent,
    cross_cutting_constraints: [...args.crossCuttingConstraints],
  };
}

/**
 * plan-dialog.md serialization (§6, ac-6). The Manager renders the plan-stage
 * dialog as human-readable markdown so the user can correct it before confirming.
 * Per §4.1 the Manager is DETERMINISTIC code: it serializes already-structured
 * fields verbatim and never interprets, judges, or rewrites the natural-language
 * content. §6 mandates four sections, so the agent's silent intent decisions are
 * also exposed (not just what the user saw):
 *  (1) 사용자 Q&A         — questions that went to the user and their answers (Q→A).
 *  (2) QuestionGate self-answer — items the agent decided NOT to ask and
 *      self-answered from code/docs/web/memory, with the 안 물은 근거 and the
 *      source/result evidence (reuses self_answer_attempts).
 *  (3) assumptions         — hypothesis-labeled gaps left unanswered, each tracing
 *      to the unanswered question (because_no_answer_to).
 *  (4) 열린/닫힌 항목       — both closed AND still-open/shallow scope nodes, so the
 *      user sees at a glance which scope is thin and can correct it.
 *
 * Returns the markdown STRING (the caller owns the runtime file write to
 * .ditto/local/runs/<wi>/plan-dialog.md, §6); this function performs no I/O.
 */
export interface PlanDialogUserQa {
  question: string;
  why_matters: string;
  answer: string;
  /**
   * 배경(왜 물었는지) + 해결 결과(답이 무엇을 정했는지) — the user-facing context for this
   * Q&A (ac-5). When this context is too long for the compact AskUserQuestion option
   * UI (`needsBriefing`), the serializer renders it as a briefing section in the
   * dialog body BEFORE the question; a short context rides inline with the Q. Optional
   * so existing coverage.json / plan-dialog deltas (no context) stay compatible.
   */
  context?: string;
}

export interface PlanDialogSelfAnswer {
  question: string;
  /** 안 물은 근거 — why this was self-answered instead of asked the user (§6.2). */
  why_not_asked: string;
  attempts: SelfAnswerAttempt[];
}

export interface PlanDialogAssumption {
  statement: string;
  label: string;
  /** Unanswered question id this assumption traces to (deep-interview §6.3). */
  because_no_answer_to: string;
}

export interface PlanDialogItem {
  id: string;
  label: string;
  state: CoverageNode['state'];
  /** Skip/deferral justification (WHY closed) for a non-resolved close — surfaced in the dialog. */
  close_reason?: string;
  /** The surviving risk a non-resolved close leaves behind — surfaced alongside close_reason. */
  residual_risk?: string;
}

export interface PlanDialogInput {
  workItemId: string;
  userQa: PlanDialogUserQa[];
  selfAnswers: PlanDialogSelfAnswer[];
  assumptions: PlanDialogAssumption[];
  closedItems: PlanDialogItem[];
  openItems: PlanDialogItem[];
  /**
   * Dialog kind/title — 'plan-dialog' (default, §6) or 'intent-dialog' (§9, intent
   * stage). Same serializer/sections; only the frontmatter kind + H1 title differ
   * so the intent stage REUSES this renderer instead of forking a second one.
   */
  kind?: 'plan-dialog' | 'intent-dialog';
}

export function serializePlanDialog(input: PlanDialogInput): string {
  const lines: string[] = [];
  const kind = input.kind ?? 'plan-dialog';

  // Minimal frontmatter (§6 추가 규칙: frontmatter 최소).
  lines.push('---');
  lines.push(`kind: ${kind}`);
  lines.push(`work_item_id: ${input.workItemId}`);
  lines.push('---');
  lines.push('');
  lines.push(`# ${kind}`);
  lines.push('');

  // (1) 사용자 Q&A
  lines.push('## 사용자 Q&A');
  if (input.userQa.length === 0) {
    lines.push('(none)');
  } else {
    for (const qa of input.userQa) {
      // ac-5/ac-6: the coverage surface honors the same context contract as the
      // check-question path. The Q&A carries its 배경+해결결과 context; when that context
      // overflows the compact option UI (needsBriefing — the SHARED threshold from
      // question-context.ts, not a re-implementation), brief the user FIRST as a
      // dialog-body section, then ask. A short context rides inline under the Q. The
      // briefing renders the caller's context verbatim (§4.1: serialize, never
      // interpret), so it adds no leading frame of its own.
      const briefFirst = qa.context !== undefined && needsBriefing(qa.context);
      if (briefFirst) {
        lines.push('### 컨텍스트 브리핑');
        lines.push(qa.context as string);
        lines.push('');
      }
      lines.push(`- Q: ${qa.question}`);
      if (qa.context !== undefined && !briefFirst) {
        lines.push(`  - context: ${qa.context}`);
      }
      lines.push(`  - why_matters: ${qa.why_matters}`);
      lines.push(`  - A: ${qa.answer}`);
    }
  }
  lines.push('');

  // (2) QuestionGate self-answer (안 물은 근거)
  lines.push('## QuestionGate self-answer (안 물은 근거)');
  if (input.selfAnswers.length === 0) {
    lines.push('(none)');
  } else {
    for (const sa of input.selfAnswers) {
      lines.push(`- Q: ${sa.question}`);
      lines.push(`  - 안 물은 근거: ${sa.why_not_asked}`);
      for (const attempt of sa.attempts) {
        lines.push(`  - [${attempt.source}] ${attempt.result}`);
      }
    }
  }
  lines.push('');

  // (3) assumptions
  lines.push('## assumptions');
  if (input.assumptions.length === 0) {
    lines.push('(none)');
  } else {
    for (const a of input.assumptions) {
      lines.push(`- (${a.label}) ${a.statement} — because_no_answer_to: ${a.because_no_answer_to}`);
    }
  }
  lines.push('');

  // (4) 열린/닫힌 항목 — both rendered so the user sees thin scope (§6 반드시 표기).
  lines.push('## 닫힌 항목');
  if (input.closedItems.length === 0) {
    lines.push('(none)');
  } else {
    for (const item of input.closedItems) {
      // A non-resolved (skipped) item carries WHY it was skipped (close_reason) and
      // WHAT RISK survives (residual_risk); render each clause only when present so a
      // resolved/swept item shows no dangling markers (surviving-risk self-description).
      const clauses: string[] = [];
      if (item.close_reason) clauses.push(`skip: ${item.close_reason}`);
      if (item.residual_risk) clauses.push(`risk: ${item.residual_risk}`);
      const suffix = clauses.length > 0 ? ` — ${clauses.join(' · ')}` : '';
      lines.push(`- [${item.state}] ${item.id}: ${item.label}${suffix}`);
    }
  }
  lines.push('');

  lines.push('## 열린 항목');
  if (input.openItems.length === 0) {
    lines.push('(none)');
  } else {
    for (const item of input.openItems) {
      lines.push(`- [${item.state}] ${item.id}: ${item.label}`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * The six pre-mortem coverage quality axes (§2). Each names a distinct failure
 * mode of "매몰" (tunnel-vision scope shrink) and is enforced by its OWN
 * mechanism — "각 축은 별도 메커니즘으로만 막힌다 — 체크리스트 하나로는 못 막는다."
 */
export const COVERAGE_AXES = [
  'completeness', // 완전성 (breadth)
  'neutrality', // 중립성 (non-bias)
  'balance', // 균형 (depth)
  'discovery', // 발견 (discovery)
  'priority', // 우선순위 (priority)
  'temporal', // 시간 정합 (temporal)
] as const;

export type CoverageAxis = (typeof COVERAGE_AXES)[number];

interface AxisMechanism {
  /** Stable id of the SEPARATE mechanism enforcing this axis (§2 table). */
  mechanism_id: string;
  /** Human-facing description of how this axis is blocked (§2 강제 메커니즘). */
  description: string;
  /**
   * The distinct enforcement entry point for this axis. Each axis gets its own
   * function (never one shared catch-all). Signatures differ per axis because
   * the mechanisms are genuinely different — this is the structural guarantee
   * ac-4 asserts. They are deterministic plumbing: the actual semantic verdict
   * is produced by the fresh fan-out judge whose input `buildJudgeInput` shapes.
   */
  // biome-ignore lint/suspicious/noExplicitAny: per-axis mechanisms have intentionally distinct shapes.
  enforce: (...args: any[]) => unknown;
}

/**
 * Axis → distinct mechanism dispatch (§2, ac-4). Each axis maps to a separate
 * mechanism_id and a separate enforce function:
 *  - completeness → multi-angle blind fresh sweep + "every node closed" termination (§4.2/§5)
 *  - neutrality   → per-scope Dialectic 3-role via OPPONENT-ROUTER reuse + leading-question review (§4.3)
 *  - balance      → per-node depth-weight gate (deterministicFloor borrow, §4.4)
 *  - discovery    → loop-until-dry admissible-novelty exhaustion (recordDryRound, §4.5)
 *  - priority     → user-priority weighting blocks termination when a high-priority node is shallow (§2 우선순위)
 *  - temporal     → plan_brief/coverage baseline frozen + divergence detection (§2 시간정합)
 *
 * Each `enforce` is GENUINE structural enforcement (deterministic code, no LLM
 * call — §4.1: the Manager강제·집계·견제, judges are separate): it REJECTS a real
 * violation and ADMITS a satisfying case from the node's structural fields, never
 * echoing a caller-supplied verdict boolean.
 */

/** Structural neutrality signal — did a real 3-role dialectic run for the node? */
export interface NeutralityState {
  /** The Opponent actually ran (not single-agent role-play) — §4.3, dialectic §2. */
  opponent_ran: boolean;
  /** Synthesizer verdict produced for this scope (dialectic.ts dialecticVerdict). */
  verdict: DialecticVerdict;
}

/** Depth-balance signal — achieved depth + the deterministicFloor ambiguity inputs (§4.4, §10 차용). */
export interface BalanceState {
  /** Self-reported achieved depth for the scope (0..1), produced by a fresh judge. */
  achievedDepth: number;
  /** Open required (critical) scope still unresolved (gates.ts AmbiguitySnapshot). */
  open_required_sections: number;
  conflicting: number;
  assumption_ratio: number;
}

/** Priority signal — user-priority + achieved depth, weighted against depth_weight (§2 우선순위). */
export interface PriorityState {
  userPriority: 'high' | 'normal' | 'low';
  achievedDepth: number;
}

export const COVERAGE_AXIS_MECHANISMS: Record<CoverageAxis, AxisMechanism> = {
  completeness: {
    mechanism_id: 'multi-angle-blind-sweep+breadth-termination',
    description:
      'Multiple blind fresh sweeps decompose scope (§4.2); every coverage node must close to terminate (§5).',
    enforce: (map: CoverageMap, dryCounter: number, k = DEFAULT_DRY_K) =>
      isCoverageTerminated(map, dryCounter, k),
  },
  neutrality: {
    mechanism_id: 'opponent-router-dialectic-3role+leading-question-review',
    description:
      'Per-scope Dialectic Producer/Opponent/Synthesizer via opponent-router reuse; passes only when the Opponent actually ran AND the Synthesizer reached a decided verdict — a missing/blocked deliberation or single-agent role-play is rejected (§4.3).',
    enforce: (state: NeutralityState | undefined) =>
      state?.opponent_ran === true && state.verdict !== 'blocked',
  },
  balance: {
    mechanism_id: 'per-node-depth-weight-gate+deterministic-floor',
    description:
      'Each scope carries depth_weight (fresh-judge estimated); the achieved depth is floor-capped (deterministicFloor, §10 차용) so a high self-report cannot escape unresolved critical scope, then must meet the node weight — proportional, not uniform (§4.4).',
    enforce: (node: CoverageNode, state: BalanceState) => {
      const floor = deterministicFloor({
        open_required_sections: state.open_required_sections,
        conflicting: state.conflicting,
        assumption_ratio: state.assumption_ratio,
      });
      const cappedDepth = Math.min(state.achievedDepth, 1 - floor);
      return cappedDepth >= node.depth_weight;
    },
  },
  discovery: {
    mechanism_id: 'loop-until-dry-admissible-novelty',
    description:
      'A dedicated completeness-critic pass runs until admissible (critical/major) novelty is exhausted (K consecutive dry rounds, §4.5).',
    enforce: (round: { admissibleBranchesAdded: number }) => recordDryRound(0, round),
  },
  priority: {
    mechanism_id: 'user-priority-weighting-termination-block',
    description:
      'High user-priority nodes get a weighted depth criterion: a high-priority node must reach its depth_weight before it may close; a shallow important node blocks termination. Normal/low-priority nodes are not subjected to this extra block here (§2 우선순위).',
    enforce: (node: CoverageNode, state: PriorityState) =>
      state.userPriority !== 'high' || state.achievedDepth >= node.depth_weight,
  },
  temporal: {
    mechanism_id: 'plan-brief-baseline-freeze+divergence-detection',
    description:
      'plan_brief/coverage result is frozen as the implementation baseline; this engine compares a downstream interface surface against the frozen baseline and reports divergence. Drift ENFORCEMENT proper is the implementation stage (reviewer/verifier) — this engine only produces the baseline and detects divergence (§2 시간정합, contract §2 l.62).',
    enforce: (baseline: readonly string[], current: readonly string[]) => {
      if (baseline.length !== current.length) return false;
      const frozen = new Set(baseline);
      return current.every((item) => frozen.has(item));
    },
  },
};

/**
 * Cost control — lightweight 3-tier + caps (§8.2). The §2 fan-out (per-node
 * 3-role + judges + per-round critic) costs multiplicatively, so the contract
 * controls it two ways: a tier scales DEPTH (rounds/sweep angles/judge passes),
 * and caps bound runaway cost. The hard invariant (§8.2, §11): both shrink
 * DEPTH ONLY — breadth (the 6 axes, the node set) is never reduced. A cap hit is
 * `cap ≠ converged` (§5): it stops and escalates, it is NOT success.
 */

/** The three cost tiers (§8.2). Lowering the tier reduces depth, never breadth. */
export const COVERAGE_TIERS = ['light', 'standard', 'full'] as const;
export type CoverageTier = (typeof COVERAGE_TIERS)[number];

export interface TierSelectionInput {
  /** Number of changed files (규모). */
  changedFileCount: number;
  /** Whether the change touches an interface surface (§7.1). */
  interfaceChanged: boolean;
  /** Reused 3-axis risk judgment (gates.ts RiskAxes). */
  risk: RiskAxes;
  /** Large/heterogeneous scope (대규모) — escalates to full (§8.2). */
  large: boolean;
}

const FEW_FILES = 3;

/**
 * Tier selection from 규모(size) + risk (§8.2 table):
 *  - full:     대규모 ∨ irreversible ∨ non_local — heavy or non-local/irreversible.
 *  - light:    변경 파일 소수 ∧ interface 무변경 ∧ risk 3축 음성 (safeDefaultable).
 *  - standard: otherwise — 중간 규모 또는 risk 일부 양성.
 * Deterministic and pure; the booleans are produced upstream (planner/finalize).
 */
export function selectCoverageTier(input: TierSelectionInput): CoverageTier {
  if (input.large || input.risk.irreversible || input.risk.non_local) {
    return 'full';
  }
  const fewFiles = input.changedFileCount <= FEW_FILES;
  if (fewFiles && !input.interfaceChanged && safeDefaultable(input.risk)) {
    return 'light';
  }
  return 'standard';
}

/**
 * Tier → brief approval status (§7.2/§8.2). `light` is the small-reversible
 * auto-waiver: the brief is still produced/recorded but auto-approved as
 * `not_required` so mutationGate proceeds without waiting on the user. standard
 * and full require explicit user approval, so they start `pending`.
 */
export function tierBriefApproval(tier: CoverageTier): 'not_required' | 'pending' {
  return tier === 'light' ? 'not_required' : 'pending';
}

/**
 * Plan-stage gate production (§3.1/§7.2/§12 wiring — the design→review seam). When
 * a plan-stage (`design`/planner) node finishes the pre-mortem coverage sweep it
 * hands back the brief content + the tier inputs (both produced upstream by the
 * fresh fan-out, never accumulated here). This DETERMINISTIC Manager step turns
 * those structural fields into the `approval_gate` patch:
 *  - `change_surface` PRESENCE turns the brief hard-gate ON for the graph (§7.2);
 *  - `plan_brief` is the user-facing body (interface/DoD/test scenarios, §7.1);
 *  - the status is `selectCoverageTier` → `tierBriefApproval`: a `light`
 *    small-reversible change auto-waives (`not_required`), standard/full require
 *    explicit user approval (`pending`).
 * Reuses the existing tier selection — it does NOT re-derive the tier rules.
 * Pure: returns only the three fields to merge into approval_gate.
 */
export interface PlanGateInput {
  changeSurface: string[];
  brief: { interface_changes: string[]; dod: string[]; test_scenarios: string[] };
  tierInputs: TierSelectionInput;
  /**
   * Force `status='pending'` regardless of tier — the deterministic front-load of an
   * intent-level ADR conflict to the approval gate (ADR-0020 D3). The caller computes
   * it with `decisionConflictRequiresApproval`; a `light`/auto-waivable tier cannot
   * silently proceed past a recorded decision the request contradicts.
   */
  requireApproval?: boolean;
  /**
   * Deterministic presence-CHECK (ADR-0024 ac-2). The caller computes this boolean
   * (exactly like `requireApproval`): true when the design node assigned per-AC
   * oracles (assignment is in play) yet some in-play AC is left WITHOUT one. When set,
   * a `light`/auto-waivable tier cannot silently close the plan stage with an oracle
   * gap — the status is forced to `pending`. No LLM/assignment logic lives here; this
   * is a pure presence flag, keeping `producePlanGate` deterministic.
   */
  oracleAssignmentIncomplete?: boolean;
  /**
   * Livelock fix (wi_260707loq §2). `mutationGate` returns `present_plan` while the
   * approval gate is `pending`, so force-continuing a routine pending at Stop alone
   * re-hits `present_plan` → a Stop/drive livelock. This clears the pending AT SOURCE:
   * when the chosen plan PRESERVES the frozen purpose (its AC id-set is CONSERVED vs
   * the frozen intent — the caller computes this reusing `intentDriftGate`'s AC id-set
   * conservation, exactly the same fact) AND nothing else forces approval, the plan
   * stage auto-waives to `not_required` so `mutationGate` proceeds instead of stalling
   * on a pending nobody will approve. A purpose-CHANGING plan is NOT purpose-preserving,
   * so it never auto-waives here. Optional + backward-compatible: absent ⇒ the status
   * falls back to `tierBriefApproval(tier)` (the prior behavior).
   *
   * CALLER CONTRACT (impl-loop owns the call site, autopilot-loop.ts design-pass):
   * pass `purposePreserving` = AC id-set conserved (intentDriftGate conservation) and
   * `highRisk` = highRiskAssumption(riskOf(workItem)). Both are optional so existing
   * callers that omit them keep the current tier-driven behavior.
   */
  purposePreserving?: boolean;
  /**
   * Force `status='pending'` for a high-risk change (gates.ts `highRiskAssumption`:
   * non_local ∨ irreversible ∨ unaudited). Computed caller-side from the work item's
   * `declared_risk` (the same `riskOf` the Stop hook's P3 yield uses), so a high-risk
   * plan cannot auto-waive past the approval gate. This WINS over `purposePreserving`
   * (a high-risk purpose-preserving change still requires approval). Optional +
   * backward-compatible: absent ⇒ not forced.
   */
  highRisk?: boolean;
}

export interface PlanGatePatch {
  status: 'pending' | 'not_required';
  change_surface: string[];
  plan_brief: { interface_changes: string[]; dod: string[]; test_scenarios: string[] };
}

export function producePlanGate(input: PlanGateInput): PlanGatePatch {
  const tier = selectCoverageTier(input.tierInputs);
  // forcePending WINS over purposePreserving (ternary order — the guard): an intent
  // conflict / oracle gap / high-risk change may not auto-waive. Only a NON-forced,
  // purpose-preserving plan clears to not_required (the §2 livelock fix); otherwise
  // fall back to the tier (backward compatible when both new flags are absent).
  const forcePending = input.requireApproval || input.oracleAssignmentIncomplete || input.highRisk;
  return {
    status: forcePending
      ? 'pending'
      : input.purposePreserving
        ? 'not_required'
        : tierBriefApproval(tier),
    change_surface: [...input.changeSurface],
    plan_brief: {
      interface_changes: [...input.brief.interface_changes],
      dod: [...input.brief.dod],
      test_scenarios: [...input.brief.test_scenarios],
    },
  };
}

/**
 * Adversarial oracle validation (ADR-0024 ac-5, blueprint §4 anti-SLOP). An
 * assigned oracle must deliver the re-evaluability its `verification_method`
 * claims. A HARD method (dynamic_test = executed, static_scan = re-scanned)
 * anchored to a non-re-evaluable target is a MISMATCH (fake / tautological): a
 * "scan" or "test" that points at prose / a doc:/intent: ref re-runs nothing.
 *
 * Concrete, testable rules (increment 1 — deliberately small, not a framework):
 *  - A hard method whose `maps_to` is a `doc:`/`intent:` style ref → REJECT.
 *  - A hard method whose `maps_to` is not a testable/scannable anchor — an AC id
 *    (`ac-N`), a path/file (has a `/` or a `name.ext`), or a rule id (a single
 *    dotted/hyphenated token, no spaces) — → REJECT (free prose is not an anchor).
 *  - `soft_judgment` makes no hard re-evaluability claim, so a doc/prose anchor is
 *    legitimate (review / user-decision) — ADMIT.
 *  - forward + raw code-pointer is already rejected by the schema (work-item.ts
 *    superRefine, ADR-0024 §3.0); this builds on that, it does not duplicate it.
 *
 * Pure: returns `{ ok, reasons }`, never throws. The AC is passed for the reason
 * message only (the rule is structural over the oracle fields).
 */
const DOC_INTENT_PREFIX = /^(doc|intent)\s*:/i;
/** A single anchor token (no whitespace): an ac-id / path / file / rule id. */
const ANCHOR_TOKEN = /^[^\s]+$/;

function isReEvaluableAnchor(mapsTo: string): boolean {
  // A doc:/intent: ref names prose, not a re-evaluable position.
  if (DOC_INTENT_PREFIX.test(mapsTo)) return false;
  // Free prose has whitespace; a real anchor (ac-id / path / file / rule id) is a
  // single token. This is the structural separation between an anchor and a label.
  return ANCHOR_TOKEN.test(mapsTo);
}

export function validateAcOracle(
  ac: { id: string },
  oracle: AcOracle,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const isHard =
    oracle.verification_method === 'dynamic_test' || oracle.verification_method === 'static_scan';
  if (isHard && !isReEvaluableAnchor(oracle.maps_to)) {
    reasons.push(
      `oracle for ${ac.id}: ${oracle.verification_method} claims a re-evaluable check but maps_to "${oracle.maps_to}" is not a testable/scannable anchor (expected an AC id, a path/file, or a rule id — not a doc:/intent: ref or free prose). A scan/test of prose is tautological (ADR-0024 §3/§4).`,
    );
  }
  return { ok: reasons.length === 0, reasons };
}

/**
 * Structural equality of two oracles (ADR-0024 ac-5). All three fields must match.
 */
export function oraclesEqual(a: AcOracle, b: AcOracle): boolean {
  return (
    a.verification_method === b.verification_method &&
    a.maps_to === b.maps_to &&
    a.direction === b.direction
  );
}

/**
 * Forward-AC oracle FREEZE (ADR-0024 ac-5). Once a FORWARD oracle is assigned at
 * the design node, a later attempt to change it to a DIFFERENT value is rejected
 * (diff = reject; freeze applies AFTER the design assignment). Equal re-assignment
 * is a no-op (idempotent → ok). A `backward` oracle is a current-code finding and
 * is NOT frozen — a later re-assignment to a different value is allowed.
 * Pure: returns `{ ok, reasons }`, never throws.
 */
export function assertOracleFrozen(
  assigned: AcOracle,
  candidate: AcOracle,
): { ok: boolean; reasons: string[] } {
  // Only the design-assigned forward oracle is frozen.
  if (assigned.direction !== 'forward') return { ok: true, reasons: [] };
  if (oraclesEqual(assigned, candidate)) return { ok: true, reasons: [] };
  return {
    ok: false,
    reasons: [
      `forward oracle is frozen after design assignment: cannot change {${assigned.verification_method},${assigned.maps_to},${assigned.direction}} → {${candidate.verification_method},${candidate.maps_to},${candidate.direction}} (ADR-0024 ac-5)`,
    ],
  };
}

/**
 * Depth budget per tier — the breadth-invariant guard (§8.2: 넓이 불변, 깊이만 축소).
 * `axes` is ALWAYS the full 6-axis set (breadth) regardless of tier; only the
 * depth knobs (rounds per node, sweep angles) shrink as the tier lowers. This
 * encodes structurally that a lower tier cannot drop an axis — every tier must
 * still close every node on all six axes (§5/§8.2).
 */
export interface TierDepthBudget {
  /** Breadth — constant across tiers (the 6 axes are never dropped). */
  axes: readonly CoverageAxis[];
  /** Depth — max adversarial rounds per node (light shrinks this, §8.2). */
  maxRoundsPerNode: number;
  /** Depth — number of blind decomposition sweep angles (§4.2; light=1). */
  sweepAngles: number;
}

const TIER_DEPTH: Record<CoverageTier, { maxRoundsPerNode: number; sweepAngles: number }> = {
  // §8.2: light = sweep 단일 패스, 범위별 1라운드.
  light: { maxRoundsPerNode: 1, sweepAngles: 1 },
  // §8.2: standard = sweep 2~3각도, 핵심 범위만 3역.
  standard: { maxRoundsPerNode: 2, sweepAngles: 3 },
  // §8.2: full = §2~§4 전체.
  full: { maxRoundsPerNode: 3, sweepAngles: 5 },
};

export function tierDepthBudget(tier: CoverageTier): TierDepthBudget {
  return { axes: COVERAGE_AXES, ...TIER_DEPTH[tier] };
}

/**
 * Termination DEPTH for a tier (§8-4) — the number of consecutive dry rounds K
 * required to terminate, reused from the tier's `maxRoundsPerNode` (light=1,
 * standard=2, full=3). This is the depth lever that is actually wired into
 * `isCoverageTerminated`; lowering the tier settles a low-stakes sweep sooner.
 * Breadth is untouched (every node/category must still close, §8.2/ac-4). With no
 * tier resolved, callers fall back to DEFAULT_DRY_K (= standard), preserving the
 * existing default (ac-7).
 */
export function coverageDryK(tier: CoverageTier): number {
  return tierDepthBudget(tier).maxRoundsPerNode;
}

/**
 * Caps (§8.2 상한) — configurable upper bounds on cost. These bound DEPTH/cost,
 * not breadth: the tree-node cap escalates rather than silently pruning scope.
 */
export interface CoverageCaps {
  /** Max LLM calls for a single node before escalation (노드당 호출 상한). */
  callsPerNode: number;
  /** Max coverage-tree node count before escalation (트리 노드 수 상한). */
  treeNodeCount: number;
  /** Max total interrogation rounds before escalation (총 라운드 상한). */
  totalRounds: number;
}

export interface CapUsage {
  callsThisNode: number;
  treeNodeCount: number;
  roundsRun: number;
}

/**
 * Cap evaluation (§8.2 + §5 cap ≠ converged). Returns whether any cap is reached
 * (`capped` ⇒ stop and escalate) and the reasons. `converged` is ALWAYS false:
 * a cap hit is never convergence/pass — the contract forbids reading a cap as
 * success. Callers stop on `capped`, then escalate the still-open scope
 * (user_owned / explicit assumption), they do NOT mark it resolved.
 */
export interface CapStatus {
  capped: boolean;
  converged: false;
  reasons: string[];
}

export function capStatus(caps: CoverageCaps, usage: CapUsage): CapStatus {
  const reasons: string[] = [];
  if (usage.callsThisNode >= caps.callsPerNode) {
    reasons.push(`per-node call cap reached: ${usage.callsThisNode}/${caps.callsPerNode}`);
  }
  if (usage.treeNodeCount >= caps.treeNodeCount) {
    reasons.push(`tree node-count cap reached: ${usage.treeNodeCount}/${caps.treeNodeCount}`);
  }
  if (usage.roundsRun >= caps.totalRounds) {
    reasons.push(`total round cap reached: ${usage.roundsRun}/${caps.totalRounds}`);
  }
  return { capped: reasons.length > 0, converged: false, reasons };
}
