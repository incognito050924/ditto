import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ZodTypeAny, z } from 'zod';
import { AutopilotStore } from '~/core/autopilot-store';
import { localDir } from '~/core/ditto-paths';
import { listChangedFiles } from '~/core/git';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import { acgAssuranceSnapshot } from '~/schemas/acg-assurance-snapshot';
import { acgImpactGraph } from '~/schemas/acg-impact-graph';
import { acgReviewGraph } from '~/schemas/acg-review-graph';
import { acgSemanticCompatibility } from '~/schemas/acg-semantic-compatibility';
import { autopilot as autopilotSchema } from '~/schemas/autopilot';
import { completionContract } from '~/schemas/completion-contract';
import { convergence as convergenceSchema } from '~/schemas/convergence';
import { decisionConflictCarrier } from '~/schemas/decision-conflict-carrier';
import { type Dialectic, dialectic as dialecticSchema } from '~/schemas/dialectic';
import { directionForkCarrier } from '~/schemas/direction-fork-carrier';
import { intentContract } from '~/schemas/intent';
import { intentMetric } from '~/schemas/intent-metric';
import { knowledgeGateCarrier } from '~/schemas/knowledge-gate-carrier';
import type { HookHandler, HookInput } from '../runtime';
import { computeSemanticNudge } from '../semantic-nudge';
// maybeRunFitness (fitness auto-trigger) is the legacy module's exported IO
// helper — reused as-is so the snapshot/fingerprint behavior stays identical.
import { maybeRunFitness } from '../stop';
import { type ArtifactRead, type DialecticsRead, evaluateStopGate } from './stop-gate';

/**
 * Stop hook — rebuilt thin IO shell (increment 3). Reads the UNCHANGED ledgers
 * under `.ditto/local/work-items/<wi>/`, hands them to the PURE gate
 * (`./stop-gate.ts`), performs the effects the gate ordered (procedure-punt
 * decision record, intent-drift metric), and returns the verdict. Verdict
 * semantics live in `src/core/gates.ts` + the gate module — not here.
 */

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
  // File exists → a parse/validation failure is a gate-input violation
  // (fail-closed), NOT a hook crash.
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    if (!parsed.success) return { status: 'malformed', name };
    return { status: 'ok', data: parsed.data };
  } catch {
    return { status: 'malformed', name };
  }
}

/**
 * Read every reviews/dialectic-*.json ledger. A file that exists but fails
 * schema parse is malformed (fail-closed); an absent reviews/ dir is an empty
 * list.
 */
