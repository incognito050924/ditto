import { createHash } from 'node:crypto';
import { open, readdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { type IntentMetric, intentMetric } from '~/schemas/intent-metric';
import { languageLedger } from '~/schemas/language-ledger';
import { type QuestionRound, questionRound } from '~/schemas/question-round';
import {
  type FollowUp,
  type WorkItem,
  type WorkItemEvent,
  workItem,
  workItemEvent,
} from '~/schemas/work-item';
import { committedWorkItemDir, dittoDir, localDir } from './ditto-paths';
import { atomicWriteText, ensureDir, readJson, writeJson } from './fs';
import { generateId } from './id';

/**
 * Best-effort read of the current git HEAD sha for `repoRoot`.
 * Returns null if `repoRoot` is not a git work tree, git is missing,
 * or the rev-parse output is not a 40-char hex sha.
 */
function tryGitHeadSha(repoRoot: string): string | null {
  const proc = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) return null;
  const sha = (proc.stdout?.toString() ?? '').trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) return null;
  return sha;
}

export interface WorkItemCreateInput {
  title: string;
  source_request: string;
  goal: string;
  acceptance_criteria: WorkItem['acceptance_criteria'];
  owner_profile?: WorkItem['owner_profile'];
  parent_id?: WorkItem['parent_id'];
  declared_risk?: WorkItem['declared_risk'];
  discovered_by?: WorkItem['discovered_by'];
  follows?: WorkItem['follows'];
}

export interface WorkItemSummary {
  id: string;
  title: string;
  status: WorkItem['status'];
  updated_at: string;
  // WS0-T1 (wi_260706aka) backlog projection fields — all OPTIONAL and all derived
  // from the committed Record tier. A bare `list()` summary (and external builders
  // like completion-coverage-doctor's) omit them; `projectBacklog` populates them.
  /** Count of UNRESOLVED follow-ups (resolved !== true). */
  unresolved_follow_ups?: number;
  /** Reason this WI is blocked from `done`, when an unresolved self-caused high/critical bug exists. */
  blocking_reason?: string;
  /** Compact coordinate of the linked GitHub issue (repo + number), when linked. */
  github_issue?: { repo: string; number: number };
  /** Strong push-readiness signal (pushReadiness().ready over this WI + its stem). */
  push_ready?: boolean;
  /** Derived lineage/rollup marker: the stem (chain) this WI belongs to. */
  lineage?: StemView;
}

// ac-5: one member of a derived chain (stem) — the WI's id, current status, and
// the predecessor it continues from (omitted on the root). Computed at query time
// from `follows` edges; there is NO stored stem object.
export interface StemMember {
  id: string;
  status: WorkItem['status'];
  follows?: string;
}

// ac-5: rolled-up status of a chain. `open` = ≥1 member is non-terminal (not
// closeable); `done` = every member is `done`; `partial` = all terminal but ≥1 was
// `abandoned` (a partial-abandon rollup).
export type StemRollup = 'done' | 'partial' | 'open';

export interface StemView {
  members: StemMember[];
  rolled_up: StemRollup;
}

const TERMINAL_STEM_STATUSES = ['done', 'abandoned'] as const;

/** ac-5: roll a chain's member statuses up into one verdict (see StemRollup). */
export function rollUpStem(members: readonly StemMember[]): StemRollup {
  const nonTerminal = members.filter(
    (m) => !(TERMINAL_STEM_STATUSES as readonly string[]).includes(m.status),
  );
  if (nonTerminal.length > 0) return 'open';
  return members.every((m) => m.status === 'done') ? 'done' : 'partial';
}

// WS0-T1 (wi_260706aka): the lineage-relevant slice of a work item that stem
// derivation needs — id + status (for the rollup), `follows` (the chain edge), and
// created_at (to break ordering ties on a branch). Loaded ONCE per backlog snapshot
// so lineage/rollup is an O(n) single pass, not an O(n²) per-row stem() re-scan.
export interface StemInput {
  id: string;
  status: WorkItem['status'];
  follows?: string;
  created_at: string;
}

/**
 * Order one component's member ids root → tip: by follows-depth up to the component
 * root, ties broken by created_at then id (fully deterministic). Extracted from the
 * inline logic in `stem()` so the single-pass `computeStemViews` and the per-id
 * `stem()` share ONE ordering rule (no divergence).
 */
function orderStemMembers(
  members: ReadonlySet<string>,
  all: ReadonlyMap<string, StemInput>,
): string[] {
  const depthOf = (mid: string): number => {
    let d = 0;
    let cur = mid;
    const seen = new Set<string>([cur]);
    for (;;) {
      const f = all.get(cur)?.follows;
      if (f === undefined || !members.has(f) || seen.has(f)) break;
      seen.add(f);
      cur = f;
      d++;
    }
    return d;
  };
  return [...members].sort((a, b) => {
    const da = depthOf(a);
    const db = depthOf(b);
    if (da !== db) return da - db;
    const ca = all.get(a)?.created_at ?? '';
    const cb = all.get(b)?.created_at ?? '';
    if (ca !== cb) return ca < cb ? -1 : 1;
    return a < b ? -1 : 1;
  });
}

/**
 * ac-5 / WS0-T1: derive the stem (chain) of EVERY work item in one pass over an
 * already-loaded backlog snapshot. Builds the `follows` connected components once
 * (forward edge + a precomputed reverse-adjacency), orders + rolls up each component
 * ONCE, and maps every member to its shared StemView. O(n) over the loaded map — no
 * disk IO — so a caller projecting N rows reads lineage/rollup off this single result
 * instead of calling the disk-reading `stem(id)` per row (which would be O(n²) reads).
 * There is NO stored stem object; this is a pure derivation.
 */
