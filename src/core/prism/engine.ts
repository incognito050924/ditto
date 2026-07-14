import {
  type CapUsage,
  type CoverageCaps,
  addNode,
  capStatus,
  closeNode,
  coverageClosureGate,
} from '~/core/coverage-manager';
import type { CoverageNode } from '~/schemas/coverage';
import type {
  PrismEvaluation,
  PrismIssueMap,
  PrismNodeEvaluation,
  PrismSeverity,
} from '~/schemas/prism';

/**
 * Prism issue-map engine (wi_260707oi1, node oi1-issuemap-engine).
 *
 * NET-NEW prism logic ONLY. The tree CRUD / close / false-green gate / cap
 * evaluation are REUSED from `coverage-manager.ts` (design decision 1: never
 * re-implement a third tree engine). This module adds the four prism concerns:
 *   - ac-2  criticalTermination (B1 vacuous-truth guard) + severity authority
 *           (MODEL-2) + unknown-close residual gate (MODEL-1);
 *   - ac-3  label-only progress summary (no id / axis / schema-field leak);
 *   - ac-4  one-shot minimal-launch notification with retract-on-regression;
 *   - ac-10 deterministic divergence detection + real cap-invocation loop.
 */

// ── severity authority (MODEL-2) ─────────────────────────────────────────────

/**
 * Effective severity of a node. Default `noncritical` — `critical` is granted only
 * by an explicit gated assignment, so the actor who benefits from the launch gate
 * cannot make a node critical (or drop it) by side-effect.
 */
export function severityOf(prism: PrismIssueMap, nodeId: string): PrismSeverity {
  return prism.severities.find((s) => s.node_id === nodeId)?.severity ?? 'noncritical';
}

export interface PrismGateResult {
  ok: boolean;
  prism?: PrismIssueMap;
  reasons: string[];
}

/**
 * MODEL-2 severity authority gate. Assign `critical`/`noncritical` to a node. A
 * critical→noncritical DEMOTION must carry an explicit reason (isomorphic to a
 * non-resolved close's residual_risk) — a silent demotion is rejected. Pure.
 */
export function assignSeverity(
  prism: PrismIssueMap,
  nodeId: string,
  severity: PrismSeverity,
  reason?: string,
): PrismGateResult {
  if (!prism.tree.nodes.some((n) => n.id === nodeId)) {
    return { ok: false, reasons: [`unknown prism node id: ${nodeId}`] };
  }
  const current = severityOf(prism, nodeId);
  const isDemotion = current === 'critical' && severity === 'noncritical';
  if (isDemotion && (reason === undefined || reason.trim().length === 0)) {
    return {
      ok: false,
      reasons: [
        `critical→noncritical demotion of ${nodeId} requires an explicit reason (MODEL-2 — a severity demotion is decision-grade, never silent)`,
      ],
    };
  }
  const others = prism.severities.filter((s) => s.node_id !== nodeId);
  const assignment = {
    node_id: nodeId,
    severity,
    ...(isDemotion ? { demotion_reason: reason } : {}),
  };
  return { ok: true, prism: { ...prism, severities: [...others, assignment] }, reasons: [] };
}

// ── prism-level per-node evaluation annotation (ac-1) ─────────────────────────

/** The prism-level evaluation record for a node, if any. */
function evaluationOf(prism: PrismIssueMap, nodeId: string): PrismNodeEvaluation | undefined {
  return (prism.evaluations ?? []).find((e) => e.node_id === nodeId);
}

/**
 * Upsert a per-node evaluation annotation (replace the single record for the node,
 * append if absent — the `evaluations` array is a per-node sidecar, not a log). Pure.
 */
function upsertEvaluation(
  prism: PrismIssueMap,
  nodeId: string,
  patch: Partial<Omit<PrismNodeEvaluation, 'node_id'>>,
): PrismIssueMap {
  const existing = prism.evaluations ?? [];
  const current = existing.find((e) => e.node_id === nodeId);
  const others = existing.filter((e) => e.node_id !== nodeId);
  const merged: PrismNodeEvaluation = { ...(current ?? {}), ...patch, node_id: nodeId };
  return { ...prism, evaluations: [...others, merged] };
}

