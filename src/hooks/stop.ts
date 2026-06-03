import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ZodTypeAny, z } from 'zod';
import { completionEvidenceGate, completionGate, convergenceGate } from '~/core/gates';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import { type AcgReviewGraph, acgReviewGraph } from '~/schemas/acg-review-graph';
import { type Autopilot, autopilot as autopilotSchema } from '~/schemas/autopilot';
import { completionContract } from '~/schemas/completion-contract';
import { convergence as convergenceSchema } from '~/schemas/convergence';
import { type Dialectic, dialectic as dialecticSchema } from '~/schemas/dialectic';
import type { WorkItem } from '~/schemas/work-item';
import type { HookHandler, HookInput } from './runtime';

/** Opponent severities that make an oracle-linked objection an admissible blocker (§6). */
const ADMISSIBLE_SEVERITIES: ReadonlySet<string> = new Set(['critical', 'high']);

/**
 * Cross-check one dialectic ledger (reviews/dialectic-<n>.json) against the
 * convergence honesty discipline. Returns continuation reasons:
 * - a synthesizer verdict of reject/blocked is an unresolved deliberation;
 * - an admissible objection (oracle-linked `maps_to` ∧ severity critical|high)
 *   that the synthesizer neither accepted nor grounded-rejected is unresolved.
 * Objections without an oracle are *taste* — surfaced, never a blocker.
 */
export function dialecticForcesContinuation(d: Dialectic): string[] {
  const reasons: string[] = [];
  const verdict = d.synthesizer.verdict;
  if (verdict === 'reject' || verdict === 'blocked') {
    reasons.push(`dialectic ${d.review_id} verdict=${verdict}; deliberation not resolved`);
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
 * Does an ACG ReviewGraph ledger force continuation? (WU-6, D5 — Review by
 * Exception). A file classified `risk: 'high'` that is still `unresolved` is a
 * high-risk change a human has not judged → the work item is not done. Returns
 * one continuation reason per such file (path|journey_id identity). High-risk
 * files WITH evidence (unresolved=false) and low/medium unresolved gaps are NOT
 * blockers here — only the unresolved high-risk exception set blocks (§5).
 */
export function acgReviewForcesContinuation(graph: AcgReviewGraph): string[] {
  const reasons: string[] = [];
  for (const file of graph.files) {
    if (file.risk === 'high' && file.unresolved === true) {
      const id = file.path ?? file.journey_id ?? '(unidentified)';
      reasons.push(`acg review: unresolved high-risk change — ${id} (${file.risk_reason})`);
    }
  }
  return reasons;
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

  const dir = join(input.repoRoot, '.ditto', 'work-items', pointer);
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
  const dialectics = await readDialecticLedgers(dir);
  // ACG ReviewGraph ledger (WU-6, D5). Lives in the work-item dir alongside the
  // other ledgers (stop reads one directory); absent → no-op, malformed → fail
  // closed, exactly like the others. D5 names `.ditto/runs/<wi>/`, but that tree
  // is run-id keyed (run manifests); the work-item dir is the work-item-keyed
  // home every other stop ledger already uses, so the ReviewGraph ledger lands
  // here too (the locked spec 00~50 does not pin the path).
  const acgReview = await readArtifact(
    join(dir, 'acg-review.json'),
    acgReviewGraph,
    'acg-review.json',
  );

  // Malformed artifact = gate-input violation → fail CLOSED (exit 2).
  const malformed = [completion, conv, pilot, dialectics, acgReview].find(
    (a) => a.status === 'malformed',
  );
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
  if (completion.status === 'ok') {
    const g = completionGate(workItem, completion.data);
    if (!g.pass) reasons.push(...g.reasons);
    const e = completionEvidenceGate(completion.data);
    if (!e.pass) reasons.push(...e.reasons);
  }
  if (conv.status === 'ok') {
    const g = convergenceGate(conv.data);
    if (!g.pass) reasons.push(...g.reasons);
  }
  if (pilot.status === 'ok' && autopilotForcesContinuation(pilot.data)) {
    reasons.push('autopilot has runnable node(s); the work item is not complete yet');
  }
  if (dialectics.status === 'ok') {
    for (const d of dialectics.items) reasons.push(...dialecticForcesContinuation(d));
  }
  if (acgReview.status === 'ok') {
    reasons.push(...acgReviewForcesContinuation(acgReview.data));
  }

  if (reasons.length > 0) {
    return {
      exitCode: 2,
      stderr: `DITTO Stop gate: keep going — ${reasons.length} item(s) remain:\n- ${reasons.join('\n- ')}\n`,
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

  // (가) nothing left to force.
  return { exitCode: 0 };
};
