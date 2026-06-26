import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ZodTypeAny, z } from 'zod';
import { commandProvider } from '~/acg/fitness/command-provider';
import { type FitnessContext, runFitness } from '~/acg/fitness/fitness-runner';
import { compositeProvider } from '~/acg/fitness/injected-provider';
import { localDir } from '~/core/ditto-paths';
import { FitnessFunctionStore } from '~/core/fitness-function-store';
import { ensureDir, writeJson } from '~/core/fs';
import {
  type ConflictDisposition,
  attestAcVerdicts,
  completionEvidenceGate,
  completionGate,
  convergenceGate,
  decisionConflictGate,
  intentDriftGate,
  knowledgeUpdateGate,
  nonPassTerminationGate,
  resolvabilityBlockers,
  riskRecordBlockers,
} from '~/core/gates';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import { type AcgAssuranceSnapshot, acgAssuranceSnapshot } from '~/schemas/acg-assurance-snapshot';
import { type AcgImpactGraph, acgImpactGraph } from '~/schemas/acg-impact-graph';
import { type AcgReviewGraph, acgReviewGraph } from '~/schemas/acg-review-graph';
import {
  type AcgSemanticCompatibility,
  acgSemanticCompatibility,
} from '~/schemas/acg-semantic-compatibility';
import { type Autopilot, autopilot as autopilotSchema } from '~/schemas/autopilot';
import { completionContract } from '~/schemas/completion-contract';
import { convergence as convergenceSchema } from '~/schemas/convergence';
import {
  type DecisionConflictCarrier,
  decisionConflictCarrier,
} from '~/schemas/decision-conflict-carrier';
import { type Dialectic, dialectic as dialecticSchema } from '~/schemas/dialectic';
import { intentContract } from '~/schemas/intent';
import { intentMetric } from '~/schemas/intent-metric';
import { type KnowledgeGateCarrier, knowledgeGateCarrier } from '~/schemas/knowledge-gate-carrier';
import type { WorkItem } from '~/schemas/work-item';
import type { HookHandler, HookInput } from './runtime';
import { computeSemanticNudge } from './semantic-nudge';

/** Opponent severities that make an oracle-linked objection an admissible blocker (§6). */
const ADMISSIBLE_SEVERITIES: ReadonlySet<string> = new Set(['critical', 'high']);

/**
 * A `maps_to` anchor that is a file:line or file path (e.g. `src/core/gates.ts:42`
 * or `src/core/gates.ts`). Returns the repo-relative file path (line suffix
 * stripped) when the anchor is a file form, else undefined. Only file-shaped
 * anchors get the backward-finding existence check (ac-4 clause 2); ac-N ids,
 * `intent:`/`doc:` refs, and free prose are intentionally NOT file anchors and
 * are left untouched. The shape gate is deliberately narrow: a single path
 * token (no whitespace) with a file extension, not prefixed by a known oracle
 * scheme — so `ac-3/empty-input` (no extension) and prose stay out of scope.
 */
function fileAnchorPath(mapsTo: string): string | undefined {
  const anchor = mapsTo.trim();
  if (/^(ac-|intent:|doc:)/.test(anchor)) return undefined;
  const path = anchor.replace(/:\d+$/, '');
  if (!/^[\w./-]+\.[A-Za-z0-9]+$/.test(path)) return undefined;
  return path;
}

/**
 * Cross-check one dialectic ledger (reviews/dialectic-<n>.json) against the
 * convergence honesty discipline. Returns continuation reasons:
 * - a synthesizer verdict of reject/blocked is an unresolved deliberation;
 * - an admissible objection (oracle-linked `maps_to` ∧ severity critical|high)
 *   that the synthesizer neither accepted nor grounded-rejected is unresolved.
 * Objections without an oracle are *taste* — surfaced, never a blocker.
 *
 * ac-4 clause 2 (wi_260623uap): when `repoRoot` is supplied, a backward-finding
 * objection whose `maps_to` is a file:line / file path anchor is additionally
 * checked for ANCHOR EXISTENCE — if the file does not resolve on disk the oracle
 * is unverifiable/stale and continuation is forced (fail-safe over-block,
 * ADR-0024 transparency). Non-file anchors (ac-N, intent:, doc:, prose) are out
 * of scope and unaffected. `repoRoot` is optional for backward-compatible
 * one-arg callers (existence check then skipped); the function stays pure over
 * its inputs (sole side-channel is a sync filesystem existence probe).
 */
