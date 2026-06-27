import { type GitPushResult, captureGitState, gitPush } from './git';
import { type StemView, WorkItemStore, pushReadiness } from './work-item-store';

// wi_2606277pt — `ditto work chain drive <wi>`: a CLI ORCHESTRATOR that drives a
// follows-stem's members sequentially (root→tip). `ditto autopilot` is
// AGENT-IN-THE-LOOP (next-node emits spawn/main_session actions an LLM owner must
// run; there is NO headless `autopilot run`). So this command automates the
// SEQUENCING across members (the user no longer types "next" between members);
// the per-member cognitive work still runs through autopilot's agent loop. The
// per-member "drive" step is an INJECTABLE seam (driveMember) so the deterministic
// orchestration — spine resolution, halt-gates, ledger, roll-up, opt-in push,
// depth cap — is fully unit-testable; production injects a subprocess-shelling
// driver (productionDriveMember below).

const TERMINAL_STEM_STATUSES = ['done', 'abandoned'] as const;

/** Thrown when the connected follows-component through <wi> branches (multi-child)
 * — we refuse to silently enlist members the user never named (ADR-20260627
 * explicit-signal boundary). Names the branch point. */
export class BranchedStemError extends Error {
  constructor(public readonly branchPoint: string) {
    super(
      `chain drive: the stem through this work item BRANCHES at ${branchPoint} (it has >1 follows-child). A branched/multi-tip chain is not a linear spine; drive each branch explicitly.`,
    );
    this.name = 'BranchedStemError';
  }
}

// ac-5: per-member typed disposition.
export type MemberDispositionKind =
  | 'driven-done'
  | 'skipped-already-done'
  | 'halted'
  | 'blocked-unlocked-no-intent';

export interface MemberLedgerEntry {
  member_id: string;
  disposition: MemberDispositionKind;
  /** present for `halted` / `blocked-unlocked-no-intent`. */
  reason?: string;
}

// ac-4: push outcome on the rolled-up chain.
export type PushOutcome =
  | 'pushed'
  | 'skipped-no-remote' // a push was attempted but git exited non-zero (graceful-degrade)
  | 'skipped-not-ready' // --push given but the chain is not done / not push-ready
  | 'not-requested'; // default: never push unasked

export interface ChainDriveResult {
  work_id: string;
  /** spine ids, root→tip. */
  members: string[];
  ledger: MemberLedgerEntry[];
  rolled_up: StemView['rolled_up'];
  /** the member that stopped the chain (halt / no-intent), if any. */
  halted_member?: string;
  /** true when the depth cap stopped the run before the spine was exhausted. */
  stopped_at_cap: boolean;
  push: PushOutcome;
  push_ready: boolean;
}

// The injected per-member driver result. `done` = the member's autopilot reached
// a pass completion (its WI is done). `halted` = it ended not-done
// (blocked/partial/abandoned) or paused for a user-only/irreversible decision.
export type DriveMemberResult = { outcome: 'done' } | { outcome: 'halted'; reason: string };

export type DriveMemberFn = (repoRoot: string, wiId: string) => Promise<DriveMemberResult>;

export interface ChainDriveDeps {
  store: WorkItemStore;
  /** whether a member has its intent.json (the same lock `autopilot bootstrap` requires). */
  intentExists: (wiId: string) => Promise<boolean>;
  driveMember: DriveMemberFn;
  /** push the rolled-up chain; returns the outcome. Injected so orchestration tests
   * never touch git. Production = productionAttemptPush. */
  attemptPush: (members: readonly string[]) => Promise<PushOutcome>;
}

export interface ChainDriveOptions {
  workId: string;
  push: boolean;
  maxDepth: number;
}

export const DEFAULT_MAX_DEPTH = 20;

/**
 * Resolve the LINEAR spine through `workId`: the connected follows-component
 * (store.stem already walks both directions, root→tip). Each WI has ≤1 follows
 * (≤1 parent), so the component is a tree; it is linear iff no member has >1
 * follows-child. A branch → BranchedStemError naming the branch point.
 */
export async function resolveSpine(store: WorkItemStore, workId: string): Promise<StemView> {
  const view = await store.stem(workId);
  const ids = new Set(view.members.map((m) => m.id));
  const childCount = new Map<string, number>();
  for (const m of view.members) {
    if (m.follows !== undefined && ids.has(m.follows)) {
      childCount.set(m.follows, (childCount.get(m.follows) ?? 0) + 1);
    }
  }
  for (const [parent, count] of childCount) {
    if (count > 1) throw new BranchedStemError(parent);
  }
  return view;
}

/**
 * Drive the linear follows-spine through `options.workId` sequentially, root→tip.
 * Each member is re-derived from its PERSISTED status (so a re-invocation resumes
 * from the first non-terminal member): a `done` member is skipped; an
 * abandoned/terminal-not-done member HALTS; a non-terminal member without
 * intent.json HALTS (no auto-create); otherwise it is driven via the injected
 * driveMember, and a not-done result HALTS. On full completion (every member done
 * + stem rolls up to done + push-readiness) the chain is push-ready, but a push
 * fires only when `options.push` is set. Bounded by `options.maxDepth` per run.
 */