export function computeStemViews(items: readonly StemInput[]): Map<string, StemView> {
  const all = new Map<string, StemInput>();
  for (const it of items) all.set(it.id, it);
  // Precompute reverse adjacency (predecessor id → its successors) once, so the
  // component BFS does not re-scan every node to find successors per step.
  const successors = new Map<string, string[]>();
  for (const it of items) {
    if (it.follows !== undefined && all.has(it.follows)) {
      const bucket = successors.get(it.follows) ?? [];
      bucket.push(it.id);
      successors.set(it.follows, bucket);
    }
  }
  const result = new Map<string, StemView>();
  const visited = new Set<string>();
  for (const start of all.keys()) {
    if (visited.has(start)) continue;
    // Connected component over follows edges (both directions).
    const members = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const cur = queue.pop();
      if (cur === undefined || members.has(cur)) continue;
      members.add(cur);
      visited.add(cur);
      const node = all.get(cur);
      if (node?.follows !== undefined && all.has(node.follows)) queue.push(node.follows);
      for (const s of successors.get(cur) ?? []) queue.push(s);
    }
    const ordered = orderStemMembers(members, all);
    const memberList: StemMember[] = ordered.map((mid) => {
      const node = all.get(mid);
      return {
        id: mid,
        status: node?.status ?? 'draft',
        ...(node?.follows !== undefined ? { follows: node.follows } : {}),
      };
    });
    const view: StemView = { members: memberList, rolled_up: rollUpStem(memberList) };
    for (const mid of members) result.set(mid, view);
  }
  return result;
}

// ac-4: "high-severity" threshold for the done block = severity ∈ {high, critical}.
const DONE_BLOCKING_SEVERITIES = ['high', 'critical'] as const;

/**
 * ac-4: the first follow-up that blocks `done` — an UNRESOLVED, self-caused bug of
 * high/critical severity (a self-caused high-severity regression). A follow-up that
 * is resolved, not self_caused, kind=idea, or below the severity threshold does NOT
 * block. Returns undefined when nothing blocks. Lives in core so both `work done`
 * (ac-4) and `pushReadiness` (ac-6) consume one rule, not two copies.
 */
export function blockingFollowUp(item: WorkItem): FollowUp | undefined {
  return (item.follow_ups ?? []).find(
    (f) =>
      f.kind === 'bug' &&
      f.self_caused === true &&
      f.resolved !== true &&
      f.severity !== undefined &&
      (DONE_BLOCKING_SEVERITIES as readonly string[]).includes(f.severity),
  );
}

// ac-6: outcome of the strong push-readiness check. `ready` is the AND of all four
// conditions; `reasons` lists exactly which failed (empty when ready).
export interface PushReadiness {
  ready: boolean;
  reasons: string[];
}

/**
 * ac-6 (wi_260626wnv): compute the STRONG push-readiness signal for a work item.
 * Push/deploy is the user's irreversible decision (charter §4-8) — this only
 * COMPUTES; it never proposes a push. A bare completion verdict=pass is too weak a
 * bar (one lightweight `verify` earns it), so a WI is push-ready ONLY when ALL hold:
 *   1. every acceptance criterion has verdict === 'pass';
 *   2. every acceptance criterion carries ≥1 REAL evidence entry — a command-kind
 *      evidence (not merely a note) — i.e. evidence depth beyond the bare verdict;
 *   3. no UNRESOLVED self-caused high/critical follow-up (reuses blockingFollowUp);
 *   4. if the WI participates in a stem (its derived stem has >1 member), the
 *      stem's rolled-up status is `done` — a half-finished chain is not push-ready.
 * Pure: the caller passes the derived `stem` (stem() is async); when omitted,
 * condition 4 does not apply (a lone WI).
 */
export function pushReadiness(item: WorkItem, stem?: StemView): PushReadiness {
  const reasons: string[] = [];
  // 1. every AC verdict === 'pass'
  const notPass = item.acceptance_criteria.filter((c) => c.verdict !== 'pass');
  if (notPass.length > 0) {
    reasons.push(
      `acceptance criteria not all pass: ${notPass.map((c) => `${c.id}=${c.verdict}`).join(', ')}`,
    );
  }
  // 2. every AC carries ≥1 command-kind evidence (depth stronger than bare verdict)
  const noCommandEvidence = item.acceptance_criteria.filter(
    (c) => !c.evidence.some((e) => e.kind === 'command'),
  );
  if (noCommandEvidence.length > 0) {
    reasons.push(
      `acceptance criteria lack real (command-kind) evidence: ${noCommandEvidence
        .map((c) => c.id)
        .join(', ')}`,
    );
  }
  // 3. no unresolved self-caused high/critical follow-up (ac-4 rule reused)
  const blocking = blockingFollowUp(item);
  if (blocking) {
    reasons.push(
      `unresolved self-caused ${blocking.severity}-severity follow-up: "${blocking.note}"`,
    );
  }
  // 4. a multi-member stem chain must be fully rolled up to done
  if (stem !== undefined && stem.members.length > 1 && stem.rolled_up !== 'done') {
    reasons.push(`stem chain not fully done (rolled_up=${stem.rolled_up})`);
  }
  return { ready: reasons.length === 0, reasons };
}

// wi_2607069bk §2.1: terminal statuses. `done`/`abandoned` are the only exclusive
// (first-terminal-wins) transitions; everything else is a plain "latest wins".
const TERMINAL_STATUSES: ReadonlySet<WorkItem['status']> = new Set(['done', 'abandoned']);
function isTerminalStatus(s: WorkItem['status']): boolean {
  return TERMINAL_STATUSES.has(s);
}

/**
 * Deterministic event ordering by (seq, actor, event_id) — NEVER by `ts`. `ts` is
 * informational and clock-skew-unsafe (§2.1); event_id is the final tiebreak so two
 * concurrent writers that raced onto the same (seq, actor) still order stably.
 */
function compareWorkItemEvents(a: WorkItemEvent, b: WorkItemEvent): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  if (a.actor !== b.actor) return a.actor < b.actor ? -1 : 1;
  if (a.event_id !== b.event_id) return a.event_id < b.event_id ? -1 : 1;
  return 0;
}

/** Canonical (key-sorted) JSON so the content hash is order-independent. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * §2.1 event_id — content hash over {kind, actor, seq, payload-core}. `seq` is
 * INCLUDED so a genuinely repeated transition (e.g. in_progress → done → in_progress
 * via reopen) is NOT collapsed with an earlier identical-content event. `ts` is
 * excluded (non-deterministic wall clock). Store-path idempotency (re-run / re-mirror)
 * is provided by the DIFF-gated emission in `emitTransitionEvents` — an update that
 * changes nothing emits no event — so the id need not be stable across re-runs.
 */
function computeEventId(
  kind: WorkItemEvent['kind'],
  actor: string,
  seq: number,
  payload: unknown,
): string {
  return createHash('sha256').update(stableStringify({ kind, actor, seq, payload })).digest('hex');
}

