import type { DittoConfigGithub } from '~/schemas/ditto-config';
import type { WorkItem } from '~/schemas/work-item';
import type { GhClient } from './gh-client';
import { parseAssigneeLogins } from './gh-client';
import { sanitizeBranchCoordinate } from './github-redaction';
import { applyBoardStatusOption } from './github-reflection';

/**
 * GitHub claim / occupancy logic (wi_2606287v9 #5 — impl core).
 *
 * The claim is REMOTE-AUTHORITATIVE-FIRST + best-effort-advisory (NOT a lock —
 * GitHub has no compare-and-set). The ONLY durable occupancy record is the GitHub
 * @me assignee; ditto's local `claimed_branch` / `posted_claim_markers` are a
 * branch-grain idempotency sentinel + a read-back convenience, never the source of
 * truth (ADR-20260628-github-backlog-sot: read-back stays SoT, one-way mirror —
 * GitHub state is NEVER pulled back into the ditto verdict/status, ADR-0018: every
 * gh failure is a notice, never a throw, never a block).
 *
 * Order is load-bearing: write the @me assignee FIRST, read-back to CONFIRM +
 * scan for conflicts, and ONLY THEN compute the local claim marker. On a remote
 * failure (assignee write degraded) or a confirmed partial (write returned ok but
 * @me is not reflected) NO local claim is written — so a second machine never sees
 * "local-owned but board-free". Read-back is purely advisory (ac-3): it emits
 * warnings (occupancy UNKNOWN on a degraded read, a duplicate-claim warning on a
 * foreign assignee, a resume hint on the same actor + a different branch) but NEVER
 * blocks and NEVER feeds the verdict. Third-party logins surfaced by read-back ride
 * only in the transient advisory warnings — they are NEVER returned in `localClaim`
 * and so never land in committed memory / tracked handoff.
 */

const SELF_ASSIGNEE = '@me';
/** claim_status_map key for the non-terminal "claimed / in progress" board column. */
const IN_PROGRESS_KEY = 'in_progress';

export interface ClaimDeps {
  client: GhClient;
  /** The `github` block from `.ditto/local/config.json` (undefined = absent OR malformed). */
  config: DittoConfigGithub | undefined;
}

export interface ClaimInput {
  workItem: WorkItem;
  /** The branch THIS session is claiming on (branch-grain occupancy). */
  branch: string;
  /** This actor's GitHub login (n6 reads `gh api user`). Used for read-back conflict
   *  attribution; absent ⇒ foreign/self attribution degrades to occupancy-only. */
  actorLogin?: string;
  /** Repo root for the public-safe branch-coordinate relativization (defaults cwd). */
  repoRoot?: string;
}

export type Occupancy = 'self' | 'foreign' | 'unknown' | 'skipped';

export interface ClaimResult {
  assigneeAdded: boolean;
  boardUpdated: boolean;
  commentPosted: boolean;
  /** Local claim marker to PERSIST into github_issue (n6 owns the work-item write).
   *  Present ONLY when the remote claim landed (assignee write ok, not a confirmed
   *  partial). Carries the actor's OWN branch coordinate — NEVER a foreign login. */
  localClaim?: { claimed_branch: string; posted_claim_markers: string[] };
  /** Advisory read-back warnings (ac-3) — NEVER block, NEVER feed the verdict. */
  warnings: string[];
  /** Skip / degradation notices (gh down, no link, board miss). */
  notices: string[];
  occupancy: Occupancy;
  /** True when nothing happened because the steady-state local marker already exists. */
  noop: boolean;
}

function emptyClaim(occupancy: Occupancy): ClaimResult {
  return {
    assigneeAdded: false,
    boardUpdated: false,
    commentPosted: false,
    warnings: [],
    notices: [],
    occupancy,
    noop: false,
  };
}

/**
 * Claim the linked GitHub issue for THIS branch/session: write the @me assignee
 * (remote-first), read-back to confirm + scan for conflicts, move the board to the
 * non-terminal "in progress" column (guarded against overwriting a terminal status),
 * post a public-safe branch comment, and return the local claim marker to persist.
 * Idempotent: a steady-state re-claim is a zero-gh-call no-op.
 */