export function dialecticForcesContinuation(d: Dialectic, repoRoot?: string): string[] {
  const reasons: string[] = [];
  const verdict = d.synthesizer.verdict;
  if (verdict === 'reject' || verdict === 'blocked') {
    reasons.push(`dialectic ${d.review_id} verdict=${verdict}; deliberation not resolved`);
  }
  // Multi-round convergence (wi_260606ezn): a `revise` verdict is NOT a close
  // while rounds remain. If round < max_rounds and required_edits are still open,
  // force another round — apply the required_edits, then re-deliberate at round+1.
  // With the default max_rounds=1 this never fires (round 1 = max → revise closes),
  // preserving the "one small deliberation, no infinite debate" default.
  if (
    verdict === 'revise' &&
    d.round < d.input.constraints.max_rounds &&
    d.synthesizer.required_edits.length > 0
  ) {
    reasons.push(
      `dialectic ${d.review_id}: verdict=revise at round ${d.round}/${d.input.constraints.max_rounds} with ${d.synthesizer.required_edits.length} required_edits open — re-deliberate next round`,
    );
  }
  // Resolution is matched by an explicit echo in accepted/rejected_objections:
  // the synthesizer counts an objection as resolved by referencing its stable
  // `id` OR its `claim` string verbatim. Resolving by `id` is paraphrase-tolerant
  // (the claim text need not be echoed); verbatim claim echo remains a backward-
  // compatible fallback for objections/ledgers without an id. Anything not
  // explicitly echoed reads as unresolved → forces continuation. This is
  // deliberately fail-safe (over-block, never a false pass); the id-or-claim
  // resolution contract is stated in the synthesizer agent body.
  const resolved = new Set<string>([
    ...d.synthesizer.accepted_objections,
    ...d.synthesizer.rejected_objections.map((r) => r.objection),
  ]);
  for (const obj of d.opponent.objections) {
    const admissible = obj.maps_to.trim().length > 0 && ADMISSIBLE_SEVERITIES.has(obj.severity);
    const idResolved = obj.id !== undefined && resolved.has(obj.id);
    if (admissible && !resolved.has(obj.claim) && !idResolved) {
      reasons.push(`dialectic ${d.review_id}: admissible objection unresolved — ${obj.claim}`);
    }
    // ac-4 clause 2: backward-finding anchor existence. Additive to (not a
    // replacement for) the resolution check above — an admissible objection
    // whose file:line/path oracle does not resolve on disk is unverifiable, so
    // we over-block (deliberately fail-safe, never a false pass).
    if (admissible && repoRoot !== undefined) {
      const anchor = fileAnchorPath(obj.maps_to);
      if (anchor !== undefined && !existsSync(join(repoRoot, anchor))) {
        reasons.push(
          `dialectic ${d.review_id}: objection maps_to '${obj.maps_to}' does not resolve to an existing file — backward-finding oracle unverifiable/stale`,
        );
      }
    }
  }
  return reasons;
}

/**
 * Work item statuses that still owe a verdict; a stop with all three ledgers
 * absent is a contract violation in these states (§M1.4 strong-block update,
 * 2026-05-31). 'done'/'abandoned' are terminal — nothing further to verify.
 */
const NON_TERMINAL_STATUSES: ReadonlyArray<WorkItem['status']> = [
  'draft',
  'in_progress',
  'blocked',
  'partial',
  'unverified',
];

type ArtifactRead<T> =
  | { status: 'absent' }
  | { status: 'malformed'; name: string }
  | { status: 'ok'; data: T };

async function readArtifact<S extends ZodTypeAny>(
  path: string,
  schema: S,
  name: string,
): Promise<ArtifactRead<z.infer<S>>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { status: 'absent' };
  }
  // File exists → from here on, a parse/validation failure is a gate-input
  // violation (fail-closed), NOT a hook crash. (D4 two-layer distinction.)
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    if (!parsed.success) return { status: 'malformed', name };
    return { status: 'ok', data: parsed.data };
  } catch {
    return { status: 'malformed', name };
  }
}

/**
 * Read every reviews/dialectic-*.json ledger for a work item. A file that
 * exists but fails schema parse is a gate-input violation (malformed → fail
 * closed), exactly like the single-artifact reads. An absent reviews/ dir is a
 * no-op (empty list) so work items that never ran a deliberation are unaffected.
 */
async function readDialecticLedgers(
  dir: string,
): Promise<{ status: 'ok'; items: Dialectic[] } | { status: 'malformed'; name: string }> {
  const reviewsDir = join(dir, 'reviews');
  let names: string[];
  try {
    names = await readdir(reviewsDir);
  } catch {
    return { status: 'ok', items: [] };
  }
  const files = names.filter((n) => /^dialectic-.*\.json$/.test(n)).sort();
  const items: Dialectic[] = [];
  for (const name of files) {
    const read = await readArtifact(join(reviewsDir, name), dialecticSchema, `reviews/${name}`);
    if (read.status === 'malformed') return { status: 'malformed', name: read.name };
    if (read.status === 'ok') items.push(read.data);
  }
  return { status: 'ok', items };
}

/**
 * Does a real mutating plan await approval? A mutating node is one owned by the
 * implementer (kinds implement/fix/docs → owner 'implementer', autopilot §2.2)
 * that is still pending. Without one, an `approval_gate.status==='pending'` is an
 * empty/bypass autopilot.json with no plan to surface — it must not yield past
 * the completion gate.
 */
function hasPendingMutatingNode(a: Autopilot): boolean {
  return a.nodes.some((n) => n.owner === 'implementer' && n.status === 'pending');
}

/**
 * A degenerate-pending autopilot is PRESENT but provides no verification path:
 * approval_gate.status==='pending' yet there is no pending mutating node to
 * surface. Treated as "no real plan" so the strong-block fires (§5#7 bypass).
 */
function isDegeneratePendingAutopilot(a: Autopilot): boolean {
  return a.approval_gate.status === 'pending' && !hasPendingMutatingNode(a);
}

function hasRunnableNode(a: Autopilot): boolean {
  const byId = new Map(a.nodes.map((n) => [n.id, n]));
  const depsPassed = (n: Autopilot['nodes'][number]) =>
    n.depends_on.every((d) => byId.get(d)?.status === 'passed');
  return a.nodes.some((n) => n.status === 'running' || (n.status === 'pending' && depsPassed(n)));
}

