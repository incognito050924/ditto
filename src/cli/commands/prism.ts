import { randomBytes } from 'node:crypto';
import { defineCommand } from 'citty';
import { addNode } from '~/core/coverage-manager';
import { resolveRepoRootForCreate } from '~/core/fs';
import {
  type MaterializeSplitResult,
  type ProposeSplitResult,
  materializeBacklogSplit,
  proposeBacklogSplit,
} from '~/core/prism/backlog';
import { type DesignDocInput, emitDesignDoc } from '~/core/prism/designdoc';
import {
  PRISM_CAPS,
  type PrismRound,
  type PrismRoundSignature,
  assignSeverity,
  closePrismNode,
  criticalTermination,
  renderProgressSummary,
  resolveLaunchNotification,
  runPrismRounds,
  severityOf,
} from '~/core/prism/engine';
import { runDivergenceRound } from '~/core/prism/loop';
import { PrismStore } from '~/core/prism/store';
import { WorkItemStore } from '~/core/work-item-store';
import type { CoverageNode } from '~/schemas/coverage';
import type { PrismIssueMap } from '~/schemas/prism';
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
      // VALUE trail — one dry round line into the preserved question-round sink.
      await store.appendValueRound(args.wi, {
        ts: new Date().toISOString(),
        work_item_id: args.wi,
        round: roundsRun + 1,
        section: 'prism-issue-map',
        generator_count: 1,
        dry: true,
        selected: [],
        all_scored: [],
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
    seen: { type: 'string', description: 'A prior question signature (repeatable) — history' },
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
    const history: PrismRoundSignature[] = asArray(args.seen).map((signature) => ({
      signature,
      trivial: false,
    }));
    const repoRoot = await resolveRepoRootForCreate();
    const store = new PrismStore(repoRoot);
    try {
      const { verdict, decision } = await runDivergenceRound(store, {
        workItemId: args.wi,
        round,
        history,
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
      const result = closePrismNode(prism, args.node, state, args.reason, args.residual);
      if (!result.ok) {
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
      const prism = await store.getMap(args.wi);
      const term = criticalTermination(prism);
      const notif = resolveLaunchNotification(prism, new Date());
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
        });
        return;
      }
      writeHuman(`착수 가능: ${term.terminated ? '예' : '아니오'} (${term.reason})`);
      if (notif.notify && notif.message) writeHuman(notif.message);
      if (notif.retracted) writeHuman('상황이 되돌아가 착수 알림을 철회했어요 (새 핵심 항목).');
    } catch (err) {
      writeError(`prism status failed: ${err instanceof Error ? err.message : String(err)}`);
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
      'Prism issue-map engine: grow (seed), evaluate a round for divergence + emit (diverge, ac-10), close (MODEL-1 gate), label-only summary (ac-3), critical-termination + minimal-launch notification (ac-2/ac-4), and backlog split (ac-8)',
  },
  subCommands: {
    seed: prismSeedCommand,
    diverge: prismDivergeCommand,
    close: prismCloseCommand,
    summary: prismSummaryCommand,
    status: prismStatusCommand,
    doc: prismDocCommand,
    backlog: prismBacklogCommand,
  },
});