/** github idempotency fold (§1.1 / C5): set-union of posted markers; claim_release removes. */
function foldGithubIssue(record: WorkItem, ordered: WorkItemEvent[]): WorkItem['github_issue'] {
  // n2 boundary: repo/number are AUTHORED coordinates on record.json — without them a
  // github event cannot be materialized, so absent-coordinate WIs ignore github events.
  if (record.github_issue === undefined) return undefined;
  const hasGithubEvents = ordered.some(
    (e) => e.kind === 'github_post' || e.kind === 'claim' || e.kind === 'claim_release',
  );
  if (!hasGithubEvents) return record.github_issue;
  const decisionIds = new Set(record.github_issue.posted_decision_ids ?? []);
  const claimMarkers = new Set(record.github_issue.posted_claim_markers ?? []);
  let claimedBranch = record.github_issue.claimed_branch;
  for (const e of ordered) {
    if (e.kind === 'github_post') {
      if (e.payload.posted_decision_id) decisionIds.add(e.payload.posted_decision_id);
      if (e.payload.posted_claim_marker) claimMarkers.add(e.payload.posted_claim_marker);
      if (e.payload.claimed_branch) claimedBranch = e.payload.claimed_branch;
    } else if (e.kind === 'claim') {
      if (e.payload.posted_claim_marker) claimMarkers.add(e.payload.posted_claim_marker);
      if (e.payload.claimed_branch) claimedBranch = e.payload.claimed_branch;
    } else if (e.kind === 'claim_release') {
      if (e.payload.posted_claim_marker) claimMarkers.delete(e.payload.posted_claim_marker);
      if (e.payload.claimed_branch && claimedBranch === e.payload.claimed_branch) {
        claimedBranch = undefined;
      }
    }
  }
  // Rebuild from the immutable coordinates + the folded idempotency sets (empty sets
  // are simply omitted — no key-delete needed).
  const {
    posted_decision_ids: _pd,
    posted_claim_markers: _pc,
    claimed_branch: _cb,
    ...coords
  } = record.github_issue;
  return {
    ...coords,
    ...(decisionIds.size > 0 ? { posted_decision_ids: [...decisionIds] } : {}),
    ...(claimMarkers.size > 0 ? { posted_claim_markers: [...claimMarkers] } : {}),
    ...(claimedBranch !== undefined ? { claimed_branch: claimedBranch } : {}),
  };
}

/**
 * §4-C5 WRITE side: the github idempotency sets (`posted_decision_ids`/
 * `posted_claim_markers`/`claimed_branch`) live in COMMITTED github events, not on
 * record.json. So when re-writing record.json we must NOT bake the event-FOLDED view
 * back onto the authored Record — that would re-couple idempotency to the Record and
 * lose it whenever the events are dropped. We take the coords from the (possibly
 * mutated) `next` github_issue but keep the idempotency fields at whatever the RAW
 * Record base already held (legacy/migrated records keep theirs — foldGithubIssue
 * reads them as a base; a fresh Record has none). New idempotency only ever arrives
 * as events.
 */
function recordGithubIssueForWrite(next: WorkItem, rawRecord: WorkItem | null): WorkItem {
  if (next.github_issue === undefined) return next;
  const {
    posted_decision_ids: _pd,
    posted_claim_markers: _pc,
    claimed_branch: _cb,
    ...coords
  } = next.github_issue;
  const base = rawRecord?.github_issue;
  return {
    ...next,
    github_issue: {
      ...coords,
      ...(base?.posted_decision_ids ? { posted_decision_ids: base.posted_decision_ids } : {}),
      ...(base?.posted_claim_markers ? { posted_claim_markers: base.posted_claim_markers } : {}),
      ...(base?.claimed_branch ? { claimed_branch: base.claimed_branch } : {}),
    },
  };
}

/**
 * wi_2607069bk §2.1 — the fold. Overlay the immutable per-event log onto the authored
 * `record`, producing a schema-valid WorkItem. Events are ordered by (seq, actor),
 * deduped by event_id, then folded per kind:
 *  - status: latest (seq,actor) wins, EXCEPT terminal (done/abandoned) is
 *    first-terminal-wins (a competing 2nd terminal is rejected — R1 exclusivity).
 *    `closed_at` derives from the winning status event; a later NON-terminal status
 *    with closed_at=null CLEARS it (reopen — key-deletion via an event, not a merge).
 *  - verdict: per criterion_id, latest (seq,actor) wins (a late fail beats an early
 *    pass — no regression masking); merged onto the matching record AC.
 *  - github_post/claim/claim_release: set-union of posted markers; release removes.
 * Pure: no IO. Callers surface corrupt event files BEFORE reaching here (readEvents).
 */
export function reduceWorkItem(record: WorkItem, events: WorkItemEvent[]): WorkItem {
  const byId = new Map<string, WorkItemEvent>();
  for (const e of events) if (!byId.has(e.event_id)) byId.set(e.event_id, e);
  const ordered = [...byId.values()].sort(compareWorkItemEvents);

  // status + closed_at
  let status: WorkItem['status'] = record.status;
  let closedAt: string | undefined = record.closed_at;
  let sawStatusEvent = false;
  let latestTs = record.updated_at;
  for (const e of ordered) {
    if (e.ts > latestTs) latestTs = e.ts;
    if (e.kind !== 'status') continue;
    // R1: once terminal, a competing terminal is rejected (first-terminal-wins). A
    // NON-terminal `to` (reopen) is still applied — that is the legitimate exit.
    if (isTerminalStatus(status) && isTerminalStatus(e.payload.to)) continue;
    sawStatusEvent = true;
    status = e.payload.to;
    closedAt = e.payload.closed_at ?? undefined; // null/absent → cleared
  }

  // verdicts (latest per criterion_id)
  const verdicts = new Map<
    string,
    Pick<WorkItem['acceptance_criteria'][number], 'verdict' | 'evidence'>
  >();
  for (const e of ordered) {
    if (e.kind !== 'verdict') continue;
    verdicts.set(e.payload.criterion_id, {
      verdict: e.payload.verdict,
      evidence: e.payload.evidence,
    });
  }
  const acceptance_criteria = record.acceptance_criteria.map((ac) => {
    const v = verdicts.get(ac.id);
    return v ? { ...ac, verdict: v.verdict, evidence: v.evidence } : ac;
  });

  const githubIssue = foldGithubIssue(record, ordered);

  // closed_at is fully event-derived once ANY status event exists (terminal → its
  // closed_at; non-terminal/reopen → cleared); with no status events the record's own
  // value is kept (pure-fold robustness). Rebuild without closed_at/github_issue so
  // they are added back only when present (no key-delete).
  const { closed_at: _rc, github_issue: _rg, ...restRecord } = record;
  const effectiveClosedAt = sawStatusEvent
    ? isTerminalStatus(status)
      ? closedAt
      : undefined
    : record.closed_at;
  const assembled: Record<string, unknown> = {
    ...restRecord,
    status,
    acceptance_criteria,
    updated_at: latestTs,
    ...(effectiveClosedAt !== undefined ? { closed_at: effectiveClosedAt } : {}),
    ...(githubIssue !== undefined ? { github_issue: githubIssue } : {}),
  };

  return workItem.parse(assembled);
}

