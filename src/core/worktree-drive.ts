import { join } from 'node:path';
import { type DriveMemberResult, scrubCredentials } from './chain-drive';
import type { WorkItemStore } from './work-item-store';
import type { WorktreeLandResult, WorktreeRemovalResult } from './worktree';

// wi_260627t82 / wi_2607156f8 — `driveWorktrees`: a CLI ORCHESTRATOR that drives an
// INDEPENDENT set of work items, each in its own DITTO worktree, then LANDS the driven
// ones straight to origin/<default> and tears the worktree down. Mirrors chain-drive.ts'
// injectable-seam shape (driveMember / land / removeWorktrees are injected so the
// deterministic orchestration — worktree gate, drive→land→remove sequencing, land-only
// teardown, halt continuation, opt-in land, depth cap — is fully unit-testable). Unlike
// chain drive, the set is NOT a follows-spine: members are independent, so a halt on one
// member CONTINUES to the next (only the depth cap breaks the loop).
//
// LANDING = pushing the worktree branch's commits straight to origin/<default> (no local
// merge into the shared main checkout). A push is IRREVERSIBLE + user-gated, so it fires
// ONLY with `options.push`; without it a driven member is left for a manual land. Failure
// classes are surfaced distinctly (C5) and a partial multi-repo land reports which repos
// landed (C1) — a failed land is never collapsed into a benign skip nor reported done.

const TERMINAL_STATUSES = ['done', 'abandoned'] as const;

export type WorktreeMemberDisposition =
  | 'driven-done' // driven to done AND every owning repo landed to origin AND torn down
  | 'halted' // the drive step ended not-done
  | 'driven-not-landed' // driven to done but not landed (no --push, or no origin) — worktree preserved
  | 'land-failed'; // driven to done but the LAND to origin FAILED — worktree preserved

export interface WorktreeMemberLedgerEntry {
  member_id: string;
  disposition: WorktreeMemberDisposition;
  /** present for `halted` / `land-failed` / `driven-not-landed`. */
  reason?: string;
  /** present for `driven-done`: whether the worktree was actually torn down. */
  removed?: boolean;
  /** owning repos that actually landed to origin (C1: partial-land visibility). */
  landed_repos?: string[];
}

/** Drive one member inside its worktree checkout; `worktreeCwd` is the '.' worktree. */
export type WorktreeDriveMemberFn = (
  worktreeCwd: string,
  wiId: string,
) => Promise<DriveMemberResult>;
export type WorktreeLandFn = (repoRoot: string, wiId: string) => Promise<WorktreeLandResult>;
export type RemoveWorktreesFn = (repoRoot: string, wiId: string) => Promise<WorktreeRemovalResult>;

export interface WorktreeDriveDeps {
  store: WorkItemStore;
  /** whether a member has its intent.json (the same lock `autopilot bootstrap` requires). */
  intentExists: (wiId: string) => Promise<boolean>;
  driveMember: WorktreeDriveMemberFn;
  /** land the member's branch(es) straight to origin/<default>; injected so tests never push. */
  land: WorktreeLandFn;
  removeWorktrees: RemoveWorktreesFn;
}

export interface WorktreeDriveOptions {
  workIds: string[];
  /** land (push to origin) each driven-done member. A push is user-gated, so OFF by default. */
  push: boolean;
  maxDepth: number;
}

export interface WorktreeDriveResult {
  work_ids: string[];
  ledger: WorktreeMemberLedgerEntry[];
  /** ids of every member whose DRIVE step did not reach done. */
  halted_members: string[];
  /** ids of every member driven to done but whose LAND to origin FAILED (need attention). */
  land_failed_members: string[];
  /** every member's drive reached done (ready to land). */
  all_driven_done: boolean;
  /** every member landed to origin and was torn down. */
  all_landed: boolean;
  /** true when the depth cap stopped the run before the set was exhausted. */
  stopped_at_cap: boolean;
  /** whether landing (push to origin) was requested for this run. */
  push_requested: boolean;
}

export const DEFAULT_MAX_DEPTH = 20;

/**
 * Drive each work item in `options.workIds` (an INDEPENDENT set, processed in order)
 * in its own worktree, then — with `options.push` — LAND it straight to origin and tear
 * it down. Per member, in order:
 *  - no '.' worktree → HALT (`no-worktree`), CONTINUE.
 *  - terminal-but-not-done (abandoned) → HALT, CONTINUE.
 *  - already `done` → skip driveMember, go straight to finish (idempotent resume); no cap.
 *  - not intent-locked → HALT (`needs-intent-lock`), CONTINUE (never auto-create intent).
 *  - else drive (consumes cap budget); a not-done result → HALT, CONTINUE.
 *  - driven-done → finish: without --push leave it `driven-not-landed`; with --push land it
 *    (every owning repo landed → `driven-done` + teardown; a benign no-origin skip →
 *    `driven-not-landed`; a hard land failure → `land-failed`, worktree preserved, with the
 *    failure class + which repos landed).
 * Only the depth cap breaks the loop — a member halt/land-failure does not stop the rest.
 */
