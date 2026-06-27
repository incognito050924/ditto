import { join } from 'node:path';
import { type DriveMemberResult, type PushOutcome, scrubCredentials } from './chain-drive';
import type { WorkItemStore } from './work-item-store';
import type { WorktreeMergeResult, WorktreeRemovalResult } from './worktree';

// wi_260627t82 — `driveWorktrees`: a CLI ORCHESTRATOR that drives an INDEPENDENT set
// of work items, each in its own DITTO worktree, then merges the clean ones back
// into their owning repo and tears the worktree down. Mirrors chain-drive.ts'
// injectable-seam shape (driveMember / merge / removeWorktrees / attemptPush are
// injected so the deterministic orchestration — worktree gate, drive→merge→remove
// sequencing, clean-only merge-back, halt continuation, opt-in push, depth cap — is
// fully unit-testable). Unlike chain drive, the set is NOT a follows-spine: members
// are independent, so a halt on one member CONTINUES to the next (only the depth cap
// breaks the loop).

const TERMINAL_STATUSES = ['done', 'abandoned'] as const;

export type WorktreeMemberDisposition = 'driven-done' | 'halted' | 'merge-conflicted';

export interface WorktreeMemberLedgerEntry {
  member_id: string;
  disposition: WorktreeMemberDisposition;
  /** present for `halted` / `merge-conflicted`. */
  reason?: string;
  /** present for `driven-done`: whether the worktree was actually torn down. */
  removed?: boolean;
}

/** Drive one member inside its worktree checkout; `worktreeCwd` is the '.' worktree. */
export type WorktreeDriveMemberFn = (
  worktreeCwd: string,
  wiId: string,
) => Promise<DriveMemberResult>;
export type WorktreeMergeFn = (repoRoot: string, wiId: string) => Promise<WorktreeMergeResult>;
export type RemoveWorktreesFn = (repoRoot: string, wiId: string) => Promise<WorktreeRemovalResult>;

export interface WorktreeDriveDeps {
  store: WorkItemStore;
  /** whether a member has its intent.json (the same lock `autopilot bootstrap` requires). */
  intentExists: (wiId: string) => Promise<boolean>;
  driveMember: WorktreeDriveMemberFn;
  merge: WorktreeMergeFn;
  removeWorktrees: RemoveWorktreesFn;
  /** push the driven set; injected so orchestration tests never touch git. */
  attemptPush: (members: readonly string[]) => Promise<PushOutcome>;
}

export interface WorktreeDriveOptions {
  workIds: string[];
  push: boolean;
  maxDepth: number;
}

export interface WorktreeDriveResult {
  work_ids: string[];
  ledger: WorktreeMemberLedgerEntry[];
  /** ids of every member that did NOT reach driven-done (halted or merge-conflicted). */
  halted_members: string[];
  all_driven_done: boolean;
  /** true when the depth cap stopped the run before the set was exhausted. */
  stopped_at_cap: boolean;
  push: PushOutcome;
  push_ready: boolean;
}

export const DEFAULT_MAX_DEPTH = 20;

/**
 * Drive each work item in `options.workIds` (an INDEPENDENT set, processed in order)
 * in its own worktree, then clean-merge it back and tear it down. Per member, in order:
 *  - no '.' worktree → HALT (`no-worktree`), CONTINUE.
 *  - terminal-but-not-done (abandoned) → HALT, CONTINUE.
 *  - already `done` → skip driveMember, go straight to merge→remove (idempotent resume);
 *    no cap consumed.
 *  - not intent-locked → HALT (`needs-intent-lock`), CONTINUE (never auto-create intent).
 *  - else drive (consumes cap budget); a not-done result → HALT, CONTINUE.
 *  - driven-done → merge back; if every owning repo merged cleanly, remove the worktree
 *    (`driven-done`); else PRESERVE it (`merge-conflicted`), never remove.
 * Only the depth cap breaks the loop — a member halt does not stop the rest. Push is
 * opt-in and fires only when every member reached driven-done.
 */
export async function driveWorktrees(
  deps: WorktreeDriveDeps,
  options: WorktreeDriveOptions,
): Promise<WorktreeDriveResult> {
  const repoRoot = deps.store.repoRoot;
  const ledger: WorktreeMemberLedgerEntry[] = [];
  let drivenCount = 0;
  let stoppedAtCap = false;

  // Merge the member's branch(es) back; on a fully-clean merge tear the worktree
  // down, else preserve it. Shared by the already-done resume path and the
  // fresh-drive path so both go through the identical clean-only gate.
  const mergeAndRemove = async (member: string): Promise<WorktreeMemberLedgerEntry> => {
    const mergeRes = await deps.merge(repoRoot, member);
    if (mergeRes.allMerged) {
      const rm = await deps.removeWorktrees(repoRoot, member);
      return { member_id: member, disposition: 'driven-done', removed: rm.removed.length > 0 };
    }
    const firstUnmerged = mergeRes.outcomes.find((o) => o.status !== 'merged');
    return {
      member_id: member,
      disposition: 'merge-conflicted',
      reason: scrubCredentials(firstUnmerged?.reason ?? 'merge did not complete'),
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
      // idempotent resume: a member that already reached done just needs its clean
      // merge-back + teardown — no drive, no cap budget.
      ledger.push(await mergeAndRemove(member));
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
    ledger.push(await mergeAndRemove(member));
  }

  const allDrivenDone = ledger.length > 0 && ledger.every((e) => e.disposition === 'driven-done');
  const haltedMembers = ledger
    .filter((e) => e.disposition !== 'driven-done')
    .map((e) => e.member_id);

  let push: PushOutcome = 'not-requested';
  if (options.push) {
    push = allDrivenDone ? await deps.attemptPush(options.workIds) : 'skipped-not-ready';
  }

  return {
    work_ids: options.workIds,
    ledger,
    halted_members: haltedMembers,
    all_driven_done: allDrivenDone,
    stopped_at_cap: stoppedAtCap,
    push,
    push_ready: allDrivenDone,
  };
}