/**
 * Does the autopilot graph force continuation? (plan M1.4 branch 나)
 * Continuation only when a node is actually runnable AND approval is not pending.
 * approval_gate.status==='pending' yields (exit 0) so M2.3 can surface the plan;
 * a graph with only blocked/terminal nodes also yields.
 */
export function autopilotForcesContinuation(a: Autopilot): boolean {
  if (a.approval_gate.status === 'pending') return false;
  return hasRunnableNode(a);
}

/**
 * Does the autopilot graph lack a real plan? True when no autopilot.json exists at
 * all (pilot absent) OR a fig-leaf autopilot.json exists with zero mutating
 * (implementer-owned) nodes — the "플랜 없는 degenerate" bypass (handoff §2 B). A
 * graph that ever held an implementer node means the path was genuinely taken, so
 * this returns false for it.
 */
function autopilotHasNoPlan(pilot: ArtifactRead<Autopilot>): boolean {
  if (pilot.status === 'absent') return true;
  if (pilot.status === 'ok') return !pilot.data.nodes.some((n) => n.owner === 'implementer');
  return false; // malformed is fail-closed earlier; never reached for the gate
}

/**
 * (B) plan→autopilot transition gate (中, wi_260615xby). Returns a continuation
 * reason when a non-trivial work item is about to CLOSE on a completion.json that
 * passes its own gate, yet autopilot was never really run (no autopilot.json, or a
 * fig-leaf graph with no plan). It bypassed the finalize→bootstrap→drive path.
 *
 * Guards (all must hold), each closing a dialectic objection:
 * - `completionWouldClose` — the completion passes completionGate+evidenceGate, so
 *   the work is actually closing. A partial/handoff checkpoint (non-passing
 *   completion) is NOT a bypass-to-close and never double-messages (OBJ-1/OBJ-5).
 * - `autopilotHasNoPlan(pilot)` — absent OR degenerate fig-leaf (OBJ-2).
 * - non-terminal status — done/abandoned already closed.
 * - not `autopilot_exempt` — the explicit escape hatch.
 * - changed code (completion OR work-item `changed_files` non-empty) — a no-change
 *   close (investigation/docs) is not the bypass this gate targets.
 * Keys on completion PRESENT + no plan, disjoint from the all-absent strong-block.
 */
export function autopilotBypassForcesContinuation(
  workItem: WorkItem,
  completion: ArtifactRead<z.infer<typeof completionContract>>,
  pilot: ArtifactRead<Autopilot>,
  completionWouldClose: boolean,
): string[] {
  if (completion.status !== 'ok' || !completionWouldClose) return [];
  if (!autopilotHasNoPlan(pilot)) return [];
  if (!NON_TERMINAL_STATUSES.includes(workItem.status)) return [];
  if (workItem.autopilot_exempt === true) return [];
  const changedCode = completion.data.changed_files.length > 0 || workItem.changed_files.length > 0;
  if (!changedCode) return [];
  return [
    `work item ${workItem.id} changed code but is closing on completion.json alone, without going through autopilot (no real plan was ever run). Non-trivial work should run finalize → bootstrap → autopilot drive (ditto autopilot bootstrap ${workItem.id}, then the autopilot skill). To close without autopilot, run "ditto autopilot exempt ${workItem.id}" or transition the work item to done/abandoned.`,
  ];
}

/**
 * Does an ACG ReviewGraph ledger force continuation? (WU-6 / producer wiring —
 * Review by Exception, §5). A file classified `risk: 'high'` that carries NO
 * evidence is a risky change nobody has shown to be handled → the work item is
 * not done. Attaching an `evidence` object (a test, a human's review note)
 * clears it. Returns one continuation reason per such file (path|journey_id
 * identity). Low/medium-risk files never block here, and a high-risk file WITH
 * evidence passes — only un-evidenced high-risk changes block.
 *
 * Why evidence-absence, not the `unresolved` flag: per 20-contracts §5 the
 * `unresolved` marker maps from reviewer-output `unverified[]` (and the adapter
 * fixes those at risk=low), so `high ∧ unresolved` is never produced and would
 * make this gate inert. Keying on "high-risk without evidence" is what makes the
 * gate actually fire on the exception set a human must judge.
 */
export function acgReviewForcesContinuation(graph: AcgReviewGraph): string[] {
  const reasons: string[] = [];
  for (const file of graph.files) {
    if (file.risk === 'high' && file.evidence === undefined) {
      const id = file.path ?? file.journey_id ?? '(unidentified)';
      reasons.push(`acg review: high-risk change without evidence — ${id} (${file.risk_reason})`);
    }
  }
  return reasons;
}

/**
 * Does an AssuranceSnapshot (fitness evaluation, 단계8) force continuation? A
 * fitness function result with `outcome: 'fail'` is a blocking property the
 * change broke — the runner already applied the cadence + delta_only policy when
 * it set the outcome (a `warn`/`track` function never lands as 'fail'). One
 * continuation reason per failed function; pass/skip never block.
 */
export function assuranceSnapshotForcesContinuation(snapshot: AcgAssuranceSnapshot): string[] {
  const reasons: string[] = [];
  for (const r of snapshot.results) {
    if (r.outcome === 'fail') {
      const n = r.new_violations ?? r.violations ?? 0;
      reasons.push(`fitness: ${r.function_id} failed — ${n} blocking violation(s)`);
    }
  }
  return reasons;
}

