import { randomBytes } from 'node:crypto';
import { defineCommand } from 'citty';
import { addNode } from '~/core/coverage-manager';
import { resolveRepoRootForCreate } from '~/core/fs';
import { IntentStore } from '~/core/intent-store';
import {
  type MaterializeSplitResult,
  type ProposeSplitResult,
  materializeBacklogSplit,
  proposeBacklogSplit,
} from '~/core/prism/backlog';
import { type DesignDocInput, emitDesignDoc } from '~/core/prism/designdoc';
import {
  type IntentFragment,
  PRISM_CAPS,
  type PrismRound,
  type PrismRoundSignature,
  assignSeverity,
  buildIntentFragments,
  closePrismNode,
  criticalTermination,
  deriveFragmentMappings,
  renderProgressSummary,
  resolveLaunchNotification,
  runPrismRounds,
  seedUncoveredFragments,
  severityOf,
} from '~/core/prism/engine';
import {
  runDivergenceRound,
  runOpponentCritiqueRound,
  runOpponentDissentRound,
} from '~/core/prism/loop';
import {
  type DialecticHost,
  type OpponentOutcome,
  type OpponentSeamConfig,
  flaggedCriticalNodeIds,
  recordOpponentCritique,
  recordOpponentDissent,
  recordSemanticCritique,
  semanticCriticTargets,
} from '~/core/prism/opponent';
import { PrismStore, deriveNovelty } from '~/core/prism/store';
import { WorkItemStore } from '~/core/work-item-store';
import type { CoverageNode } from '~/schemas/coverage';
import {
  type PrismIssueMap,
  type PrismNodeEvaluation,
  type PrismOpponentVerdict,
  prismOpponentVerdicts,
} from '~/schemas/prism';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/** A fresh prism issue-map node id: `prism_<lowhex>` (matches the 2nd-defense pattern). */
function prismNodeId(): string {
  return `prism_${randomBytes(6).toString('hex')}`;
}

/** citty repeatable string arg is `undefined | string | string[]` — always normalize. */
function asArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * ac-1: upsert the A2 close-gate inputs (justifying_reason / refutation_attempted)
 * onto a node's prism-level evaluation annotation BEFORE `closePrismNode` reads them.
 * Replace the single record for the node, append when absent (the `evaluations` array
 * is a per-node sidecar). Pure — mirrors the engine's own private upsert.
 */
