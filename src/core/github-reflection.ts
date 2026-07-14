import { boardItemMatchesRepoNumber } from '~/cli/commands/work';
import type { CompletionContract } from '~/schemas/completion-contract';
import type { DittoConfigGithub } from '~/schemas/ditto-config';
import type { WorkItem } from '~/schemas/work-item';
import type { GhClient } from './gh-client';
import { buildPublicSafeSummary } from './github-redaction';

/**
 * GitHub termination reflection (wi_260628d79, G4/G5 — impl-reflection node).
 *
 * Fires ONLY at a TERMINAL work-item transition (`done` | `abandoned`) — NEVER on
 * a partial/blocked/capped/unverified run (those leave the WI open, so the board
 * must stay accurate). The wiring lives at the terminal-transition call sites
 * (the pass-gated done-flip in `autopilot complete`, the `work done` close, and
 * the `work abandon` close), NOT at the verdict-blind `CompletionStore.write()`
 * which persists completion.json for EVERY verdict (cross-feature regression
 * guard: a non-terminal complete must post NOTHING).
 *
 * Reflection is independent, separately-degradable effects (ADR-0018 우아한
 * 강등 — every gh failure is a notice, never a throw, never a block):
 *   1. a result-summary issue comment on the linked github_issue (ac-4);
 *   2. a Project v2 board status update via the D7 `status_map` (ac-5);
 *   3. wi_2606287v9 ac-7 — a terminal @me claim release (drop the @me assignee) so
 *      the board/assignee is clean on close; the result-summary comment above is the
 *      durable audit, so NO second comment is posted (the 1-comment contract holds).
 * The issue is CLOSED only on the explicit manual `--close-issue` path; autopilot
 * NEVER auto-closes. completion stays ditto-evidence — GitHub status is never
 * pulled back into the verdict.
 */

export type TerminationTrigger = 'done' | 'abandoned';

export interface ReflectionDeps {
  client: GhClient;
  /** The `github` block from `.ditto/local/config.json` (undefined = absent OR malformed). */
  config: DittoConfigGithub | undefined;
}

export interface ReflectionInput {
  workItem: WorkItem;
  /** Optional — `work abandon` has no completion contract; the comment falls back to WI verdicts. */
  completion?: CompletionContract;
  trigger: TerminationTrigger;
  /** Manual path ONLY: also close the issue. Autopilot never sets this (no auto-close). */
  closeIssue?: boolean;
}

export interface ReflectionResult {
  commentPosted: boolean;
  statusUpdated: boolean;
  issueClosed: boolean;
  /** wi_2606287v9 ac-7: whether the terminal @me claim was released (assignee dropped)
   *  on close. Best-effort + degradable — false on no-link / degraded / non-terminal. */
  assigneeReleased: boolean;
  /** Human-readable skip/degradation notices (never thrown — surfaced by the caller). */
  notices: string[];
}

export interface StatusField {
  id: string;
  options: { id: string; name: string }[];
}

/**
 * SHARED field-selection rule (wi_2606289h9 C2): "Status" (case-insensitive) wins,
 * else the first single-select field that carries options. The SINGLE source both
 * the apply-time field id (`extractStatusFieldId`) and the setup-time option list
 * (`extractStatusOptions`, github.ts) derive from — so an auto-detected/backfilled
 * option id is always valid at claim time (no divergent 3rd copy of the rule).
 * Returns null on an absent/odd shape — a missing field is a skip, not a crash.
 */
export function selectStatusField(fieldList: unknown): StatusField | null {
  if (typeof fieldList !== 'object' || fieldList === null) return null;
  const fields = (fieldList as { fields?: unknown }).fields;
  if (!Array.isArray(fields)) return null;
  const withOptions = fields.filter(
    (f): f is { id?: unknown; name?: unknown; options: unknown[] } =>
      typeof f === 'object' && f !== null && Array.isArray((f as { options?: unknown }).options),
  );
  const status =
    withOptions.find((f) => typeof f.name === 'string' && f.name.toLowerCase() === 'status') ??
    withOptions[0];
  if (!status || typeof status.id !== 'string') return null;
  const options = status.options
    .filter(
      (o): o is { id: string; name: string } =>
        typeof o === 'object' &&
        o !== null &&
        typeof (o as { id?: unknown }).id === 'string' &&
        typeof (o as { name?: unknown }).name === 'string',
    )
    .map((o) => ({ id: o.id, name: o.name }));
  return { id: status.id, options };
}

/**
 * Extract the Project v2 Status single-select FIELD id (the id `projectItemEdit`
 * needs as `--field-id`) via the shared `selectStatusField` rule.
 */