export function claim(deps: ClaimDeps, input: ClaimInput): ClaimResult {
  const gi = input.workItem.github_issue;
  if (!gi) {
    return {
      ...emptyClaim('skipped'),
      notices: ['No linked GitHub issue on the work item — claim skipped.'],
    };
  }

  const coord = sanitizeBranchCoordinate(input.branch, input.repoRoot);
  const marker = `claim:${coord}`;
  const existingMarkers = gi.posted_claim_markers ?? [];

  // Idempotency: steady state for THIS branch = local marker already present. A
  // re-claim on the steady state is a zero-gh-call no-op; the gh write happens once
  // per claim edge.
  if (gi.claimed_branch === coord && existingMarkers.includes(marker)) {
    return { ...emptyClaim('self'), noop: true };
  }

  // 1. Remote-authoritative FIRST: write the @me assignee. On failure write NO local
  //    claim (remote-first invariant).
  const assign = deps.client.issueAddAssignee(gi.repo, gi.number, SELF_ASSIGNEE);
  if (!assign.ok) {
    return {
      ...emptyClaim('skipped'),
      notices: [
        `Claim degraded (${assign.reason}) — assignee not set; NO local claim written (remote-first).`,
      ],
    };
  }

  // 2. Read-back CONFIRM + conflict scan (ac-3). ADVISORY ONLY — never blocks, never
  //    feeds the verdict (ADR-20260628 one-way mirror).
  const warnings: string[] = [];
  let occupancy: Occupancy = 'self';
  const view = deps.client.issueView(gi.repo, gi.number);
  if (!view.ok) {
    occupancy = 'unknown';
    warnings.push(
      `Occupancy UNKNOWN: claim read-back degraded (${view.reason}) — the assignee write returned ok but the claim could not be confirmed (advisory; GitHub has no compare-and-set, this is best-effort, not a lock).`,
    );
  } else {
    const logins = parseAssigneeLogins(view.value);
    const actor = input.actorLogin;
    const selfPresent = actor ? logins.includes(actor) : logins.length > 0;
    const foreign = actor ? logins.filter((l) => l !== actor) : [];

    // Confirmed partial: the write returned ok but @me is NOT reflected. Distinct
    // from a degraded read ("occupancy UNKNOWN") — here the read SUCCEEDED and shows
    // the claim did not take. Write NO local claim (remote-first invariant).
    if (actor && logins.length === 0) {
      warnings.push(
        'Claim read-back: the assignee write returned ok but @me is NOT reflected on the issue — treating as a partial; NO local claim written (advisory, not a lock).',
      );
      return { ...emptyClaim('unknown'), assigneeAdded: true, warnings };
    }

    if (foreign.length > 0) {
      occupancy = 'foreign';
      warnings.push(
        `Duplicate-claim warning: the issue is ALSO assigned to ${foreign.join(', ')} — another session may be working this (advisory; GitHub has no compare-and-set, this is not a lock).`,
      );
    }
    // Same actor, a DIFFERENT branch already recorded locally ⇒ resume hint.
    if (selfPresent && gi.claimed_branch && gi.claimed_branch !== coord) {
      warnings.push(
        `Resume hint: you already claimed this issue on branch '${gi.claimed_branch}' — this is a different branch ('${coord}'). Likely your other session/branch.`,
      );
    }
  }

  const notices: string[] = [];

  // 3. Board → non-terminal "in progress" (claim_status_map). GUARDED: a non-terminal
  //    claim must NEVER overwrite a terminal board status. Reason from the WI status
  //    (the ditto-side SoT for terminal state) — a terminal WI ⇒ skip the claim move.
  let boardUpdated = false;
  const isTerminal = input.workItem.status === 'done' || input.workItem.status === 'abandoned';
  const claimOption = deps.config?.claim_status_map?.[IN_PROGRESS_KEY];
  if (isTerminal) {
    notices.push(
      `Claim board move skipped: work item status is '${input.workItem.status}' (terminal) — a non-terminal claim must not overwrite a terminal board status.`,
    );
  } else if (!claimOption) {
    notices.push(
      "Claim board move skipped: no claim_status_map entry for 'in_progress' (run `ditto github setup`).",
    );
  } else {
    const board = applyBoardStatusOption(
      { client: deps.client, config: deps.config },
      input.workItem,
      claimOption,
    );
    boardUpdated = board.statusUpdated;
    notices.push(...board.notices);
  }

  // 4. Public-safe branch comment (no wi_ leak), idempotent: only if not already posted.
  let commentPosted = false;
  if (!existingMarkers.includes(marker)) {
    const commentBody = `## ditto: work item claimed\n\nIn progress on branch \`${coord}\`.`;
    const comment = deps.client.issueComment(gi.repo, gi.number, commentBody);
    if (comment.ok) commentPosted = true;
    else notices.push(`Claim comment degraded (${comment.reason}) — not posted.`);
  }

  // 5. ONLY NOW compute the local claim marker (after the remote write + confirm).
  const localClaim = {
    claimed_branch: coord,
    posted_claim_markers: [...existingMarkers, marker],
  };

  return {
    assigneeAdded: true,
    boardUpdated,
    commentPosted,
    localClaim,
    warnings,
    notices,
    occupancy,
    noop: false,
  };
}

