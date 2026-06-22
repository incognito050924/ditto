import type { CoverageMap, CoverageNode, CoverageRoundPayload } from '~/schemas/coverage';
import {
  COVERAGE_AXIS_MECHANISMS,
  type CoverageTier,
  type JudgeInput,
  type PlanDialogInput,
  type TierSelectionInput,
  addNode,
  buildJudgeInput,
  closeNode,
  coverageClosureGate,
  coverageDryK,
  isCoverageTerminated,
  recordDryRound,
  selectCoverageTier,
  selectReadyCoverageNodes,
  serializePlanDialog,
  tierDepthBudget,
} from './coverage-manager';
import { CoverageStore } from './coverage-store';
import {
  CATEGORY_NODE_PREFIX,
  farFieldCoverageNodes,
  farFieldLenses,
  loadFarFieldTaxonomy,
} from './coverage-taxonomy';
import { localDir } from './ditto-paths';
import { IntentStore } from './intent-store';
import { WorkItemStore } from './work-item-store';

/**
 * Plan-stage pre-mortem coverage loop glue — parallel to `nextNode`/`recordResult`
 * (autopilot-loop.ts) for the coverage sweep. The deterministic Manager primitives
 * (coverage-manager.ts) own tree CRUD, scheduling, axis enforcement, termination.
 * This module is their SINGLE production caller: it persists the coverage map to
 * `.ditto/local/runs/<wi>/coverage.json` via CoverageStore, schedules the next
 * open scope node for interrogation, applies the six §2 axis mechanisms +
 * false-green gate on close, loops until admissible-novelty is dry (§4.5), then
 * serializes plan-dialog.md and returns the plan_brief inputs.
 *
 * Division of labour (charter §3.1): CODE computes/gates/aggregates here; the main
 * agent spawns the fresh fan-out judges + 3-role dialectic and hands their
 * STRUCTURAL signals back via `recordCoverageRound`. The dry counter persists
 * inside the coverage map's root-node bookkeeping is NOT used — instead the
 * counter is derived from the map + carried in the round payload, keeping the
 * Manager primitives pure.
 */

/** Where the dry counter is stashed across calls (no schema change — sidecar file). */
function dryCounterPath(repoRoot: string, workItemId: string): string {
  return localDir(repoRoot, 'runs', workItemId, 'coverage-dry-counter');
}

