import { defineCommand } from 'citty';
import { bootstrapAutopilot } from '~/core/autopilot-bootstrap';
import { runCleanup } from '~/core/autopilot-cleanup';
import { assembleCompletionFromGraph } from '~/core/autopilot-complete';
import { kindToOwner } from '~/core/autopilot-graph';
import { nextNode, recordResult, recordResultPayload } from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import { CompletionStore } from '~/core/completion-store';
import { nextCoverageNode, recordCoverageRound } from '~/core/coverage-loop';
import { checkE2eCompletionGate } from '~/core/e2e/completion-gate';
import { detectWebSurfaceChange } from '~/core/e2e/web-surface';
import { resolveRepoRootForCreate } from '~/core/fs';
import { intentDriftGate, interfaceBaselineDriftGate } from '~/core/gates';
import { listChangedFiles } from '~/core/git';
import { IntentStore } from '~/core/intent-store';
import { WorkItemStore } from '~/core/work-item-store';
import { coverageRoundPayload } from '~/schemas/coverage';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/**
 * `ditto autopilot bootstrap` — surface bootstrapAutopilot as a thin CLI so the
 * deep-interview `finalize` step (in-process call) and manual operators (CLI
 * call) reach the SAME core function. Idempotent on success: the second call
 * with the same intent re-writes an autopilot.json with a fresh autopilot_id
 * but identical structure.
 */