async function readDialecticLedgers(dir: string): Promise<DialecticsRead> {
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
 * Record a P6 procedure-punt force-continuation to the append-only decision
 * log, ONCE per pending-node signature (Stop fires repeatedly on the same
 * state). Best-effort: a ledger-write failure never changes the verdict.
 */
async function maybeRecordProcedurePunt(
  repoRoot: string,
  workItemId: string,
  graph: { nodes: Array<{ id: string; owner: string; status: string }> },
): Promise<void> {
  try {
    const signature = graph.nodes
      .filter((n) => n.owner === 'implementer' && n.status === 'pending')
      .map((n) => n.id)
      .sort()
      .join(',');
    if (signature.length === 0) return;
    const store = new AutopilotStore(repoRoot);
    const existing = await store.readDecisions(workItemId);
    if (
      existing.some((d) => d.decision === 'procedure_punt_continued' && d.node_id === signature)
    ) {
      return;
    }
    await store.appendDecision(workItemId, {
      ts: new Date().toISOString(),
      node_id: signature,
      decision: 'procedure_punt_continued',
      reason:
        'Stop hook force-continued a routine procedure-punt pause (approval pending, no intent-conflict / high-risk / oracle-gap decision to yield for)',
    });
  } catch {
    // best-effort ledger write
  }
}

const DRIFT_HOPS = ['H1', 'H2', 'H3'] as const;

function driftHops(lines: string[]): Array<(typeof DRIFT_HOPS)[number]> {
  return DRIFT_HOPS.filter((h) => lines.some((l) => l.includes(`${h}:`)));
}

/**
 * Persist the intent-drift verdict to metrics.jsonl. Best-effort + de-duped
 * against the last record (Stop fires repeatedly on the same state); clean
 * stops record nothing.
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

const NON_TERMINAL_STATUSES = new Set(['draft', 'in_progress', 'blocked', 'partial', 'unverified']);

export const stopHandler: HookHandler = async (input: HookInput) => {
  const raw = (input.raw ?? {}) as Record<string, unknown>;

  // 8-iteration guard: once we have forced a continuation, let Claude stop.
  if (raw.stop_hook_active === true) return { exitCode: 0 };

  const sessionId = typeof raw.session_id === 'string' ? raw.session_id : undefined;
  if (!sessionId)
    return {
      exitCode: 0,
      stderr:
        'DITTO Stop 완료 게이트가 실행되지 않음(did not run): session_id가 없어 완료/수렴 게이트를 검사할 수 없음.\n',
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
  // Fitness auto-trigger: refresh the assurance snapshot before the gate reads it.
  await maybeRunFitness(input.repoRoot, pointer, dir);

  const ledgers = {
    completion: await readArtifact(
      join(dir, 'completion.json'),
      completionContract,
      'completion.json',
    ),
    conv: await readArtifact(join(dir, 'convergence.json'), convergenceSchema, 'convergence.json'),
    pilot: await readArtifact(join(dir, 'autopilot.json'), autopilotSchema, 'autopilot.json'),
    intent: await readArtifact(join(dir, 'intent.json'), intentContract, 'intent.json'),
    dialectics: await readDialecticLedgers(dir),
    acgReview: await readArtifact(join(dir, 'acg-review.json'), acgReviewGraph, 'acg-review.json'),
    assurance: await readArtifact(
      join(dir, 'assurance-snapshot.json'),
      acgAssuranceSnapshot,
      'assurance-snapshot.json',
    ),
    impact: await readArtifact(join(dir, 'impact-graph.json'), acgImpactGraph, 'impact-graph.json'),
    semantic: await readArtifact(
      join(dir, 'semantic-compatibility.json'),
      acgSemanticCompatibility,
      'semantic-compatibility.json',
    ),
    knowledge: await readArtifact(
      join(dir, 'knowledge-gate.json'),
      knowledgeGateCarrier,
      'knowledge-gate.json',
    ),
    decisionConflicts: await readArtifact(
      join(dir, 'decision-conflict.json'),
      decisionConflictCarrier,
      'decision-conflict.json',
    ),
    directionFork: await readArtifact(
      join(dir, 'direction-fork.json'),
      directionForkCarrier,
      'direction-fork.json',
    ),
  };

  const decision = evaluateStopGate({
    workItem,
    ledgers,
    repoRoot: input.repoRoot,
    uncommittedFiles: () => listChangedFiles(input.repoRoot),
    computeNudge: () =>
      computeSemanticNudge(input.repoRoot, workItem, {
        semanticPresent: ledgers.semantic.status === 'ok',
        isNonTerminal: NON_TERMINAL_STATUSES.has(workItem.status),
      }),
  });

  // Effects ordered by the pure gate — performed before the verdict returns.
  if (decision.effects.recordProcedurePunt && ledgers.pilot.status === 'ok') {
    await maybeRecordProcedurePunt(input.repoRoot, pointer, ledgers.pilot.data);
  }
  if (decision.effects.intentDrift) {
    await recordIntentDriftMetric(input.repoRoot, pointer, decision.effects.intentDrift);
  }

  return decision.stderr !== undefined
    ? { exitCode: decision.exitCode, stderr: decision.stderr }
    : { exitCode: decision.exitCode };
};