/**
 * OBJ-1 trivial-proxy floor (research §8-A.2 "증거추가 0이면 차단"). A critical
 * resolved-close must have contributed NEW grounding — not just self-authored prose:
 * either a child decomposition (the node branched into sub-issues) OR a recorded
 * opponent artifact (critique/dissent). STRUCTURAL presence only — this never judges
 * the reason's *quality* (that is the model's job, out of scope). Pure.
 */
function evidenceAddedForNode(prism: PrismIssueMap, nodeId: string): boolean {
  const node = prism.tree.nodes.find((n) => n.id === nodeId);
  if (node !== undefined && node.children.length > 0) return true;
  const evalRec = evaluationOf(prism, nodeId);
  const critique = evalRec?.opponent_critique;
  const dissent = evalRec?.opponent_dissent;
  return (
    (critique !== undefined && critique.trim().length > 0) ||
    (dissent !== undefined && dissent.trim().length > 0)
  );
}

// ── close gate (MODEL-1 unknown-close residual) ──────────────────────────────

/** An unknown-close state — a "모름-닫기" that defers rather than resolves. */
function isUnknownCloseState(state: Exclude<CoverageNode['state'], 'open'>): boolean {
  return state === 'out_of_scope' || state === 'user_owned';
}

/**
 * Close a prism node through the coverage-manager machinery, adding the prism
 * gates:
 *   - false-green gate (coverageClosureGate) — reused, no re-implement;
 *   - MODEL-1: an unknown-close (out_of_scope/user_owned) of a CRITICAL node
 *     requires a recorded residual_risk. A no-residual "모름-닫기" of critical
 *     scope is REJECTED (it must not silently count as critical resolution).
 *   - ac-1 A2: a `resolved` close of a CRITICAL node requires BOTH a non-empty
 *     justifying_reason AND an attempted refutation (from the node's evaluation
 *     annotation), PLUS added grounding this round (OBJ-1). Any miss REJECTS the
 *     close and stamps the node prism-level `unevaluated`. Homomorphic with the
 *     MODEL-1 residual gate above (same critical-severity condition).
 * Pure: returns the new prism on success, reasons on rejection.
 */
export function closePrismNode(
  prism: PrismIssueMap,
  nodeId: string,
  state: Exclude<CoverageNode['state'], 'open'>,
  reason?: string,
  residualRisk?: string,
): PrismGateResult {
  const gate = coverageClosureGate(prism.tree, nodeId, state);
  if (!gate.pass) return { ok: false, reasons: gate.reasons };
  const isCritical = severityOf(prism, nodeId) === 'critical';
  const noResidual = residualRisk === undefined || residualRisk.trim().length === 0;
  if (isCritical && isUnknownCloseState(state) && noResidual) {
    return {
      ok: false,
      reasons: [
        `핵심 항목 "${nodeId}"을(를) '모름'으로 닫으려면(${state}) 남는 위험(residual_risk)을 반드시 적어야 해요 — 위험을 안 적고 '모름'으로 닫는 건 거부되고, 핵심 항목을 해결한 것으로 치지 않아요`,
      ],
    };
  }
  // ac-1 A2 critical resolved-close gate — homomorphic with MODEL-1 above.
  if (isCritical && state === 'resolved') {
    const evalRec = evaluationOf(prism, nodeId);
    const missing: string[] = [];
    const hasReason =
      evalRec?.justifying_reason !== undefined && evalRec.justifying_reason.trim().length > 0;
    if (!hasReason) missing.push('채운 근거 사유(justifying_reason)');
    if (evalRec?.refutation_attempted !== true) {
      missing.push('가장 강한 반박을 한 번 시도한 기록(refutation_attempted)');
    }
    if (!evidenceAddedForNode(prism, nodeId)) {
      missing.push(
        '이번에 새로 더해진 근거(grounding) — 하위 항목으로 쪼개거나 반대 검토 기록이 있어야 하고, 혼자 쓴 사유만으로는 부족해요',
      );
    }
    if (missing.length > 0) {
      return {
        ok: false,
        // Stamp `unevaluated`: closed with neither real justification nor a survived
        // rebuttal (argumentation 3-value). The score reads the SAME stamp (below).
        prism: upsertEvaluation(prism, nodeId, { evaluation: 'unevaluated' }),
        reasons: [
          `핵심 항목 "${nodeId}"을(를) 해결로 닫으려면 ${missing.join(', ')}이(가) 필요해요 — 이 닫기는 거부되고, 항목은 '판단 못 함(unevaluated)' 상태로 표시돼요`,
        ],
      };
    }
  }
  const tree = closeNode(prism.tree, nodeId, state, reason, residualRisk);
  const closed: PrismIssueMap = { ...prism, tree };
  // A passing critical resolved-close is argumentation-`justified` (real reason +
  // attempted refutation + added grounding) — stamp it so the termination score reads
  // the same input as this gate (gate↔score self-check, CLAUDE.md).
  const next =
    isCritical && state === 'resolved'
      ? upsertEvaluation(closed, nodeId, { evaluation: 'justified' })
      : closed;
  return { ok: true, prism: next, reasons: [] };
}