/**
 * Does an ImpactGraph (단계3) force continuation? `unresolved[]` is impact the
 * analyzer could not statically settle and explicitly recorded rather than hide
 * (dynamic dispatch, reflection, cross-repo, journey_unknown / default-deny).
 * Each entry is unverified risk a human must map or dismiss → one continuation
 * reason per unresolved entry. Resolved `affected_nodes` never block here; once
 * the impact is mapped, re-running the producer yields a clean graph that clears
 * the gate (same shape as `acgReviewForcesContinuation`).
 */
export function impactForcesContinuation(graph: AcgImpactGraph): string[] {
  return graph.unresolved.map((u) => `impact: unresolved ${u.kind} — ${u.path} (${u.reason})`);
}

/**
 * Does a SemanticCompatibility (단계6) force continuation? Type safety ≠ meaning
 * safety (20-contracts §4); the verdict gates 단계6 통과/차단 (§4 line 489, line 730).
 * Two verdicts block, mirroring the default-deny of the impact/journey gates and
 * DITTO's "completion is gated by evidence":
 *   - `semantic_safe: 'no'` WITHOUT `intended_breaking` → an UNINTENDED meaning
 *     regression (the `User|null → User` class, §4 example). The methodology §6
 *     failure path returns this to 단계5.
 *   - `semantic_safe: 'unverified'` → meaning could not be checked (no behavior
 *     test); an evidence gap a human must close (verify or declare intended).
 * A declared-intended break (`'no' ∧ intended_breaking`) and a verified-safe
 * change (`'yes'`) clear. The artifact carries ALL detected pairs (G4 multi-
 * change); every blocking pair contributes a reason, so resolving one does not
 * clear the others.
 */
export function semanticForcesContinuation(sem: AcgSemanticCompatibility): string[] {
  return sem.changes.flatMap((change) => {
    const v = change.verdict;
    const where = `${change.before} → ${change.after}`;
    if (v.semantic_safe === 'unverified') {
      return [
        `semantic: meaning compatibility unverified for ${where} — verify or declare intended`,
      ];
    }
    if (v.semantic_safe === 'no' && v.intended_breaking !== true) {
      return [`semantic: unintended meaning break ${where} (was: ${change.old_meaning})`];
    }
    return [];
  });
}

/** A graph node carrying durable-knowledge responsibility (kind or owner). */
function isKnowledgeNode(n: Autopilot['nodes'][number]): boolean {
  return n.kind === 'knowledge' || n.owner === 'knowledge-curator';
}

/** Terminal = the node has finished running; only then is its gate due to fire. */
const TERMINAL_NODE_STATUSES: ReadonlySet<string> = new Set(['passed', 'failed', 'blocked']);

/**
 * Does the knowledge-update gate force continuation? (axis-4, G1 runtime wiring.)
 * INERT unless the graph has a TERMINAL knowledge node (kind `knowledge` or owner
 * `knowledge-curator`) — a no-knowledge work item, or one whose knowledge node has
 * not finished, never blocks. The gate input is the persisted carrier
 * (knowledge-gate.json); an absent carrier is also inert (a no-trigger work item
 * that recorded nothing is the valid EXPLICIT skip — ADR-0010 (b): the gate
 * enforces "declared trigger ↔ actual record" consistency, never "record
 * something"). Malformed carrier fail-closes upstream like every other ledger.
 */
export function knowledgeForcesContinuation(
  graph: Autopilot,
  carrier: KnowledgeGateCarrier | undefined,
): string[] {
  const hasTerminalKnowledgeNode = graph.nodes.some(
    (n) => isKnowledgeNode(n) && TERMINAL_NODE_STATUSES.has(n.status),
  );
  if (!hasTerminalKnowledgeNode || carrier === undefined) return [];
  const g = knowledgeUpdateGate(carrier.triggers, carrier.delta);
  return g.pass ? [] : g.reasons.map((r) => `knowledge update — ${r}`);
}

/**
 * Does a residual labeled in the completion's `unverified[]` force continuation?
 * (ac-2 runtime wiring.) Delegates the classification to the pure
 * `resolvabilityBlockers` (gates.ts default-DENY): an `agent_resolvable` residual
 * (or one naming an owned AC) ALWAYS blocks — parking what the agent can resolve is
 * the anti-pattern; an ungrounded `blocked_external`/`accepted_tradeoff`/`user_decision`
 * residual blocks as an ungrounded residual claim. It inspects resolvability
 * regardless of `out_of_scope` (an item marked out_of_scope=true yet labeled
 * agent_resolvable is exactly the parked-resolvable bypass to catch). One reason
 * per blocker; a user-decision surface gets distinct `deferred_needs_user_ok`
 * wording (the user must decide or ground it), not the plain resolvable/ungrounded
 * phrasing. The CALLER gates this on `completionWouldClose` so it only fires on a
 * completion that actually passes its own gates (no double-message on a partial).
 */
export function residualResolvabilityForcesContinuation(
  completion: z.infer<typeof completionContract>,
  workItem: WorkItem,
): string[] {
  const acceptanceIds = workItem.acceptance_criteria.map((c) => c.id);
  return resolvabilityBlockers(completion.unverified, acceptanceIds).map((b) =>
    b.userDecision
      ? `residual deferred_needs_user_ok — ${b.item}: ${b.reason}`
      : `residual blocks pass-close — ${b.item}: ${b.reason}`,
  );
}