async function readDryCounter(repoRoot: string, workItemId: string): Promise<number> {
  const file = Bun.file(dryCounterPath(repoRoot, workItemId));
  if (!(await file.exists())) return 0;
  const n = Number.parseInt((await file.text()).trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

async function writeDryCounter(repoRoot: string, workItemId: string, n: number): Promise<void> {
  await Bun.write(dryCounterPath(repoRoot, workItemId), String(n));
}

function rootNode(label: string): CoverageNode {
  return {
    id: 'cov-root',
    parent_id: null,
    label,
    origin: 'seed',
    depth_weight: 1,
    state: 'open',
    children: [],
  };
}

/** The original-intent label used to seed the root node + every judge input (§4.1). */
async function originalIntent(repoRoot: string, workItemId: string): Promise<string> {
  const intents = new IntentStore(repoRoot);
  if (await intents.exists(workItemId)) {
    return (await intents.get(workItemId)).goal;
  }
  const items = new WorkItemStore(repoRoot);
  if (await items.exists(workItemId)) {
    return (await items.get(workItemId)).title;
  }
  return workItemId;
}

/**
 * Which stage drives this coverage sweep. The engine (tree CRUD, axis
 * enforcement, dry counter, termination) is identical for both; the stage only
 * selects the dialog artifact: 'plan' → plan-dialog.md (§6), 'intent' →
 * intent-dialog.md (§9). Default 'plan' keeps every existing caller unchanged.
 */
export type CoverageStage = 'plan' | 'intent';

export type NextCoverageNodeResult =
  | {
      action: 'interrogate';
      node: CoverageNode;
      judgeInput: JudgeInput;
      tier: CoverageTier;
      /**
       * How many blind sweep angles to spawn for this node — the tier's effort
       * lever (light=1 / standard=3 / full=5, §8.2). Breadth (every category) is
       * invariant; this scales the *effort per node* with stakes (ac-4) so a
       * low-stakes sweep is cheaper and a high-stakes one more thorough (ac-8).
       */
      sweepAngles: number;
      dryCounter: number;
    }
  | { action: 'dry'; terminated: true };

/**
 * Coverage loop step 1–4 (mirror of `nextNode`). On the first call (no
 * coverage.json yet) seeds the root node = original intent (origin:'seed',
 * state:'open') and persists it. Then schedules the next ready (leaf-frontier)
 * open node via `selectReadyCoverageNodes`. Returns `{action:'dry'}` once
 * `isCoverageTerminated` holds (every node closed AND K dry rounds). The
 * `tier` and `judgeInput` are computed deterministically from the map; the
 * caller runs the fresh fan-out with ONLY `judgeInput` (zero accumulated context).
 */
export async function nextCoverageNode(args: {
  repoRoot: string;
  workItemId: string;
  tierInputs?: TierSelectionInput;
  /**
   * Explicit intensity override entered by the user (ac-4). When set it forces
   * the tier — and thus the termination depth K — winning over both `tierInputs`
   * (stakes-derived) and the standard default. Absent → unchanged (ac-7).
   */
  intensity?: CoverageTier;
  /**
   * Seed each floor category as a coverage node so termination requires every
   * category swept (§8-2, ac-2). Default false preserves the root-only tree (ac-7).
   * Only consulted on the first call (when the map is seeded).
   */
  seedCategories?: boolean;
}): Promise<NextCoverageNodeResult> {
  const { repoRoot, workItemId } = args;
  const store = new CoverageStore(repoRoot);
  // ac-10: resolve the project's tier-② taxonomy (floor + .ditto/coverage-taxonomy.json)
  // once; it drives both the seeded category nodes and the injected lenses. Absent/
  // malformed config → the code floor (fail-open).
  const taxonomy = await loadFarFieldTaxonomy(repoRoot);
  let map: CoverageMap;
  if (await store.exists(workItemId)) {
    map = await store.getMap(workItemId);
  } else {
    const intent = await originalIntent(repoRoot, workItemId);
    map = {
      schema_version: '0.1.0',
      work_item_id: workItemId,
      root_id: 'cov-root',
      // §8-2: category-complete discovery seeds every floor category as a node so
      // termination requires each one swept (ac-2); off → root-only tree (ac-7).
      nodes: args.seedCategories
        ? farFieldCoverageNodes(intent, 'cov-root', taxonomy)
        : [rootNode(intent)],
    };
    await store.writeMap(workItemId, map);
  }

  const dryCounter = await readDryCounter(repoRoot, workItemId);
  // §8-4: termination depth K scales with the stakes-derived tier (light=1,
  // standard=2, full=3); no tierInputs → standard = the existing default (ac-7).
  const tier =
    args.intensity ?? (args.tierInputs ? selectCoverageTier(args.tierInputs) : 'standard');
  // §8.2 effort lever surfaced to the caller: how many blind sweep angles to spawn
  // per node (light=1/standard=3/full=5). Breadth invariant; effort scales (ac-4/ac-8).
  const sweepAngles = tierDepthBudget(tier).sweepAngles;
  if (isCoverageTerminated(map, dryCounter, coverageDryK(tier))) {
    return { action: 'dry', terminated: true };
  }

  const ready = selectReadyCoverageNodes(map);
  const node = ready[0];
  if (node === undefined) {
    // No open node but counter not yet dry: still need K dry rounds. The caller
    // records empty rounds (no new branches) to drive the counter to K.
    return {
      action: 'interrogate',
      node: rootNode(map.nodes[0]?.label ?? workItemId),
      judgeInput: buildJudgeInput({
        node: map.nodes[0] ?? rootNode(workItemId),
        originalIntent: await originalIntent(repoRoot, workItemId),
        // Far-field floor lenses (design §8-1) — the fresh judge now sees every
        // category instead of the previous empty slot (cross_cutting_constraints:[]).
        crossCuttingConstraints: farFieldLenses(taxonomy),
      }),
      tier,
      sweepAngles,
      dryCounter,
    };
  }

  const intent = await originalIntent(repoRoot, workItemId);
  return {
    action: 'interrogate',
    node: { ...node },
    judgeInput: buildJudgeInput({
      node,
      originalIntent: intent,
      // Far-field floor lenses (design §8-1) — see the no-ready-node path above.
      crossCuttingConstraints: farFieldLenses(taxonomy),
    }),
    tier,
    sweepAngles,
    dryCounter,
  };
}

/** Structural axis signals (the schema's axis_signals shape). */
type CoverageAxisSignals = NonNullable<CoverageRoundPayload['axis_signals']>;

export type RecordCoverageRoundResult =
  | {
      terminated: false;
      closed: boolean;
      /** Axis-mechanism reasons that REJECTED a requested close (node stays open). */
      reasons: string[];
      dryCounter: number;
    }
  | {
      terminated: true;
      brief: { interface_changes: string[]; dod: string[]; test_scenarios: string[] };
      tierInputs?: TierSelectionInput;
      planDialogPath: string;
    };

/**
 * Run the six §2 axis mechanisms against this scope's structural signals + the
 * false-green closure gate. Returns the rejecting reasons (empty ⇒ all pass).
 * Each axis is its OWN mechanism (COVERAGE_AXIS_MECHANISMS) — never one shared
 * check (§2/ac-4). completeness/discovery are run as loop-level termination, so
 * the per-close gate here enforces neutrality, balance, priority, temporal +
 * the structural false-green gate.
 */
function enforceClose(
  map: CoverageMap,
  node: CoverageNode,
  state: Exclude<CoverageNode['state'], 'open'>,
  signals: CoverageAxisSignals,
  reason: string | undefined,
): string[] {
  const reasons: string[] = [];

  const gate = coverageClosureGate(map, node.id, state);
  if (!gate.pass) reasons.push(...gate.reasons);

  // §8-2 / ac-2 fail-closed: a seeded category closed in a NON-resolved state
  // (out_of_scope / user_owned) is a skip/deferral — it MUST carry a recorded
  // justification, never a silent pass. 'resolved' means the category was actually
  // swept and settled, so the sweep itself is the record (no skip reason needed).
  if (
    node.id.startsWith(CATEGORY_NODE_PREFIX) &&
    state !== 'resolved' &&
    (reason === undefined || reason.trim() === '')
  ) {
    reasons.push(
      `category ${node.id} skipped as ${state} without a reason: a category skip must be a recorded, justified decision (ac-2)`,
    );
  }

  // LOW1 (wi_2606144ta) fail-closed: a 'resolved' close asserts the scope was
  // adversarially settled, so it MUST carry the neutrality signal. Without it the
  // non-structural axes are silently skipped and a node closes having never been
  // checked. user_owned / out_of_scope closes are deferrals, not resolutions, so
  // they do not require neutrality.
  if (state === 'resolved' && signals.neutrality === undefined) {
    reasons.push(
      `neutrality axis required for resolved close of ${node.id}: axis_signals.neutrality absent`,
    );
  }

  const neutralityOk =
    signals.neutrality === undefined ||
    (COVERAGE_AXIS_MECHANISMS.neutrality.enforce(signals.neutrality) as boolean);
  if (!neutralityOk) {
    reasons.push(`neutrality axis rejected ${node.id}: Opponent did not run or verdict blocked`);
  }

  if (signals.balance !== undefined) {
    const balanceOk = COVERAGE_AXIS_MECHANISMS.balance.enforce(node, signals.balance) as boolean;
    if (!balanceOk) {
      reasons.push(`balance axis rejected ${node.id}: achieved depth below depth_weight floor`);
    }
  }

  if (signals.priority !== undefined) {
    const priorityOk = COVERAGE_AXIS_MECHANISMS.priority.enforce(node, signals.priority) as boolean;
    if (!priorityOk) {
      reasons.push(`priority axis rejected ${node.id}: high-priority node still shallow`);
    }
  }

  if (signals.temporalBaseline !== undefined && signals.temporalCurrent !== undefined) {
    const temporalOk = COVERAGE_AXIS_MECHANISMS.temporal.enforce(
      signals.temporalBaseline,
      signals.temporalCurrent,
    ) as boolean;
    if (!temporalOk) {
      reasons.push(`temporal axis rejected ${node.id}: surface diverged from frozen baseline`);
    }
  }

  return reasons;
}

/**
 * Coverage loop step 5–6 (mirror of `recordResult`). Append every child node
 * (append-only growth, §3.2); step the dry counter from this round's admissible
 * novelty (§4.5); if `close_as` is set, run all six axis mechanisms + the
 * false-green gate — only an all-pass closes the node, otherwise it stays open
 * and the rejecting reasons are returned. Persists coverage.json on every call.
 * On `isCoverageTerminated` (breadth AND depth), assembles + writes plan-dialog.md
 * and returns the brief + tier inputs for the design node's plan_brief.
 *
 * This is the SINGLE production caller of addNode / closeNode /
 * selectReadyCoverageNodes / coverageClosureGate / recordDryRound /
 * isCoverageTerminated / buildJudgeInput / COVERAGE_AXIS_MECHANISMS /
 * serializePlanDialog.
 */
export async function recordCoverageRound(args: {
  repoRoot: string;
  workItemId: string;
  payload: CoverageRoundPayload;
  /** Brief content the design node produced — folded into the result on termination. */
  brief?: { interface_changes: string[]; dod: string[]; test_scenarios: string[] };
  tierInputs?: TierSelectionInput;
  /**
   * Explicit intensity override entered by the user (ac-4) — forces the tier (and
   * termination depth K), winning over `tierInputs` and the standard default.
   * Must match the value passed to `nextCoverageNode` so both termination checks
   * use the same K. Absent → unchanged (ac-7).
   */
  intensity?: CoverageTier;
  /** plan-dialog delta assembled into plan-dialog.md on termination (§6). */
  dialogDelta?: Partial<PlanDialogInput>;
  /** Stage selecting the dialog artifact on termination (default 'plan', §6/§9). */
  stage?: CoverageStage;
}): Promise<RecordCoverageRoundResult> {
  const { repoRoot, workItemId, payload } = args;
  const store = new CoverageStore(repoRoot);
  let map = await store.getMap(workItemId);

  const children = [...(payload.derived_nodes ?? []), ...(payload.discovered_nodes ?? [])];
  for (const child of children) {
    map = addNode(map, {
      id: child.id,
      parent_id: child.parent_id,
      label: child.label,
      origin: child.origin,
      depth_weight: child.depth_weight,
      state: 'open',
      children: [],
    });
  }

  const prevCounter = await readDryCounter(repoRoot, workItemId);
  const nextCounter = recordDryRound(prevCounter, {
    admissibleBranchesAdded: payload.admissibleBranchesAdded,
  });
  await writeDryCounter(repoRoot, workItemId, nextCounter);

  let closed = false;
  let reasons: string[] = [];
  if (payload.close_as !== undefined) {
    const node = map.nodes.find((n) => n.id === payload.node_id);
    if (node === undefined) {
      reasons = [`unknown coverage node id: ${payload.node_id}`];
    } else {
      reasons = enforceClose(
        map,
        node,
        payload.close_as,
        payload.axis_signals ?? {},
        payload.close_reason,
      );
      if (reasons.length === 0) {
        map = closeNode(map, payload.node_id, payload.close_as, payload.close_reason);
        closed = true;
      }
    }
  }

  await store.writeMap(workItemId, map);

  // §8-4: same stakes-proportional K as nextCoverageNode (default standard, ac-7).
  const tier =
    args.intensity ?? (args.tierInputs ? selectCoverageTier(args.tierInputs) : 'standard');
  if (isCoverageTerminated(map, nextCounter, coverageDryK(tier))) {
    const delta = args.dialogDelta ?? {};
    const closedItems = map.nodes
      .filter((n) => n.state !== 'open')
      .map((n) => ({ id: n.id, label: n.label, state: n.state }));
    const openItems = map.nodes
      .filter((n) => n.state === 'open')
      .map((n) => ({ id: n.id, label: n.label, state: n.state }));
    const stage: CoverageStage = args.stage ?? 'plan';
    const dialogInput: PlanDialogInput = {
      workItemId,
      userQa: delta.userQa ?? [],
      selfAnswers: delta.selfAnswers ?? [],
      assumptions: delta.assumptions ?? [],
      closedItems: delta.closedItems ?? closedItems,
      openItems: delta.openItems ?? openItems,
      kind: stage === 'intent' ? 'intent-dialog' : 'plan-dialog',
    };
    const markdown = serializePlanDialog(dialogInput);
    if (stage === 'intent') {
      await store.writeIntentDialog(workItemId, markdown);
    } else {
      await store.writePlanDialog(workItemId, markdown);
    }
    const dialogFile = stage === 'intent' ? 'intent-dialog.md' : 'plan-dialog.md';
    return {
      terminated: true,
      brief: args.brief ?? { interface_changes: [], dod: [], test_scenarios: [] },
      ...(args.tierInputs ? { tierInputs: args.tierInputs } : {}),
      planDialogPath: `.ditto/local/runs/${workItemId}/${dialogFile}`,
    };
  }

  return { terminated: false, closed, reasons, dryCounter: nextCounter };
}
