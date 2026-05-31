import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ZodTypeAny, z } from 'zod';
import { completionGate, convergenceGate } from '~/core/gates';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
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
  const resolved = new Set<string>([
    ...d.synthesizer.accepted_objections,
    ...d.synthesizer.rejected_objections.map((r) => r.objection),
  ]);
  for (const obj of d.opponent.objections) {
    const admissible = obj.maps_to.trim().length > 0 && ADMISSIBLE_SEVERITIES.has(obj.severity);
    if (admissible && !resolved.has(obj.claim)) {
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

export const stopHandler: HookHandler = async (input: HookInput) => {
  const raw = (input.raw ?? {}) as Record<string, unknown>;

  // (1) 8-iteration guard: once we have forced a continuation, let Claude stop.
  if (raw.stop_hook_active === true) return { exitCode: 0 };

  // Stop only branches on what it actually sees. API/rate-limit/auth/max-output
  // arrive as the separate StopFailure event whose output is ignored — not here.
  const sessionId = typeof raw.session_id === 'string' ? raw.session_id : undefined;
  if (!sessionId) return { exitCode: 0 };

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

  // Malformed artifact = gate-input violation → fail CLOSED (exit 2).
  const malformed = [completion, conv, pilot, dialectics].find((a) => a.status === 'malformed');
  if (malformed && malformed.status === 'malformed') {
    return {
      exitCode: 2,
      stderr: `DITTO Stop gate: ${malformed.name} is malformed (cannot verify completion). Fix or remove it before stopping.\n`,
    };
  }

  // Yield precedence: an autopilot waiting on approval/blocker stops the loop so
  // the plan/decision can surface (plan M1.4 branch 나 exceptions).
  if (pilot.status === 'ok' && pilot.data.approval_gate.status === 'pending') {
    return { exitCode: 0 };
  }

  const reasons: string[] = [];
  if (completion.status === 'ok') {
    const g = completionGate(workItem, completion.data);
    if (!g.pass) reasons.push(...g.reasons);
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
    pilot.status === 'absent' &&
    NON_TERMINAL_STATUSES.includes(workItem.status)
  ) {
    return {
      exitCode: 2,
      stderr: `DITTO Stop gate: work item ${workItem.id} is ${workItem.status} but no completion.json / convergence.json / autopilot.json exists. Run /ditto:verify (writes completion.json) or transition the work item to done/abandoned before stopping.\n`,
    };
  }

  // (가) nothing left to force.
  return { exitCode: 0 };
};