/**
 * Does a structured residual-risk record in the completion's `remaining_risk_records[]`
 * force continuation? (ac-3 completion-side enforcement — the structural sibling of
 * `residualResolvabilityForcesContinuation`.) It delegates to `riskRecordBlockers`
 * (gates.ts), which routes the records through the SAME default-DENY classifier the
 * `unverified[]` residual gate uses, so the two residual surfaces share ONE label space
 * (R11) and never drift. An `agent_resolvable` record ALWAYS blocks (parking what the
 * agent can resolve is the anti-pattern — an unhandled auto-resolvable risk must not
 * silently leak through completion); a `blocked_external`/`accepted_tradeoff`/
 * `user_decision` record releases ONLY with grounding. R5/ADR-0018: a tool-absence
 * record is `blocked_external`+grounding and therefore releases — never
 * `agent_resolvable`. Absent records (the legacy completion shape) ⇒ []. The CALLER
 * gates this on `completionWouldClose`, exactly like the unverified[] residual gate, so
 * it fires only on a completion that passes its own gates (no double-message on a partial).
 */
export function riskRecordForcesContinuation(
  completion: z.infer<typeof completionContract>,
  workItem: WorkItem,
): string[] {
  const acceptanceIds = workItem.acceptance_criteria.map((c) => c.id);
  return riskRecordBlockers(completion.remaining_risk_records, acceptanceIds).map((b) =>
    b.userDecision
      ? `residual-risk record deferred_needs_user_ok — ${b.item}: ${b.reason}`
      : `residual-risk record blocks pass-close — ${b.item}: ${b.reason}`,
  );
}

/**
 * Decision-conflict guardrail (ADR-0020). The detecting node declares the ADR
 * conflicts it judged in a carrier; this runs `decisionConflictGate` and splits the
 * dispositions two ways, mirroring the gate's routing:
 *  - `reasons` (force continuation): conflicts that must not silently proceed —
 *    intent conflicts under autopilot (D3 fail-closed) and any `ask_user` route;
 *  - `advisories` (non-blocking disclosure): auto-aligned method conflicts and
 *    `justify`-ed preferences — surfaced anyway, because D2's transparency invariant
 *    forbids silent autonomous compliance: the basis must reach the OUTPUT.
 * Absent carrier → inert (declaring no conflicts is a valid run).
 */
export function decisionConflictForcesContinuation(carrier: DecisionConflictCarrier | undefined): {
  reasons: string[];
  advisories: string[];
} {
  if (carrier === undefined) return { reasons: [], advisories: [] };
  const { dispositions } = decisionConflictGate(carrier.conflicts, carrier.mode);
  const line = (d: ConflictDisposition) =>
    `${d.conflict.adr_id} (${d.conflict.kind}/${d.conflict.level}) → ${d.route}: ${d.conflict.basis}`;
  const blocks = (d: ConflictDisposition) => d.route === 'block' || d.route === 'ask_user';
  return {
    reasons: dispositions.filter(blocks).map((d) => `decision conflict — ${line(d)}`),
    advisories: dispositions
      .filter((d) => !blocks(d))
      .map((d) => `decision conflict (disclosed, agent followed ADR) — ${line(d)}`),
  };
}

/**
 * fitness 자동 트리거 — 정의된 fitness가 있으면 stop 시점에 평가해 assurance-snapshot.json을
 * 최신화한다(stale 없음). deterministic은 commandProvider가 실제 평가한다.
 * llm_judged/executed는 에이전트가 미리 산출한 표준 경로 verdict 파일
 * (.ditto/local/work-items/<wi>/fitness-verdicts.json)이 있으면 합성 provider가 그 판정을 소비하고,
 * 없으면 기존 동작(provider가 skip → fail-open)을 유지한다.
 * fail-open: 정의 없음·실행 에러는 조용히 반환해 기존 게이트(이전 snapshot/없음)로 폴백한다.
 */
export async function maybeRunFitness(
  repoRoot: string,
  workItemId: string,
  dir: string,
): Promise<void> {
  try {
    const fns = await new FitnessFunctionStore(repoRoot).read(workItemId);
    if (!fns || fns.length === 0) return;
    const ctx: FitnessContext = {
      trigger: 'per_change',
      changeRef: workItemId,
      riskKnown: false,
      producedAt: new Date().toISOString(),
    };
    const verdictsPath = join(dir, 'fitness-verdicts.json');
    const provider = (await Bun.file(verdictsPath).exists())
      ? compositeProvider(repoRoot, verdictsPath)
      : commandProvider(repoRoot);
    const snapshot = await runFitness(fns, ctx, provider);
    await ensureDir(dir);
    await writeJson(join(dir, 'assurance-snapshot.json'), acgAssuranceSnapshot, snapshot);
  } catch {
    // fail-open
  }
}

const DRIFT_HOPS = ['H1', 'H2', 'H3'] as const;

/** Distinct intent-chain hops named in the drift reason/advisory strings. */
function driftHops(lines: string[]): Array<(typeof DRIFT_HOPS)[number]> {
  return DRIFT_HOPS.filter((h) => lines.some((l) => l.includes(`${h}:`)));
}