export function extractStatusFieldId(fieldList: unknown): string | null {
  return selectStatusField(fieldList)?.id ?? null;
}

/**
 * Build the PUBLIC-SAFE result-summary comment body posted to the linked issue
 * (ac-15). CONSTRUCTED via the allow-list redaction layer from ONLY the safe
 * fields — the 1-line summary (title), the commit SHA (`started_at_sha`), the
 * aggregate verdict, and the per-AC verdict — so no internal wi id, AC statement
 * text, or raw absolute path leaks onto a public / cross-repo issue. Pure.
 */
export function buildResultSummary(input: ReflectionInput): string {
  const wi = input.workItem;
  return buildPublicSafeSummary({
    summaryLine: wi.title,
    ...(wi.started_at_sha ? { sha: wi.started_at_sha } : {}),
    ...(input.completion ? { finalVerdict: input.completion.final_verdict } : {}),
    acVerdicts: (wi.acceptance_criteria ?? []).map((ac) => ({ id: ac.id, verdict: ac.verdict })),
  });
}

/**
 * Resolve + apply ONE Project v2 board status update to a known single-select
 * `optionId`, sharing the WHOLE resolution chain (project node id → board item id →
 * field-list → Status field id → `projectItemEdit`) between the terminal reflection
 * path (this file, via `status_map`) and the non-terminal claim path (github-claim,
 * via `claim_status_map`). Option-id-parameterized so the caller owns ONLY the
 * map→option lookup; every miss here is a skip + notice (unknown project node id,
 * issue not on the board, no Status field, gh degradation). The board is never
 * allowed to fail the caller. Returns whether the edit landed plus any notices.
 */
export function applyBoardStatusOption(
  deps: ReflectionDeps,
  workItem: WorkItem,
  optionId: string,
): { statusUpdated: boolean; notices: string[] } {
  const notices: string[] = [];
  const cfg = deps.config;
  if (!cfg?.project.node_id) {
    notices.push('Project board: project node_id unknown in config — board status update skipped.');
    return { statusUpdated: false, notices };
  }
  const gi = workItem.github_issue;
  if (!gi?.project_item_id) {
    notices.push(
      'Project board: issue not on the board (no project_item_id) — board status update skipped.',
    );
    return { statusUpdated: false, notices };
  }
  const itemId = gi.project_item_id;
  // Re-validate the persisted project_item_id still points at THIS issue's card BEFORE
  // editing (wi_260714usn ac-5): a stale/mispopulated id could target ANOTHER repo's card
  // on a multi-repo board and silently flip the wrong one. Read the board and reuse the
  // one matcher (boardItemMatchesRepoNumber) — on a confirmed coordinate MISMATCH, skip
  // fail-closed. A board READ failure must NOT block a legitimate edit (ADR-0018 best-effort),
  // so on degrade / unreadable list we fall through and edit as before.
  const board = deps.client.projectItemList(cfg.project.owner, cfg.project.number);
  if (board.ok) {
    const items = (board.value as { items?: unknown })?.items;
    if (Array.isArray(items)) {
      const card = items.find((it) => (it as { id?: unknown })?.id === itemId);
      if (card && !boardItemMatchesRepoNumber(card, gi.number, gi.repo)) {
        notices.push(
          `Project board: persisted project_item_id points at a card whose coordinate does not match ${gi.repo}#${gi.number} — board status update skipped (stale/mispopulated id).`,
        );
        return { statusUpdated: false, notices };
      }
    }
  }
  const fieldList = deps.client.projectFieldList(cfg.project.owner, cfg.project.number);
  if (!fieldList.ok) {
    notices.push(
      `Project board: field-list degraded (${fieldList.reason}) — board status update skipped.`,
    );
    return { statusUpdated: false, notices };
  }
  const fieldId = extractStatusFieldId(fieldList.value);
  if (!fieldId) {
    notices.push(
      'Project board: no Status single-select field on the Project — board status update skipped.',
    );
    return { statusUpdated: false, notices };
  }
  const edit = deps.client.projectItemEdit({
    projectId: cfg.project.node_id,
    itemId,
    fieldId,
    optionId,
  });
  if (!edit.ok) {
    notices.push(`Project board: status update degraded (${edit.reason}) — board left unchanged.`);
    return { statusUpdated: false, notices };
  }
  return { statusUpdated: true, notices };
}

/**
 * Resolve + apply the Project v2 board status update for a TERMINAL trigger via the
 * D7 `status_map`. Owns only the trigger→option lookup (an unmapped trigger is a skip
 * + notice); the shared resolution chain lives in `applyBoardStatusOption`.
 */