/**
 * R6 (§10.1): a work-item event file failed to parse. Work-item events are
 * STATE-BEARING — a silently-dropped terminal event would revive a stale status
 * (regression). Unlike memory-store's bare `catch {}` skip, reduction of a work item
 * REFUSES to proceed and surfaces the corrupt paths so reconcile/doctor can report.
 */
export class WorkItemEventCorruptError extends Error {
  constructor(
    public readonly workItemId: string,
    public readonly corruptPaths: string[],
  ) {
    super(
      `work item ${workItemId} has ${corruptPaths.length} unparseable event file(s): ${corruptPaths.join(', ')}. Work-item events are state-bearing; refusing to reduce with a dropped event (would revive a stale status). Inspect via reconcile.`,
    );
    this.name = 'WorkItemEventCorruptError';
  }
}

/**
 * §2.2 / R6 (§10.1): the surface-don't-mutate view of a work item's committed event
 * log. `head_status`/`head_closed_at` are RE-DERIVED from the parseable events (the
 * fold over `events/`); `unparseable_events` ENUMERATES the corrupt event files by
 * path so `ditto work reconcile` / doctor can report them. reconcile never repairs
 * or GCs (that is out of scope, §0) — it only counts and surfaces.
 */
export interface WorkItemReconcileReport {
  id: string;
  /** Re-derived head status from parseable events, or null when no Record/legacy WI exists. */
  head_status: WorkItem['status'] | null;
  head_closed_at?: string;
  /** Count of parseable event files under `events/`. */
  event_count: number;
  /** Absolute paths of event files that failed to parse (R6 surface, sorted). */
  unparseable_events: string[];
}

export class WorkItemStore {
  constructor(public readonly repoRoot: string) {}

  private workItemDir(id: string): string {
    return localDir(this.repoRoot, 'work-items', id);
  }

  private workItemPath(id: string): string {
    return join(this.workItemDir(id), 'work-item.json');
  }

  private languageLedgerPath(id: string): string {
    return join(this.workItemDir(id), 'language-ledger.json');
  }

  // §1.1 committed Record base: record.json (authored WorkItem) + events/ (immutable log).
  private recordPath(id: string): string {
    return join(committedWorkItemDir(this.repoRoot, id), 'record.json');
  }

  private eventsDir(id: string): string {
    return join(committedWorkItemDir(this.repoRoot, id), 'events');
  }

  /** record.json (authored fields) or null when this WI has no committed Record yet. */
  private async readRecord(id: string): Promise<WorkItem | null> {
    if (!(await Bun.file(this.recordPath(id)).exists())) return null;
    return readJson(this.recordPath(id), workItem);
  }