export async function driveChain(
  deps: ChainDriveDeps,
  options: ChainDriveOptions,
): Promise<ChainDriveResult> {
  const { store } = deps;
  const view = await resolveSpine(store, options.workId); // throws on a branched stem
  const members = view.members.map((m) => m.id);
  const ledger: MemberLedgerEntry[] = [];
  let haltedMember: string | undefined;
  let stoppedAtCap = false;
  let iterated = 0;

  for (const member of members) {
    if (iterated >= options.maxDepth) {
      stoppedAtCap = true;
      break;
    }
    // Re-read fresh persisted status — resume derives state per-member, not from an
    // in-memory or end-only ledger.
    const item = await store.get(member);
    if (item.status === 'done') {
      ledger.push({ member_id: member, disposition: 'skipped-already-done' });
      continue;
    }
    if ((TERMINAL_STEM_STATUSES as readonly string[]).includes(item.status)) {
      // terminal but NOT done (abandoned) → HALT, do not skip like a done member.
      ledger.push({
        member_id: member,
        disposition: 'halted',
        reason: `terminal-not-done: member is ${item.status}`,
      });
      haltedMember = member;
      break;
    }
    // Non-terminal: it must be intent-locked before we drive it (the same lock
    // `autopilot bootstrap` requires). Missing → HALT; never auto-create intent.
    if (!(await deps.intentExists(member))) {
      ledger.push({
        member_id: member,
        disposition: 'blocked-unlocked-no-intent',
        reason: 'needs-intent-lock',
      });
      haltedMember = member;
      break;
    }
    // Only a DRIVEN member consumes cap budget (ac-5): skipped-already-done members
    // are not work, so on resume a long done prefix must not exhaust the cap.
    iterated++;
    const result = await deps.driveMember(store.repoRoot, member);
    if (result.outcome === 'done') {
      ledger.push({ member_id: member, disposition: 'driven-done' });
      continue;
    }
    ledger.push({
      member_id: member,
      disposition: 'halted',
      reason: scrubCredentials(result.reason),
    });
    haltedMember = member;
    break;
  }

  // Roll up from FRESH statuses (members may have flipped during this run).
  const freshView = await resolveSpine(store, options.workId);
  const rolledUp = freshView.rolled_up;
  // push-readiness: reuse the strong bar (every AC pass + real evidence + no
  // self-caused regression + a fully-done stem). Evaluated on the queried item +
  // the fresh stem so condition 4 (chain done) applies.
  const queried = await store.get(options.workId);
  const pushReady = pushReadiness(queried, freshView).ready && rolledUp === 'done';

  let push: PushOutcome = 'not-requested';
  if (options.push) {
    push = pushReady ? await deps.attemptPush(members) : 'skipped-not-ready';
  }

  return {
    work_id: options.workId,
    members,
    ledger,
    rolled_up: rolledUp,
    ...(haltedMember !== undefined ? { halted_member: haltedMember } : {}),
    stopped_at_cap: stoppedAtCap,
    push,
    push_ready: pushReady,
  };
}

/**
 * Scrub `userinfo@` (https://user:token@host) credentials from any captured git
 * URL / stderr before it lands in the ledger or an error message (ac-4 secret).
 * Replaces the user[:token] between `//` and `@` with `***`.
 */
export function scrubCredentials(text: string): string {
  return text.replace(/(\/\/)[^/@\s]+@/g, '$1***@');
}

// ─── production seams (NOT unit-tested with fakes; exercised via the CLI) ─────

/**
 * Production per-member driver. agent-in-the-loop boundary: there is NO headless
 * `autopilot run`, so this advances only what the autopilot CLI can — it shells
 * `ditto autopilot complete` (a SUBPROCESS, so the CLI handler's e2e /
 * intent-drift / blockingFollowUp gates run; we must NOT call
 * assembleCompletionFromGraph directly — that would bypass them and be a
 * false-green) and derives the disposition from the member's PERSISTED status.
 * The per-member cognitive work (pending agent-owned nodes) still runs through
 * autopilot's own agent loop separately; this command only automates the
 * SEQUENCING across members.
 */
export async function productionDriveMember(
  repoRoot: string,
  wiId: string,
): Promise<DriveMemberResult> {
  const proc = Bun.spawnSync(
    ['ditto', 'autopilot', 'complete', '--workItem', wiId, '--output', 'json'],
    { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' },
  );
  const item = await new WorkItemStore(repoRoot).get(wiId);
  if (item.status === 'done') return { outcome: 'done' };
  const stderr = (proc.stderr?.toString() ?? '').trim();
  const reason =
    proc.exitCode === 0
      ? `member ${wiId} did not reach done via autopilot complete (status=${item.status})`
      : scrubCredentials(stderr || `autopilot complete exited ${proc.exitCode}`);
  return { outcome: 'halted', reason };
}

/**
 * Production push of the rolled-up chain. Derives the current branch + default
 * remote (`origin`) — no user-supplied remote/branch flags (out of scope; would
 * re-open the injection surface). Pushes HEAD via gitPush (no force, `--`
 * end-of-options). Graceful-degrade: a detached HEAD or any non-zero push exit →
 * `skipped-no-remote`, never an error. The gating (chain done + push-ready) is
 * the caller's; this is the git mechanics only.
 */
export async function productionAttemptPush(
  repoRoot: string,
  members: readonly string[],
): Promise<PushOutcome> {
  void members; // single shared tree (P5): the stem commits are on the current HEAD
  const { branch } = captureGitState(repoRoot);
  if (!branch || branch === 'HEAD') return 'skipped-no-remote';
  const result = gitPush(repoRoot, 'origin', 'HEAD');
  return result.ok ? 'pushed' : 'skipped-no-remote';
}

export type { GitPushResult };