export async function driveWorktrees(
  deps: WorktreeDriveDeps,
  options: WorktreeDriveOptions,
): Promise<WorktreeDriveResult> {
  const repoRoot = deps.store.repoRoot;
  const ledger: WorktreeMemberLedgerEntry[] = [];
  let drivenCount = 0;
  let stoppedAtCap = false;

  // A driven-to-done member's finish step: land (push to origin, user-gated) then, on a
  // full land, tear down. Shared by the already-done resume path and the fresh-drive path.
  const finishMember = async (member: string): Promise<WorktreeMemberLedgerEntry> => {
    if (!options.push) {
      // A push is irreversible + user-gated: without --push we drive to done but never
      // land. The worktree is preserved for a manual land.
      return {
        member_id: member,
        disposition: 'driven-not-landed',
        reason: 'push not requested (re-run with --push to land to origin)',
      };
    }
    const landRes = await deps.land(repoRoot, member);
    const landedRepos = landRes.outcomes
      .filter((o) => o.status === 'landed')
      .map((o) => o.worktree.owning_repo);
    if (landRes.allLanded) {
      const rm = await deps.removeWorktrees(repoRoot, member);
      return {
        member_id: member,
        disposition: 'driven-done',
        removed: rm.removed.length > 0,
        landed_repos: landedRepos,
      };
    }
    // Not all landed. A HARD failure (push-gate / auth-network / non-FF-exhausted /
    // rebase-conflict) is distinct from a benign no-origin skip (C5): never collapse them.
    const failure = landRes.outcomes.find(
      (o) => o.status !== 'landed' && o.status !== 'skipped-no-origin',
    );
    if (!failure) {
      // Every non-landed outcome is a benign no-origin skip — nothing failed, just nowhere
      // to land. The worktree is preserved (teardown needs a confirmed land).
      return {
        member_id: member,
        disposition: 'driven-not-landed',
        reason: 'no origin to land to (push manually)',
        ...(landedRepos.length > 0 ? { landed_repos: landedRepos } : {}),
      };
    }
    // A real land failure (C5): surface the class + which repos already landed (C1),
    // and PRESERVE the worktree (never a driven-done, never a force-delete).
    return {
      member_id: member,
      disposition: 'land-failed',
      reason: `${failure.status}${failure.reason ? `: ${scrubCredentials(failure.reason)}` : ''}`,
      ...(landedRepos.length > 0 ? { landed_repos: landedRepos } : {}),
    };
  };

  for (const member of options.workIds) {
    if (drivenCount >= options.maxDepth) {
      stoppedAtCap = true;
      break;
    }
    const item = await deps.store.get(member);
    const ws = item.worktrees.find((w) => w.owning_repo === '.');
    if (!ws) {
      ledger.push({
        member_id: member,
        disposition: 'halted',
        reason: 'no-worktree: no DITTO worktree to drive',
      });
      continue;
    }
    if (item.status !== 'done' && (TERMINAL_STATUSES as readonly string[]).includes(item.status)) {
      ledger.push({
        member_id: member,
        disposition: 'halted',
        reason: `terminal-not-done: member is ${item.status}`,
      });
      continue;
    }
    if (item.status === 'done') {
      // idempotent resume: a member that already reached done just needs its finish step
      // (land + teardown) — no drive, no cap budget.
      ledger.push(await finishMember(member));
      continue;
    }
    if (!(await deps.intentExists(member))) {
      ledger.push({ member_id: member, disposition: 'halted', reason: 'needs-intent-lock' });
      continue;
    }
    drivenCount++;
    const res = await deps.driveMember(join(repoRoot, ws.worktree_path), member);
    if (res.outcome !== 'done') {
      ledger.push({
        member_id: member,
        disposition: 'halted',
        reason: scrubCredentials(res.reason),
      });
      continue;
    }
    ledger.push(await finishMember(member));
  }

  const allDrivenDone = ledger.length > 0 && ledger.every((e) => e.disposition !== 'halted');
  const allLanded = ledger.length > 0 && ledger.every((e) => e.disposition === 'driven-done');
  const haltedMembers = ledger.filter((e) => e.disposition === 'halted').map((e) => e.member_id);
  const landFailedMembers = ledger
    .filter((e) => e.disposition === 'land-failed')
    .map((e) => e.member_id);

  return {
    work_ids: options.workIds,
    ledger,
    halted_members: haltedMembers,
    land_failed_members: landFailedMembers,
    all_driven_done: allDrivenDone,
    all_landed: allLanded,
    stopped_at_cap: stoppedAtCap,
    push_requested: options.push,
  };
}