// ── ac-2 critical termination (B1 vacuous-truth guard) ───────────────────────

/**
 * MODEL-1 산입 rule: a critical node counts as RESOLVED when it is `resolved`, OR
 * when it is an unknown-close (out_of_scope/user_owned) that carries a recorded
 * residual_risk. A no-residual unknown-close does NOT count (double-checked here
 * even though closePrismNode already rejects it).
 *
 * ac-1 gate↔score self-check: a node the A2 gate stamped `unevaluated` (closed with
 * neither a real justification nor a survived rebuttal) NEVER counts as resolved —
 * even if it reached `resolved` state or bypassed the close gate. The score reads the
 * SAME evaluation input the close gate writes.
 */
function isCriticalResolved(node: CoverageNode, evaluation?: PrismEvaluation): boolean {
  if (evaluation === 'unevaluated') return false;
  if (node.state === 'open') return false;
  if (node.state === 'resolved') return true;
  return node.residual_risk !== undefined && node.residual_risk.trim().length > 0;
}

export interface CriticalTerminationVerdict {
  terminated: boolean;
  reason: string;
}

/**
 * ac-2 critical termination: minimal-launch is reachable when every CRITICAL node
 * is resolved. Non-critical survivors do NOT block termination (the user's call).
 *
 * B1 vacuous-truth guard: `every()` over an EMPTY critical set is `true`, which
 * would make a 0-critical / empty map falsely report terminated (and then fire the
 * launch notification). So termination fires ONLY when the map has actually been
 * explored (≥1 node) AND carries ≥1 critical node — a 0-critical / empty map never
 * terminates or notifies.
 */
export function criticalTermination(prism: PrismIssueMap): CriticalTerminationVerdict {
  if (prism.tree.nodes.length === 0) {
    return {
      terminated: false,
      reason: '아직 살펴본 항목이 하나도 없어요 — 무엇을 정할지 정리를 시작하기 전이에요',
    };
  }
  const criticalIds = new Set(
    prism.severities.filter((s) => s.severity === 'critical').map((s) => s.node_id),
  );
  const criticalNodes = prism.tree.nodes.filter((n) => criticalIds.has(n.id));
  if (criticalNodes.length === 0) {
    return {
      terminated: false,
      reason: '꼭 정해야 할 핵심 항목이 아직 없어요 — 핵심 항목이 하나도 없으면 착수 알림은 뜨지 않아요',
    };
  }
  const unresolved = criticalNodes.filter(
    (n) => !isCriticalResolved(n, evaluationOf(prism, n.id)?.evaluation),
  );
  if (unresolved.length > 0) {
    return {
      terminated: false,
      reason: `아직 정하지 못한 핵심 항목이 ${unresolved.length}개 남았어요`,
    };
  }
  return {
    terminated: true,
    reason: '핵심 항목을 모두 정리했어요 (덜 중요한 항목은 남아 있을 수 있고, 그건 사용자가 판단해요)',
  };
}

// ── ac-2 completeness-termination seed (original-intent coverage) ─────────────

/** One original-intent fragment (from intent.json source_request/goal/in_scope). */
export interface IntentFragment {
  /** Stable fragment id (e.g. 'goal', 'in_scope[0]'). */
  id: string;
  /** The fragment text — becomes the seeded node's label when the fragment is uncovered. */
  text: string;
}

/** One explicit reverse-map entry: a node the agent declares addresses a fragment. */
export interface FragmentMapping {
  fragment_id: string;
  node_id: string;
}