  /**
   * Read the immutable event log. R6 (§10.1): a file that fails to parse is NOT
   * silently dropped — corrupt paths are collected and surfaced (throw), because a
   * dropped terminal event would revive a stale status.
   */
  private async readEvents(id: string): Promise<WorkItemEvent[]> {
    let names: string[];
    try {
      names = await readdir(this.eventsDir(id));
    } catch {
      return [];
    }
    const events: WorkItemEvent[] = [];
    const corrupt: string[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.eventsDir(id), name);
      try {
        events.push(await readJson(path, workItemEvent));
      } catch {
        corrupt.push(path);
      }
    }
    if (corrupt.length > 0) throw new WorkItemEventCorruptError(id, corrupt.sort());
    return events;
  }

  /**
   * Append one immutable event. seq is the WI-global max+1 (a natural causal order for
   * the common single-writer case; (seq,actor) still orders concurrent writers).
   * `open(wx)` gives exclusive creation (immutable, no TOCTOU). Idempotency is NOT done
   * here — the DIFF in `emitTransitionEvents`/create already gates emission, so a
   * re-run/retry (whose event is already reflected in get()) produces no diff and no
   * duplicate append.
   */
  private async appendEvent(
    id: string,
    actor: string,
    kind: WorkItemEvent['kind'],
    payload: WorkItemEvent['payload'],
  ): Promise<void> {
    const events = await this.readEvents(id);
    const seq = events.reduce((max, e) => Math.max(max, e.seq), -1) + 1;
    const eventId = computeEventId(kind, actor, seq, payload);
    const validated = workItemEvent.parse({
      schema_version: '0.1.0',
      work_item_id: id,
      seq,
      actor,
      event_id: eventId,
      ts: new Date().toISOString(),
      kind,
      payload,
    });
    await ensureDir(this.eventsDir(id));
    const safeActor = actor.replace(/[^A-Za-z0-9._-]/g, '_');
    const fileName = `${String(seq).padStart(6, '0')}.${safeActor}.${eventId.slice(0, 12)}.json`;
    const path = join(this.eventsDir(id), fileName);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(path, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return; // belt: already present
      throw err;
    }
    try {
      await handle.writeFile(`${JSON.stringify(validated, null, 2)}\n`, 'utf8');
    } finally {
      await handle.close();
    }
  }

  /**
   * Emit the transition events for a `prev → next` mutation (diff-based, §5). Status
   * and AC-verdict changes become events; AUTHORED-field changes (title/goal/AC
   * membership/lineage/…) ride on record.json (rewritten by the caller). github
   * idempotency stays record-authored in n2 (n6 rewires those consumers to emit
   * github events, which reduceWorkItem then folds).
   */
  private async emitTransitionEvents(id: string, prev: WorkItem, next: WorkItem): Promise<void> {
    const actor = next.owner_profile;
    const statusChanged =
      prev.status !== next.status || (prev.closed_at ?? null) !== (next.closed_at ?? null);
    if (statusChanged) {
      await this.appendEvent(id, actor, 'status', {
        to: next.status,
        closed_at: next.closed_at ?? null,
      });
    }
    const prevAc = new Map(prev.acceptance_criteria.map((c) => [c.id, c]));
    for (const ac of next.acceptance_criteria) {
      const before = prevAc.get(ac.id);
      if (before === undefined) continue; // a new AC is authored (record.json), not a verdict
      const changed =
        before.verdict !== ac.verdict ||
        JSON.stringify(before.evidence) !== JSON.stringify(ac.evidence);
      if (changed) {
        await this.appendEvent(id, actor, 'verdict', {
          criterion_id: ac.id,
          verdict: ac.verdict,
          evidence: ac.evidence,
        });
      }
    }
  }

  /**
   * Legacy compatibility bridge: exists()/list()/archive() and ~consumers still read
   * `.ditto/local/work-items/<id>/work-item.json`. Keep the reduced view mirrored
   * there (personal tier, gitignored — no committed leak) until n3 repoints those
   * readers at the committed Record. Not the source of truth; get() reduces the
   * Record + events.
   */
  private async writeMirror(id: string, item: WorkItem): Promise<void> {
    await writeJson(this.workItemPath(id), workItem, item);
  }

  // §3.3 D2: committed archive namespace for a Record moved out of the active set.
  // A SIBLING of the active committed base (`.ditto/work-items/`), so the moved
  // Record stays git-tracked (restorable, move-not-delete) yet dual-base list()
  // no longer resurfaces it.
  private committedArchiveDir(label: string, id: string): string {
    return join(dittoDir(this.repoRoot), 'work-items-archive', label, id);
  }

  async exists(id: string): Promise<boolean> {
    // §6 dual base: a committed Record OR a legacy personal work-item.json counts.
    if (await Bun.file(this.recordPath(id)).exists()) return true;
    try {
      await stat(this.workItemPath(id));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * §6 forced lazy-migrate (Finding B-F2, "TBD" forbidden): the first committed write
   * of a LEGACY work item (one with only `.ditto/local/.../work-item.json`, no
   * committed record.json) FIRST synthesizes a COMPLETE record.json from the legacy
   * file — title, goal, ALL acceptance criteria, lineage, everything — plus a
   * `created` status event capturing the legacy status, so the fold reproduces the
   * pre-migration state. Writing the full record BEFORE any patch event guarantees
   * every subsequent event folds onto a complete Record; a status-only event can
   * never make `workItem.parse` throw on a missing required field. No-op when a
   * committed Record already exists or when the id is brand-new (create() owns that).
   */
  private async ensureMigrated(id: string): Promise<void> {
    if (await Bun.file(this.recordPath(id)).exists()) return;
    if (!(await Bun.file(this.workItemPath(id)).exists())) return;
    const legacy = await readJson(this.workItemPath(id), workItem);
    await writeJson(this.recordPath(id), workItem, legacy);
    await this.appendEvent(id, legacy.owner_profile, 'status', {
      to: legacy.status,
      closed_at: legacy.closed_at ?? null,
    });
  }

  async create(input: WorkItemCreateInput, now: Date = new Date()): Promise<WorkItem> {
    const id = await generateId('wi', (candidate) => this.exists(candidate));
    const nowIso = now.toISOString();
    const draft = {
      schema_version: '0.1.0' as const,
      id,
      title: input.title,
      source_request: input.source_request,
      goal: input.goal,
      acceptance_criteria: input.acceptance_criteria,
      status: 'draft' as const,
      owner_profile: input.owner_profile ?? ('workspace-write' as const),
      ...(input.parent_id !== undefined ? { parent_id: input.parent_id } : {}),
      ...(input.declared_risk !== undefined ? { declared_risk: input.declared_risk } : {}),
      ...(input.discovered_by !== undefined ? { discovered_by: input.discovered_by } : {}),
      ...(input.follows !== undefined ? { follows: input.follows } : {}),
      child_ids: [],
      changed_files: [],
      risks: [],
      runs: [],
      created_at: nowIso,
      updated_at: nowIso,
    };
    // §3.2 A2: NO eager ensureDir(evidence/). A lightweight Record is record.json +
    // a `created` status event; evidence/ is created lazily by the Run tier on append.
    const record = await writeJson(this.recordPath(id), workItem, draft);
    await this.appendEvent(id, record.owner_profile, 'status', { to: 'draft' });
    await writeJson(this.languageLedgerPath(id), languageLedger, {
      schema_version: '0.1.0',
      work_item_id: id,
      created_at: nowIso,
      updated_at: nowIso,
      changes: [],
    });
    const reduced = await this.get(id);
    await this.writeMirror(id, reduced);
    return reduced;
  }

  async get(id: string): Promise<WorkItem> {
    const record = await this.readRecord(id);
    if (record === null) {
      // Legacy fallback for a pre-split WI (record.json absent) — full dual-base
      // migration is n3; this keeps pre-split `.ditto/local/.../work-item.json` reads
      // working during the migration window.
      return readJson(this.workItemPath(id), workItem);
    }
    return reduceWorkItem(record, await this.readEvents(id));
  }

  /**
   * Read, transform, validate, and atomically replace a work item.
   * The mutator must not produce a different `id`; that would be a different
   * work item entirely.
   */
  async update(id: string, mutator: (current: WorkItem) => WorkItem): Promise<WorkItem> {
    // §6: migrate a legacy WI to a complete committed Record BEFORE the first patch,
    // so every emitted event folds onto a full Record (no partial-field corruption).
    await this.ensureMigrated(id);
    const current = await this.get(id);
    // §4-C5: the RAW Record base (pre-fold) — its github idempotency is what record.json
    // keeps on write; the event-folded additions in `current` are NOT baked back.
    const rawRecord = await this.readRecord(id);
    const next = mutator(current);
    if (next.id !== current.id) {
      throw new Error(`update mutator changed work item id from ${current.id} to ${next.id}`);
    }
    // started_at_sha backfill:
    //   work item이 in_progress이면서 started_at_sha가 아직 비어 있을 때만
    //   git HEAD sha를 한 번 박는다. 첫 draft→in_progress 전환과 legacy
    //   (이미 in_progress인데 sha 누락) 두 경우 모두 catch. 이미 박혀 있으면
    //   덮어쓰지 않음(idempotent). done/blocked/partial 등으로 가는 update는
    //   backfill 대상이 아님 — 마감 자산에 잘못된 현재 sha를 채워 넣는 것을
    //   막기 위해. git 실패 시 omit.
    let withSha: WorkItem = next;
    if (next.status === 'in_progress' && next.started_at_sha === undefined) {
      const sha = tryGitHeadSha(this.repoRoot);
      if (sha !== null) {
        withSha = { ...next, started_at_sha: sha };
      }
    }
    const withTouched = { ...withSha, updated_at: new Date().toISOString() };
    // Validate BEFORE any write so a schema-breaking mutation throws with disk
    // untouched (e.g. status=blocked without re_entry).
    const validated = workItem.parse(withTouched);
    // Promote status/verdict transitions to immutable events; authored fields (and the
    // started_at_sha backfill) ride on record.json. reduce re-derives status/verdict/
    // github from events on top of the record, so the two never disagree.
    await this.emitTransitionEvents(id, current, validated);
    // §4-C5: persist only coords + the raw github idempotency base — never the
    // event-folded sets (those are re-derived by foldGithubIssue from committed events).
    await writeJson(this.recordPath(id), workItem, recordGithubIssueForWrite(validated, rawRecord));
    const reduced = await this.get(id);
    await this.writeMirror(id, reduced);
    return reduced;
  }

  /**
   * §4-C5 github idempotency WRITE side. The posted-decision / claim-marker /
   * claimed-branch idempotency state is appended as COMMITTED events (`github_post` /
   * `claim` / `claim_release`) that `foldGithubIssue` unions onto the immutable
   * coordinates — so the state survives a Run-tier delete (the whole point of the
   * split) and never rides on the authored record.json. Consumers READ the folded
   * view via `get()`; these are the only WRITE paths. Re-appending an already-folded
   * marker is naturally idempotent (fold uses a Set), so a re-post never duplicates.
   * The mirror is refreshed so legacy `work-item.json` readers see the new fold.
   */
  private async appendGithubEvent(
    id: string,
    kind: 'github_post' | 'claim' | 'claim_release',
    payload: { posted_decision_id?: string; posted_claim_marker?: string; claimed_branch?: string },
  ): Promise<void> {
    const actor = (await this.get(id)).owner_profile;
    await this.appendEvent(id, actor, kind, payload);
    await this.writeMirror(id, await this.get(id));
  }

  /** Append a `github_post` idempotency event (a decision/claim marker posted to the issue). */
  async recordGithubPost(
    id: string,
    payload: { posted_decision_id?: string; posted_claim_marker?: string; claimed_branch?: string },
  ): Promise<void> {
    await this.appendGithubEvent(id, 'github_post', payload);
  }

  /** Append a `claim` event (branch claimed the issue; marker + branch fold in). */
  async recordClaim(
    id: string,
    payload: { posted_claim_marker?: string; claimed_branch?: string },
  ): Promise<void> {
    await this.appendGithubEvent(id, 'claim', payload);
  }

  /** Append a `claim_release` event (un-claim): removes the folded marker and clears the branch. */
  async releaseClaim(
    id: string,
    payload: { posted_claim_marker?: string; claimed_branch?: string },
  ): Promise<void> {
    await this.appendGithubEvent(id, 'claim_release', payload);
  }

  /**
   * Move a work item to a terminal status (`done` / `abandoned`) and stamp
   * `closed_at`. Manual counterpart to the autopilot/handoff completion paths —
   * lets a user close a draft (`abandon`) or sync a verified item to `done`.
   * The `done` evidence gate (completion `final_verdict=pass`) is enforced by
   * the caller (CLI), not here; this is the pure state transition.
   */
  async close(
    id: string,
    terminal: Extract<WorkItem['status'], 'done' | 'abandoned'>,
    now: Date = new Date(),
  ): Promise<WorkItem> {
    return this.update(id, (cur) => {
      // R1 terminal guard: this is the single chokepoint every terminal transition
      // passes through — manual `work done`/`abandon` AND the autopilot pass→done
      // flip. An already-terminal WI must not be silently overwritten (e.g. an
      // `abandoned` item flipped to `done`). The mutator runs synchronously before
      // any write, so this throw leaves the on-disk state untouched. The only
      // legitimate way past this is reopen()→close().
      if (cur.status === 'done' || cur.status === 'abandoned') {
        throw new Error(
          `work ${id} is already ${cur.status} (terminal); reopen first (ditto work reopen ${id}) before re-closing`,
        );
      }
      return {
        ...cur,
        status: terminal,
        closed_at: now.toISOString(),
      };
    });
  }

  /**
   * Reopen a terminal work item (`done`/`abandoned`) back to `in_progress`,
   * dropping `closed_at`. The inverse of `close`: since `close` now refuses to
   * overwrite a terminal item, reopen→close is the ONLY sanctioned way to move a
   * closed WI to a different terminal state — so the transition is explicit, never
   * silent. Throws on a non-terminal WI (nothing to reopen). The `started_at_sha`
   * backfill is handled by `update` (it stamps only when in_progress && undefined).
   */
  async reopen(id: string): Promise<WorkItem> {
    return this.update(id, (cur) => {
      if (cur.status !== 'done' && cur.status !== 'abandoned') {
        throw new Error(
          `work ${id} is ${cur.status} (not terminal); reopen only applies to a done/abandoned WI`,
        );
      }
      const { closed_at: _dropped, ...rest } = cur;
      return { ...rest, status: 'in_progress' as const };
    });
  }

  /**
   * Park a work item in a resumable, non-terminal status (`partial`/`blocked`)
   * with the `re_entry` instructions the schema requires for those statuses.
   * Distinct from `close` (terminal done/abandoned): a parked item keeps no
   * `closed_at` — it stays open for resume. The CLI enforces that re_entry carries
   * a command or evidence need before calling this; the schema superRefine is the
   * backstop (it rejects partial/blocked without re_entry).
   */
  async park(
    id: string,
    status: Extract<WorkItem['status'], 'partial' | 'blocked'>,
    reEntry: WorkItem['re_entry'],
  ): Promise<WorkItem> {
    return this.update(id, (cur) => ({
      ...cur,
      status,
      re_entry: reEntry,
    }));
  }

  /**
   * ac-5: walk the `follows` chain UPWARD from `id` (exclusive of `id`), returning
   * predecessor ids in order [parent, grandparent, …root]. A missing predecessor
   * stops the walk; a pre-existing cycle is broken by the visited set. Used to
   * reject a `--follows` edge that would close a cycle.
   */
  async chainAncestors(id: string): Promise<string[]> {
    const out: string[] = [];
    const seen = new Set<string>([id]);
    let cur = await this.get(id);
    while (cur.follows !== undefined) {
      const next = cur.follows;
      if (seen.has(next)) break;
      seen.add(next);
      out.push(next);
      if (!(await this.exists(next))) break;
      cur = await this.get(next);
    }
    return out;
  }

  /**
   * ac-5: derive the chain (stem) that contains `id` — the connected component of
   * the `follows` graph, walked transitively in BOTH directions (up to predecessors,
   * down to successors). Members are returned in lineage order (root → tip): sorted
   * by chain depth, ties broken by `created_at` then id for determinism. There is NO
   * stored stem object; this is computed each call.
   */
  async stem(id: string): Promise<StemView> {
    await this.get(id); // clear error if `id` is unknown
    // Load every WI's lineage-relevant fields once (follows for edges, status for
    // the rollup, created_at to break ordering ties on a branch), then derive all
    // stems in ONE pass. The single-WI view is read off the shared result.
    const items: StemInput[] = [];
    let sawId = false;
    for (const s of await this.list()) {
      const item = await this.get(s.id);
      if (item.id === id) sawId = true;
      items.push({
        id: item.id,
        status: item.status,
        created_at: item.created_at,
        ...(item.follows !== undefined ? { follows: item.follows } : {}),
      });
    }
    // Belt: an item resolvable via get() but not surfaced by list() (races/edge
    // cases) is still projected as at least a one-member stem.
    if (!sawId) {
      const item = await this.get(id);
      items.push({
        id: item.id,
        status: item.status,
        created_at: item.created_at,
        ...(item.follows !== undefined ? { follows: item.follows } : {}),
      });
    }
    const views = computeStemViews(items);
    return views.get(id) ?? { members: [{ id, status: 'draft' }], rolled_up: 'open' };
  }

  /**
   * WS0-T1 (wi_260706aka): enumerate + reduce ONLY the committed Record tier
   * (`.ditto/work-items/<id>/` — record.json folded with events/). It deliberately
   * NEVER reads the Run/legacy base (`.ditto/local/...`, gitignored) — deriving the
   * backlog projection strictly from the committed Record is what makes its output
   * deterministic across a Run-tier wipe (ac-5). A malformed record / corrupt-event
   * WI is skipped (an explicit get() still surfaces its error elsewhere).
   */
  async listCommittedRecords(): Promise<WorkItem[]> {
    const base = join(dittoDir(this.repoRoot), 'work-items');
    let entries: string[];
    try {
      entries = await readdir(base);
    } catch {
      return [];
    }
    const items: WorkItem[] = [];
    for (const name of entries) {
      try {
        if (!(await stat(join(base, name))).isDirectory()) continue;
        const record = await this.readRecord(name);
        if (record === null) continue;
        items.push(reduceWorkItem(record, await this.readEvents(name)));
      } catch {
        // skip malformed record / corrupt-event WI (surfaced via an explicit get()).
      }
    }
    return items;
  }

  /**
   * Archive terminal (`done`/`abandoned`) work items out of the active set
   * (ADR-0005 D3 / §3.3 D2). Move-not-delete (restorable), no git history rewrite —
   * the goal is to lighten the agent's active working set, not shrink `.git`.
   * Targets are found via the DUAL base (committed Record + legacy personal), so a
   * legacy-only or committed-only terminal WI is archived too.
   *
   * DECOMPOSE (D2): the Run/personal dir moves to `.ditto/local/archive/<label>/<id>`
   * (unchanged), and the committed Record moves to the SIBLING committed archive
   * namespace `.ditto/work-items-archive/<label>/<id>` — still git-tracked and
   * restorable, so the Record survives, yet dual-base list() stops resurfacing it.
   *
   * DEVIATION (surfaced, charter §4-11): the design §3.3 sketch "append a
   * status(→archived) event, move ONLY the Run" is NOT implementable against the
   * landed schema — 'archived' is not a `workItemStatus` (common.ts:55) and the
   * first-terminal-wins reducer rejects a 2nd terminal status (it would also erase
   * the done/abandoned distinction). So the committed Record is RELOCATED (still
   * git-tracked) instead, which honors the existing archive contract "archived items
   * leave the active list" and Record durability. Adding an 'archived' status +
   * list-filter is a cross-cutting schema change outside n3's surgical scope.
   *
   * Returns the ids moved. `label` must be a safe path segment.
   */
  async archive(label: string): Promise<string[]> {
    if (!/^[A-Za-z0-9._-]+$/.test(label) || label === '.' || label === '..') {
      throw new Error(
        `archive label must be a safe path segment ([A-Za-z0-9._-]+, not '.' or '..'; got: ${label})`,
      );
    }
    const targets = (await this.list()).filter(
      (s) => s.status === 'done' || s.status === 'abandoned',
    );
    if (targets.length === 0) return [];
    const runArchiveBase = localDir(this.repoRoot, 'archive', label);
    await ensureDir(runArchiveBase);
    for (const t of targets) {
      // Committed Record → committed archive (git-tracked move, restorable).
      if (await Bun.file(this.recordPath(t.id)).exists()) {
        const dest = this.committedArchiveDir(label, t.id);
        await ensureDir(dirname(dest));
        await rename(committedWorkItemDir(this.repoRoot, t.id), dest);
      }
      // Run/personal tier → personal archive (unchanged, ADR-0005). Absent for a
      // committed-only WI.
      try {
        await rename(this.workItemDir(t.id), join(runArchiveBase, t.id));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    return targets.map((t) => t.id);
  }

  /**
   * §6 dual base: the ids of every active work item — the union of the committed
   * Record base (`.ditto/work-items/`) AND the legacy personal base
   * (`.ditto/local/work-items/`), deduped. Both cohorts stay visible during the
   * migration window (WS0-T4 migrates the legacy tier). The single enumeration path
   * shared by `list()` and `listAll()` so neither reinvents the dual-base scan.
   */
  private async collectWorkItemIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const base of [
      join(dittoDir(this.repoRoot), 'work-items'),
      localDir(this.repoRoot, 'work-items'),
    ]) {
      let entries: string[];
      try {
        entries = await readdir(base);
      } catch {
        continue;
      }
      for (const name of entries) {
        try {
          if ((await stat(join(base, name))).isDirectory()) ids.add(name);
        } catch {
          // skip a vanished/unreadable entry
        }
      }
    }
    return ids;
  }

  /**
   * WS0-T1 (wi_260706aka): the FULL reduced WorkItem for every active id, dual-base
   * (committed Record ⋃ legacy personal). Unlike `listCommittedRecords()` (committed
   * tier only), this keeps the ~67 not-yet-migrated legacy items visible — so the
   * backlog projection (`ditto work list`) is not truncated to the committed few. A
   * malformed / corrupt-event WI is skipped (an explicit get() still surfaces it).
   * The lineage/rollup pass over this set stays O(n): the caller builds stems ONCE.
   */
  async listAll(): Promise<WorkItem[]> {
    const items: WorkItem[] = [];
    for (const id of await this.collectWorkItemIds()) {
      try {
        items.push(await this.get(id));
      } catch {
        // skip malformed / corrupt-event work items; an explicit get() surfaces it.
      }
    }
    return items;
  }

  async list(): Promise<WorkItemSummary[]> {
    // §6 dual base: enumerate the committed Record base AND the legacy personal base,
    // dedup by id (committed Record wins via get()'s record.json-first fallback).
    // Both cohorts stay visible during the migration window.
    const ids = await this.collectWorkItemIds();
    const summaries: WorkItemSummary[] = [];
    for (const id of ids) {
      try {
        const item = await this.get(id);
        summaries.push({
          id: item.id,
          title: item.title,
          status: item.status,
          updated_at: item.updated_at,
        });
      } catch {
        // skip malformed / corrupt-event work items in list; an explicit get()
        // surfaces the schema / WorkItemEventCorruptError with a clear message.
      }
    }
    summaries.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    return summaries;
  }

  /**
   * §2.2 / R6: re-derive a work item's head from its committed events AND enumerate +
   * count the unparseable event files, SURFACING them (surface-don't-mutate — no
   * repair/GC, §0). Unlike get()/reduceWorkItem (which THROW on a corrupt event so a
   * stale status can never be served), reconcile never throws: it re-derives the head
   * from the PARSEABLE subset and reports the corrupt paths so `ditto work reconcile`
   * / doctor can show what needs attention. Backs the reconcile/doctor surface.
   */
  async reconcile(id: string): Promise<WorkItemReconcileReport> {
    const dir = this.eventsDir(id);
    const parseable: WorkItemEvent[] = [];
    const unparseable: string[] = [];
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      names = [];
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const path = join(dir, name);
      try {
        parseable.push(await readJson(path, workItemEvent));
      } catch {
        unparseable.push(path);
      }
    }
    const record = await this.readRecord(id);
    let headStatus: WorkItem['status'] | null = null;
    let headClosedAt: string | undefined;
    if (record !== null) {
      const reduced = reduceWorkItem(record, parseable);
      headStatus = reduced.status;
      headClosedAt = reduced.closed_at;
    } else if (await Bun.file(this.workItemPath(id)).exists()) {
      const legacy = await readJson(this.workItemPath(id), workItem);
      headStatus = legacy.status;
      headClosedAt = legacy.closed_at;
    }
    return {
      id,
      head_status: headStatus,
      ...(headClosedAt !== undefined ? { head_closed_at: headClosedAt } : {}),
      event_count: parseable.length,
      unparseable_events: unparseable.sort(),
    };
  }

  /** Newline-safe append of one JSONL line at an absolute path (creates the dir). */
  private async appendJsonlAtPath(path: string, jsonLine: string): Promise<void> {
    await ensureDir(dirname(path));
    const file = Bun.file(path);
    const existing = (await file.exists()) ? await file.text() : '';
    const trimmedExisting =
      existing.endsWith('\n') || existing.length === 0 ? existing : `${existing}\n`;
    await atomicWriteText(path, `${trimmedExisting}${jsonLine}\n`);
  }

  private async appendEvidenceJsonl(
    workItemId: string,
    filename: string,
    jsonLine: string,
  ): Promise<void> {
    return this.appendJsonlAtPath(
      join(this.workItemDir(workItemId), 'evidence', filename),
      jsonLine,
    );
  }

  async appendCommandLogLine(workItemId: string, jsonLine: string): Promise<void> {
    return this.appendEvidenceJsonl(workItemId, 'commands.jsonl', jsonLine);
  }

  // V6: file-mutation tool use (Edit/Write/MultiEdit) recorded alongside commands
  // so the evidence trail is not command-only.
  async appendEditLogLine(workItemId: string, jsonLine: string): Promise<void> {
    return this.appendEvidenceJsonl(workItemId, 'edits.jsonl', jsonLine);
  }

  private metricsPath(workItemId: string): string {
    // Root level (sibling of autopilot-decisions.jsonl), not under evidence/:
    // metrics.jsonl is measurement instrumentation, not per-AC work evidence (D1).
    return join(this.workItemDir(workItemId), 'metrics.jsonl');
  }

  /** Append one intent-metric line. Caller pre-serializes (mirrors appendDecision). */
  async appendMetricLine(workItemId: string, jsonLine: string): Promise<void> {
    return this.appendJsonlAtPath(this.metricsPath(workItemId), jsonLine);
  }

  /** Read metrics.jsonl, schema-validating each line. Absent file → empty. */
  async readMetrics(workItemId: string): Promise<IntentMetric[]> {
    const file = Bun.file(this.metricsPath(workItemId));
    if (!(await file.exists())) return [];
    const text = await file.text();
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => intentMetric.parse(JSON.parse(line)));
  }

  private questionRoundsPath(workItemId: string): string {
    // Root level (sibling of metrics.jsonl), not under evidence/: a question-score
    // trail is measurement instrumentation, not per-AC work evidence (ADR-0005 D1).
    return join(this.workItemDir(workItemId), 'question-rounds.jsonl');
  }

  /** Append one question-round line. Caller pre-serializes (mirrors appendMetricLine). */
  async appendQuestionRoundLine(workItemId: string, jsonLine: string): Promise<void> {
    return this.appendJsonlAtPath(this.questionRoundsPath(workItemId), jsonLine);
  }

  /** Read question-rounds.jsonl, schema-validating each line. Absent file → empty. */
  async readQuestionRounds(workItemId: string): Promise<QuestionRound[]> {
    const file = Bun.file(this.questionRoundsPath(workItemId));
    if (!(await file.exists())) return [];
    const text = await file.text();
    return text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => questionRound.parse(JSON.parse(line)));
  }
}

// Re-export the input shape for type imports
export type { WorkItem };

// Helper for callers that want to validate ad-hoc work item objects
export const workItemSchema = workItem;
export const partialWorkItemSchema = workItem;
export const acceptanceCriterionInputSchema = z
  .object({
    id: z.string().min(1),
    statement: z.string().min(1),
  })
  .passthrough();
