import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defineCommand } from 'citty';
import { type ApprovalSourceValue, applyApproval, applyRejection } from '~/core/autopilot-approval';
import { bootstrapAutopilot } from '~/core/autopilot-bootstrap';
import { runCleanup } from '~/core/autopilot-cleanup';
import {
  assembleCompletionFromGraph,
  attestCompletion,
  projectAutoHandling,
  projectDirectionDecisions,
} from '~/core/autopilot-complete';
import { computeDownstream, kindToOwner, proposalsToNodes } from '~/core/autopilot-graph';
import {
  hashAuthoredTest,
  nextNode,
  recordResult,
  recordResultPayload,
} from '~/core/autopilot-loop';
import { AutopilotStore } from '~/core/autopilot-store';
import {
  checkCiteGate,
  citeNeedsReproposalMeasurement,
  crossValidateCite,
  detectActiveConflicts,
} from '~/core/cite-gate';
import { CompletionStore, mirrorAcceptanceVerdicts } from '~/core/completion-store';
import { nextCoverageNode, recordCoverageRound } from '~/core/coverage-loop';
import { COVERAGE_TIERS, type CoverageTier } from '~/core/coverage-manager';
import {
  type RawRelevanceJudgment,
  type RelevanceRefute,
  assembleRelevanceVerdicts,
} from '~/core/coverage-relevance';
import { CoverageStore } from '~/core/coverage-store';
import {
  type CategoryRelevanceVerdict,
  FAR_FIELD_ROUTED_OUT,
  type RoutedOutCategory,
  farFieldCategoriesEnabled,
  farFieldCoverageReport,
} from '~/core/coverage-taxonomy';
import { readGithubConfig } from '~/core/ditto-config';
import { dittoDir } from '~/core/ditto-paths';
import { checkE2eCompletionGate } from '~/core/e2e/completion-gate';
import { detectWebSurfaceChange } from '~/core/e2e/web-surface';
import { resolveRepoRootForCreate } from '~/core/fs';
import {
  intentDriftGate,
  interfaceBaselineDriftGate,
  passCloseResidualBlockers,
} from '~/core/gates';
import { createGhClient } from '~/core/gh-client';
import { applyBoardStatusOption, reflectAutopilotTermination } from '~/core/github-reflection';
import { IntentStore } from '~/core/intent-store';
import { type LandResult, landCommit } from '~/core/land-commit';
import { type MeasurementReport, measureHallucination } from '~/core/memory-measure';
import { loadResolvedRecipe } from '~/core/recipe/load';
import { WorkItemStore, blockingFollowUp } from '~/core/work-item-store';
import type { NodeProposal } from '~/schemas/autopilot';
import { coverageRoundPayload } from '~/schemas/coverage';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';
import { autoClaimOnInProgressEdge, buildClaimWiring, releaseClaimOnTerminal } from './work';

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
    e2e: {
      type: 'boolean',
      description:
        'Opt in to entry-phase E2E authoring: seed a main-session e2e-author node between design and implement (wi_260707loq ac-6)',
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
      // wi_260707loq ac-6: the caller for e2eOptIn — pass the `--e2e` flag through so the
      // entry-phase e2e-author node can actually be seeded (default false ⇒ skip preserved).
      e2eOptIn: args.e2e,
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
    // wi_2606287v9 ac-2: the AUTOPILOT in_progress transition. Bootstrapping the graph
    // is the start of the heavy path — promote the WI (non-terminal, not already
    // in_progress) draft→in_progress and fire the claim ONCE on that edge (idempotent
    // branch-grain sentinel). The gh claim only runs when the WI is actually linked to
    // an issue (otherwise the status promotion stands alone, no gh subprocess). Every
    // gh failure is a notice, never a throw (ADR-0018), so it can NOT undo bootstrap.
    const claimNotices: string[] = [];
    if (
      workItem.status !== 'in_progress' &&
      workItem.status !== 'done' &&
      workItem.status !== 'abandoned'
    ) {
      const promoted = await items.update(args.workItem, (cur) => ({
        ...cur,
        status: 'in_progress' as const,
      }));
      if (workItem.github_issue) {
        const wiring = await buildClaimWiring(repoRoot);
        const claimRes = await autoClaimOnInProgressEdge(
          items,
          args.workItem,
          workItem.status,
          promoted,
          wiring,
        );
        claimNotices.push(...claimRes.warnings, ...claimRes.notices);
      }
    }
    if (format === 'json') {
      writeJson({
        work_item_id: args.workItem,
        autopilot_id: result.graph.autopilot_id,
        approval_gate: result.graph.approval_gate.status,
        node_ids: result.graph.nodes.map((n) => n.id),
        path: `.ditto/local/work-items/${args.workItem}/autopilot.json`,
        // wi_2606289h9 C5: surface GitHub claim/board-move notices to the JSON consumer
        // too (was human-branch only — the silent-skip this WI kills).
        claim_notices: claimNotices,
      });
    } else {
      writeHuman(`Bootstrapped autopilot ${result.graph.autopilot_id}`);
      for (const n of claimNotices) writeHuman(`  GitHub claim: ${n}`);
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
 * Re-proposal-rate measurement over the repo's ADR bodies — the same source
 * `ditto memory measure` reads (memory.ts §memoryMeasure). The completion path
 * has no candidate plan texts, so this is the inventory baseline (re-proposal
 * rate is 0 with an empty candidate set). A missing ADR dir is tolerated:
 * `measureHallucination([], [])` yields an empty, non-crashing report so the
 * cross-check stays advisory and never blocks completion.
 */
async function measureReproposalForCompletion(repoRoot: string): Promise<MeasurementReport> {
  const adrDir = join(dittoDir(repoRoot), 'knowledge', 'adr');
  let names: string[];
  try {
    names = (await readdir(adrDir)).filter((n) => n.endsWith('.md')).sort();
  } catch {
    names = [];
  }
  const adrs = await Promise.all(
    names.map(async (n) => ({ id: n, body: await readFile(join(adrDir, n), 'utf8') })),
  );
  return measureHallucination(adrs, []);
}

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
      const workItemStore = new WorkItemStore(repoRoot);
      const workItem = await workItemStore.get(args.workItem);
      // Read the append-only decision log once: it feeds BOTH the e2e completion
      // gate and the ac-6 auto-handling ledger projected below.
      const decisions = await aps.readDecisions(args.workItem);
      // 완료측 결정론 체크 (dialectic-1 O-4/O-18): E2E 제안 결정과 회귀 게이트
      // 기록은 에이전트 기억이 아니라 여기서 기계로 강제된다 — 의무 미이행
      // 상태로는 completion을 조립하지 않는다.
      const e2eViolations = await checkE2eCompletionGate(repoRoot, {
        workItemId: args.workItem,
        changedFiles: workItem.changed_files,
        decisions,
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
      // wi_260709sq3: resolve the effective recipe (same source as the loop's barrier
      // command resolution) so its `barrier_opt_out` flag reaches the completion seam.
      // When true, an absent/no-command DEGRADED barrier is NOT-APPLICABLE (not floored);
      // absent/false ⇒ today's FLOOR default. A barrier that RAN and FAILED still floors.
      const recipe = await loadResolvedRecipe(repoRoot, undefined, () => {});
      // wi_260710l33 (#24): re-hash the FROZEN manifest on disk NOW so the completion
      // assembly can re-check frozen-test integrity at the boundary — catching a frozen
      // red test breached OUT-OF-BAND after the last mutating pass (the in-loop check
      // only fires on a mutating pass). Mirrors the loop's currentByPath build
      // (autopilot-loop.ts). Bound entries only (no captured hash ⇒ no binding, degrade).
      const frozenManifest = graph.approval_gate.plan_brief?.test_spec?.test_backed ?? [];
      const frozenHashByPath = new Map<string, string | undefined>();
      for (const t of frozenManifest) {
        if (t.frozen_hash === undefined) continue;
        frozenHashByPath.set(t.test_path, await hashAuthoredTest(repoRoot, t.test_path));
      }
      const completion = assembleCompletionFromGraph(graph, workItem, {
        ...(args.summary ? { summary: args.summary } : {}),
        // ac-3 producer: thread the ledger so an UNRESOLVED agent_resolvable risk
        // (auto-routed but its re-verify did not converge) lands in
        // remaining_risk_records and the Stop gate can block on it (no silent leak).
        decisions,
        barrierOptOut: recipe.barrier_opt_out ?? false,
        // wi_2607103tp ac-3 (M3): DEDICATED phantom-red opt-out (independent of
        // barrier_opt_out) reaches the completion floor the same way.
        phantomRedOptOut: recipe.phantom_red_opt_out ?? false,
        // wi_260710l33 (#24): inject the on-disk frozen-test hashes so the assembly's
        // frozen-breach floor runs. Inert when the manifest is empty/unbound.
        currentTestHash: (p) => frozenHashByPath.get(p),
      });
      // false-green 차단 (wi_260624xb8 ac-2): completion은 AC를 work-item에서
      // 읽으므로, intent.json이 work-item보다 많은 AC를 선언했는데 동기화가 안 된
      // 경우(scope shrink) ac-2..N이 조용히 빠진 채 final_verdict=pass가 날 수
      // 있다. assemble 결과가 pass인데 intent-conservation(H1 AC id-set)이 깨졌으면
      // pass completion을 디스크에 쓰지 않는다. e2e 게이트와 동일한 차단 패턴.
      // (ADR-0024 §3: 여기서는 per-AC 판정이 아니라 AC id-set 보존만 강제한다 —
      // 개별 verdict/oracle 판정은 deriveAcVerdicts에 그대로 둔다.)
      const intentStore = new IntentStore(repoRoot);
      if (completion.final_verdict === 'pass' && (await intentStore.exists(args.workItem))) {
        const intent = await intentStore.get(args.workItem);
        const drift = intentDriftGate({ intent, workItem, graph });
        if (!drift.pass) {
          if (format === 'json') {
            writeJson({ work_item_id: args.workItem, intent_drift: drift.reasons });
          } else {
            writeError(
              `complete blocked by intent-conservation (false-green guard, ${drift.reasons.length}):`,
            );
            for (const r of drift.reasons) writeError(`  - ${r}`);
            writeError(
              '  → sync the work item AC to intent (re-run bootstrap), then re-run complete',
            );
          }
          process.exit(RUNTIME_ERROR_EXIT);
          return;
        }
      }
      await new CompletionStore(repoRoot).write(completion);
      // wi_260627273: mirror the derived per-AC verdicts + evidence back onto the
      // work item so `work status`/`push-ready` read the verified state instead of
      // the stale `unverified` the criteria were created with. Runs for EVERY verdict
      // (not just the pass flip below), is idempotent, and copies a `partial`/`fail`
      // as-is — the completion is the single source of the derived verdict.
      await workItemStore.update(args.workItem, (cur) => mirrorAcceptanceVerdicts(cur, completion));
      // ac-3 (wi_2606264rm): a pass completion is the work item's real finish line —
      // `autopilot complete` becomes the single termination gate, flipping the WI to
      // done here so no separate manual `work done` is needed. NON-pass leaves the
      // status untouched (this if(pass) wrap is what guarantees the invariant —
      // close() itself is verdict-blind). An already-terminal WI (a benign re-run of
      // complete) is left alone. A self-caused high/critical follow-up still blocks
      // the auto-close (parity with `work done`, blockingFollowUp): fix/resolve it,
      // then re-run — never a silent done over an open regression. The terminal
      // overwrite invariant (abandoned↛done) is enforced one level down in
      // store.close (R1); the pre-check here is for a clean skipped signal, not a
      // crash, on re-run.
      // T2 ac-1/ac-2 (wi_260627vl6): verified→landed. On a flip-eligible pass we
      // LAND the run's changed_files (one git-revertable commit per owning sub-repo)
      // BEFORE the status→done flip — "verified" only becomes "done" once the work
      // is actually committed. The land step runs on the SAME path that would flip
      // to done: AFTER the already-terminal skip AND AFTER the blocking-follow-up
      // exit (which process.exit()s above), so a pass carrying an unresolved
      // self-caused high/critical follow-up is NEVER committed-but-not-done. Engine
      // mechanics (run-artifact exclusion, unrelated-dirt abort, empty→no-op,
      // idempotent re-run, detached-HEAD failure, NO push) live in landCommit; this
      // only sequences land→flip and routes a land FAILURE to status=blocked (not
      // done). A re-run of an already-blocked WI re-drives landCommit idempotently
      // (already-committed sub-repos are skipped) to reconcile a partial commit.
      let autoClose: 'flipped' | 'skipped' | 'blocked' = 'skipped';
      let land: LandResult | undefined;
      if (completion.final_verdict === 'pass') {
        if (workItem.status === 'done' || workItem.status === 'abandoned') {
          autoClose = 'skipped'; // already terminal — nothing to flip
        } else {
          const blocking = blockingFollowUp(workItem);
          if (blocking) {
            writeError(
              `complete: ${args.workItem} verified pass but cannot auto-close — unresolved self-caused ${blocking.severity}-severity follow-up "${blocking.note}". Resolve it (ditto work follow-up ${args.workItem} --resolve <n>), then re-run.`,
            );
            process.exit(RUNTIME_ERROR_EXIT);
            return;
          }
          // ac-1 (wi_260710tjd) TERMINATION-COMPLETENESS gate. Before the done-flip,
          // run the SAME in-scope agent-owned residual classifiers the Stop hook uses:
          // a verified pass whose completion still carries an UNDISPOSED agent_resolvable
          // residual (unverified[]/remaining_risk_records[]) must NOT flip to done here
          // (the flip would bypass the Stop NON_TERMINAL guard). Out-of-scope/candidate
          // follow-ups are on neither surface (capture≠drive, ADR-20260627), so they
          // never block; blocking fires BEFORE land, so nothing is committed.
          const residualBlockers = passCloseResidualBlockers(
            completion,
            workItem.acceptance_criteria.map((c) => c.id),
          );
          if (residualBlockers.length > 0) {
            writeError(
              `complete: ${args.workItem} verified pass but cannot auto-close — ${residualBlockers.length} in-scope agent-owned residual(s): ${residualBlockers.join(
                '; ',
              )}. Resolve/ground each (or move it out of scope), then re-run.`,
            );
            process.exit(RUNTIME_ERROR_EXIT);
            return;
          }
          // Deterministic commit message from the WI id + title — never LLM-authored
          // free text (ac-5: the land step stays deterministic, push-free).
          const landMessage = `ditto land ${args.workItem}: ${workItem.title}`;
          land = await landCommit(repoRoot, workItem.changed_files, landMessage);
          if (land.status === 'committed' || land.status === 'noop') {
            await workItemStore.close(args.workItem, 'done');
            autoClose = 'flipped';
          } else {
            // land FAILURE (aborted_dirty / aborted_detached) → do NOT flip done;
            // park as blocked with the precise reason so the operator can fix the
            // blocker and re-run (which reconciles via the idempotent land engine).
            const dirtyCount = land.dirty.reduce((n, d) => n + d.paths.length, 0);
            const dirtyList = land.dirty.map((d) => `${d.repo}: ${d.paths.join(', ')}`).join('; ');
            const reason =
              land.status === 'aborted_dirty'
                ? `land aborted — ${dirtyCount} working-tree path(s) outside the declared change_surface: ${dirtyList}. These are likely files an owner changed but did NOT report in its record-result changed_files (change_surface under-declaration), or genuinely unrelated concurrent work. Next: check the owners' reported changed_files against \`git status\`, then either expand the work item's changed_files to include the real run output, or stash the unrelated work — then re-run \`ditto autopilot complete\`. (Run byproducts under .ditto/memory are auto-absorbed; these paths are not.)`
                : `land aborted — detached HEAD (commit would be orphaned) in: ${land.detached.join(', ')}`;
            await workItemStore.park(args.workItem, 'blocked', {
              command: `# resolve the land blocker, then re-run: ditto autopilot complete --workItem ${args.workItem}`,
              fresh_evidence_needed: [reason],
            });
            autoClose = 'blocked';
          }
        }
      }
      // G4/G5 (wi_260628d79): GitHub termination reflection — fires ONLY on the real
      // done-flip (autoClose==='flipped'), NEVER on a non-terminal complete. The
      // verdict-blind CompletionStore.write() above persisted completion.json for
      // EVERY verdict; posting there would notify GitHub on partial/fail/unverified
      // (ac-4 cross-feature regression). auto_reflect is opt-in (default OFF); a
      // MALFORMED config records a notice rather than silently disabling an opted-in
      // reflection (absent config stays silent). Autopilot never closes the issue.
      const reflectNotices: string[] = [];
      {
        let ghMalformed = false;
        const ghConfig = await readGithubConfig(repoRoot, () => {
          ghMalformed = true;
        });
        const reflection = reflectAutopilotTermination(
          { client: createGhClient(), config: ghConfig, configMalformed: ghMalformed },
          {
            autoClose,
            // Mirror the derived per-AC verdicts onto the WI so the posted comment
            // shows the verified state, not the stale `unverified` it was created with.
            workItem: mirrorAcceptanceVerdicts(workItem, completion),
            completion,
          },
        );
        reflectNotices.push(...reflection.notices);
        // wi_2606287v9 ac-5: a land-blocked terminal park is NON-terminal but the board
        // must reflect it — move the linked issue to the Blocked column via
        // claim_status_map.blocked. Independent, degradable; never throws.
        if (autoClose === 'blocked' && ghConfig?.claim_status_map?.blocked) {
          const blockedBoard = applyBoardStatusOption(
            { client: createGhClient(), config: ghConfig },
            workItem,
            ghConfig.claim_status_map.blocked,
          );
          reflectNotices.push(...blockedBoard.notices);
        }
        // wi_2606287v9 ac-5: unconditional terminal @me release on the real done-flip
        // (only when THIS session claimed the issue), independent of the auto_reflect
        // opt-in — the bootstrap auto-claim is unconditional, so the release must be too.
        // Comment-free (the reflection's result-summary is the durable audit); degradable.
        if (autoClose === 'flipped' && workItem.github_issue?.claimed_branch) {
          const rel = await releaseClaimOnTerminal(
            workItemStore,
            args.workItem,
            await buildClaimWiring(repoRoot),
          );
          reflectNotices.push(...rel.notices);
        }
      }
      // ac-2 cite-or-abstain advisory gate: did the lineage-pushed nodes cite or
      // abstain against the governing decisions injected into their packets?
      // ADVISORY — warnings are surfaced but NEVER block completion (no exit
      // change). A `skip` verdict (empty denominator: no node received a push)
      // is info, NOT a vacuous checked-pass.
      const cite = await checkCiteGate(repoRoot, { workItemId: args.workItem, graph });
      // ac-4 표식 단독 성공판정 금지: cross-validate the cite verdict against the
      // deterministic re-proposal rate (memory-measure source). ADVISORY — a
      // cite `pass` is only "confirmed" when the outcome backs it; otherwise it
      // is surfaced as cited-but-unvalidated / cannot-confirm. NEVER blocks
      // (mirrors the cite-gate; never touches final_verdict or exit code). A
      // non-pass cite verdict ⇒ not-applicable (no clean cite to validate).
      // AC2 (6번): crossValidateCite only consumes the measurement on a pass, so
      // skip the whole-ADR-corpus read entirely on skip/warning (no pushed node /
      // nothing to validate) — the empty report is byte-identical for those paths.
      const measurement = citeNeedsReproposalMeasurement(cite.verdict)
        ? await measureReproposalForCompletion(repoRoot)
        : measureHallucination([], []);
      const citeCrossCheck = crossValidateCite(cite, measurement);
      // 단계2 능동 모순경고: where a pushed node's OUTPUT re-proposes a rejected
      // alternative of a governing ADR, surface it per-node. ADVISORY · FN우선;
      // never blocks, never touches final_verdict (same posture as the cite-gate).
      const conflicts = await detectActiveConflicts(repoRoot, {
        workItemId: args.workItem,
        graph,
      });
      // ac-6 (T1): emit the positive per-AC attestation + the auto-handling ledger
      // at run termination. The attestation reads completion.acceptance (the SAME
      // derived verdicts just assembled — gate↔score one input); the ledger projects
      // the loop's existing auto_fix/surface/batch_escalate decisions (no re-derive).
      const attestation = attestCompletion(completion);
      const autoHandling = projectAutoHandling(decisions);
      // ac-4 (wi_260707loq): the DEDICATED direction-fork ledger. Separate from the
      // auto-handling ledger above (which admits only auto_fix/surface/batch_escalate) —
      // an autonomous `direction` fork is disclosed on its own with the four ac-4 fields
      // (무엇때문에 · 선택지 · 선택+의도근거 · 파급/되돌리기비용) so a run's autonomy is
      // never buried. Each entry carries the `decision_id` handle `ditto autopilot revise`
      // targets (ac-5). Pure projection of the append-only log (no re-derive).
      const directionDecisions = projectDirectionDecisions(decisions);
      // D4 dialectic 결정 (a) (wi_2606278qa): this run materialized out-of-scope
      // follow-ups as tracked draft WIs but does NOT auto-drive them (materialize
      // != drive — per-WI approval + intent-lock is the intended control boundary,
      // not relaxed here). Closing the T1 ac-4 residual-transference friction:
      // surface each unresolved materialized follow-up WI + its precise pick-up
      // command so the user doesn't have to hunt for the id. READ-ONLY — no auto-drive.
      const followUpsToPickUp = (workItem.follow_ups ?? [])
        .filter((f) => !f.resolved && f.materialized_wi)
        // ac-2 (wi_260710tjd): order by the ADVISORY `priority` (lower rank first);
        // a follow-up without a priority sorts LAST. Coalesce undefined to +Infinity
        // to avoid the NaN that `a.priority - b.priority` would yield. Array.sort is
        // stable, so equal/both-undefined ranks keep insertion order. Ordering ONLY —
        // priority drives nothing (no-auto-pick, ADR-20260627); the shape below is
        // unchanged, so priority never leaks into the pick-up drive surface.
        .sort(
          (a, b) =>
            (a.priority ?? Number.POSITIVE_INFINITY) - (b.priority ?? Number.POSITIVE_INFINITY),
        )
        .map((f) => ({ work_item_id: f.materialized_wi as string, note: f.note }));
      if (format === 'json') {
        writeJson({
          work_item_id: args.workItem,
          final_verdict: completion.final_verdict,
          auto_close: {
            outcome: autoClose,
            status:
              autoClose === 'flipped'
                ? 'done'
                : autoClose === 'blocked'
                  ? 'blocked'
                  : workItem.status,
          },
          // T2 ac-1/ac-2/ac-5: surface the land result (never silent). committed →
          // per-repo sha; aborted_* → the abort reason that drove status=blocked.
          land: land
            ? {
                status: land.status,
                commits: land.commits.map((c) => ({ repo: c.repo, sha: c.sha })),
                dirty: land.dirty,
                detached: land.detached,
                // wi_260627s2d: gitignored declared paths are dropped (uncommittable),
                // but SURFACED — a wrongly-gitignored real source file would otherwise
                // vanish silently past the change_surface safety net.
                dropped_gitignored: land.droppedGitignored,
                ...(land.droppedGitignored.length > 0
                  ? {
                      dropped_gitignored_warning: `${land.droppedGitignored.length} declared changed_files path(s) were gitignored and NOT committed: ${land.droppedGitignored.map((d) => d.path).join(', ')}. If any is a real source file, fix its .gitignore and re-run; if it is a stale reference, remove it from the work item's changed_files.`,
                    }
                  : {}),
              }
            : null,
          acceptance: completion.acceptance.map((a) => ({
            criterion_id: a.criterion_id,
            verdict: a.verdict,
            evidence_count: a.evidence.length,
          })),
          attestation,
          auto_handling: autoHandling,
          direction_decisions: directionDecisions,
          cite_gate: {
            verdict: cite.verdict,
            pushed_node_ids: cite.pushed_node_ids,
            warnings: cite.warnings,
          },
          cite_cross_check: citeCrossCheck,
          conflict_warnings: conflicts,
          follow_ups_to_pick_up: followUpsToPickUp,
          github_reflection: { notices: reflectNotices },
          path: `.ditto/local/work-items/${args.workItem}/completion.json`,
        });
      } else {
        writeHuman(
          `Assembled completion for ${args.workItem}: final_verdict=${completion.final_verdict}`,
        );
        if (autoClose === 'flipped') {
          writeHuman('  auto-close (ac-3): flipped → done');
        } else if (autoClose === 'blocked') {
          writeHuman('  auto-close: BLOCKED (land failed) → status=blocked (not done)');
        } else {
          writeHuman(
            `  auto-close (ac-3): skipped (status=${workItem.status}${completion.final_verdict === 'pass' ? ', already terminal' : ', non-pass'})`,
          );
        }
        // T2 ac-1/ac-2/ac-5: land-result line (mirror cleanup.ts "committed <repo>:
        // <sha>"). Never silent — committed shas, no-op, or the abort reason.
        if (land) {
          if (land.status === 'committed') {
            for (const c of land.commits) {
              writeHuman(`  committed ${c.repo}: ${c.sha} (${c.paths.length} path(s))`);
            }
          } else if (land.status === 'noop') {
            writeHuman('  land: no-op (empty or already-committed changeset)');
          } else if (land.status === 'aborted_dirty') {
            writeHuman('  land FAILED (aborted_dirty) → status=blocked:');
            for (const d of land.dirty) {
              writeHuman(`    unrelated dirt in ${d.repo}: ${d.paths.join(', ')}`);
            }
          } else {
            writeHuman(
              `  land FAILED (aborted_detached) → status=blocked: ${land.detached.join(', ')}`,
            );
          }
        }
        for (const a of completion.acceptance) {
          writeHuman(`  ${a.criterion_id}: ${a.verdict} (${a.evidence.length} evidence)`);
        }
        writeHuman('  attestation (per-AC, ac-6):');
        for (const a of attestation) {
          writeHuman(`    ${a.criterion_id}: ${a.state}${a.basis ? ` — ${a.basis}` : ''}`);
        }
        const handledCount =
          autoHandling.auto_fixed.length +
          autoHandling.surfaced.length +
          autoHandling.materialized.length;
        if (handledCount === 0) {
          writeHuman('  auto-handling ledger (ac-6): none (nothing auto-handled this run)');
        } else {
          writeHuman(
            `  auto-handling ledger (ac-6): ${autoHandling.auto_fixed.length} auto-fixed, ${autoHandling.surfaced.length} surfaced, ${autoHandling.materialized.length} materialized`,
          );
          for (const e of [
            ...autoHandling.auto_fixed,
            ...autoHandling.surfaced,
            ...autoHandling.materialized,
          ]) {
            writeHuman(
              `    [${e.decision}] ${e.node_id}${e.resolvability ? ` (${e.resolvability})` : ''}: ${e.reason}`,
            );
          }
        }
        // ac-4: the dedicated direction-fork section (autonomy disclosure). Each entry
        // shows the four fields + the decision_id handle for `ditto autopilot revise`.
        if (directionDecisions.length === 0) {
          writeHuman('  방향 결정 (direction forks, ac-4): none (자율 방향분기 없음)');
        } else {
          writeHuman(`  방향 결정 (direction forks, ac-4): ${directionDecisions.length}건`);
          for (const d of directionDecisions) {
            writeHuman(`    [${d.node_id}] fork=${d.fork_node_id} (decision ${d.decision_id})`);
            writeHuman(`      무엇때문에: ${d.trigger}`);
            writeHuman(`      선택지: ${d.options.join('; ')}`);
            writeHuman(`      선택+의도근거: ${d.choice} — ${d.intent_basis}`);
            writeHuman(`      파급/되돌리기비용: ${d.blast_radius} / ${d.reverse_cost}`);
          }
        }
        if (completion.final_verdict !== 'pass') {
          writeHuman(
            '  (non-pass: criteria without evidence stay unverified — close them, then re-run)',
          );
        }
        if (cite.verdict === 'warning') {
          writeHuman(
            `  cite-or-abstain (ac-2, advisory — non-blocking): ${cite.warnings.length} warning(s)`,
          );
          for (const w of cite.warnings) writeHuman(`    [${w.node_id}] ${w.message}`);
        }
        writeHuman(
          `  cite cross-check (ac-4, advisory — non-blocking): ${citeCrossCheck.combined} (re-proposal rate ${citeCrossCheck.reproposal_rate.toFixed(3)})`,
        );
        if (conflicts.length > 0) {
          writeHuman(
            `  능동 모순경고 (단계2, advisory — non-blocking): ${conflicts.length}건 — 기각된 대안 재제안 가능성`,
          );
          for (const c of conflicts) writeHuman(`    [${c.node_id}] ${c.message}`);
        }
        // D4 (a): surface this run's open materialized follow-ups + pick-up command
        // (materialize != drive — never auto-started, the user picks them up).
        if (followUpsToPickUp.length > 0) {
          writeHuman(
            `  이 run이 남긴 후속 ${followUpsToPickUp.length}건 (draft, 미착수 — materialize≠drive) — 착수 명령:`,
          );
          for (const f of followUpsToPickUp) {
            writeHuman(`    - ${f.work_item_id}: ${f.note}`);
            writeHuman(
              `      착수: ditto work set-criteria ${f.work_item_id} --criteria "<…>" → ditto verify → ditto work done (경량) | /ditto:deep-interview (heavy)`,
            );
          }
        }
        // G4/G5: GitHub reflection notices (skip/degradation; empty when reflection
        // did not fire — non-terminal, default-OFF, or absent config).
        if (reflectNotices.length > 0) {
          writeHuman(`  GitHub reflection (${reflectNotices.length}):`);
          for (const n of reflectNotices) writeHuman(`    - ${n}`);
        }
      }
    } catch (err) {
      writeError(`complete failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * Next fork-generation token for `revise` (ac-5). Scans existing node ids for the
 * `~r<gen>` suffix and returns max+1 (1 when none present). Monotonic, so a second
 * revise of an already-revised subgraph mints ids that never collide with the first
 * round — the fresh-id guarantee the K-block avoidance rests on.
 */
function nextForkGeneration(nodeIds: string[]): number {
  let max = 0;
  for (const id of nodeIds) {
    const g = /~r(\d+)$/.exec(id)?.[1];
    if (g !== undefined) {
      const n = Number(g);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

/**
 * Mint a fresh id for `origId` at generation `gen`, stripping any prior `~r<n>`
 * suffix so ids never accumulate suffixes across repeated revises.
 */
function freshForkId(origId: string, gen: number): string {
  return `${origId.replace(/~r\d+$/, '')}~r${gen}`;
}

/**
 * `ditto autopilot revise` — re-drive the subgraph DOWNSTREAM of a direction fork
 * with FRESH node ids (ac-5). Given the target `direction` decision (matched by its
 * decision_id or fork node id), it: (1) resolves the fork from
 * `direction_record.fork_node_id`; (2) computes the transitive dependents
 * (`computeDownstream`); (3) tears them down (`removeNodes`); (4) regenerates that
 * subgraph via `proposalsToNodes` with a monotonic `~r<gen>` id suffix — edges
 * re-rooted on the fork, inner edges remapped to the fresh ids — and splices it
 * (integrity-gated `addNodes`); (5) resets the fork node to pending so the SAME work
 * item re-drives from that point.
 *
 * The fresh ids are LOAD-BEARING (sweep HIGH-2): `sameOracleFailureCount` keys the
 * stale-K-block on node_id and the append-only decision log is never truncated, so a
 * REUSED id would inherit the fork's prior oracle-unsatisfied failures and K-block
 * immediately. A fresh id makes that count zero — the re-driven node starts clean.
 */
const autopilotRevise = defineCommand({
  meta: {
    name: 'revise',
    description: 'Re-drive the subgraph downstream of a direction fork with fresh node ids (ac-5)',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    decision: {
      type: 'string',
      description:
        'Target direction decision — its decision_id (from `complete`) or the fork node id',
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
    const repoRoot = await requireGraph(args.workItem);
    try {
      const aps = new AutopilotStore(repoRoot);
      const decisions = await aps.readDecisions(args.workItem);
      // Resolve the target fork. `--decision` matches EITHER the stable decision_id the
      // completion report surfaces OR the fork node id (friendlier for a single fork).
      const directions = projectDirectionDecisions(decisions);
      const matches = directions.filter(
        (d) => d.decision_id === args.decision || d.fork_node_id === args.decision,
      );
      if (matches.length === 0) {
        writeError(
          `no direction decision matched "${args.decision}" for ${args.workItem}. Available: ${
            directions.map((d) => `${d.decision_id} (fork ${d.fork_node_id})`).join(', ') ||
            '(none)'
          }`,
        );
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      if (matches.length > 1) {
        writeError(
          `"${args.decision}" is ambiguous (${matches.length} direction decisions share it). Re-run with a specific decision_id: ${matches
            .map((d) => d.decision_id)
            .join(', ')}`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const [target] = matches;
      if (!target) {
        writeError(`no direction decision matched "${args.decision}"`);
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      const forkNodeId = target.fork_node_id;
      const graph = await aps.get(args.workItem);
      const byId = new Map(graph.nodes.map((n) => [n.id, n]));
      if (!byId.has(forkNodeId)) {
        writeError(`fork node ${forkNodeId} is no longer in the graph for ${args.workItem}`);
        process.exit(RUNTIME_ERROR_EXIT);
        return;
      }
      // (2) downstream = transitive dependents of the fork.
      const downstreamIds = computeDownstream(graph.nodes, forkNodeId);
      // (4) fresh ids via a monotonic ~r<gen> suffix (the K-block avoidance).
      const gen = nextForkGeneration(graph.nodes.map((n) => n.id));
      const idMap = new Map(downstreamIds.map((id) => [id, freshForkId(id, gen)]));
      const proposals: NodeProposal[] = [];
      for (const id of downstreamIds) {
        const n = byId.get(id);
        const freshId = idMap.get(id);
        if (!n || freshId === undefined) continue; // computeDownstream guarantees both
        proposals.push({
          id: freshId,
          kind: n.kind,
          purpose: n.purpose,
          // Re-rooted on the fork: a dep that is itself downstream is remapped to its
          // fresh id; the fork (and any surviving upstream/sibling) is kept as-is.
          depends_on: n.depends_on.map((dep) => idMap.get(dep) ?? dep),
          acceptance_refs: n.acceptance_refs,
          ...(n.agent_hint !== undefined ? { agent_hint: n.agent_hint } : {}),
          ...(n.file_scope !== undefined ? { file_scope: n.file_scope } : {}),
        });
      }
      const fresh = proposalsToNodes(proposals);
      // (3) tear down the downstream subgraph. removeNodes guards pending-only, so
      // re-arm any non-pending downstream node to pending first (it is removed next).
      for (const id of downstreamIds) {
        const n = byId.get(id);
        if (n && n.status !== 'pending') {
          await aps.updateNode(args.workItem, id, (cur) => ({ ...cur, status: 'pending' }));
        }
      }
      await aps.removeNodes(args.workItem, downstreamIds);
      // (4/5) splice the fresh subgraph (integrity-gated) then reset the fork to
      // pending so the SAME work item re-drives from the fork point.
      await aps.addNodes(args.workItem, fresh);
      await aps.updateNode(args.workItem, forkNodeId, (cur) => ({ ...cur, status: 'pending' }));

      const regenerated = downstreamIds
        .map((from) => ({ from, to: idMap.get(from) }))
        .filter((r): r is { from: string; to: string } => r.to !== undefined);
      if (format === 'json') {
        writeJson({
          work_item_id: args.workItem,
          fork_node_id: forkNodeId,
          decision_id: target.decision_id,
          removed_node_ids: downstreamIds,
          regenerated,
          fork_reset_to: 'pending',
        });
      } else {
        writeHuman(
          `Revised ${args.workItem} from direction fork ${forkNodeId} (decision ${target.decision_id}):`,
        );
        writeHuman(
          `  removed downstream (${downstreamIds.length}): ${downstreamIds.join(', ') || '(none)'}`,
        );
        if (regenerated.length > 0) {
          writeHuman(`  regenerated with fresh ids (${regenerated.length}):`);
          for (const r of regenerated) writeHuman(`    ${r.from} -> ${r.to}`);
        }
        writeHuman(
          `  fork ${forkNodeId} reset to pending — re-drive: ditto autopilot next-node --workItem ${args.workItem}`,
        );
      }
    } catch (err) {
      writeError(`revise failed: ${err instanceof Error ? err.message : String(err)}`);
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
      // plan stage) and flag an unconsented interface/scope change against it.
      // The current surface is THIS work item's own changed_files (the files its
      // nodes actually touched, unioned by record-result; autopilot-loop.ts ~983),
      // NOT the whole working tree — autopilot does not assume per-work-item
      // worktree isolation, so a sibling work item's uncommitted changes in the
      // same tree must not be falsely flagged as this work item's scope grow
      // (wi_260619qdx). The comparison reuses the temporal axis mechanism
      // (interfaceBaselineDriftGate → temporal.enforce). No frozen baseline ⇒
      // no-op pass (brief regime inactive). This is the enforcement seam the
      // engine deliberately leaves to reviewer/verifier.
      const currentSurface = workItem.changed_files;
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

/**
 * Parse the user's `--coverageIntensity` override (ac-4). Undefined → no override
 * (engine keeps its stakes-derived/standard tier, ac-7). An unknown value throws
 * so the caller can exit with a usage error, mirroring `parseOutputFormat`. Both
 * coverage-next and coverage-round share this so the entered tier is validated
 * identically and threaded to the same termination K.
 */
function parseCoverageIntensity(raw: string | undefined): CoverageTier | undefined {
  if (raw === undefined) return undefined;
  if ((COVERAGE_TIERS as readonly string[]).includes(raw)) return raw as CoverageTier;
  throw new Error(`--coverageIntensity must be one of ${COVERAGE_TIERS.join('|')} (got "${raw}")`);
}

/**
 * Parse `--relevance` (design §5) — a JSON `{judgments, refutes}` of the host's
 * grounded relevance judgments + adversarial refutes — and assemble it into the
 * verdicts the seed gate consumes. The §5 safety rules (justified ∧ refute-survived)
 * live in `assembleRelevanceVerdicts`, not here. Undefined → no gate (every category
 * open, ac-7). Malformed → throws so the caller exits with a usage error.
 */
function parseRelevance(raw: string | undefined):
  | {
      verdicts: CategoryRelevanceVerdict[];
      raw: { judgments: RawRelevanceJudgment[]; refutes: RelevanceRefute[] };
    }
  | undefined {
  if (raw === undefined) return undefined;
  let parsed: { judgments?: unknown; refutes?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('--relevance must be JSON {judgments,refutes}');
  }
  if (!Array.isArray(parsed.judgments)) {
    throw new Error(
      '--relevance.judgments must be an array of {id,relevant,reason?,residual_risk?}',
    );
  }
  const judgments = parsed.judgments as RawRelevanceJudgment[];
  const refutes = Array.isArray(parsed.refutes) ? (parsed.refutes as RelevanceRefute[]) : [];
  // Keep the raw judgments/refutes alongside the assembled verdicts: assembly (§5) is
  // lossy (a refuted skip flips to relevant), so the raw is persisted at seed as the
  // provenance sidecar for post-hoc skip-cause diagnosis (wi_26062227h).
  return { verdicts: assembleRelevanceVerdicts(judgments, refutes), raw: { judgments, refutes } };
}

const autopilotCoverageNext = defineCommand({
  meta: {
    name: 'coverage-next',
    description: 'Compute the next plan-stage coverage step (seed root, schedule node, or dry)',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    coverageIntensity: {
      type: 'string',
      description: `Override sweep intensity at entry: ${COVERAGE_TIERS.join('|')} (default: stakes-derived, ac-4)`,
    },
    relevance: {
      type: 'string',
      description:
        'Relevance gate input JSON {judgments,refutes} — pre-closes irrelevant categories at seed so only relevant ones are swept (§5). Consulted on the first (seed) call only.',
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    let intensity: CoverageTier | undefined;
    let relevance: ReturnType<typeof parseRelevance>;
    try {
      format = parseOutputFormat(args.output);
      intensity = parseCoverageIntensity(args.coverageIntensity);
      relevance = parseRelevance(args.relevance);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await requireGraph(args.workItem);
    try {
      const res = await nextCoverageNode({
        repoRoot,
        workItemId: args.workItem,
        // §8-2: opt-in category-complete discovery (env toggle until ac-10 config).
        seedCategories: farFieldCategoriesEnabled(),
        // §5 (wi_260625l0v): relevance gate verdicts pre-close irrelevant categories
        // at seed (assembled from the host's grounded judgments + adversarial refutes).
        ...(relevance ? { relevanceVerdicts: relevance.verdicts } : {}),
        // wi_26062227h: raw judgments/refutes persisted at seed as the provenance sidecar.
        ...(relevance ? { rawRelevance: relevance.raw } : {}),
        // ac-4: explicit user override wins over the stakes-derived/standard tier.
        ...(intensity ? { intensity } : {}),
      });
      if (format === 'json') {
        writeJson(res);
      } else if (res.action === 'dry') {
        writeHuman('Coverage: dry — sweep terminated (breadth + depth). Record the design result.');
      } else if (res.dryProbe) {
        writeHuman(
          `Coverage: DRY ROUND (all nodes closed, dry_counter=${res.dryCounter}) — nothing to close`,
        );
        writeHuman(
          '  → spawn ONE completeness-critic only (NO sweep angles, NO 3-role dialectic, NO per-axis judges); the only signal that matters is whether a new admissible branch appears. Then coverage-round.',
        );
      } else {
        const n = res.wave.length;
        writeHuman(
          `Coverage: interrogate ${n} ready node(s)${n > 1 ? ' — sweep in PARALLEL' : ''} (tier=${res.tier})`,
        );
        for (const item of res.wave) {
          writeHuman(`  - ${item.node.id}: ${item.node.label}`);
        }
        writeHuman(`  sweep_angles: ${res.sweepAngles}`);
        writeHuman(`  dry_counter:  ${res.dryCounter}`);
        writeHuman(
          '  → spawn EACH wave node in parallel (fresh sweep + 3-role dialectic + judges, ONLY its judgeInput), then coverage-round EACH result sequentially (record stays single-writer)',
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
    coverageIntensity: {
      type: 'string',
      description: `Override sweep intensity at entry: ${COVERAGE_TIERS.join('|')} (default: stakes-derived, ac-4)`,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    let intensity: CoverageTier | undefined;
    try {
      format = parseOutputFormat(args.output);
      intensity = parseCoverageIntensity(args.coverageIntensity);
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
        // wi_260706n4w n7 fix (ac-1 reachability): thread the payload's oracle_claims to
        // recordCoverageRound's oracle seam — without this the injection/secret
        // fail-closed tier was unreachable from the product surface. The conditional
        // spread bridges zod's `category_id?: string | undefined` inference to the
        // exact-optional OracleClaimInput (exactOptionalPropertyTypes).
        ...(parsed.data.oracle_claims
          ? {
              oracleClaims: parsed.data.oracle_claims.map((c) => ({
                claim_id: c.claim_id,
                ...(c.category_id !== undefined ? { category_id: c.category_id } : {}),
                claim: c.claim,
              })),
            }
          : {}),
        // ac-4: explicit user override wins over stakes-derived tier_inputs.
        ...(intensity ? { intensity } : {}),
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

/**
 * Human-format routed-out section (wi_260707rwf ac-1): id · route · reason for
 * every category removed from the far-field floor, so a human reader of the
 * report — including the coverage.json-absent early return, where the ledger is
 * static — sees the narrowing, never a silently smaller universe. JSON output
 * already carries `routed_out` via farFieldCoverageReport (contract unchanged).
 */
function writeRoutedOutSection(routedOut: readonly RoutedOutCategory[]): void {
  writeHuman(`  routed out: ${routedOut.length} (left the far-field floor — see receiving gate)`);
  for (const r of routedOut) {
    writeHuman(`    - ${r.id} → ${r.route}: ${r.reason}`);
  }
}

/**
 * `ditto autopilot coverage-report` — deterministic far-field process coverage
 * (ac-11a, design §8-6): read the work item's coverage.json and report how the
 * far-field breadth was handled (swept / skipped-with-reason / open) and whether
 * the breadth is complete. Read-only; absent coverage.json → no sweep recorded.
 */
const autopilotCoverageReport = defineCommand({
  meta: {
    name: 'coverage-report',
    description:
      'Report far-field process coverage: swept/skipped(+reason)/open categories + completeness (ac-11a)',
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
    const store = new CoverageStore(repoRoot);
    if (!(await store.exists(args.workItem))) {
      if (format === 'json') {
        writeJson({ seeded: 0, resolved: 0, open: 0, skipped: [], complete: false });
      } else {
        writeHuman('Far-field coverage: no sweep recorded (coverage.json absent).');
        // ac-1: the routed-out ledger is static — it holds without a sweep too.
        writeRoutedOutSection(FAR_FIELD_ROUTED_OUT);
      }
      return;
    }
    const report = farFieldCoverageReport(await store.getMap(args.workItem));
    if (format === 'json') {
      writeJson(report);
      return;
    }
    writeHuman(`Far-field coverage (${args.workItem}):`);
    writeHuman(`  seeded:   ${report.seeded}`);
    writeHuman(`  resolved: ${report.resolved} (swept-dry)`);
    writeHuman(`  open:     ${report.open}`);
    writeHuman(`  skipped:  ${report.skipped.length}`);
    for (const s of report.skipped) {
      writeHuman(`    - ${s.id} [${s.state}]: ${s.reason ?? '(no reason recorded!)'}`);
    }
    writeRoutedOutSection(report.routed_out);
    // ac-2 (wi_260707rwf): seeded=0 with seeding ON means the map existed before
    // category seeding ran (e.g. deep-interview projected coverage.json first —
    // coverage-loop seeds categories only on first write), NOT that seeding is
    // off. Best-available signal: the report-time env toggle; the seed-time
    // decision itself is not persisted in the map.
    const unseededNote =
      report.seeded === 0
        ? farFieldCategoriesEnabled()
          ? ' (0 categories — map-exists skip: coverage.json predates category seeding)'
          : ' (far-field seeding off)'
        : '';
    writeHuman(`  complete: ${report.complete}${unseededNote}`);
  },
});

/**
 * `ditto autopilot status` — surface the approval gate, its plan brief
 * ("무엇을 승인하는가"), and node progress so an operator decides on the gate
 * without hand-reading autopilot.json (wi_260615xby A). Read-only.
 */
const autopilotStatus = defineCommand({
  meta: {
    name: 'status',
    description: 'Show the approval gate, plan brief, and node progress for a work item',
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
    const graph = await new AutopilotStore(repoRoot).get(args.workItem);
    const gate = graph.approval_gate;
    const byStatus = graph.nodes.reduce<Record<string, number>>((acc, n) => {
      acc[n.status] = (acc[n.status] ?? 0) + 1;
      return acc;
    }, {});
    // ADR-0024 결정5 (ac-1): surface each AC's frozen oracle, READ from
    // work-item.acceptance_criteria[].oracle. View-only — recompute nothing, run
    // no sweep. ACs without an oracle are omitted; a missing work-item.json
    // (graph-only status) yields an empty list rather than a crash.
    const items = new WorkItemStore(repoRoot);
    const acceptanceOracles = (await items.exists(args.workItem))
      ? (await items.get(args.workItem)).acceptance_criteria.flatMap((ac) =>
          ac.oracle
            ? [
                {
                  ac_id: ac.id,
                  verification_method: ac.oracle.verification_method,
                  maps_to: ac.oracle.maps_to,
                  direction: ac.oracle.direction,
                },
              ]
            : [],
        )
      : [];
    if (format === 'json') {
      writeJson({
        work_item_id: args.workItem,
        autopilot_id: graph.autopilot_id,
        approval_gate: gate,
        acceptance_oracles: acceptanceOracles,
        nodes: { total: graph.nodes.length, by_status: byStatus },
      });
      return;
    }
    writeHuman(`Autopilot ${graph.autopilot_id} (${args.workItem})`);
    writeHuman(`  approval_gate: ${gate.status}${gate.source ? ` (source: ${gate.source})` : ''}`);
    if (gate.approved_by) writeHuman(`  approved_by:   ${gate.approved_by}`);
    if (gate.change_surface?.length) {
      writeHuman(`  change_surface: ${gate.change_surface.join(', ')}`);
    }
    if (gate.plan_brief) {
      writeHuman('  plan_brief:');
      for (const c of gate.plan_brief.interface_changes) writeHuman(`    interface: ${c}`);
      for (const d of gate.plan_brief.dod) writeHuman(`    dod:       ${d}`);
      for (const s of gate.plan_brief.test_scenarios) writeHuman(`    test:      ${s}`);
    }
    if (acceptanceOracles.length > 0) {
      writeHuman('  acceptance_oracles:');
      for (const o of acceptanceOracles) {
        writeHuman(`    ${o.ac_id}: ${o.verification_method} · ${o.maps_to} · ${o.direction}`);
      }
    }
    const counts = Object.entries(byStatus)
      .map(([s, n]) => `${s}=${n}`)
      .join(' ');
    writeHuman(`  nodes:         ${graph.nodes.length} (${counts})`);
    if (gate.status === 'pending') {
      writeHuman('  → review the brief, then: ditto autopilot approve|reject --workItem <wi>');
    }
  },
});

const APPROVAL_SOURCES: readonly ApprovalSourceValue[] = ['user', 'approved_spec', 'issue', 'prd'];

/**
 * `ditto autopilot approve` — flip a pending approval gate to approved, recording
 * source/approved_at/approved_by, so the loop's `autopilotForcesContinuation`
 * picks it up (wi_260615xby A). Resolves the manual-edit gotcha (#1). Writes only
 * the gate; the loop core is untouched.
 */
const autopilotApprove = defineCommand({
  meta: { name: 'approve', description: 'Approve a pending plan approval gate' },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    by: { type: 'string', description: 'Recorded as approved_by (default: user)', required: false },
    source: {
      type: 'string',
      description: 'Approval source: user|approved_spec|issue|prd (default: user)',
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
    if (
      args.source !== undefined &&
      !APPROVAL_SOURCES.includes(args.source as ApprovalSourceValue)
    ) {
      writeError(
        `invalid --source "${args.source}"; expected one of: ${APPROVAL_SOURCES.join(', ')}`,
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await requireGraph(args.workItem);
    try {
      const updated = await new AutopilotStore(repoRoot).updateApprovalGate(args.workItem, (gate) =>
        applyApproval(gate, {
          ...(args.by ? { by: args.by } : {}),
          ...(args.source ? { source: args.source as ApprovalSourceValue } : {}),
        }),
      );
      const gate = updated.approval_gate;
      if (format === 'json') {
        writeJson({ work_item_id: args.workItem, approval_gate: gate });
      } else {
        writeHuman(`Approved ${args.workItem}: gate=${gate.status} source=${gate.source}`);
        writeHuman(`  approved_by: ${gate.approved_by} at ${gate.approved_at}`);
      }
    } catch (err) {
      writeError(`approve failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto autopilot reject` — flip a pending approval gate to rejected (the loop
 * then rolls back, autopilot-loop.ts). An optional --reason is persisted as a
 * note evidence_ref. Writes only the gate; the loop core is untouched.
 */
const autopilotReject = defineCommand({
  meta: { name: 'reject', description: 'Reject a pending plan approval gate' },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    reason: { type: 'string', description: 'Why the plan is rejected (recorded)', required: false },
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
      const updated = await new AutopilotStore(repoRoot).updateApprovalGate(args.workItem, (gate) =>
        applyRejection(gate, args.reason),
      );
      const gate = updated.approval_gate;
      if (format === 'json') {
        writeJson({ work_item_id: args.workItem, approval_gate: gate });
      } else {
        writeHuman(`Rejected ${args.workItem}: gate=${gate.status}`);
        if (args.reason) writeHuman(`  reason: ${args.reason}`);
      }
    } catch (err) {
      writeError(`reject failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto autopilot exempt` — set (or --unset) the work item's `autopilot_exempt`
 * flag, the escape hatch for the (B) plan→autopilot Stop gate (wi_260615xby). The
 * gate's error message points here so a user is never forced to hand-edit
 * work-item.json. Writes only the work item; no autopilot graph is touched.
 */
const autopilotExempt = defineCommand({
  meta: {
    name: 'exempt',
    description: 'Mark a work item exempt from the plan→autopilot Stop gate (or --unset)',
  },
  args: {
    workItem: { type: 'string', description: 'Work item id (wi_*)', required: true },
    unset: {
      type: 'boolean',
      description: 'Clear the exemption instead of setting it',
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
    const repoRoot = await resolveRepoRootForCreate();
    const items = new WorkItemStore(repoRoot);
    if (!(await items.exists(args.workItem))) {
      writeError(`work item ${args.workItem} not found`);
      process.exit(RUNTIME_ERROR_EXIT);
      return;
    }
    const exempt = !args.unset;
    try {
      await items.update(args.workItem, (current) => {
        const { autopilot_exempt: _drop, ...rest } = current;
        return exempt ? { ...rest, autopilot_exempt: true } : rest;
      });
      if (format === 'json') {
        writeJson({ work_item_id: args.workItem, autopilot_exempt: exempt });
      } else {
        writeHuman(
          exempt
            ? `Work item ${args.workItem} is now autopilot-exempt (closes on completion.json alone).`
            : `Work item ${args.workItem} is no longer autopilot-exempt.`,
        );
      }
    } catch (err) {
      writeError(`exempt failed: ${err instanceof Error ? err.message : String(err)}`);
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
    status: autopilotStatus,
    approve: autopilotApprove,
    reject: autopilotReject,
    exempt: autopilotExempt,
    'next-node': autopilotNextNode,
    'record-result': autopilotRecordResult,
    complete: autopilotComplete,
    revise: autopilotRevise,
    cleanup: autopilotCleanup,
    'propose-e2e': autopilotProposeE2e,
    'intent-drift': autopilotIntentDrift,
    'coverage-next': autopilotCoverageNext,
    'coverage-round': autopilotCoverageRound,
    'coverage-report': autopilotCoverageReport,
  },
});