export interface CompletenessSeedResult {
  prism: PrismIssueMap;
  /** Fragment ids that had zero addressing node and were seeded as unresolved. */
  seededFragmentIds: string[];
  reason: string;
}

/**
 * Deterministic seed-node id for an uncovered fragment — stable, so re-running the
 * completeness check never duplicates the seed (idempotent).
 */
export function completenessSeedId(fragmentId: string): string {
  return `prism_seed_${fragmentId}`;
}

/** Seeded gap nodes are shallow surface markers — they carry no depth expectation. */
const COMPLETENESS_SEED_DEPTH_WEIGHT = 0.5;

/**
 * ac-2 completeness-termination seed. Reverse-maps the original-intent fragments
 * (intent.json source_request/goal/in_scope — NOT the root node's `'original intent'`
 * placeholder label) against the explicit node→fragment mappings, and for every
 * fragment that NO node addresses, seeds an `open` node so the gap is SURFACED rather
 * than silently dropped.
 *
 * DETERMINISTIC = explicit-mapping-absence ONLY: a fragment with zero addressing node.
 * The semantic "characterize vs achieve" judgment is out of scope (the model's job) —
 * the mapping itself is supplied by the caller; this shell only detects absence + seeds.
 *
 * Seed severity = NONCRITICAL (the severity default — no assignment added). This is the
 * measured cap-interaction decision (intent unknown). A CRITICAL seed would block
 * `criticalTermination` until resolved, and an unresolvable gap could only be relieved by
 * hitting a divergence cap (cap-halt ≠ termination) — i.e. it would HARD-BLOCK termination,
 * exactly what the intent forbids ("must not create an unterminatable loop"). A noncritical
 * seed surfaces the gap (visible in `renderProgressSummary`) yet provably can NEVER flip
 * `criticalTermination` off (non-critical survivors do not block), so it cannot cause an
 * unterminatable loop. Append-only via `addNode` (rejects dup/dangling); idempotent via
 * `completenessSeedId`. Pure.
 */
export function seedUncoveredFragments(
  prism: PrismIssueMap,
  fragments: readonly IntentFragment[],
  mappings: readonly FragmentMapping[],
): CompletenessSeedResult {
  const nodeIds = new Set(prism.tree.nodes.map((n) => n.id));
  // Covered = a fragment explicitly mapped to an EXISTING node (a mapping to a
  // non-existent node is not coverage — the addressing node must be real).
  const covered = new Set(mappings.filter((m) => nodeIds.has(m.node_id)).map((m) => m.fragment_id));
  const rootExists = nodeIds.has(prism.tree.root_id);
  let tree = prism.tree;
  const seededFragmentIds: string[] = [];
  for (const frag of fragments) {
    if (covered.has(frag.id)) continue;
    const seedId = completenessSeedId(frag.id);
    if (nodeIds.has(seedId)) continue; // already seeded — idempotent, no duplicate
    tree = addNode(tree, {
      id: seedId,
      parent_id: rootExists ? prism.tree.root_id : null,
      label: frag.text,
      origin: 'discovered',
      depth_weight: COMPLETENESS_SEED_DEPTH_WEIGHT,
      state: 'open',
      children: [],
    });
    nodeIds.add(seedId);
    seededFragmentIds.push(frag.id);
  }
  return {
    prism: { ...prism, tree },
    seededFragmentIds,
    reason:
      seededFragmentIds.length === 0
        ? 'every original-intent fragment is addressed by ≥1 node — no completeness gap'
        : `seeded ${seededFragmentIds.length} uncovered original-intent fragment(s) as noncritical surface node(s) — gap surfaced, termination not hard-blocked (ac-2)`,
  };
}

/**
 * Split the original intent (intent.json) into deterministic ac-2 completeness
 * fragments: the `goal` plus each `in_scope` item, each with a STABLE id
 * (`goal` / `in_scope[i]`, index preserved). Blank entries are dropped — an empty
 * fragment can never be "addressed" by a node. Pure: the CLI reads intent.json, this
 * shapes it into the `IntentFragment[]` that `seedUncoveredFragments` consumes.
 */