function upsertPrismEvaluation(
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
 * Read the ORIGINAL intent text (source_request) from the work item's intent.json,
 * or `undefined` when the WI has no intent sidecar (e.g. a bare prism draft that
 * precedes deep-interview finalize). Used by the ac-3 launch re-anchor and the ac-5/
 * ac-6 opponent brief.
 */
async function readOriginalIntent(
  repoRoot: string,
  workItemId: string,
): Promise<string | undefined> {
  const intents = new IntentStore(repoRoot);
  if (!(await intents.exists(workItemId))) return undefined;
  return (await intents.get(workItemId)).source_request;
}

/**
 * ac-2 completeness fragments — the original-intent pieces (intent.json goal +
 * in_scope) the termination check reverse-maps against the issue-map nodes. Returns
 * `[]` when the WI has no intent sidecar (a bare prism draft precedes finalize). The
 * split itself is the pure, unit-tested `buildIntentFragments`.
 */
async function readIntentFragments(
  repoRoot: string,
  workItemId: string,
): Promise<IntentFragment[]> {
  const intents = new IntentStore(repoRoot);
  if (!(await intents.exists(workItemId))) return [];
  return buildIntentFragments(await intents.get(workItemId));
}

/**
 * The opponent model policy for a bare CLI run (dialecticInput.model_policy defaults):
 * Codex preferred, claude-opus synthesizer. opponent-router resolves the candidate
 * order from this; the actual invocation is host-delegated (ADR-0001) and absent here.
 */
const BARE_MODEL_POLICY: OpponentSeamConfig['policy'] = {
  producer: 'current-host',
  opponent_preferred: 'codex',
  opponent_fallback: [],
  synthesizer: 'claude-opus',
};

/** Load the Run-tier draft, or seed an empty map with a root container. */
async function loadOrInit(store: PrismStore, workItemId: string): Promise<PrismIssueMap> {
  if (await store.exists(workItemId)) return store.getMap(workItemId);
  const rootId = prismNodeId();
  return {
    schema_version: '0.1.0',
    work_item_id: workItemId,
    tree: {
      schema_version: '0.1.0',
      work_item_id: workItemId,
      root_id: rootId,
      nodes: [
        {
          id: rootId,
          parent_id: null,
          label: 'original intent',
          origin: 'seed',
          depth_weight: 1,
          state: 'open',
          children: [],
        },
      ],
    },
    severities: [],
    evaluations: [],
  };
}

/**
 * `ditto prism seed` — grow the issue map by ONE node, as one interview round. This
 * is the real production caller of the cap loop (`runPrismRounds` → `capStatus`): a
 * node/round/tree cap HIT stops with an escalation (cap ≠ success), never a silent
 * grow. On success the node is appended via the reused `addNode`, severity is set
 * through the MODEL-2 gate, and the round is appended to the VALUE trail.
 */
const prismSeedCommand = defineCommand({
  meta: { name: 'seed', description: 'Add one issue-map node (interview round; cap-enforced)' },
  args: {
    wi: { type: 'string', description: 'Work item id (wi_*)' },
    label: { type: 'string', description: 'Plain-language label of the issue' },
    critical: { type: 'boolean', description: 'Mark the node critical (MODEL-2)', default: false },
    'max-nodes': { type: 'string', description: 'Tree-node cap override (default 60)' },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    if (!args.wi || !args.label) {
      writeError('prism seed requires --wi <wi_*> and --label <text>');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const store = new PrismStore(repoRoot);
    try {
      const prism = await loadOrInit(store, args.wi);
      const roundsRun = (await store.readValueRounds(args.wi)).length;
      const caps = {
        ...PRISM_CAPS,
        ...(args['max-nodes'] ? { treeNodeCount: Number(args['max-nodes']) } : {}),
      };
      // REAL cap invocation: one round that would add one node.
      const drive = runPrismRounds([{ addedNodeCount: 1 }], caps, {
        treeNodeCount: prism.tree.nodes.length,
        roundsRun,
      });
      if (drive.halted) {
        // cap ≠ converged/success — stop and escalate (design decision 2, ac-10).
        if (format === 'json') {
          writeJson({ work_item_id: args.wi, halted: true, escalation: drive.escalation });
        } else {
          writeError('prism seed HALTED — cap reached (escalate, not success):');
          for (const r of drive.escalation) writeError(`  - ${r}`);
        }
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      const nodeId = prismNodeId();
      const child: CoverageNode = {
        id: nodeId,
        parent_id: prism.tree.root_id,
        label: args.label,
        origin: 'derived',
        depth_weight: 0.5,
        state: 'open',
        children: [],
      };
      let next: PrismIssueMap = { ...prism, tree: addNode(prism.tree, child) };
      if (args.critical) {
        const gate = assignSeverity(next, nodeId, 'critical');
        if (!gate.ok) {
          writeError(gate.reasons.join('; '));
          process.exit(RUNTIME_ERROR_EXIT);
          return;
        }
        next = gate.prism as PrismIssueMap;
      }
      await store.writeMap(next);
      // VALUE trail — one dry round line into the preserved question-round sink. A seed
      // ALWAYS appends a node, so it carries admissible novelty by construction
      // (wi_260708yut — consistent with the diverge path's derived novelty).
      await store.appendValueRound(args.wi, {
        ts: new Date().toISOString(),
        work_item_id: args.wi,
        round: roundsRun + 1,
        section: 'prism-issue-map',
        generator_count: 1,
        dry: true,
        selected: [],
        all_scored: [],
        novelty: true,
      });
      if (format === 'json') {
        writeJson({
          work_item_id: args.wi,
          node_id: nodeId,
          severity: severityOf(next, nodeId),
          node_count: next.tree.nodes.length,
        });
      } else {
        writeHuman(`seeded: ${args.label} [${severityOf(next, nodeId)}] (${nodeId})`);
      }
    } catch (err) {
      writeError(`prism seed failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto prism diverge` — run ONE interview round through the deterministic
 * divergence detector and EMIT the verdict (never silent). This is the shipped
 * production caller of `runDivergenceRound` (the `detectDivergence` + Record-tier
 * emit seam, ac-10): the interview loop hands each round here, so —
 *   - a re-challenge WITH new grounding evidence → a durable `challenge_admit`
 *     decision (admitted once as a visible item); exit 0 (proceed).
 *   - a meaningless divergence (쳇바퀴 repeat / decided-conflict without evidence)
 *     → a durable `early_exit` decision and a STOP (exit non-zero — a flagged
 *     divergence is not a green continue).
 *   - no divergence → no record; exit 0 (proceed).
 * A round is either a `--question` (with prior `--seen` signatures as history) or a
 * `--challenge-of <node>` re-challenge (`--new-evidence` if it carries new grounding).
 */
const prismDivergeCommand = defineCommand({
  meta: {
    name: 'diverge',
    description: 'Evaluate one interview round for divergence and emit the verdict (ac-10)',
  },
  args: {
    wi: { type: 'string', description: 'Work item id (wi_*)' },
    question: { type: 'string', description: 'The current question signature (question round)' },
    trivial: { type: 'boolean', description: 'Mark the current question trivial', default: false },
    seen: {
      type: 'string',
      description: 'A prior question signature (repeatable) — non-trivial history',
    },
    'seen-trivial': {
      type: 'string',
      description:
        'A prior TRIVIAL question signature (repeatable) — appended to the history tail; the trivial_streak shape counts consecutive trivial entries at the tail, so these make it CLI-reachable (wi_2607075vc)',
    },
    'challenge-of': {
      type: 'string',
      description: 'Decided node id being re-challenged (challenge round)',
    },
    signature: { type: 'string', description: 'The re-challenge signature (with --challenge-of)' },
    'new-evidence': {
      type: 'boolean',
      description: 'The re-challenge carries NEW grounding evidence (admissible once)',
      default: false,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    if (!args.wi) {
      writeError('prism diverge requires --wi <wi_*>');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const hasQuestion = Boolean(args.question);
    const hasChallenge = Boolean(args['challenge-of']);
    if (hasQuestion === hasChallenge) {
      writeError('prism diverge requires exactly one of --question <sig> or --challenge-of <node>');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    if (hasChallenge && !args.signature) {
      writeError('prism diverge --challenge-of also requires --signature <text>');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const round: PrismRound = hasChallenge
      ? {
          challenge: {
            decided_id: args['challenge-of'] as string,
            signature: args.signature as string,
            new_evidence: args['new-evidence'],
          },
        }
      : { question: { signature: args.question as string, trivial: args.trivial } };
    // Non-trivial history first, then the trivial ones at the tail: detectDivergence
    // counts consecutive trivial entries from the tail, so --seen-trivial is what makes
    // the trivial_streak shape reachable (wi_2607075vc — previously all history was
    // hardcoded trivial:false, so the streak could never reach TRIVIAL_STREAK_CAP).
    const history: PrismRoundSignature[] = [
      ...asArray(args.seen).map((signature) => ({ signature, trivial: false })),
      ...asArray(args['seen-trivial']).map((signature) => ({ signature, trivial: true })),
    ];
    const repoRoot = await resolveRepoRootForCreate();
    const store = new PrismStore(repoRoot);
    try {
      const { verdict, decision } = await runDivergenceRound(store, {
        workItemId: args.wi,
        round,
        history,
      });
      // VALUE trail (wi_260708yut) — persist this round's deterministically-derived
      // admissible novelty into the preserved question-round sink so an offline replay
      // can later demonstrate value-of-information (B6 data premise). dry=true/selected=[]
      // keeps the dry⟺selected constraint satisfied (a divergence round asks nothing new).
      const roundsRun = (await store.readValueRounds(args.wi)).length;
      await store.appendValueRound(args.wi, {
        ts: new Date().toISOString(),
        work_item_id: args.wi,
        round: roundsRun + 1,
        section: 'prism-divergence',
        generator_count: 1,
        dry: true,
        selected: [],
        all_scored: [],
        novelty: deriveNovelty(verdict),
      });
      if (format === 'json') {
        writeJson({ work_item_id: args.wi, verdict, ...(decision ? { decision } : {}) });
      } else {
        writeHuman(`판정: ${verdict.action} — ${verdict.reason}`);
        if (decision) writeHuman(`기록됨(Record tier): ${decision.kind}`);
      }
      // A flagged meaningless divergence is a STOP+escalate, never a green continue.
      if (verdict.diverged) process.exit(RUNTIME_ERROR_EXIT);
    } catch (err) {
      writeError(`prism diverge failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto prism close` — close a node through the MODEL-1 gate. A no-residual
 * unknown-close (out_of_scope/user_owned) of a critical node is REJECTED. An
 * accepted unknown-close records a durable Record-tier decision (never silent).
 */
const prismCloseCommand = defineCommand({
  meta: { name: 'close', description: 'Close an issue-map node (MODEL-1 unknown-close gate)' },
  args: {
    wi: { type: 'string', description: 'Work item id (wi_*)' },
    node: { type: 'string', description: 'Node id to close' },
    state: { type: 'string', description: 'resolved | out_of_scope | user_owned' },
    reason: { type: 'string', description: 'Why closed (justification)' },
    residual: {
      type: 'string',
      description: 'Surviving risk (required for a critical unknown-close)',
    },
    'justifying-reason': {
      type: 'string',
      description: 'The reason justifying a critical resolved-close (A2 gate input, ac-1)',
    },
    'refutation-attempted': {
      type: 'boolean',
      description:
        'A strongest-rebuttal (Popper refutation) was attempted before closing (A2 gate input, ac-1)',
      default: false,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const state = args.state;
    if (!args.wi || !args.node || !state) {
      writeError('prism close requires --wi, --node, and --state');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    if (state !== 'resolved' && state !== 'out_of_scope' && state !== 'user_owned') {
      writeError(`--state must be resolved | out_of_scope | user_owned (got: ${state})`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const store = new PrismStore(repoRoot);
    try {
      const prism = await store.getMap(args.wi);
      // ac-1: wire the A2 gate inputs into the node's evaluation annotation BEFORE the
      // gate reads them — closePrismNode requires BOTH on a critical `resolved` close.
      const evalPatch: Partial<Omit<PrismNodeEvaluation, 'node_id'>> = {};
      if (args['justifying-reason']) evalPatch.justifying_reason = args['justifying-reason'];
      if (args['refutation-attempted']) evalPatch.refutation_attempted = true;
      const prismForClose =
        Object.keys(evalPatch).length > 0
          ? upsertPrismEvaluation(prism, args.node, evalPatch)
          : prism;
      const result = closePrismNode(prismForClose, args.node, state, args.reason, args.residual);
      if (!result.ok) {
        // OBJ-4: an A2 rejection stamps the node prism-level `unevaluated` in
        // result.prism — persist that Run-tier trace so the under-think catch is
        // durable/measurable, never a silent exit with no record. Run tier ONLY (the
        // committed-base decisions tier is OFF-LIMITS, wi_260708cdl); other rejections
        // (false-green / residual gate) carry no prism and write nothing.
        if (result.prism) await store.writeMap(result.prism as PrismIssueMap);
        if (format === 'json') {
          writeJson({ work_item_id: args.wi, ok: false, reasons: result.reasons });
        } else {
          writeError('prism close REJECTED:');
          for (const r of result.reasons) writeError(`  - ${r}`);
        }
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      const next = result.prism as PrismIssueMap;
      await store.writeMap(next);
      if (state !== 'resolved') {
        await store.appendDecision({
          schema_version: '0.1.0',
          work_item_id: args.wi,
          kind: state === 'user_owned' ? 'unknown_close' : 'skip',
          node_id: args.node,
          reason: args.reason ?? `closed as ${state}`,
          ...(args.residual ? { residual_risk: args.residual } : {}),
          recorded_at: new Date().toISOString(),
        });
      }
      if (format === 'json') {
        writeJson({ work_item_id: args.wi, ok: true, node_id: args.node, state });
      } else {
        writeHuman(`closed: ${args.node} → ${state}`);
      }
    } catch (err) {
      writeError(`prism close failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto prism summary` — the label-only remaining-scope view (ac-3). Renders only
 * the natural-language labels of open items — no node id, severity, or axis name.
 */
const prismSummaryCommand = defineCommand({
  meta: { name: 'summary', description: 'Label-only progress summary of remaining scope (ac-3)' },
  args: {
    wi: { type: 'string', description: 'Work item id (wi_*)' },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    if (!args.wi) {
      writeError('prism summary requires --wi <wi_*>');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const store = new PrismStore(repoRoot);
    try {
      const prism = await store.getMap(args.wi);
      const labels = renderProgressSummary(prism);
      if (format === 'json') {
        writeJson({ remaining: labels });
        return;
      }
      if (labels.length === 0) {
        writeHuman('남은 항목이 없어요.');
        return;
      }
      writeHuman('아직 정할 항목:');
      for (const label of labels) writeHuman(`  - ${label}`);
    } catch (err) {
      writeError(`prism summary failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto prism status` — critical-termination status + the ac-4 minimal-launch
 * notification. Announces "최소 착수 가능" ONCE (console, no question hook), stamping
 * a durable notified_at + Record-tier decision; retracts the stamp on a regression.
 */
const prismStatusCommand = defineCommand({
  meta: {
    name: 'status',
    description: 'Critical-termination status + one-shot launch notification (ac-2/ac-4)',
  },
  args: {
    wi: { type: 'string', description: 'Work item id (wi_*)' },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    if (!args.wi) {
      writeError('prism status requires --wi <wi_*>');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const store = new PrismStore(repoRoot);
    try {
      const loaded = await store.getMap(args.wi);
      // ac-2 completeness seed: this is the production path where termination is
      // evaluated, so it is where the original-intent coverage check must fire. Split
      // intent.json into fragments, derive the explicit node→fragment mappings string-
      // level, and seed a NONCRITICAL `open` node for every fragment no node addresses.
      // The gap then SURFACES (prism tree / summary) but — being noncritical — can never
      // hard-block criticalTermination (no over-think loop). Run-tier persist only.
      const fragments = await readIntentFragments(repoRoot, args.wi);
      const seedResult = seedUncoveredFragments(
        loaded,
        fragments,
        deriveFragmentMappings(fragments, loaded),
      );
      const prism = seedResult.prism;
      if (seedResult.seededFragmentIds.length > 0) {
        await store.writeMap(prism);
      }
      const term = criticalTermination(prism);
      // ac-3: pass the ORIGINAL intent (source_request) so a firing launch notification
      // carries the achieve-vs-characterize re-anchor surface (non-blocking, console only).
      const originalIntent = await readOriginalIntent(repoRoot, args.wi);
      const notif = resolveLaunchNotification(prism, new Date(), originalIntent);
      if (notif.notify || notif.retracted) {
        await store.writeMap(notif.prism);
      }
      if (notif.notify) {
        await store.appendDecision({
          schema_version: '0.1.0',
          work_item_id: args.wi,
          kind: 'notified',
          reason: 'minimal-launch reachable — critical scope all resolved',
          recorded_at: new Date().toISOString(),
        });
      }
      if (format === 'json') {
        writeJson({
          work_item_id: args.wi,
          terminated: term.terminated,
          reason: term.reason,
          notified: notif.notify,
          retracted: notif.retracted,
          ...(notif.reAnchor ? { re_anchor: notif.reAnchor } : {}),
        });
        return;
      }
      writeHuman(`착수 가능: ${term.terminated ? '예' : '아니오'} (${term.reason})`);
      if (notif.notify && notif.message) writeHuman(notif.message);
      // ac-3 re-anchor surface: original intent verbatim + achieve-vs-characterize prompt.
      if (notif.notify && notif.reAnchor) writeHuman(`\n${notif.reAnchor}`);
      if (notif.retracted) writeHuman('상황이 되돌아가 착수 알림을 철회했어요 (새 핵심 항목).');
    } catch (err) {
      writeError(`prism status failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto prism tree` — PURE QUERY of the issue-map tree (ac-4). Renders the tree
 * structure + each node's label · severity · state · close_reason (+ residual /
 * argumentation eval / opponent status when present) and the question-round
 * timestamps. Reads ONLY (getMap + readValueRounds) — never writeMap / appendDecision,
 * so `ditto prism tree` cannot mutate state. A not-yet-seeded map is a clean message,
 * not a crash.
 */
const prismTreeCommand = defineCommand({
  meta: {
    name: 'tree',
    description:
      'Render the issue-map tree (label·severity·state·close_reason) + question-round timestamps — pure query, no mutation (ac-4)',
  },
  args: {
    wi: { type: 'string', description: 'Work item id (wi_*)' },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    if (!args.wi) {
      writeError('prism tree requires --wi <wi_*>');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const store = new PrismStore(repoRoot);
    try {
      // A not-yet-seeded map is a clean message, never a crash (missing/partial map).
      if (!(await store.exists(args.wi))) {
        if (format === 'json') {
          writeJson({
            work_item_id: args.wi,
            exists: false,
            nodes: [],
            question_round_timestamps: [],
          });
          return;
        }
        writeHuman(
          `아직 이슈맵이 없어요 (${args.wi}) — 먼저 \`ditto prism seed\`로 항목을 추가하세요.`,
        );
        return;
      }
      // PURE READ — no writeMap / appendDecision anywhere below.
      const prism = await store.getMap(args.wi);
      const timestamps = (await store.readValueRounds(args.wi)).map((r) => r.ts);
      const byId = new Map(prism.tree.nodes.map((n) => [n.id, n]));
      const evalOf = (nodeId: string) => prism.evaluations.find((e) => e.node_id === nodeId);
      const nodeView = (nodeId: string) => {
        const node = byId.get(nodeId);
        const evalRec = evalOf(nodeId);
        return {
          id: nodeId,
          label: node?.label,
          severity: severityOf(prism, nodeId),
          state: node?.state,
          ...(node?.close_reason ? { close_reason: node.close_reason } : {}),
          ...(node?.residual_risk ? { residual_risk: node.residual_risk } : {}),
          ...(evalRec?.evaluation ? { evaluation: evalRec.evaluation } : {}),
          ...(evalRec?.opponent_status ? { opponent_status: evalRec.opponent_status } : {}),
          children: node?.children ?? [],
        };
      };
      if (format === 'json') {
        writeJson({
          work_item_id: args.wi,
          root_id: prism.tree.root_id,
          nodes: prism.tree.nodes.map((n) => nodeView(n.id)),
          question_round_timestamps: timestamps,
        });
        return;
      }
      const lines: string[] = [];
      const rendered = new Set<string>();
      const walk = (nodeId: string, depth: number): void => {
        const node = byId.get(nodeId);
        if (!node || rendered.has(nodeId)) return;
        rendered.add(nodeId);
        const evalRec = evalOf(nodeId);
        const parts = [
          `${'  '.repeat(depth)}- ${node.label}`,
          `[${severityOf(prism, nodeId)}]`,
          `<${node.state}>`,
        ];
        if (evalRec?.evaluation) parts.push(`{${evalRec.evaluation}}`);
        if (evalRec?.opponent_status) parts.push(`(opponent: ${evalRec.opponent_status})`);
        if (node.close_reason) parts.push(`— close: ${node.close_reason}`);
        if (node.residual_risk) parts.push(`— residual: ${node.residual_risk}`);
        lines.push(parts.join(' '));
        for (const childId of node.children) walk(childId, depth + 1);
      };
      walk(prism.tree.root_id, 0);
      // Any node not reachable from root (defensive completeness) — never drop a node.
      for (const node of prism.tree.nodes) walk(node.id, 0);
      writeHuman(`이슈맵 (${args.wi}):`);
      for (const line of lines) writeHuman(line);
      if (timestamps.length > 0) {
        writeHuman('질문 라운드 시각:');
        for (const ts of timestamps) writeHuman(`  - ${ts}`);
      } else {
        writeHuman('질문 라운드 기록 없음');
      }
    } catch (err) {
      writeError(`prism tree failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto prism opponent` — the PRODUCTION CALLER of the model-assist opponent seam
 * (ac-5 critique over A2-flagged critical nodes · ac-6 dissent at the anchor). It
 * genuinely INVOKES `runOpponentCritiqueRound` / `runOpponentDissentRound` (no dead
 * wire): the seam runs, resolves the opponent via opponent-router, and persists its
 * Run-tier annotation in one writeMap.
 *
 * ADR-0001 boundary: this bare CLI carries NO host delegate. `isAvailable`=false /
 * `delegate`→null means opponent-router resolves no usable host, so the seam DEGRADES
 * to the deterministic shell and stamps `opponent_status='host_absent'` (ADR-0018 /
 * OBJ-3). That degrade — the call happens, the stamp is written, no crash / no fake
 * pass — IS the observable wiring proof in the bare CLI; a host-driven skill would
 * inject a real availability predicate + delegate here.
 */
const prismOpponentCommand = defineCommand({
  meta: {
    name: 'opponent',
    description:
      'Drive the model-assist opponent seam: critique over A2-flagged critical nodes (ac-5) or independent dissent at the anchor (ac-6). Host-delegated (ADR-0001); with no host it degrades gracefully and stamps host_absent (ADR-0018).',
  },
  args: {
    wi: { type: 'string', description: 'Work item id (wi_*)' },
    concern: {
      type: 'string',
      description: 'critique (ac-5, A2-flagged critical nodes) | dissent (ac-6, anchor)',
      default: 'critique',
    },
    host: {
      type: 'string',
      description: 'Current host for opponent-router candidate resolution: claude-code | codex',
      default: 'claude-code',
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    if (!args.wi) {
      writeError('prism opponent requires --wi <wi_*>');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const concern = args.concern ?? 'critique';
    if (concern !== 'critique' && concern !== 'dissent') {
      writeError(`--concern must be critique | dissent (got: ${concern})`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const currentHost: DialecticHost = args.host === 'codex' ? 'codex' : 'claude-code';
    const repoRoot = await resolveRepoRootForCreate();
    const store = new PrismStore(repoRoot);
    try {
      if (!(await store.exists(args.wi))) {
        writeError(`prism opponent: no issue map for ${args.wi} — seed one first`);
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      const config: OpponentSeamConfig = {
        policy: BARE_MODEL_POLICY,
        currentHost,
        // No host delegate in the bare CLI → the seam degrades (host_absent), ADR-0018.
        isAvailable: () => ({ available: false, reason: 'runtime' }),
        delegate: async () => null,
        intent: (await readOriginalIntent(repoRoot, args.wi)) ?? '',
      };
      const outcome =
        concern === 'critique'
          ? await runOpponentCritiqueRound(store, args.wi, config)
          : await runOpponentDissentRound(store, args.wi, config);
      if (format === 'json') {
        writeJson({
          work_item_id: args.wi,
          concern,
          host_available: outcome.host_available,
          engaged: outcome.engaged,
          degraded: outcome.degraded,
          skipped_by_cap: outcome.skipped_by_cap,
        });
        return;
      }
      if (!outcome.host_available) {
        writeHuman(
          `opponent host 없음 — 결정적 shell로 우아하게 강등했어요 (${concern}, host_absent). (ADR-0018)`,
        );
      } else {
        writeHuman(
          `opponent 실행 (${concern}): ${outcome.engaged.length}건 기록, ${outcome.degraded.length}건 강등.`,
        );
      }
      if (outcome.degraded.length > 0) {
        writeHuman('강등된 노드(host_absent 스탬프):');
        for (const id of outcome.degraded) writeHuman(`  - ${id}`);
      }
    } catch (err) {
      writeError(`prism opponent failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/** Node label for a brief target, falling back to the id when the node is missing. */
function briefTargetLabel(prism: PrismIssueMap, nodeId: string): string {
  return prism.tree.nodes.find((n) => n.id === nodeId)?.label ?? nodeId;
}

/**
 * `ditto prism opponent-briefs` — emit the structured briefs the host layer needs to
 * spawn opponent agents (ADR-0001: NO model call here). Three groups, each target
 * carrying its node id + label + the ORIGINAL intent text: critique_targets (the
 * A2-flagged critical nodes), dissent_anchor (the tree root — the intent frame), and
 * semantic_targets (the covered (fragment,node) pairs). The host runs the judgment; the
 * verdicts flow back through `opponent-record`.
 */
const prismOpponentBriefsCommand = defineCommand({
  meta: {
    name: 'opponent-briefs',
    description:
      'Emit structured opponent briefs (critique/dissent/semantic targets) for the host to judge — no model call (ADR-0001).',
  },
  args: {
    wi: { type: 'string', description: 'Work item id (wi_*)' },
  },
  run: async ({ args }) => {
    if (!args.wi) {
      writeError('prism opponent-briefs requires --wi <wi_*>');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const store = new PrismStore(repoRoot);
    try {
      if (!(await store.exists(args.wi))) {
        writeError(`prism opponent-briefs: no issue map for ${args.wi} — seed one first`);
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      const prism = await store.getMap(args.wi);
      const intent = (await readOriginalIntent(repoRoot, args.wi)) ?? '';
      const fragments = await readIntentFragments(repoRoot, args.wi);
      const target = (nodeId: string) => ({
        node_id: nodeId,
        label: briefTargetLabel(prism, nodeId),
        intent,
      });
      writeJson({
        work_item_id: args.wi,
        // ac-5 critique: the A2-flagged critical nodes (unevaluated ∧ critical).
        critique_targets: flaggedCriticalNodeIds(prism).map(target),
        // ac-6 dissent: the tree root — the original-intent frame.
        dissent_anchor: target(prism.tree.root_id),
        // A1 semantic: the covered (fragment,node) pairs, carrying the mapped fragment.
        semantic_targets: semanticCriticTargets(prism, fragments).map((m) => ({
          ...target(m.node_id),
          fragment_id: m.fragment_id,
        })),
      });
    } catch (err) {
      writeError(
        `prism opponent-briefs failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/** The concern→record-primitive routing (per-surface, mirrors the seam's own record-back). */
function recordVerdict(
  prism: PrismIssueMap,
  verdict: PrismOpponentVerdict,
  outcome: OpponentOutcome,
): PrismIssueMap {
  switch (verdict.concern) {
    case 'critique':
      return recordOpponentCritique(prism, verdict.node_id, outcome);
    case 'dissent':
      return recordOpponentDissent(prism, verdict.node_id, outcome);
    case 'semantic':
      return recordSemanticCritique(prism, verdict.node_id, outcome);
  }
}

/**
 * `ditto prism opponent-record` — consume the host's verdict JSON and persist the
 * record-back through the existing seam primitives (ADR-0001: no model call). The
 * pass-in-JSON precedent (autopilot coverage-next --relevance): JSON.parse in try/catch
 * → USAGE_ERROR, then a zod safeParse (M1), then an in-memory fold + EXACTLY ONE
 * writeMap (OBJ-2 single-writer, mirrors loop.ts).
 *
 * Hardening — this is the FIRST path feeding EXTERNAL node_ids into upsertEvaluation
 * (which appends unconditionally with no tree-membership guard):
 *  - M1: safeParse rejects a malformed payload → USAGE_ERROR, map UNCHANGED.
 *  - M2: any verdict whose node_id ∉ tree.nodes → fail-closed, NO orphan upsert
 *    (ADR-0018 never-silent). An empty (whitespace) text degrades to host_absent,
 *    never a false `engaged` stamp.
 *  - M3: echo the recorded engaged/degraded ids; with --briefed, surface the briefed
 *    concerns that went unanswered.
 */
const prismOpponentRecordCommand = defineCommand({
  meta: {
    name: 'opponent-record',
    description:
      'Record host-delegated opponent verdicts (critique/dissent/semantic) into the prism map — validated + fail-closed on foreign node ids (ADR-0018).',
  },
  args: {
    wi: { type: 'string', description: 'Work item id (wi_*)' },
    json: {
      type: 'string',
      description: 'Verdict payload JSON {verdicts:[{concern,node_id,text}]}',
    },
    briefed: {
      type: 'string',
      description: 'Optional comma-separated briefed node ids — surfaces unanswered concerns (M3)',
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    if (!args.wi || !args.json) {
      writeError('prism opponent-record requires --wi <wi_*> and --json <verdicts>');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    // Pass-in-JSON: parse then safeParse (M1). Either failure → USAGE_ERROR, no write.
    let raw: unknown;
    try {
      raw = JSON.parse(args.json);
    } catch (err) {
      writeError(`--json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const parsed = prismOpponentVerdicts.safeParse(raw);
    if (!parsed.success) {
      writeError('--json failed schema validation:');
      for (const issue of parsed.error.issues) {
        writeError(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const store = new PrismStore(repoRoot);
    try {
      if (!(await store.exists(args.wi))) {
        writeError(`prism opponent-record: no issue map for ${args.wi} — seed one first`);
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      const prism = await store.getMap(args.wi);
      // M2: fail-closed on any verdict node_id not in the tree — NEVER upsert an orphan
      // evaluation the tree render can't show (ADR-0018 never-silent verdict loss).
      const known = new Set(prism.tree.nodes.map((n) => n.id));
      const foreign = parsed.data.verdicts.map((v) => v.node_id).filter((id) => !known.has(id));
      if (foreign.length > 0) {
        writeError(
          `prism opponent-record: verdict node_id(s) absent from tree — refusing orphan record (ADR-0018): ${[...new Set(foreign)].join(', ')}`,
        );
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      // In-memory fold: an empty (whitespace) text degrades to host_absent (M2) — never a
      // false engaged stamp. Then EXACTLY ONE writeMap (OBJ-2 single-writer).
      let next = prism;
      const engaged: string[] = [];
      const degraded: string[] = [];
      for (const v of parsed.data.verdicts) {
        const outcome: OpponentOutcome =
          v.text.trim().length > 0
            ? { status: 'engaged', text: v.text }
            : { status: 'host_absent' };
        next = recordVerdict(next, v, outcome);
        (outcome.status === 'engaged' ? engaged : degraded).push(v.node_id);
      }
      await store.writeMap(next);
      // M3: surface briefed-but-unanswered concerns when the briefed set is supplied.
      const briefed = (args.briefed ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const answered = new Set(parsed.data.verdicts.map((v) => v.node_id));
      const unanswered = briefed.filter((id) => !answered.has(id));
      if (format === 'json') {
        writeJson({ work_item_id: args.wi, engaged, degraded, unanswered });
        return;
      }
      writeHuman(`opponent-record: ${engaged.length}건 기록(engaged), ${degraded.length}건 강등.`);
      if (engaged.length > 0) writeHuman(`  engaged: ${engaged.join(', ')}`);
      if (degraded.length > 0) writeHuman(`  degraded(host_absent): ${degraded.join(', ')}`);
      if (unanswered.length > 0) {
        writeHuman(`  브리핑됐으나 미응답: ${unanswered.join(', ')}`);
      }
    } catch (err) {
      writeError(
        `prism opponent-record failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto prism doc` — emit the human-readable `.ditto/specs` design document from a refined
 * design-doc payload (JSON), through the fail-closed gate (`emitDesignDoc`): containment on the
 * out path, grounding required on factual claims (ac-5), no raw transcription, and the compile
 * -input sections bound by the preserved `computeSpecDigest` (ac-6). A sub-threshold emit needs
 * the explicit `--allow-ungrounded` flag, and then ships the unresolved items marked in-doc.
 */
const prismDocCommand = defineCommand({
  meta: {
    name: 'doc',
    description: 'Emit the design document with grounding + digest binding (ac-5/ac-6)',
  },
  args: {
    wi: { type: 'string', description: 'Work item id (wi_*)' },
    input: { type: 'string', description: 'Path to the design-doc payload JSON' },
    out: {
      type: 'string',
      description: 'Repo-relative output path (default .ditto/specs/<wi>-design.md)',
    },
    'allow-ungrounded': {
      type: 'boolean',
      description:
        'Explicit decision: emit even with ungrounded factual claims (marks them unresolved)',
      default: false,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    if (!args.wi || !args.input) {
      writeError('prism doc requires --wi <wi_*> and --input <payload.json>');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const targetPath = args.out ?? `.ditto/specs/${args.wi}-design.md`;
    const repoRoot = await resolveRepoRootForCreate();
    try {
      const payloadFile = Bun.file(args.input);
      if (!(await payloadFile.exists())) {
        writeError(`payload not found: ${args.input}`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const input = (await payloadFile.json()) as DesignDocInput;
      const result = emitDesignDoc(input, {
        targetPath,
        repoRoot,
        allowUngrounded: args['allow-ungrounded'],
      });
      if (result.status === 'rejected') {
        if (format === 'json') {
          writeJson({ work_item_id: args.wi, ok: false, reasons: result.reasons });
        } else {
          writeError('prism doc REJECTED:');
          for (const r of result.reasons) writeError(`  - ${r}`);
        }
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      await Bun.write(result.abs, result.markdown);
      if (format === 'json') {
        writeJson({
          work_item_id: args.wi,
          ok: true,
          path: targetPath,
          digest: result.digest,
          unresolved: result.unresolved,
        });
        return;
      }
      writeHuman(`design doc emitted: ${targetPath}`);
      writeHuman(`  digest: ${result.digest}`);
      if (result.unresolved.length > 0) {
        writeHuman('  미해결(근거 없음) 항목:');
        for (const u of result.unresolved) writeHuman(`    - ${u}`);
      }
    } catch (err) {
      writeError(`prism doc failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto prism backlog propose` — from a CONFIRMED design doc + proposed items,
 * produce and persist a backlog-split PROPOSAL (ac-8). Nothing is materialized here:
 * a proposal is presented; materialization waits for the user's explicit approval.
 * The `--input` payload is `{ doc: DesignDocInput, items: [...] }`.
 */
const prismBacklogProposeCommand = defineCommand({
  meta: {
    name: 'propose',
    description: 'Propose a backlog split from a confirmed design doc (ac-8)',
  },
  args: {
    wi: { type: 'string', description: 'Parent work item id (wi_*)' },
    input: { type: 'string', description: 'Path to the split payload JSON ({ doc, items })' },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    if (!args.wi || !args.input) {
      writeError('prism backlog propose requires --wi <wi_*> and --input <payload.json>');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const store = new PrismStore(repoRoot);
    try {
      const payloadFile = Bun.file(args.input);
      if (!(await payloadFile.exists())) {
        writeError(`payload not found: ${args.input}`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const payload = (await payloadFile.json()) as { doc: DesignDocInput; items: unknown[] };
      const result: ProposeSplitResult = proposeBacklogSplit(payload.doc, payload.items ?? []);
      if (result.status === 'rejected') {
        if (format === 'json') {
          writeJson({ work_item_id: args.wi, ok: false, reasons: result.reasons });
        } else {
          writeError('prism backlog propose REJECTED:');
          for (const r of result.reasons) writeError(`  - ${r}`);
        }
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      await store.writeBacklogSplit({
        schema_version: '0.1.0',
        work_item_id: args.wi,
        items: result.items,
        materialized: [],
      });
      if (format === 'json') {
        writeJson({ work_item_id: args.wi, ok: true, proposed: result.items.length });
        return;
      }
      writeHuman(`분할안을 제안했어요 (${result.items.length}건). 승인 후에만 물화됩니다:`);
      for (const item of result.items) writeHuman(`  - ${item.title}`);
      writeHuman('승인하려면: ditto prism backlog materialize --wi <wi> --statement "<원문 승인>"');
    } catch (err) {
      writeError(
        `prism backlog propose failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto prism backlog materialize` — materialize the persisted proposal into
 * per-item WI DRAFTS, ONLY when `--statement` carries the user's own approval words
 * (ac-8). A bare invocation without `--statement` is NOT approval and is rejected.
 * Materialize creates DRAFTS only (no intent.json, no auto-start) and is idempotent.
 */
const prismBacklogMaterializeCommand = defineCommand({
  meta: {
    name: 'materialize',
    description:
      'Materialize the approved split into per-item WI drafts (user statement required, ac-8)',
  },
  args: {
    wi: { type: 'string', description: 'Parent work item id (wi_*)' },
    statement: {
      type: 'string',
      description: "The user's own approval words (required — a bare call is NOT approval)",
    },
    by: { type: 'string', description: 'Who approved (attribution)', default: 'user' },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    if (!args.wi) {
      writeError('prism backlog materialize requires --wi <wi_*>');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    // The approval primitive: a bare CLI call (no --statement) is NOT approval.
    if (!args.statement || args.statement.trim().length === 0) {
      writeError(
        'prism backlog materialize requires --statement "<원문 승인>": bare 호출은 승인이 아닙니다 (사용자 원문 필요)',
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const prism = new PrismStore(repoRoot);
    const workItems = new WorkItemStore(repoRoot);
    try {
      const result: MaterializeSplitResult = await materializeBacklogSplit({
        workItems,
        prism,
        parentId: args.wi,
        approval: {
          confirmed: true,
          statement: args.statement,
          approved_by: args.by ?? 'user',
          approved_at: new Date().toISOString(),
        },
      });
      if (result.status === 'rejected') {
        if (format === 'json') {
          writeJson({ work_item_id: args.wi, ok: false, reasons: result.reasons });
        } else {
          writeError('prism backlog materialize REJECTED:');
          for (const r of result.reasons) writeError(`  - ${r}`);
        }
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      if (format === 'json') {
        writeJson({ work_item_id: args.wi, ok: true, materialized_wis: result.materialized_wis });
        return;
      }
      writeHuman(
        `승인 확인 — ${result.materialized_wis.length}건을 draft 작업으로 물화했어요 (자동 착수 없음):`,
      );
      for (const id of result.materialized_wis) writeHuman(`  - ${id}`);
    } catch (err) {
      writeError(
        `prism backlog materialize failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const prismBacklogCommand = defineCommand({
  meta: {
    name: 'backlog',
    description:
      'Backlog split (ac-8): propose a split from a confirmed design doc, then materialize per-item WI drafts ONLY after the user’s explicit statement approval',
  },
  subCommands: {
    propose: prismBacklogProposeCommand,
    materialize: prismBacklogMaterializeCommand,
  },
});

export const prismCommand = defineCommand({
  meta: {
    name: 'prism',
    description:
      'Prism issue-map engine: grow (seed), evaluate a round for divergence + emit (diverge, ac-10), close (MODEL-1 + A2 resolved-close gate), label-only summary (ac-3), critical-termination + minimal-launch re-anchor (ac-2/ac-3/ac-4), pure-query tree view (ac-4), model-assist opponent seam (ac-5/ac-6), and backlog split (ac-8)',
  },
  subCommands: {
    seed: prismSeedCommand,
    diverge: prismDivergeCommand,
    close: prismCloseCommand,
    summary: prismSummaryCommand,
    status: prismStatusCommand,
    tree: prismTreeCommand,
    opponent: prismOpponentCommand,
    'opponent-briefs': prismOpponentBriefsCommand,
    'opponent-record': prismOpponentRecordCommand,
    doc: prismDocCommand,
    backlog: prismBacklogCommand,
  },
});