/**
 * Persist the intentDriftGate verdict to metrics.jsonl as a SIDE EFFECT of the
 * Stop gate (measurement-infra P3). This is the only thing P3 adds to Stop —
 * exit code / blocking / advisory logic is untouched. Fail-open: a measurement
 * write must never break the gate. De-dup against the last record (Stop fires
 * repeatedly on the same state; without de-dup the drift incidence would be
 * polluted by the Stop count, D2/§7). Clean (no drift) stops record nothing.
 */
async function recordIntentDriftMetric(
  repoRoot: string,
  workItemId: string,
  drift: { reasons: string[]; advisories: string[] },
): Promise<void> {
  if (drift.reasons.length === 0 && drift.advisories.length === 0) return;
  try {
    const store = new WorkItemStore(repoRoot);
    const last = (await store.readMetrics(workItemId)).at(-1);
    if (
      last &&
      JSON.stringify(last.blocking_reasons) === JSON.stringify(drift.reasons) &&
      JSON.stringify(last.advisories) === JSON.stringify(drift.advisories)
    ) {
      return; // identical to the previous record → de-dup
    }
    const record = intentMetric.parse({
      ts: new Date().toISOString(),
      work_item_id: workItemId,
      kind: 'intent_drift',
      source: 'stop_hook',
      blocking_reasons: drift.reasons,
      advisories: drift.advisories,
      hops: driftHops([...drift.reasons, ...drift.advisories]),
    });
    await store.appendMetricLine(workItemId, JSON.stringify(record));
  } catch {
    // measurement is best-effort; never let it affect the Stop verdict
  }
}