export function buildIntentFragments(intent: {
  goal?: string;
  in_scope?: readonly string[];
}): IntentFragment[] {
  const fragments: IntentFragment[] = [];
  const goal = intent.goal?.trim();
  if (goal) fragments.push({ id: 'goal', text: goal });
  (intent.in_scope ?? []).forEach((raw, i) => {
    const text = raw.trim();
    if (text) fragments.push({ id: `in_scope[${i}]`, text });
  });
  return fragments;
}

/**
 * Distinctive tokens of a fragment — whitespace/punct-split words of length ≥ 2.
 * Exported so the deep-interview intent-layer semantic critic (wi_260709hzg, #15) reuses
 * the SAME tokenizer — the wi_260708jnp whole-token-match lesson lives here, and re-deriving
 * it would fork that lesson. The intent-layer mapper does whole-token membership on this set.
 */
export function fragmentKeywords(text: string): string[] {
  return text
    .split(/[\s,.;:!?·—…()[\]{}"'`/\\]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

/**
 * Derive the explicit node→fragment mappings TOKEN-LEVEL (no model call): a fragment
 * is mapped to a node when a distinctive keyword of the fragment appears as a WHOLE
 * TOKEN of the node's `label` or `close_reason` (tokenized by the SAME splitter as the
 * fragment). A fragment addressed by zero node stays unmapped, so
 * `seedUncoveredFragments` surfaces it as a gap. This is exactly the intent's
 * deterministic scope ("explicit-mapping-absence ONLY") — no semantic achieve-vs-
 * characterize judgment (that stays the model's job, out of scope). Pure.
 *
 * wi_260708jnp: was `node.text.includes(kw)` (substring), which false-mapped a keyword
 * that is only a word-INTERNAL substring of an unrelated node token (e.g. keyword `id`
 * "matching" `provider`), silently marking a genuinely-uncovered fragment as covered so
 * its gap was never seeded. Whole-token set membership removes that bleed while keeping
 * the same model-free determinism (token equality is as model-free as substring).
 */
export function deriveFragmentMappings(
  fragments: readonly IntentFragment[],
  prism: PrismIssueMap,
): FragmentMapping[] {
  const nodeTokens = prism.tree.nodes.map((n) => ({
    id: n.id,
    tokens: new Set(fragmentKeywords(`${n.label} ${n.close_reason ?? ''}`)),
  }));
  const mappings: FragmentMapping[] = [];
  for (const frag of fragments) {
    const keywords = fragmentKeywords(frag.text);
    if (keywords.length === 0) continue;
    for (const node of nodeTokens) {
      if (keywords.some((kw) => node.tokens.has(kw))) {
        mappings.push({ fragment_id: frag.id, node_id: node.id });
      }
    }
  }
  return mappings;
}

// ── ac-4 minimal-launch notification (one-shot + retract on regression) ───────

/**
 * The user-facing minimal-launch line — everyday language, no ids / jargon / hooks.
 * This is a CONSOLE announcement (ac-4: 질문 훅 절대 미사용), emitted once.
 */
export const MINIMAL_LAUNCH_MESSAGE =
  '핵심으로 꼭 정해야 할 것은 모두 정리됐어요. 지금 최소한으로 착수할 수 있어요. (남은 항목은 착수하면서 정해도 됩니다.)';

/** ac-3 achieve-vs-characterize re-facing prompt shown with the launch re-anchor. */
export const REANCHOR_PROMPT =
  '착수 전에 원래 의도를 다시 봅니다 — 아래 원문을 실제로 "달성"했는지, 아니면 "특징만 서술"하고 넘어갔는지 확인하세요.';

/** Compose the ac-3 re-anchor surface: the re-facing prompt above the intent verbatim. */
function buildReAnchor(originalIntent: string): string {
  return `${REANCHOR_PROMPT}\n\n${originalIntent.trim()}`;
}

export interface LaunchNotification {
  prism: PrismIssueMap;
  /** Emit the one-shot console message NOW. */
  notify: boolean;
  /** A prior notification was CLEARED because the map regressed (new/reopened critical). */
  retracted: boolean;
  message?: string;
  /**
   * ac-3 re-anchor surface — the original-intent text re-faced with an
   * achieve-vs-characterize prompt. Present ONLY when the one-shot launch message
   * fires AND the caller supplied the original intent. NON-BLOCKING: a surface the
   * caller prints beside the launch line, never a gate on termination/launch.
   */
  reAnchor?: string;
}

/**
 * ac-4 launch-notification state machine. When critical scope becomes all-resolved
 * (non-critical may survive) and we have NOT yet notified → announce once and stamp
 * `notified_at` (durable one-shot). When the map has regressed out of termination
 * yet still carries a stamp → RETRACT it (clear `notified_at`) so re-reaching
 * re-announces. Pure; the caller owns the console write + persistence.
 *
 * ac-3: when the launch message fires and `originalIntent` is supplied, the returned
 * notification ALSO carries the `reAnchor` surface (original intent + achieve-vs-
 * characterize prompt). It is NON-BLOCKING — added to the payload only, it never
 * changes the notify/retract flow.
 */
export function resolveLaunchNotification(
  prism: PrismIssueMap,
  now: Date,
  originalIntent?: string,
): LaunchNotification {
  const { terminated } = criticalTermination(prism);
  const alreadyNotified = prism.notified_at !== undefined;
  if (terminated) {
    if (alreadyNotified) return { prism, notify: false, retracted: false };
    const hasIntent = originalIntent !== undefined && originalIntent.trim().length > 0;
    return {
      prism: { ...prism, notified_at: now.toISOString() },
      notify: true,
      retracted: false,
      message: MINIMAL_LAUNCH_MESSAGE,
      ...(hasIntent ? { reAnchor: buildReAnchor(originalIntent as string) } : {}),
    };
  }
  if (alreadyNotified) {
    const { notified_at: _dropped, ...rest } = prism;
    return { prism: rest as PrismIssueMap, notify: false, retracted: true };
  }
  return { prism, notify: false, retracted: false };
}

// ── ac-3 label-only progress summary ─────────────────────────────────────────

/**
 * ac-3 progress summary — the labels of the still-open items, and NOTHING else.
 * Deliberately NOT `serializePlanDialog` (that renders node ids). No node id, no
 * severity enum, no coverage axis name, no schema field leaks — only the
 * natural-language `label`, so the user reads plain scope, not internals. The root
 * container (root_id) is excluded — it is the intent frame, not a remaining item.
 */
export function renderProgressSummary(prism: PrismIssueMap): string[] {
  return prism.tree.nodes
    .filter((n) => n.state === 'open' && n.id !== prism.tree.root_id)
    .map((n) => n.label);
}

// ── ac-10 divergence detection + cap-invocation loop ─────────────────────────

/** Normalize a question/challenge signature so trivial variants collapse to one key. */
function normalizeSignature(signature: string): string {
  return signature.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Consecutive trivial-question streak that trips a divergence flag. */
export const TRIVIAL_STREAK_CAP = 3;

export type DivergenceKind = 'repeat_question' | 'trivial_streak' | 'decided_conflict_no_evidence';

export interface DivergenceVerdict {
  diverged: boolean;
  kind?: DivergenceKind;
  /** What to do — never a silent drop: cap-stop escalates, challenge-node admits, continue proceeds. */
  action: 'cap-stop' | 'challenge-node' | 'continue';
  reason: string;
}

export interface PrismRoundSignature {
  signature: string;
  trivial: boolean;
}

export interface PrismChallenge {
  /** The already-decided item this challenge contests. */
  decided_id: string;
  signature: string;
  /** true = the re-challenge brings NEW grounding evidence (admissible once). */
  new_evidence: boolean;
}

export interface PrismRound {
  /** Nodes this round appended to the tree (for the tree-node cap). */
  addedNodeCount?: number;
  question?: PrismRoundSignature;
  challenge?: PrismChallenge;
}

/**
 * ac-10 deterministic divergence detection. Flags — WITHOUT any LLM call — the
 * three meaningless-divergence shapes the design names:
 *   - repeat_question: a near-duplicate of an earlier question (쳇바퀴, no new signal);
 *   - trivial_streak:  TRIVIAL_STREAK_CAP consecutive trivial questions;
 *   - decided_conflict_no_evidence: re-challenging a decided item with NO new evidence.
 * A challenge WITH new evidence is admissible → routes to a VISIBLE challenge node
 * (once), never a silent suppression. Pure and deterministic.
 */
export function detectDivergence(
  round: PrismRound,
  history: readonly PrismRoundSignature[],
): DivergenceVerdict {
  if (round.challenge) {
    if (round.challenge.new_evidence) {
      return {
        diverged: false,
        action: 'challenge-node',
        reason: `이미 정한 "${round.challenge.decided_id}"에 새 근거가 있어요 — 다시 볼 항목으로 한 번만 받아들여요`,
      };
    }
    return {
      diverged: true,
      kind: 'decided_conflict_no_evidence',
      action: 'cap-stop',
      reason: `이미 정한 "${round.challenge.decided_id}"을(를) 새 근거 없이 다시 문제 삼고 있어요 — 겉도는 반복으로 보고 멈춰요(조용히 넘기지 않고 드러냅니다)`,
    };
  }
  if (round.question) {
    const key = normalizeSignature(round.question.signature);
    if (history.some((h) => normalizeSignature(h.signature) === key)) {
      return {
        diverged: true,
        kind: 'repeat_question',
        action: 'cap-stop',
        reason: '앞선 질문과 거의 똑같아요 — 새로운 내용 없이 제자리를 도는 반복이에요(쳇바퀴)',
      };
    }
    if (round.question.trivial) {
      let streak = 1;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i]?.trivial) streak += 1;
        else break;
      }
      if (streak >= TRIVIAL_STREAK_CAP) {
        return {
          diverged: true,
          kind: 'trivial_streak',
          action: 'cap-stop',
          reason: `사소한 질문이 ${streak}번 연달아 나왔어요 — 겉도는 반복으로 봐요`,
        };
      }
    }
  }
  return { diverged: false, action: 'continue', reason: '벗어난 신호 없음 — 계속 진행해요' };
}

/**
 * Default prism caps (§8.2-style — node/event/round upper bounds). A cap hit is a
 * STOP+escalate, never success (cap ≠ converged). Configurable by the caller.
 */
export const PRISM_CAPS: CoverageCaps = {
  callsPerNode: 8,
  treeNodeCount: 60,
  totalRounds: 40,
};

export interface PrismDriveResult {
  roundsRun: number;
  treeNodeCount: number;
  /** A cap was reached → the loop stopped and escalated (NOT termination/success). */
  halted: boolean;
  /** Cap reasons when halted (empty otherwise) — cap ≠ converged. */
  escalation: string[];
  /** Every divergence verdict observed, in order (visible, never silent). */
  divergences: DivergenceVerdict[];
}

/**
 * ac-10 cap-invocation loop. Drives the interview rounds and — this is the point —
 * ACTUALLY CALLS `capStatus` (the reused coverage cap evaluator) BEFORE each round.
 * The moment any cap is reached the loop HALTS and escalates; it does NOT keep
 * running or report success (cap ≠ converged, cap ≠ termination). Deterministic;
 * the caller supplies the already-produced rounds and the caps.
 */
export function runPrismRounds(
  rounds: readonly PrismRound[],
  caps: CoverageCaps = PRISM_CAPS,
  start: Partial<CapUsage> = {},
): PrismDriveResult {
  let usage: CapUsage = {
    callsThisNode: start.callsThisNode ?? 0,
    treeNodeCount: start.treeNodeCount ?? 0,
    roundsRun: start.roundsRun ?? 0,
  };
  const history: PrismRoundSignature[] = [];
  const divergences: DivergenceVerdict[] = [];
  for (const round of rounds) {
    // REAL cap call every iteration, BEFORE processing the round.
    const cap = capStatus(caps, usage);
    if (cap.capped) {
      return {
        roundsRun: usage.roundsRun,
        treeNodeCount: usage.treeNodeCount,
        halted: true,
        escalation: cap.reasons,
        divergences,
      };
    }
    if (round.question || round.challenge) {
      divergences.push(detectDivergence(round, history));
      if (round.question) history.push(round.question);
    }
    usage = {
      ...usage,
      treeNodeCount: usage.treeNodeCount + (round.addedNodeCount ?? 0),
      roundsRun: usage.roundsRun + 1,
    };
  }
  return {
    roundsRun: usage.roundsRun,
    treeNodeCount: usage.treeNodeCount,
    halted: false,
    escalation: [],
    divergences,
  };
}