const autopilotBootstrap = defineCommand({
  meta: {
    name: 'bootstrap',
    description: 'Build the autopilot graph for a work item from its intent.json',
  },
  args: {
    workItem: {
      type: 'string',
      description: 'Work item id (wi_*) whose intent.json drives the graph',
      required: true,
    },
    riskNonLocal: {
      type: 'boolean',
      description: 'Set when the change touches code outside the obvious local site',
      default: false,
    },
    riskIrreversible: {
      type: 'boolean',
      description: 'Set when the change cannot be undone by a follow-up commit',
      default: false,
    },
    riskUnaudited: {
      type: 'boolean',
      description: 'Set when the change introduces dependencies / surfaces nobody has reviewed',
      default: false,
    },
    approvedSource: {
      type: 'string',
      description: 'Pre-approval source: approved_spec|issue|prd|user (omit for auto risk gate)',
      required: false,
    },
    output: {
      type: 'string',
      description: 'Output format: human|json',
      default: 'human',
    },
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
    const approvedSource = args.approvedSource;
    if (
      approvedSource !== undefined &&
      !['approved_spec', 'issue', 'prd', 'user'].includes(approvedSource)
    ) {
      writeError(
        `invalid --approved-source "${approvedSource}"; expected one of: approved_spec, issue, prd, user`,
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const items = new WorkItemStore(repoRoot);
    if (!(await items.exists(args.workItem))) {
      writeError(`work item ${args.workItem} not found`);
      process.exit(RUNTIME_ERROR_EXIT);
      return;
    }
    const intentStore = new IntentStore(repoRoot);
    if (!(await intentStore.exists(args.workItem))) {
      writeError(
        `intent.json missing for ${args.workItem}. Run /ditto:deep-interview (ditto deep-interview finalize) first.`,
      );
      process.exit(RUNTIME_ERROR_EXIT);
      return;
    }
    const workItem = await items.get(args.workItem);
    const intent = await intentStore.get(args.workItem);
    const result = await bootstrapAutopilot(repoRoot, {
      workItem,
      intent,
      risk: {
        non_local: args.riskNonLocal,
        irreversible: args.riskIrreversible,
        unaudited: args.riskUnaudited,
      },
      ...(approvedSource
        ? { approvedSource: approvedSource as 'approved_spec' | 'issue' | 'prd' | 'user' }
        : {}),
    });
    if (result.status !== 'created') {
      writeError(`autopilot bootstrap failed (${result.status}):`);
      for (const reason of result.reasons) writeError(`  - ${reason}`);
      process.exit(RUNTIME_ERROR_EXIT);
      return;
    }
    if (format === 'json') {
      writeJson({
        work_item_id: args.workItem,
        autopilot_id: result.graph.autopilot_id,
        approval_gate: result.graph.approval_gate.status,
        node_ids: result.graph.nodes.map((n) => n.id),
        path: `.ditto/local/work-items/${args.workItem}/autopilot.json`,
      });
    } else {
      writeHuman(`Bootstrapped autopilot ${result.graph.autopilot_id}`);
      writeHuman(`  work_item:     ${args.workItem}`);
      writeHuman(`  approval_gate: ${result.graph.approval_gate.status}`);
      writeHuman(`  nodes:         ${result.graph.nodes.map((n) => n.id).join(' -> ')}`);
      writeHuman(`  path:          .ditto/local/work-items/${args.workItem}/autopilot.json`);
    }
  },
});

/**
 * `ditto autopilot next-node` / `record-result` — surface the deterministic loop
 * steps (G9) so the `autopilot` skill calls them instead of re-describing the
 * logic in prose. Same shape as the deep-interview step CLI: resolve repo root,
 * require an existing autopilot graph, call the core step function, render
 * human/json. The driver (main agent) loops by calling these repeatedly.
 */
async function requireGraph(workItem: string): Promise<string> {
  const repoRoot = await resolveRepoRootForCreate();
  if (!(await new AutopilotStore(repoRoot).exists(workItem))) {
    writeError(
      `autopilot.json missing for ${workItem}. Run ditto autopilot bootstrap (or deep-interview finalize) first.`,
    );
    process.exit(RUNTIME_ERROR_EXIT);
  }
  return repoRoot;
}

const autopilotNextNode = defineCommand({
  meta: {
    name: 'next-node',
    description:
      'Compute the next loop action (select ready node, consume approval gate, dispatch)',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
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
    const repoRoot = await requireGraph(args.workItem);
    try {
      const res = await nextNode(repoRoot, args.workItem);
      if (format === 'json') {
        writeJson(res);
      } else if (res.action === 'spawn') {
        writeHuman(`Next: spawn ${res.owner} on ${res.node_id}`);
        writeHuman(`  task:       ${res.packet.task}`);
        writeHuman(`  done_when:  ${res.packet.context.done_when}`);
        writeHuman(`  file_scope: ${res.packet.context.file_scope.join(', ') || '(none)'}`);
      } else if (res.action === 'spawn_wave') {
        writeHuman(`Next: spawn wave (${res.spawns.length} parallel nodes)`);
        for (const s of res.spawns) {
          writeHuman(`  - ${s.owner} on ${s.node_id}: ${s.packet.task}`);
        }
      } else {
        writeHuman(`Next: ${res.action} — ${res.reason}`);
        if (res.action === 'rollback') {
          writeHuman(`  rolled_back: ${res.rolled_back_node_ids.join(', ') || '(none)'}`);
        } else if (res.action === 'blocked') {
          writeHuman(`  blocked:     ${res.blocked_node_ids.join(', ') || '(none)'}`);
        } else if (res.action === 'done') {
          writeHuman(
            `  → run completion (${res.all_passed ? 'expect pass' : 'expect partial/fail'})`,
          );
        } else if (res.action === 'cleanup') {
          writeHuman(`  node:        ${res.node_id}`);
          writeHuman(`  → run: ditto autopilot cleanup --workItem <wi> --node ${res.node_id}`);
        } else if (res.action === 'main_session') {
          writeHuman(`  node:        ${res.node_id}`);
          writeHuman('  → run the ditto:e2e-author skill inline, then record-result');
        }
      }
    } catch (err) {
      writeError(`next-node failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const autopilotRecordResult = defineCommand({
  meta: {
    name: 'record-result',
    description: "Record an owner subagent's result: G7 guard, classify, decide, persist",
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    json: {
      type: 'string',
      description: 'JSON payload matching recordResultPayload schema',
      required: true,
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
    let raw: unknown;
    try {
      raw = JSON.parse(args.json);
    } catch (err) {
      writeError(`--json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const parsed = recordResultPayload.safeParse(raw);
    if (!parsed.success) {
      writeError('--json failed schema validation:');
      for (const issue of parsed.error.issues) {
        writeError(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await requireGraph(args.workItem);
    try {
      const res = await recordResult(repoRoot, { workItemId: args.workItem, payload: parsed.data });
      if (format === 'json') {
        writeJson(res);
      } else {
        writeHuman(`Recorded ${res.node_id}: ${res.outcome} → status=${res.status}`);
        if (!res.guard_contentful) {
          writeHuman('  (G7: non-contentful result — claimed outcome overridden to fixable)');
        }
        if (res.decision) {
          writeHuman(`  decision: ${res.decision}${res.cap_exceeded ? ' (cap exceeded)' : ''}`);
        }
      }
    } catch (err) {
      writeError(`record-result failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto autopilot complete` — assemble a completion contract from the finished
 * graph (done→completion bridge). Maps each acceptance criterion to the evidence
 * the nodes collected and derives its verdict, evidence-gated (a pass needs a
 * passed addressing node WITH evidence; otherwise unverified). Not auto-pass —
 * `final_verdict=pass` still demands every AC closed with real evidence (§6.8).
 */
const autopilotComplete = defineCommand({
  meta: {
    name: 'complete',
    description:
      'Assemble a completion contract from the finished autopilot graph (evidence-gated)',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    summary: {
      type: 'string',
      description: 'Completion narrative; a terse default is derived when omitted',
      required: false,
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
    const repoRoot = await requireGraph(args.workItem);
    try {
      const aps = new AutopilotStore(repoRoot);
      const graph = await aps.get(args.workItem);
      const workItem = await new WorkItemStore(repoRoot).get(args.workItem);
      // 완료측 결정론 체크 (dialectic-1 O-4/O-18): E2E 제안 결정과 회귀 게이트
      // 기록은 에이전트 기억이 아니라 여기서 기계로 강제된다 — 의무 미이행
      // 상태로는 completion을 조립하지 않는다.
      const e2eViolations = await checkE2eCompletionGate(repoRoot, {
        workItemId: args.workItem,
        changedFiles: workItem.changed_files,
        decisions: await aps.readDecisions(args.workItem),
      });
      if (e2eViolations.length > 0) {
        if (format === 'json') {
          writeJson({ work_item_id: args.workItem, e2e_gate: e2eViolations });
        } else {
          writeError(`complete blocked by the e2e completion gate (${e2eViolations.length}):`);
          for (const v of e2eViolations) writeError(`  [${v.code}] ${v.message}`);
        }
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      const completion = assembleCompletionFromGraph(graph, workItem, {
        ...(args.summary ? { summary: args.summary } : {}),
      });
      await new CompletionStore(repoRoot).write(completion);
      if (format === 'json') {
        writeJson({
          work_item_id: args.workItem,
          final_verdict: completion.final_verdict,
          acceptance: completion.acceptance.map((a) => ({
            criterion_id: a.criterion_id,
            verdict: a.verdict,
            evidence_count: a.evidence.length,
          })),
          path: `.ditto/local/work-items/${args.workItem}/completion.json`,
        });
      } else {
        writeHuman(
          `Assembled completion for ${args.workItem}: final_verdict=${completion.final_verdict}`,
        );
        for (const a of completion.acceptance) {
          writeHuman(`  ${a.criterion_id}: ${a.verdict} (${a.evidence.length} evidence)`);
        }
        if (completion.final_verdict !== 'pass') {
          writeHuman(
            '  (non-pass: criteria without evidence stay unverified — close them, then re-run)',
          );
        }
      }
    } catch (err) {
      writeError(`complete failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto autopilot cleanup` — run the deterministic cleanup step for a
 * `driver`-owned (cleanup) node: tear down the per-run git worktrees (§2.2).
 * Worktree removal is irreversible git work, so it is gated by an EXPLICIT
 * approval — pass `--approve` to authorize. Without it (and with worktrees to
 * remove) the node is blocked and the teardown plan is surfaced for a decision.
 */
const autopilotCleanup = defineCommand({
  meta: {
    name: 'cleanup',
    description:
      'Run the deterministic cleanup step for a driver-owned node (gated worktree teardown)',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    node: { type: 'string', description: 'Cleanup node id', required: true },
    approve: {
      type: 'boolean',
      description: 'Explicit approval for the irreversible git (worktree removal) step',
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
    const repoRoot = await requireGraph(args.workItem);
    try {
      const res = await runCleanup(repoRoot, {
        workItemId: args.workItem,
        nodeId: args.node,
        approve: args.approve,
      });
      if (format === 'json') {
        writeJson(res);
      } else if (res.status === 'blocked') {
        writeHuman(`Cleanup ${res.node_id}: blocked — ${res.reason}`);
        writeHuman(`  plan (${res.plan.length}): ${res.plan.join(', ') || '(none)'}`);
        writeHuman('  → re-run with --approve to authorize the irreversible git step');
      } else {
        writeHuman(
          `Cleanup ${res.node_id}: passed — removed ${res.removed.length}/${res.plan.length} worktree(s)`,
        );
        if (res.skipped.length > 0) {
          for (const s of res.skipped) writeHuman(`  skipped: ${s.path} (${s.reason})`);
        }
      }
    } catch (err) {
      writeError(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto autopilot propose-e2e` — the deterministic half of the E2E authoring
 * proposal (wi_260610p9h ac-6). Detects whether the changed files touch a web
 * surface (frontend page/component or backend API, diff-based heuristic in
 * `src/core/e2e/web-surface.ts`); the driver then ASKS THE USER and re-runs
 * with `--decision` to record the answer: decline → decision log only (no
 * node), accept → an `e2e-author` (main-session) node is added to the graph.
 * The proposal dialogue itself stays with the driver — this CLI only detects
 * and records (determinism).
 */
const autopilotProposeE2e = defineCommand({
  meta: {
    name: 'propose-e2e',
    description:
      'Detect web-surface changes and record the user decision on E2E authoring (accept adds an e2e-author node)',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    changedFiles: {
      type: 'string',
      description: 'Comma-separated repo-relative changed paths to scan',
      required: true,
    },
    decision: {
      type: 'string',
      description: 'accept|decline — record the user decision (omit to only detect)',
      required: false,
    },
    journeys: {
      type: 'string',
      description: 'Optional user journey hint carried onto the e2e-author node on accept',
      required: false,
    },
    after: {
      type: 'string',
      description:
        'Comma-separated existing node ids the e2e-author node must run AFTER (depends_on)',
      required: false,
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
    const decision = args.decision;
    if (decision !== undefined && decision !== 'accept' && decision !== 'decline') {
      writeError(`invalid --decision "${decision}"; expected accept or decline`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const after = (args.after ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);
    const repoRoot = await requireGraph(args.workItem);
    const changed = args.changedFiles
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    const detection = detectWebSurfaceChange(changed);
    try {
      if (!detection.web) {
        // No web surface in the diff → nothing to propose, regardless of any
        // --decision: there is no proposal for the user to answer.
        if (format === 'json') {
          writeJson({ web: false, surfaces: [], proposal_needed: false });
        } else {
          writeHuman('No web-surface change detected — E2E authoring proposal not needed.');
        }
        return;
      }
      if (decision === undefined) {
        if (format === 'json') {
          writeJson({ web: true, surfaces: detection.surfaces, proposal_needed: true });
        } else {
          writeHuman(`Web-surface change detected (${detection.surfaces.length} surface(s)):`);
          for (const s of detection.surfaces) writeHuman(`  - [${s.kind}] ${s.path}`);
          writeHuman('  → ask the user, then re-run with --decision accept|decline');
        }
        return;
      }
      const aps = new AutopilotStore(repoRoot);
      const ts = new Date().toISOString();
      const surfaceSummary = detection.surfaces.map((s) => `${s.kind}:${s.path}`).join(', ');
      if (decision === 'decline') {
        // Decline → decision log only; the graph stays as-is (no authoring node)
        // and verification proceeds through the regular verify nodes (ac-6).
        await aps.appendDecision(args.workItem, {
          ts,
          node_id: 'e2e-proposal',
          decision: 'e2e_decline',
          reason: `user declined E2E authoring for web-surface change (${surfaceSummary})`,
        });
        if (format === 'json') {
          writeJson({ web: true, decision: 'decline', node_id: null });
        } else {
          writeHuman('Recorded decline — no e2e-author node added; regular verification proceeds.');
        }
        return;
      }
      // accept → add a non-mutating e2e-author (main-session) node, ordered
      // after the nodes named by --after (O-17: the authoring dialogue should
      // not race the implement work that motivated it).
      const graph = await aps.get(args.workItem);
      const taken = new Set(graph.nodes.map((n) => n.id));
      const unknownAfter = after.filter((id) => !taken.has(id));
      if (unknownAfter.length > 0) {
        writeError(`--after references unknown node id(s): ${unknownAfter.join(', ')}`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      let seq = 1;
      while (taken.has(`e2e-author-${seq}`)) seq += 1;
      const nodeId = `e2e-author-${seq}`;
      await aps.addNodes(args.workItem, [
        {
          id: nodeId,
          kind: 'e2e-author',
          owner: kindToOwner('e2e-author'),
          purpose: `Author E2E journey scenarios with the user for the changed web surfaces (${surfaceSummary})${
            args.journeys ? ` — journey hint: ${args.journeys}` : ''
          }`,
          status: 'pending',
          depends_on: after,
          acceptance_refs: [],
          evidence_refs: [],
          ac_verdicts: [],
          attempts: { fix: 0, switch: 0 },
        },
      ]);
      await aps.appendDecision(args.workItem, {
        ts,
        node_id: nodeId,
        decision: 'e2e_accept',
        reason: `user accepted E2E authoring for web-surface change (${surfaceSummary})`,
      });
      if (format === 'json') {
        writeJson({ web: true, decision: 'accept', node_id: nodeId });
      } else {
        writeHuman(`Recorded accept — added e2e-author node ${nodeId} (main-session owned).`);
      }
    } catch (err) {
      writeError(`propose-e2e failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto autopilot intent-drift` — surface the axis-2 intent-conservation gate
 * (`intentDriftGate`). At finalize the chain (intent → work-item → autopilot →
 * completion) is written consistently from one payload; this re-checks that the
 * two intent-bearing keys (goal string, AC id set) stay conserved hop by hop as
 * the graph grows over a long run. It is the deterministic floor — a node's prose
 * fidelity to an AC's meaning stays with the reviewer (code-level) and verifier
 * (per-AC evidence). A non-zero exit means the run drifted from the frozen intent:
 * a drifted graph cannot be a final pass. Completion is folded in only if present.
 */
const autopilotIntentDrift = defineCommand({
  meta: {
    name: 'intent-drift',
    description:
      'Check intent conservation across the contract chain (goal + AC id set, hop by hop vs frozen intent)',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
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
    const repoRoot = await resolveRepoRootForCreate();
    const intents = new IntentStore(repoRoot);
    const items = new WorkItemStore(repoRoot);
    const graphs = new AutopilotStore(repoRoot);
    const completions = new CompletionStore(repoRoot);
    try {
      for (const [label, exists] of [
        ['intent.json', await intents.exists(args.workItem)],
        ['work-item.json', await items.exists(args.workItem)],
        ['autopilot.json', await graphs.exists(args.workItem)],
      ] as const) {
        if (!exists) {
          writeError(`${label} missing for ${args.workItem}; cannot check intent drift`);
          process.exit(RUNTIME_ERROR_EXIT);
          return;
        }
      }
      const intent = await intents.get(args.workItem);
      const workItem = await items.get(args.workItem);
      const graph = await graphs.get(args.workItem);
      const completion = (await completions.exists(args.workItem))
        ? await completions.get(args.workItem)
        : undefined;
      const result = intentDriftGate({
        intent,
        workItem,
        graph,
        ...(completion ? { completion } : {}),
      });
      // ac-5 (wi_260614z7r): consume the FROZEN temporal baseline the coverage
      // engine produced (approval_gate.change_surface, set by producePlanGate at
      // plan stage) and flag an unconsented interface/scope change against it. The
      // current surface is the real working-tree change set; the comparison reuses
      // the temporal axis mechanism (interfaceBaselineDriftGate → temporal.enforce).
      // No frozen baseline ⇒ no-op pass (brief regime inactive). This is the
      // enforcement seam the engine deliberately leaves to reviewer/verifier.
      const currentSurface = listChangedFiles(repoRoot, { excludeDittoRuns: true });
      const surfaceDrift = interfaceBaselineDriftGate(
        graph.approval_gate.change_surface,
        currentSurface,
      );
      const pass = result.pass && surfaceDrift.pass;
      if (format === 'json') {
        writeJson({
          pass,
          reasons: [...result.reasons, ...surfaceDrift.reasons],
          advisories: result.advisories,
        });
      } else {
        writeHuman(`intent drift: ${pass ? 'PASS (conserved)' : 'FAIL (drift detected)'}`);
        for (const r of result.reasons) writeHuman(`  - ${r}`);
        for (const r of surfaceDrift.reasons) writeHuman(`  - ${r}`);
        // Advisories are non-blocking (goal-string divergence — a re-statement or
        // real drift the user judges); they never change the exit code.
        for (const a of result.advisories) writeHuman(`  ~ (advisory) ${a}`);
      }
      // Exit reflects BLOCKING reasons only (AC id-set conservation + interface/
      // scope baseline drift). Advisories are surfaced above but do not fail.
      if (!pass) process.exit(RUNTIME_ERROR_EXIT);
    } catch (err) {
      writeError(`intent-drift failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto autopilot coverage-next` / `coverage-round` — surface the plan-stage
 * pre-mortem coverage loop steps (premortem-coverage §4·§5·§9), modeled on
 * next-node/record-result. coverage-next seeds the root (original intent) on the
 * first call, schedules the next open scope node, and returns the judge input +
 * tier (or `dry` when terminated). coverage-round hands the fan-out's structural
 * signals back to the deterministic Manager: append children, step the dry
 * counter, gate `close_as` through the six axes; on termination it writes
 * plan-dialog.md and returns the brief for the design node's plan_brief.
 *
 * Spawn-capability division (§3.1): the CLI computes/gates/aggregates; the main
 * agent spawns the fresh sweep + 3-role dialectic + judges. The CLI never spawns.
 */
const autopilotCoverageNext = defineCommand({
  meta: {
    name: 'coverage-next',
    description: 'Compute the next plan-stage coverage step (seed root, schedule node, or dry)',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
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
    const repoRoot = await requireGraph(args.workItem);
    try {
      const res = await nextCoverageNode({ repoRoot, workItemId: args.workItem });
      if (format === 'json') {
        writeJson(res);
      } else if (res.action === 'dry') {
        writeHuman('Coverage: dry — sweep terminated (breadth + depth). Record the design result.');
      } else {
        writeHuman(`Coverage: interrogate ${res.node.id} (tier=${res.tier})`);
        writeHuman(`  label:       ${res.node.label}`);
        writeHuman(`  dry_counter: ${res.dryCounter}`);
        writeHuman(
          '  → run fresh sweep + 3-role dialectic + judges with ONLY judgeInput, then coverage-round',
        );
      }
    } catch (err) {
      writeError(`coverage-next failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const autopilotCoverageRound = defineCommand({
  meta: {
    name: 'coverage-round',
    description: 'Record a coverage interrogation round: append, step dry counter, gate close',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    json: {
      type: 'string',
      description: 'JSON payload matching coverageRoundPayload schema',
      required: true,
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
    let raw: unknown;
    try {
      raw = JSON.parse(args.json);
    } catch (err) {
      writeError(`--json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const parsed = coverageRoundPayload.safeParse(raw);
    if (!parsed.success) {
      writeError('--json failed schema validation:');
      for (const issue of parsed.error.issues) {
        writeError(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await requireGraph(args.workItem);
    // Optional passthrough fields (brief / tier_inputs) the design node folds into
    // plan_brief on termination — not part of the structural round schema.
    const extra = raw as { brief?: unknown; tier_inputs?: unknown };
    try {
      const res = await recordCoverageRound({
        repoRoot,
        workItemId: args.workItem,
        payload: parsed.data,
        ...(extra.brief
          ? {
              brief: extra.brief as {
                interface_changes: string[];
                dod: string[];
                test_scenarios: string[];
              },
            }
          : {}),
        ...(extra.tier_inputs
          ? {
              tierInputs: extra.tier_inputs as {
                changedFileCount: number;
                interfaceChanged: boolean;
                risk: { non_local: boolean; irreversible: boolean; unaudited: boolean };
                large: boolean;
              },
            }
          : {}),
      });
      if (format === 'json') {
        writeJson(res);
      } else if (res.terminated) {
        writeHuman(`Coverage round: TERMINATED — plan-dialog written (${res.planDialogPath})`);
        writeHuman('  → record the design result WITH plan_brief');
      } else {
        writeHuman(
          `Coverage round: ${res.closed ? 'closed' : 'open'} — dry_counter=${res.dryCounter}`,
        );
        if (res.reasons.length > 0) {
          writeHuman('  close rejected (node stays open):');
          for (const r of res.reasons) writeHuman(`    - ${r}`);
        }
      }
    } catch (err) {
      writeError(`coverage-round failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

export const autopilotCommand = defineCommand({
  meta: {
    name: 'autopilot',
    description:
      'Manage the autopilot graph (bootstrap) and drive the loop (next-node/record-result/complete/cleanup)',
  },
  subCommands: {
    bootstrap: autopilotBootstrap,
    'next-node': autopilotNextNode,
    'record-result': autopilotRecordResult,
    complete: autopilotComplete,
    cleanup: autopilotCleanup,
    'propose-e2e': autopilotProposeE2e,
    'intent-drift': autopilotIntentDrift,
    'coverage-next': autopilotCoverageNext,
    'coverage-round': autopilotCoverageRound,
  },
});