export const stopHandler: HookHandler = async (input: HookInput) => {
  const raw = (input.raw ?? {}) as Record<string, unknown>;

  // (1) 8-iteration guard: once we have forced a continuation, let Claude stop.
  if (raw.stop_hook_active === true) return { exitCode: 0 };

  // Stop only branches on what it actually sees. API/rate-limit/auth/max-output
  // arrive as the separate StopFailure event whose output is ignored — not here.
  const sessionId = typeof raw.session_id === 'string' ? raw.session_id : undefined;
  if (!sessionId)
    return {
      exitCode: 0,
      stderr:
        'DITTO Stop completion gate did not run: no session_id was provided, so the completion/convergence gates could not be checked.\n',
    };

  const pointer = await new SessionPointerStore(input.repoRoot).get(sessionId);
  if (!pointer) return { exitCode: 0 };

  let workItem: Awaited<ReturnType<WorkItemStore['get']>>;
  try {
    workItem = await new WorkItemStore(input.repoRoot).get(pointer);
  } catch {
    return { exitCode: 0 }; // no loadable work item → nothing to judge
  }

  const dir = localDir(input.repoRoot, 'work-items', pointer);
  // fitness 자동 트리거: 게이트가 snapshot을 읽기 전에 정의된 fitness를 최신 평가한다.
  await maybeRunFitness(input.repoRoot, pointer, dir);
  const completion = await readArtifact(
    join(dir, 'completion.json'),
    completionContract,
    'completion.json',
  );
  const conv = await readArtifact(
    join(dir, 'convergence.json'),
    convergenceSchema,
    'convergence.json',
  );
  const pilot = await readArtifact(join(dir, 'autopilot.json'), autopilotSchema, 'autopilot.json');
  // Frozen intent — the source of truth the chain must stay conserved against
  // (axis-2 intent drift). Absent → no intent flow to check; malformed → fail
  // closed like every other ledger.
  const intent = await readArtifact(join(dir, 'intent.json'), intentContract, 'intent.json');
  const dialectics = await readDialecticLedgers(dir);
  // ACG ReviewGraph ledger (WU-6, D5). Lives in the work-item dir alongside the
  // other ledgers (stop reads one directory); absent → no-op, malformed → fail
  // closed, exactly like the others. D5 names `.ditto/local/runs/<wi>/`, but that tree
  // is run-id keyed (run manifests); the work-item dir is the work-item-keyed
  // home every other stop ledger already uses, so the ReviewGraph ledger lands
  // here too (the locked spec 00~50 does not pin the path).
  const acgReview = await readArtifact(
    join(dir, 'acg-review.json'),
    acgReviewGraph,
    'acg-review.json',
  );
  // ACG fitness (AssuranceSnapshot, 단계8) + impact (ImpactGraph, 단계3) ledgers.
  // Same work-item-dir home + absent/malformed discipline as the other ledgers;
  // each fail-closes on malform and is a no-op when absent.
  const assurance = await readArtifact(
    join(dir, 'assurance-snapshot.json'),
    acgAssuranceSnapshot,
    'assurance-snapshot.json',
  );
  const impact = await readArtifact(
    join(dir, 'impact-graph.json'),
    acgImpactGraph,
    'impact-graph.json',
  );
  // ACG semantic compatibility (단계6) ledger — same work-item-dir home + absent/
  // malformed discipline; gates an unintended/unverified meaning change.
  const semantic = await readArtifact(
    join(dir, 'semantic-compatibility.json'),
    acgSemanticCompatibility,
    'semantic-compatibility.json',
  );
  // Knowledge-update gate carrier (axis-4, G1) — the persisted triggers + delta the
  // knowledge node declared. Same work-item-dir home + absent/malformed discipline:
  // absent → inert (valid no-trigger skip), malformed → fail-closed.
  const knowledge = await readArtifact(
    join(dir, 'knowledge-gate.json'),
    knowledgeGateCarrier,
    'knowledge-gate.json',
  );
  // Decision-conflict carrier (ADR-0020) — ADR conflicts the detecting node declared.
  // Same work-item-dir home + absent/malformed discipline.
  const decisionConflicts = await readArtifact(
    join(dir, 'decision-conflict.json'),
    decisionConflictCarrier,
    'decision-conflict.json',
  );

  // Malformed artifact = gate-input violation → fail CLOSED (exit 2).
  const malformed = [
    completion,
    conv,
    pilot,
    intent,
    dialectics,
    acgReview,
    assurance,
    impact,
    semantic,
    knowledge,
    decisionConflicts,
  ].find((a) => a.status === 'malformed');
  if (malformed && malformed.status === 'malformed') {
    return {
      exitCode: 2,
      stderr: `DITTO Stop gate: ${malformed.name} is malformed (cannot verify completion). Fix or remove it before stopping.\n`,
    };
  }

  // Yield precedence: an autopilot waiting on approval/blocker stops the loop so
  // the plan/decision can surface (plan M1.4 branch 나 exceptions).
  if (
    pilot.status === 'ok' &&
    pilot.data.approval_gate.status === 'pending' &&
    hasPendingMutatingNode(pilot.data)
  ) {
    return { exitCode: 0 };
  }

  const reasons: string[] = [];
  // Non-blocking intent-drift advisories (goal/source_request string divergence):
  // surfaced so the user can judge a re-statement vs real drift, but they never
  // force continuation (dialectic P1 — ACG assigns goal-wording judgment to
  // human/LLM review, not a deterministic block).
  const advisories: string[] = [];
  // Whether the completion passes its OWN gates (so the work is actually closing,
  // not a partial/handoff checkpoint). Gates the (B) bypass check below.
  let completionWouldClose = false;
  if (completion.status === 'ok') {
    const g = completionGate(workItem, completion.data);
    if (!g.pass) reasons.push(...g.reasons);
    const e = completionEvidenceGate(completion.data);
    if (!e.pass) reasons.push(...e.reasons);
    completionWouldClose = g.pass && e.pass;
    // (ac-1 / ac-5) Non-pass termination gate. completionGate enumerates per-AC
    // verdicts only on a pass, and the residual gate reads only `unverified[]` — so a
    // NON-pass completion that PARKS an in-scope unverified/fail criterion without an
    // honest `non_pass_status` declaration slips both and silent-terminates at exit 0.
    // This gate enumerates `acceptance[].verdict` directly and BLOCKS that silent park
    // (ac-5: a no-progress run that writes such a completion does not terminate);
    // an honest partial/blocked (non_pass_status) TERMINATES (ADR-20260626 D2). No-op
    // on pass completions (owned by completionGate above) — no behaviour change there.
    const np = nonPassTerminationGate(completion.data);
    if (!np.pass) reasons.push(...np.reasons);
  }
  if (conv.status === 'ok') {
    const g = convergenceGate(conv.data);
    if (!g.pass) reasons.push(...g.reasons);
  }
  if (pilot.status === 'ok' && autopilotForcesContinuation(pilot.data)) {
    reasons.push('autopilot has runnable node(s); the work item is not complete yet');
  }
  // (B) plan→autopilot transition gate (中, wi_260615xby). A non-trivial work item
  // actually CLOSING on a completion.json (it passes its own gate) yet with no real
  // autopilot plan ever run bypassed finalize→bootstrap→drive. See the helper for
  // the full guard set (completion-would-close, no-plan, non-terminal, not exempt,
  // changed code) — disjoint from the strong-block below (which needs completion
  // ABSENT) so the two never double-message.
  reasons.push(
    ...autopilotBypassForcesContinuation(workItem, completion, pilot, completionWouldClose),
  );
  // (ac-2) residual resolvability gate. Gated on completionWouldClose so it fires
  // ONLY on a completion that actually passes its own gates — a closing work item
  // that parks an agent-resolvable residual, or attaches an ungrounded
  // non-resolvable label, must keep going. Disjoint from the completion gate above
  // (which never reads the resolvability labels), so no double-message; fires for
  // ANY completion.json present (including a direct /ditto:verify write, no
  // autopilot.json required).
  if (completion.status === 'ok' && completionWouldClose) {
    reasons.push(...residualResolvabilityForcesContinuation(completion.data, workItem));
    // (ac-3) the same default-DENY policy over the structured `remaining_risk_records[]`
    // surface: a parked agent_resolvable record (or an ungrounded non-resolvable one)
    // blocks a pass-close exactly as an unverified[] residual does (R11 — one label space).
    reasons.push(...riskRecordForcesContinuation(completion.data, workItem));
  }
  // Axis-2 intent drift: the chain (intent → work-item → autopilot → completion)
  // is conserved by construction at finalize; this catches post-finalize
  // divergence (goal rewrite, AC grow/shrink, invented refs) before the work item
  // can close. Deterministic floor — semantic fidelity stays with reviewer.
  if (intent.status === 'ok' && pilot.status === 'ok') {
    const d = intentDriftGate({
      intent: intent.data,
      workItem,
      graph: pilot.data,
      ...(completion.status === 'ok' ? { completion: completion.data } : {}),
    });
    if (!d.pass) reasons.push(...d.reasons.map((r) => `intent drift — ${r}`));
    advisories.push(...d.advisories.map((r) => `intent drift (advisory) — ${r}`));
    // P3 side effect only — does not touch reasons/advisories/exit above.
    await recordIntentDriftMetric(input.repoRoot, pointer, {
      reasons: d.reasons,
      advisories: d.advisories,
    });
  }
  if (dialectics.status === 'ok') {
    for (const d of dialectics.items)
      reasons.push(...dialecticForcesContinuation(d, input.repoRoot));
  }
  if (acgReview.status === 'ok') {
    reasons.push(...acgReviewForcesContinuation(acgReview.data));
  }
  if (assurance.status === 'ok') {
    reasons.push(...assuranceSnapshotForcesContinuation(assurance.data));
  }
  if (impact.status === 'ok') {
    reasons.push(...impactForcesContinuation(impact.data));
  }
  if (semantic.status === 'ok') {
    reasons.push(...semanticForcesContinuation(semantic.data));
  }
  // Axis-4 knowledge-update gate (G1). Inert unless the graph has a terminal
  // knowledge node AND a carrier is present; ADR-0010 (b) preserved (never forces
  // recording, only "declared trigger ↔ actual record" consistency).
  if (pilot.status === 'ok') {
    reasons.push(
      ...knowledgeForcesContinuation(
        pilot.data,
        knowledge.status === 'ok' ? knowledge.data : undefined,
      ),
    );
  }
  // Decision-conflict guardrail (ADR-0020): intent conflicts block (D3 fail-closed),
  // every detected conflict is disclosed (D2 transparency) even when auto-aligned.
  const dc = decisionConflictForcesContinuation(
    decisionConflicts.status === 'ok' ? decisionConflicts.data : undefined,
  );
  reasons.push(...dc.reasons);
  advisories.push(...dc.advisories);

  // Advisory suffix — appended to whatever this handler returns (blocking or not),
  // so a non-blocking goal-divergence note reaches the user even on exit 0.
  const advisoryBlock =
    advisories.length > 0
      ? `DITTO Stop advisory (non-blocking) — ${advisories.length} item(s):\n- ${advisories.join('\n- ')}\n`
      : '';

  // (ac-6) Per-AC positive attestation. Built from the SAME per-AC verdicts the
  // completion recorded (`completion.acceptance`) — `attestAcVerdicts` folds the 4
  // verdicts into 3 attestation states, so it can never disagree with what closed
  // each AC. Non-blocking: appended (like advisoryBlock) to whatever this handler
  // returns so the user sees what every AC is attested as at the run's stop. Empty
  // when no completion is present.
  const attestation =
    completion.status === 'ok'
      ? attestAcVerdicts(
          // Map to the minimal DerivedAcVerdict shape; conditional-spread `notes` so
          // an absent note never lands as `notes: undefined` (exactOptionalPropertyTypes).
          completion.data.acceptance.map((a) => ({
            criterion_id: a.criterion_id,
            verdict: a.verdict,
            ...(a.notes !== undefined ? { notes: a.notes } : {}),
          })),
        )
      : [];
  const attestationBlock =
    attestation.length > 0
      ? `DITTO Stop attestation (per-AC) — ${attestation.length} criterion/criteria:\n${attestation
          .map((a) => `- ${a.criterion_id}: ${a.state}${a.basis ? ` — ${a.basis}` : ''}`)
          .join('\n')}\n`
      : '';

  if (reasons.length > 0) {
    return {
      exitCode: 2,
      stderr: `DITTO Stop gate: keep going — ${reasons.length} item(s) remain:\n- ${reasons.join('\n- ')}\n${advisoryBlock}${attestationBlock}`,
    };
  }

  // Strong-block update (§M1.4, 2026-05-31): a NON_TERMINAL work item that
  // stops with completion/convergence/autopilot ALL absent is the "verify 안
  // 한 채 그냥 종료" outcome gap. Force a continuation that demands either a
  // verdict artifact or an explicit terminal transition. Terminal work items
  // (done/abandoned) and any work item with at least one ledger present go
  // through the existing gate paths above.
  if (
    completion.status === 'absent' &&
    conv.status === 'absent' &&
    (pilot.status === 'absent' ||
      (pilot.status === 'ok' && isDegeneratePendingAutopilot(pilot.data))) &&
    NON_TERMINAL_STATUSES.includes(workItem.status)
  ) {
    return {
      exitCode: 2,
      stderr: `DITTO Stop gate: work item ${workItem.id} is ${workItem.status} but has no real verification path (no completion.json / convergence.json, and no autopilot.json with a plan to run). Run /ditto:verify (writes completion.json) or transition the work item to done/abandoned before stopping.\n`,
    };
  }

  // (가) nothing left to force. The work item may stop — but if it touched source
  // without any semantic-compatibility artifact, surface a non-blocking AX nudge
  // (S1, wi_260605aw1) to run `ditto semantic scan`. Cheap (git only, no CodeQL),
  // advisory (exit 0 unchanged), self-limiting (gone once a semantic artifact exists).
  const nudge = computeSemanticNudge(input.repoRoot, workItem, {
    semanticPresent: semantic.status === 'ok',
    isNonTerminal: NON_TERMINAL_STATUSES.includes(workItem.status),
  });
  const tail = `${advisoryBlock}${attestationBlock}${nudge ?? ''}`;
  return tail.length > 0 ? { exitCode: 0, stderr: tail } : { exitCode: 0 };
};