export interface UnclaimInput {
  workItem: WorkItem;
  /** Optional audit text for the release/takeover timeline comment. */
  reason?: string;
  /** Optional claim_status_map key to move the board to on release (e.g. 'blocked' →
   *  Blocked column). Absent ⇒ no board move (plain release). */
  boardStatusKey?: string;
}

export interface UnclaimResult {
  assigneeRemoved: boolean;
  boardUpdated: boolean;
  commentPosted: boolean;
  /** Whether the local claim marker should be CLEARED on persist (n6 owns the write). */
  cleared: boolean;
  notices: string[];
}

/**
 * Release the claim: drop the @me assignee ONLY (issueRemoveAssignee @me — NEVER
 * clears other assignees, ac-7), post a durable release/takeover timeline comment so
 * the handoff is auditable (not just a mutated field), and optionally move the board
 * (e.g. blocked → Blocked). Every gh failure is a notice, never a throw.
 */
export function unclaim(deps: ClaimDeps, input: UnclaimInput): UnclaimResult {
  const notices: string[] = [];
  const gi = input.workItem.github_issue;
  if (!gi) {
    return {
      assigneeRemoved: false,
      boardUpdated: false,
      commentPosted: false,
      cleared: false,
      notices: ['No linked GitHub issue on the work item — unclaim skipped.'],
    };
  }

  // 1. Drop @me ONLY (never clears another session's assignee).
  const rm = deps.client.issueRemoveAssignee(gi.repo, gi.number, SELF_ASSIGNEE);
  const assigneeRemoved = rm.ok;
  if (!rm.ok) notices.push(`Unclaim degraded (${rm.reason}) — @me assignee not removed.`);

  // 2. Durable release/takeover timeline comment (auditable handoff, not just a field flip).
  const commentBody = `## ditto: claim released\n\n${input.reason ?? 'Claim released — the issue is free for takeover.'}`;
  const comment = deps.client.issueComment(gi.repo, gi.number, commentBody);
  const commentPosted = comment.ok;
  if (!comment.ok) notices.push(`Release comment degraded (${comment.reason}) — not posted.`);

  // 3. Optional board move (e.g. blocked → Blocked column) via claim_status_map.
  let boardUpdated = false;
  if (input.boardStatusKey) {
    const option = deps.config?.claim_status_map?.[input.boardStatusKey];
    if (!option) {
      notices.push(
        `Release board move skipped: no claim_status_map entry for '${input.boardStatusKey}'.`,
      );
    } else {
      const board = applyBoardStatusOption(
        { client: deps.client, config: deps.config },
        input.workItem,
        option,
      );
      boardUpdated = board.statusUpdated;
      notices.push(...board.notices);
    }
  }

  return { assigneeRemoved, boardUpdated, commentPosted, cleared: true, notices };
}