function applyBoardStatus(
  deps: ReflectionDeps,
  input: ReflectionInput,
): { statusUpdated: boolean; notices: string[] } {
  const optionId = deps.config?.status_map?.[input.trigger];
  if (!optionId) {
    return {
      statusUpdated: false,
      notices: [
        `Project board: no status_map entry for '${input.trigger}' — board status update skipped (run \`ditto github setup\` to map it).`,
      ],
    };
  }
  return applyBoardStatusOption(deps, input.workItem, optionId);
}

/**
 * Perform the reflection effects for an established terminal transition. The
 * caller has ALREADY decided to reflect (autopilot: `auto_reflect` opt-in; manual:
 * an explicit flag) — this function does the posting, gracefully degrading each
 * effect independently. No github_issue link → skip + notice (not an error).
 */
export function reflectTermination(deps: ReflectionDeps, input: ReflectionInput): ReflectionResult {
  const notices: string[] = [];
  const gi = input.workItem.github_issue;
  if (!gi) {
    notices.push('No linked GitHub issue on the work item — reflection skipped.');
    return {
      commentPosted: false,
      statusUpdated: false,
      issueClosed: false,
      assigneeReleased: false,
      notices,
    };
  }

  // 1. result-summary comment (ac-4). Public-safe via the redaction allow-list (ac-15).
  const body = buildResultSummary(input);
  const comment = deps.client.issueComment(gi.repo, gi.number, body);
  const commentPosted = comment.ok;
  if (!comment.ok) {
    notices.push(`Issue comment degraded (${comment.reason}) — not posted.`);
  }

  // 2. board status via D7 status_map (ac-5). Independent degradation.
  const board = applyBoardStatus(deps, input);
  notices.push(...board.notices);

  // 3. terminal @me claim release (wi_2606287v9 ac-7): drop the @me assignee so the
  //    board/assignee is clean on close. @me-only (issueRemoveAssignee never clears
  //    other assignees). Best-effort + degradable; the summary comment above is the
  //    durable audit, so NO second comment is posted.
  const release = deps.client.issueRemoveAssignee(gi.repo, gi.number, '@me');
  const assigneeReleased = release.ok;
  if (!release.ok) {
    notices.push(`Assignee release degraded (${release.reason}) — @me left assigned.`);
  }

  // 4. close ONLY on the explicit manual --close-issue path. Autopilot never closes.
  let issueClosed = false;
  if (input.closeIssue) {
    const close = deps.client.issueClose(gi.repo, gi.number);
    if (close.ok) issueClosed = true;
    else notices.push(`Issue close degraded (${close.reason}) — issue left open.`);
  }

  return {
    commentPosted,
    statusUpdated: board.statusUpdated,
    issueClosed,
    assigneeReleased,
    notices,
  };
}

/**
 * Autopilot-path reflection gate + effect in one testable seam. DOUBLE-gates on
 * the real terminal transition: it reflects ONLY when `autoClose === 'flipped'`
 * (the actual status→done flip), so a partial/unverified/blocked complete — which
 * persists completion.json but does NOT flip — posts NOTHING (the cross-feature
 * regression guard). When the flip IS terminal: a MALFORMED config emits a
 * recorded notice (an opted-in `auto_reflect` must not be silently disabled by a
 * broken sibling block); an ABSENT config or `auto_reflect:false` is the silent
 * default-OFF (no notice). Autopilot NEVER closes the issue.
 */
export function reflectAutopilotTermination(
  deps: ReflectionDeps & { configMalformed: boolean },
  input: {
    autoClose: 'flipped' | 'skipped' | 'blocked';
    workItem: WorkItem;
    completion?: CompletionContract;
  },
): ReflectionResult {
  const base: ReflectionResult = {
    commentPosted: false,
    statusUpdated: false,
    issueClosed: false,
    assigneeReleased: false,
    notices: [],
  };
  // Only the actual terminal flip reflects — partial/unverified/blocked post nothing.
  if (input.autoClose !== 'flipped') return base;
  // Malformed config: do NOT silently disable an opted-in auto_reflect — record it.
  if (deps.configMalformed) {
    return {
      ...base,
      notices: [
        'GitHub reflection: config is malformed — auto-reflect could not be honored (reflection skipped). Fix .ditto/local/config.json (run `ditto github setup`).',
      ],
    };
  }
  // Absent config or auto_reflect=false: silent default-OFF (no notice).
  if (!deps.config?.auto_reflect) return base;
  // Opted in: reflect (autopilot never closes — closeIssue omitted).
  return reflectTermination(
    { client: deps.client, config: deps.config },
    {
      workItem: input.workItem,
      trigger: 'done',
      ...(input.completion ? { completion: input.completion } : {}),
    },
  );
}
