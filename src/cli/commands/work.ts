import { defineCommand } from 'citty';
import { AutopilotStore } from '~/core/autopilot-store';
import {
  BranchedStemError,
  DEFAULT_MAX_DEPTH,
  driveChain,
  productionAttemptPush,
  productionDriveMember,
} from '~/core/chain-drive';
import { PLACEHOLDER_AC_STATEMENT } from '~/core/charter';
import {
  CompletionStore,
  assembleCompletionFromWorkItem,
  mirrorAcceptanceVerdicts,
} from '~/core/completion-store';
import { readGithubConfig } from '~/core/ditto-config';
import { resolveRepoRootForCreate } from '~/core/fs';
import { acceptanceTestable, completionEvidenceGate, completionGate } from '~/core/gates';
import {
  type GhClient,
  type GhDegradation,
  type GhDegradeReason,
  createGhClient,
} from '~/core/gh-client';
import { postUnpostedDecisions } from '~/core/github-progress';
import { reflectTermination } from '~/core/github-reflection';
import { IntentStore } from '~/core/intent-store';
import {
  InvalidBaseRefError,
  InvalidHeadRefError,
  writeWorkItemHandoff,
} from '~/core/work-item-handoff';
import { WorkItemStore, blockingFollowUp, pushReadiness } from '~/core/work-item-store';
import { createWorktreeForWorkItem, worktreeBindingHint } from '~/core/worktree';
import { declarerRole, workItemId } from '~/schemas/common';
import type { CompletionContract } from '~/schemas/completion-contract';
import type { DittoConfigGithub } from '~/schemas/ditto-config';
import {
  type AcceptanceCriterion,
  type FollowUp,
  type GithubIssueLink,
  type WorkItem,
  severityLevel,
} from '~/schemas/work-item';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/**
 * Parse a `--criteria` string into per-AC statements: split on `;`, trim, drop
 * empties. Shared by `work start --criteria` and `work set-criteria` so both
 * surfaces build acceptance criteria the same way.
 */
function parseCriteriaStatements(raw: string): string[] {
  return raw
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ac-3: the work item's declared risk axis. Same vocabulary as gates.ts RiskAxes
// (non_local/irreversible/unaudited); shared by `work start --risk` and
// `work set-criteria --risk`.
const RISK_FLAGS = ['non_local', 'irreversible', 'unaudited'] as const;

/**
 * Parse a `--risk "non_local,irreversible"` string into `declared_risk` flags.
 * Comma-separated; each token must be a known risk flag (an unknown token is
 * reported so a typo is not silently dropped). `risk` is undefined when no flag
 * was set (so an empty `--risk ""` records nothing).
 */
function parseRiskFlags(raw: string): { risk?: WorkItem['declared_risk']; unknown: string[] } {
  const tokens = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const unknown: string[] = [];
  const risk: Record<string, boolean> = {};
  for (const t of tokens) {
    if ((RISK_FLAGS as readonly string[]).includes(t)) risk[t] = true;
    else unknown.push(t);
  }
  return { risk: Object.keys(risk).length > 0 ? risk : undefined, unknown };
}

/** True iff any declared_risk flag is set on the work item. */
function hasDeclaredRisk(item: WorkItem): boolean {
  const r = item.declared_risk;
  return !!r && (r.non_local === true || r.irreversible === true || r.unaudited === true);
}

/**
 * Observability gate: reuse the deterministic `acceptanceTestable` (gates.ts) on
 * each statement so the setter rejects a vague term or a statement with no
 * observable predicate. Returns a per-statement rejection message for every
 * statement that fails; empty when all are testable. Callers reject the WHOLE
 * batch on any failure (no partial write).
 */
function rejectNonObservableCriteria(statements: string[]): string[] {
  const errors: string[] = [];
  statements.forEach((statement, i) => {
    const result = acceptanceTestable({ statement });
    if (!result.pass) errors.push(`ac-${i + 1} "${statement}": ${result.reasons.join('; ')}`);
  });
  return errors;
}

interface SupersededRecord {
  statement: string;
  reason: string;
}

/**
 * Provenance records for the new criterion at `index`: the prior criterion's
 * existing supersession history, plus its statement when it was graded
 * (non-`unverified`) — replacing a graded statement is what we must not lose. The
 * LAST new criterion also absorbs the provenance of any graded prior criteria
 * beyond the new count, so a dropped graded statement is never silently lost.
 */
function supersededRecordsFor(
  prior: readonly AcceptanceCriterion[],
  index: number,
  newCount: number,
  reason: string,
): SupersededRecord[] {
  const records: SupersededRecord[] = [];
  const old = prior[index];
  if (old) {
    records.push(...(old.superseded ?? []));
    if (old.verdict !== 'unverified') records.push({ statement: old.statement, reason });
  }
  if (index === newCount - 1) {
    for (const c of prior.slice(newCount)) {
      if (c.verdict !== 'unverified') records.push({ statement: c.statement, reason });
    }
  }
  return records;
}

/**
 * Build fresh (`unverified`) acceptance criteria from the statements. When
 * `reason` is defined (an explicit `--supersede`), prior graded statements are
 * preserved in each new criterion's `superseded` provenance; when undefined
 * (plain replace, no graded criteria locked), criteria carry no provenance.
 */
function buildCriteria(
  statements: string[],
  prior: readonly AcceptanceCriterion[],
  reason: string | undefined,
) {
  const newCount = statements.length;
  return statements.map((statement, i) => {
    const records = reason === undefined ? [] : supersededRecordsFor(prior, i, newCount, reason);
    return {
      id: `ac-${i + 1}`,
      statement,
      verdict: 'unverified' as const,
      evidence: [],
      ...(records.length > 0 ? { superseded: records } : {}),
    };
  });
}

// ── M3 (wi_260628d79): GitHub issue pull + link + cross-repo guard (G1/G2, ac-1/2/13).
// Pull/link logic lives here as injectable functions so the AC tests inject a FAKE
// GhClient (createFakeGhClient) and a real WorkItemStore on a tmp dir, asserting on
// the result + store state — no `gh` subprocess (OBJ-3 seam).

export interface IssueCoord {
  /** owner/name exactly as parsed (case preserved for display/storage). */
  repo: string;
  number: number;
}

/** Parse an `owner/repo#n` issue coordinate. Returns null on a malformed token. */
export function parseIssueCoord(raw: string): IssueCoord | null {
  const m = /^([^/\s#]+)\/([^/\s#]+)#(\d+)$/.exec(raw.trim());
  if (!m) return null;
  return { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
}

/**
 * Canonical form of an owner/repo coordinate for the cross-repo guard (ac-13
 * BINDING). GitHub owner/name are case-insensitive; we strip a trailing `.git`
 * and surrounding space, then lowercase — so a non-canonical parse (mixed case, a
 * `.git` suffix from a remote URL) can NOT weaken the guard by making a foreign
 * repo compare unequal-yet-execute, nor the rooted repo compare equal-yet-skip.
 */
export function canonicalizeRepo(repo: string): string {
  return repo
    .trim()
    .replace(/\.git$/i, '')
    .toLowerCase();
}

/** True iff two owner/repo coordinates name the same repo (canonical compare). */
export function sameRepoCoord(a: string, b: string): boolean {
  return canonicalizeRepo(a) === canonicalizeRepo(b);
}

/** The fetched issue fields pull seeds a work item from. */
interface FetchedIssue {
  title: string;
  body: string;
}

function readIssue(value: unknown): FetchedIssue {
  const v = (value ?? {}) as { title?: unknown; body?: unknown };
  return {
    title: typeof v.title === 'string' ? v.title : '',
    body: typeof v.body === 'string' ? v.body : '',
  };
}

export interface PullIssueDeps {
  client: GhClient;
  store: WorkItemStore;
  /**
   * Canonical-comparable owner/name of the rooted repo (ADR-0011 session root), or
   * null when undeterminable (no git remote). A null session repo can not prove
   * same-repo, so the guard FAILS CLOSED — it treats the pull as cross-repo.
   */
  sessionRepo: string | null;
  /**
   * The linked Project config (from `ditto github setup`), or undefined. When present
   * and the issue is on the board, `project_item_id` is populated so completion
   * reflection can update the board status (best-effort; absent config is a no-op).
   */
  config?: DittoConfigGithub | undefined;
}

export type PullIssueResult =
  | { kind: 'created'; id: string; coord: IssueCoord }
  | { kind: 'existing'; id: string; coord: IssueCoord }
  | { kind: 'cross_repo'; coord: IssueCoord; sessionRepo: string | null; title: string }
  | { kind: 'degraded'; reason: GhDegradeReason; detail: string };

/** Find a work item already linked to `coord` (canonical match); null if none. */
async function findLinkedWorkItem(store: WorkItemStore, coord: IssueCoord): Promise<string | null> {
  for (const s of await store.list()) {
    const item = await store.get(s.id);
    const gi = item.github_issue;
    if (gi && gi.number === coord.number && sameRepoCoord(gi.repo, coord.repo)) return item.id;
  }
  return null;
}

async function createWorkItemFromIssue(
  store: WorkItemStore,
  coord: IssueCoord,
  issue: FetchedIssue,
  projectItemId: string | null,
): Promise<string> {
  const title = issue.title.trim() || `Issue ${coord.repo}#${coord.number}`;
  const sourceRequest =
    [issue.title.trim(), issue.body.trim()].filter((s) => s.length > 0).join('\n\n') ||
    `${coord.repo}#${coord.number}`;
  const created = await store.create({
    title: title.slice(0, 200),
    source_request: sourceRequest,
    goal: title,
    acceptance_criteria: [
      {
        id: 'ac-1',
        statement: PLACEHOLDER_AC_STATEMENT,
        verdict: 'unverified' as const,
        evidence: [],
      },
    ],
  });
  await store.update(created.id, (cur) => ({
    ...cur,
    github_issue: {
      repo: coord.repo,
      number: coord.number,
      ...(projectItemId ? { project_item_id: projectItemId } : {}),
    },
  }));
  return created.id;
}

/**
 * G1 pull: fetch the issue and seed a work item from its title/body, saving the
 * `github_issue` coord (ac-1). IDEMPOTENT — an existing WI linked to the exact
 * coord short-circuits to that id with no fetch and no duplicate. CROSS-REPO
 * (ac-13): when the coord's repo != the session root, change-execution is
 * fail-closed (no WI is created); the issue is still fetched for display and the
 * coord returned for a manual `link-issue` (link/display allowed, execution blocked).
 */
export async function pullIssue(deps: PullIssueDeps, coord: IssueCoord): Promise<PullIssueResult> {
  // Idempotency first (ac-1): an already-linked WI returns its id — no fetch, no dup.
  const existingId = await findLinkedWorkItem(deps.store, coord);
  if (existingId) return { kind: 'existing', id: existingId, coord };

  // Cross-repo guard (ac-13, ADR-0011): fail closed on a foreign — or undeterminable
  // — session repo. Fetch for display (표시 allowed), but do NOT create the execution
  // vessel. CANONICALIZE both sides so a non-canonical parse can't weaken the guard.
  const isSameRepo = deps.sessionRepo !== null && sameRepoCoord(coord.repo, deps.sessionRepo);
  if (!isSameRepo) {
    const foreignView = deps.client.issueView(coord.repo, coord.number);
    const title = foreignView.ok ? readIssue(foreignView.value).title : '';
    return { kind: 'cross_repo', coord, sessionRepo: deps.sessionRepo, title };
  }

  const view = deps.client.issueView(coord.repo, coord.number);
  if (!view.ok) return { kind: 'degraded', reason: view.reason, detail: view.detail };
  // Best-effort board item id so completion reflection (ac-5) has an item to edit.
  const projectItemId = resolveProjectItemId(
    { client: deps.client, config: deps.config },
    coord.number,
  );
  const id = await createWorkItemFromIssue(deps.store, coord, readIssue(view.value), projectItemId);
  return { kind: 'created', id, coord };
}

// ── M4 (wi_260628d79): mirror an EXISTING GitHub issue's sub-issue / task-list
// hierarchy into the work items' parent_id/child_ids (ac-3). ditto creates NO
// issues and NO work items here — it only relates work items that are ALREADY
// linked to the parent/child issues. Resolution order:
//   1. graphql addSubIssue read FIRST (the GitHub sub_issues preview field);
//   2. task-list `- [ ] #n` / `- [x] #n` parse of the issue BODY as fallback;
//   3. BOTH fail → degrade to manual input (skip + notice), never throw (ADR-0018).
export interface MirrorHierarchyDeps {
  client: GhClient;
  store: WorkItemStore;
}

export type MirrorHierarchyResult =
  | {
      kind: 'mirrored';
      source: 'graphql' | 'task_list';
      parent_id: string;
      child_work_ids: string[];
      child_issue_numbers: number[];
      /** Child issue numbers with NO local work item linked (skipped, not created). */
      unlinked_child_issues: number[];
    }
  | { kind: 'degraded'; reason: GhDegradeReason; detail: string };

/** The GitHub sub-issues (preview) read. `gh api graphql` has no native sub-issue
 *  command, so we query the `subIssues` field directly. */
const SUB_ISSUES_QUERY =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){subIssues(first:100){nodes{number}}}}}';

/** Pull child issue numbers out of a `subIssues.nodes[].number` graphql payload.
 *  Tolerant of a missing/odd shape (returns []) — a malformed payload is not a crash. */
function parseSubIssueNumbers(value: unknown): number[] {
  const nodes = (
    value as {
      data?: { repository?: { issue?: { subIssues?: { nodes?: unknown } } } };
    }
  )?.data?.repository?.issue?.subIssues?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes
    .map((n) => (n as { number?: unknown })?.number)
    .filter((n): n is number => typeof n === 'number' && Number.isInteger(n));
}

/** Parse task-list checkbox issue refs (`- [ ] #n` / `- [x] #n`) out of an issue
 *  body. Same-repo `#n` refs only (what the v1 link schema records). */
function parseTaskListIssueNumbers(body: string): number[] {
  const re = /^\s*[-*]\s*\[[ xX]\]\s*#(\d+)\b/gm;
  const out: number[] = [];
  for (let m = re.exec(body); m !== null; m = re.exec(body)) out.push(Number(m[1]));
  return out;
}

/**
 * Mirror the parent issue's child hierarchy onto the local work items. The parent
 * WI must already carry a `github_issue` coord. For each resolved child issue
 * number we relate the LOCAL work item already linked to that coord (parent_id on
 * the child, child_ids on the parent) — a child issue with no linked WI is skipped
 * (recorded in `unlinked_child_issues`), never auto-created. Idempotent: child_ids
 * is set-merged. Both resolution sources failing yields a degrade, not a throw.
 */
export async function mirrorHierarchy(
  deps: MirrorHierarchyDeps,
  parentWorkId: string,
): Promise<MirrorHierarchyResult> {
  const parent = await deps.store.get(parentWorkId); // clear error if the WI is unknown
  const gi = parent.github_issue;
  if (!gi) {
    return {
      kind: 'degraded',
      reason: 'nonzero',
      detail: `work item ${parentWorkId} is not linked to a GitHub issue — link it first with \`ditto work link-issue\``,
    };
  }
  const [owner, name] = gi.repo.split('/');

  let childNumbers: number[] = [];
  let source: 'graphql' | 'task_list' | null = null;
  let lastDegrade: GhDegradation | null = null;

  // 1. graphql addSubIssue read FIRST.
  const gql = deps.client.apiGraphql(SUB_ISSUES_QUERY, {
    owner: owner ?? '',
    name: name ?? '',
    number: String(gi.number),
  });
  if (gql.ok) {
    const nums = parseSubIssueNumbers(gql.value);
    if (nums.length > 0) {
      childNumbers = nums;
      source = 'graphql';
    }
  } else {
    lastDegrade = gql;
  }

  // 2. task-list parse FALLBACK (graphql unavailable/errored or returned no children).
  if (source === null) {
    const view = deps.client.issueView(gi.repo, gi.number);
    if (view.ok) {
      const nums = parseTaskListIssueNumbers(readIssue(view.value).body);
      if (nums.length > 0) {
        childNumbers = nums;
        source = 'task_list';
      }
    } else {
      lastDegrade = view;
    }
  }

  // 3. BOTH fail → degrade to manual input. Never throws (ADR-0018).
  if (source === null) {
    return {
      kind: 'degraded',
      reason: lastDegrade?.reason ?? 'unparseable',
      detail:
        lastDegrade?.detail ??
        'no sub-issues via graphql and no task-list refs in the issue body — provide the hierarchy manually',
    };
  }

  // Relate the local work items already linked to each child issue. No issue and no
  // work item is created here — an unlinked child issue is recorded and skipped.
  const childWorkIds: string[] = [];
  const unlinked: number[] = [];
  for (const num of childNumbers) {
    const childId = await findLinkedWorkItem(deps.store, { repo: gi.repo, number: num });
    if (childId === null) {
      unlinked.push(num);
      continue;
    }
    if (childId === parentWorkId) continue; // never self-parent
    childWorkIds.push(childId);
    await deps.store.update(childId, (cur) => ({ ...cur, parent_id: parentWorkId }));
  }
  await deps.store.update(parentWorkId, (cur) => ({
    ...cur,
    child_ids: Array.from(new Set([...cur.child_ids, ...childWorkIds])),
  }));

  return {
    kind: 'mirrored',
    source,
    parent_id: parentWorkId,
    child_work_ids: childWorkIds,
    child_issue_numbers: childNumbers,
    unlinked_child_issues: unlinked,
  };
}

export type LinkIssueResult =
  | { kind: 'linked'; id: string; coord: IssueCoord; alreadyLinked: boolean }
  | { kind: 'conflict'; id: string; existing: GithubIssueLink; coord: IssueCoord };

/**
 * G2 link: attach `coord` to an EXISTING work item (ac-2). IDEMPOTENT — linking the
 * same coord again is a no-op (no write, identical state). A WI already linked to a
 * DIFFERENT issue is a conflict (1 WI ↔ 1 issue, v1) — not silently relinked.
 * Cross-repo is ALLOWED here (backlog link/display; execution stays per-repo, ac-13).
 */
export async function linkIssue(
  store: WorkItemStore,
  workId: string,
  coord: IssueCoord,
  opts?: { client: GhClient; config: DittoConfigGithub | undefined },
): Promise<LinkIssueResult> {
  const item = await store.get(workId); // throws a clear error if the WI is unknown
  const existing = item.github_issue;
  if (existing && existing.number === coord.number && sameRepoCoord(existing.repo, coord.repo)) {
    // Idempotent: already linked to this exact coord — no write, state unchanged.
    return { kind: 'linked', id: workId, coord, alreadyLinked: true };
  }
  if (existing) return { kind: 'conflict', id: workId, existing, coord };
  // Best-effort board item id (ac-5 reflection target); absent when gh/config missing.
  const projectItemId = opts
    ? resolveProjectItemId({ client: opts.client, config: opts.config }, coord.number)
    : null;
  await store.update(workId, (cur) => ({
    ...cur,
    github_issue: {
      repo: coord.repo,
      number: coord.number,
      ...(projectItemId ? { project_item_id: projectItemId } : {}),
    },
  }));
  return { kind: 'linked', id: workId, coord, alreadyLinked: false };
}

/** Derive the rooted repo's owner/name from `git remote get-url origin`; null when
 *  there is no origin / not a git tree (the pull guard then fails closed). */
function parseRemoteUrlToRepo(url: string): string | null {
  const m = /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}

function resolveSessionRepoCoord(repoRoot: string): string | null {
  const proc = Bun.spawnSync(['git', '-C', repoRoot, 'remote', 'get-url', 'origin'], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) return null;
  return parseRemoteUrlToRepo(proc.stdout?.toString() ?? '');
}

/**
 * Manual-path GitHub reflection (wi_260628d79, G4/G5). The `work done`/`work
 * abandon` terminal close fires this ONLY when the operator passes an explicit
 * --comment-issue/--close-issue flag (unlike the autopilot path's auto_reflect
 * opt-in). Reads the github config for the D7 status_map; a malformed/absent
 * config still posts the comment — only the board update is skipped, with a
 * notice. Surfaces every skip/degradation notice; never throws (ADR-0018), so a
 * gh failure can NOT undo the already-committed terminal close.
 */
async function reflectManualTermination(
  repoRoot: string,
  item: WorkItem,
  trigger: 'done' | 'abandoned',
  opts: { closeIssue: boolean; completion?: CompletionContract },
): Promise<void> {
  let ghMalformed = false;
  const ghConfig = await readGithubConfig(repoRoot, () => {
    ghMalformed = true;
  });
  const res = reflectTermination(
    { client: createGhClient(), config: ghConfig },
    {
      workItem: item,
      trigger,
      closeIssue: opts.closeIssue,
      ...(opts.completion ? { completion: opts.completion } : {}),
    },
  );
  if (res.commentPosted) writeHuman('GitHub: posted result comment to the linked issue.');
  if (res.statusUpdated) writeHuman('GitHub: updated Project board status.');
  if (res.issueClosed) writeHuman('GitHub: closed the linked issue.');
  if (ghMalformed) {
    writeHuman(
      '  GitHub reflection: config is malformed — board status update skipped (comment unaffected). Fix .ditto/local/config.json.',
    );
  }
  for (const n of res.notices) writeHuman(`  GitHub reflection: ${n}`);
}

const workStart = defineCommand({
  meta: {
    name: 'start',
    description: 'Create a new work item from a request and initial goal',
  },
  args: {
    goal: {
      type: 'positional',
      description:
        'Observable outcome stated in project terms (omit with --issue: the issue title seeds it)',
      required: false,
    },
    request: {
      type: 'string',
      description: 'Verbatim user request that produced this work item (omit with --issue)',
      required: false,
    },
    issue: {
      type: 'string',
      description:
        'Pull a GitHub issue (owner/repo#n): fetch title/body via gh → seed source_request + save the github_issue coord. Idempotent; a cross-repo coord is link/display-only (execution blocked, ADR-0011).',
      required: false,
    },
    title: {
      type: 'string',
      description: 'Short title; defaults to goal truncated',
      required: false,
    },
    criteria: {
      type: 'string',
      description:
        'Real observable acceptance criteria, semicolon-separated — set at creation instead of the placeholder',
      required: false,
    },
    risk: {
      type: 'string',
      description:
        'Declared risk flags, comma-separated: non_local,irreversible,unaudited (drives the heavy-path nudge + lightweight-close override gate)',
      required: false,
    },
    follows: {
      type: 'string',
      description:
        'Predecessor work item id this WI continues from (chain lineage; see `ditto work stem`)',
      required: false,
    },
    profile: {
      type: 'string',
      description: 'Owner profile: read-only|workspace-write|networked|reviewer|isolated',
      default: 'workspace-write',
    },
    worktree: {
      type: 'boolean',
      description: 'Also create the work item branch+worktree(s) (like `ditto worktree create`)',
      default: false,
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
    const repoRoot = await resolveRepoRootForCreate();
    const store = new WorkItemStore(repoRoot);

    // --issue (G1 pull): fetch the issue via gh, seed source_request, save the coord.
    // Routed before the normal create path; goal/request come from the issue.
    if (args.issue !== undefined) {
      const coord = parseIssueCoord(args.issue);
      if (coord === null) {
        writeError(
          `--issue must be an owner/repo#n coordinate (e.g. octo/app#42); got "${args.issue}"`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const sessionRepo = resolveSessionRepoCoord(repoRoot);
      // Project config (if `ditto github setup` ran) lets pull populate project_item_id
      // so completion reflection can update the board status (ac-5). Best-effort.
      const ghConfig = await readGithubConfig(repoRoot);
      const result = await pullIssue(
        { client: createGhClient(), store, sessionRepo, config: ghConfig },
        coord,
      );
      switch (result.kind) {
        case 'created':
          if (format === 'json') {
            writeJson({
              work_item_id: result.id,
              path: `.ditto/local/work-items/${result.id}/work-item.json`,
              github_issue: { repo: coord.repo, number: coord.number },
            });
          } else {
            writeHuman(`Created work item ${result.id} from ${coord.repo}#${coord.number}`);
            writeHuman(`  path: ${repoRoot}/.ditto/local/work-items/${result.id}/work-item.json`);
          }
          return;
        case 'existing':
          if (format === 'json') {
            writeJson({ work_item_id: result.id, already_linked: true });
          } else {
            writeHuman(
              `${coord.repo}#${coord.number} is already linked to ${result.id} — no duplicate created.`,
            );
          }
          return;
        case 'cross_repo':
          // Fail-closed on execution; link/display allowed (ADR-0011, ac-13).
          writeError(
            `cross-repo: ${coord.repo}#${coord.number} is not the session's rooted repo (${
              result.sessionRepo ?? 'unknown'
            }). Execution is blocked here (ADR-0011 session-rooting). Issue: "${result.title}". Link it to an existing work item with: ditto work link-issue <wi> ${coord.repo}#${coord.number}`,
          );
          process.exit(USAGE_ERROR_EXIT);
          return;
        case 'degraded':
          writeError(
            `cannot pull ${coord.repo}#${coord.number}: gh ${result.reason}${
              result.detail ? ` (${result.detail})` : ''
            }. Provide the link manually with: ditto work link-issue <wi> ${coord.repo}#${coord.number}`,
          );
          process.exit(RUNTIME_ERROR_EXIT);
          return;
      }
    }

    if (!args.goal) {
      writeError('a goal positional is required (or use --issue <owner/repo#n> to pull one)');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    if (!args.request) {
      writeError('--request is required (or use --issue <owner/repo#n> to pull one)');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const profile = args.profile as
      | 'read-only'
      | 'workspace-write'
      | 'networked'
      | 'reviewer'
      | 'isolated';
    const title = args.title ?? args.goal.slice(0, 80);
    const realStatements = args.criteria ? parseCriteriaStatements(args.criteria) : [];
    if (realStatements.length > 0) {
      const errors = rejectNonObservableCriteria(realStatements);
      if (errors.length > 0) {
        writeError(`--criteria rejected (not observable/testable): ${errors.join('; ')}`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
    }
    let declared_risk: WorkItem['declared_risk'];
    if (args.risk !== undefined) {
      const parsed = parseRiskFlags(args.risk);
      if (parsed.unknown.length > 0) {
        writeError(
          `--risk has unknown flag(s) ${parsed.unknown.join(', ')}; allowed: ${RISK_FLAGS.join(', ')}`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      declared_risk = parsed.risk;
    }
    // ac-5: chain lineage edge. A brand-new WI has no successors, so no cycle is
    // possible at creation; we only reject a predecessor that does not exist (a
    // dangling lineage edge). Cycle protection lives on `work stem --follows`.
    let follows: WorkItem['follows'];
    if (args.follows !== undefined) {
      if (!(await store.exists(args.follows))) {
        writeError(`--follows predecessor ${args.follows} does not exist`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      follows = args.follows;
    }
    const acceptance_criteria =
      realStatements.length > 0
        ? realStatements.map((statement, i) => ({
            id: `ac-${i + 1}`,
            statement,
            verdict: 'unverified' as const,
            evidence: [],
          }))
        : [
            {
              id: 'ac-1',
              // Single source of truth (V1): the placeholder detector in
              // user-prompt-submit matches this exact string to fire the
              // deep-interview directive, so the CLI must emit the same constant
              // rather than a hand-written sibling that silently bypasses it.
              statement: PLACEHOLDER_AC_STATEMENT,
              verdict: 'unverified' as const,
              evidence: [],
            },
          ];
    try {
      const created = await store.create({
        title,
        source_request: args.request,
        goal: args.goal,
        owner_profile: profile,
        acceptance_criteria,
        ...(declared_risk !== undefined ? { declared_risk } : {}),
        ...(follows !== undefined ? { follows } : {}),
      });
      // ac-3: --worktree also creates the branch+worktree(s) right after the work
      // item exists, reusing the same path `ditto worktree create` uses. Without the
      // flag, behavior is unchanged (work item only — no git repo required).
      const worktrees = args.worktree ? await createWorktreeForWorkItem(repoRoot, created.id) : [];
      if (format === 'json') {
        writeJson({
          work_item_id: created.id,
          path: `.ditto/local/work-items/${created.id}/work-item.json`,
          status: created.status,
          repo_root: repoRoot,
          worktrees,
        });
      } else {
        writeHuman(`Created work item ${created.id}`);
        writeHuman(`  goal: ${created.goal}`);
        writeHuman(`  status: ${created.status}`);
        writeHuman(`  path: ${repoRoot}/.ditto/local/work-items/${created.id}/work-item.json`);
        if (worktrees.length > 0) {
          writeHuman(`Created ${worktrees.length} worktree(s):`);
          for (const wt of worktrees) {
            writeHuman(`  ${wt.owning_repo}\t${wt.branch}\t${wt.worktree_path}`);
          }
          const hint = worktreeBindingHint(repoRoot, worktrees, created.id);
          if (hint) writeHuman(hint);
        }
        writeHuman('Next steps — heavy path (complex/irreversible work):');
        writeHuman(
          '  1. /ditto:deep-interview (or: ditto deep-interview start → record-turn → check-readiness → finalize) — writes intent.json',
        );
        writeHuman(
          `  2. ditto autopilot bootstrap --workItem ${created.id} (requires intent.json from finalize)`,
        );
        writeHuman(
          'Or the lightweight path (simple/reversible work — no deep-interview/autopilot):',
        );
        writeHuman(
          `  1. ditto work set-criteria ${created.id} --criteria "<observable criterion; …>"`,
        );
        writeHuman(`  2. ditto verify ${created.id} --criterion <ac> -- <command>`);
        writeHuman(`  3. ditto work done ${created.id}`);
      }
    } catch (err) {
      writeError(`work start failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const workSetCriteria = defineCommand({
  meta: {
    name: 'set-criteria',
    description:
      'Replace placeholder acceptance criteria with real, observable criteria (semicolon-separated)',
  },
  args: {
    workId: {
      type: 'positional',
      description: 'Work item id to set acceptance criteria on',
      required: true,
    },
    criteria: {
      type: 'string',
      description:
        'Observable criteria, semicolon-separated — one acceptance criterion (ac-1, ac-2, …) each',
      required: true,
    },
    supersede: {
      type: 'boolean',
      description:
        'Override the lock on already-graded criteria. Requires --reason; prior statements are preserved as provenance.',
      default: false,
    },
    reason: {
      type: 'string',
      description: 'Why the graded criteria are being replaced (required with --supersede)',
      required: false,
    },
    risk: {
      type: 'string',
      description:
        'Declared risk flags, comma-separated: non_local,irreversible,unaudited (recorded on the work item)',
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
    const supersede = args.supersede === true;
    if (supersede && !args.reason) {
      writeError('--supersede requires --reason "<why the graded criteria are being replaced>"');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const statements = parseCriteriaStatements(args.criteria);
    if (statements.length === 0) {
      writeError('--criteria must contain at least one non-empty statement (semicolon-separated)');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const observabilityErrors = rejectNonObservableCriteria(statements);
    if (observabilityErrors.length > 0) {
      writeError(
        `--criteria rejected (not observable/testable): ${observabilityErrors.join('; ')}`,
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    let declared_risk: WorkItem['declared_risk'];
    if (args.risk !== undefined) {
      const parsed = parseRiskFlags(args.risk);
      if (parsed.unknown.length > 0) {
        writeError(
          `--risk has unknown flag(s) ${parsed.unknown.join(', ')}; allowed: ${RISK_FLAGS.join(', ')}`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      declared_risk = parsed.risk;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const store = new WorkItemStore(repoRoot);
    try {
      const current = await store.get(args.workId);
      // Lock-with-provenance (charter §4-6): a criterion that already carries a
      // verdict must not be silently overwritten (goalpost-moving). Block by
      // default; require explicit --supersede --reason to override.
      const graded = current.acceptance_criteria.filter((c) => c.verdict !== 'unverified');
      if (graded.length > 0 && !supersede) {
        writeError(
          `work ${args.workId} has graded criteria (${graded
            .map((c) => `${c.id}=${c.verdict}`)
            .join(
              ', ',
            )}); set-criteria would overwrite verified results. Re-run with --supersede --reason "<why>" to override (prior statements are preserved as provenance).`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const nextCriteria = buildCriteria(
        statements,
        current.acceptance_criteria,
        supersede ? (args.reason as string) : undefined,
      );
      const updated = await store.update(args.workId, (cur) => ({
        ...cur,
        acceptance_criteria: nextCriteria,
        ...(declared_risk !== undefined ? { declared_risk } : {}),
      }));
      if (format === 'json') {
        writeJson({
          work_item_id: updated.id,
          acceptance_criteria: updated.acceptance_criteria.map((c) => ({
            id: c.id,
            statement: c.statement,
          })),
        });
      } else {
        writeHuman(
          `Set ${updated.acceptance_criteria.length} acceptance criteria on ${updated.id}:`,
        );
        for (const c of updated.acceptance_criteria) writeHuman(`  ${c.id}: ${c.statement}`);
      }
    } catch (err) {
      writeError(`work set-criteria failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

// ── M7 (wi_260628d79): show the linked issue coord + Project v2 board position
// (status/priority) on `work status`, and surface DIVERGENCE when the board status
// disagrees with the work item status (ac-6, G5/G7). The board read is an injectable
// seam (OBJ-3): the AC tests inject a FAKE GhClient and assert on loadBoardView +
// formatBoardLines — no `gh` subprocess. Two axes with OPPOSITE source-of-truth:
//   - completion axis: ditto is SoT (write) — `done`/`abandoned` come from evidence;
//   - priority axis:   GitHub is SoT (read-only) — ditto never writes priority.
// Everything degrades gracefully (ADR-0018): gh unavailable/unauth/perm → the coord
// is still shown (it is local), the board is marked unavailable with a reason, no throw.

/** The board's current single-select field values for the linked issue (display only). */
export interface BoardPosition {
  /** The Projects v2 item id (`PVTI_…`) — used to populate `project_item_id` on link. */
  itemId: string | null;
  status: string | null;
  priority: string | null;
}

export interface BoardDivergence {
  diverged: boolean;
  message: string | null;
}

export interface BoardView {
  /** owner/repo#n — read from the LOCAL link, so it shows even when gh is down. */
  coord: string;
  position: BoardPosition | null;
  divergence: BoardDivergence;
  /** Set when the board could not be read; the coord still shows (graceful degrade). */
  unavailable: { reason: string; detail?: string } | null;
}

export interface BoardStatusDeps {
  client: GhClient;
  config: DittoConfigGithub | undefined;
}

/**
 * Pull the linked issue's board position (Status + Priority single-select names) out
 * of a `gh project item-list --format json` payload. Tolerant of an odd/missing shape
 * (returns null when the issue is not found on the board) — a missing item is a skip,
 * not a crash.
 */
export function parseBoardPosition(itemList: unknown, issueNumber: number): BoardPosition | null {
  const items = (itemList as { items?: unknown })?.items;
  if (!Array.isArray(items)) return null;
  for (const it of items) {
    const content = (it as { content?: { number?: unknown } })?.content;
    if (!content || (content as { number?: unknown }).number !== issueNumber) continue;
    const id = (it as { id?: unknown }).id;
    const status = (it as { status?: unknown }).status;
    const priority = (it as { priority?: unknown }).priority;
    return {
      itemId: typeof id === 'string' ? id : null,
      status: typeof status === 'string' ? status : null,
      priority: typeof priority === 'string' ? priority : null,
    };
  }
  return null;
}

/**
 * Resolve the Projects v2 board item id (`PVTI_…`) for an issue on the configured
 * Project, so pull/link can save it as `github_issue.project_item_id` — without it,
 * completion reflection (ac-5) has no item to edit and skips the board update.
 * BEST-EFFORT (ADR-0018): no project config / gh degraded / issue not on the board
 * all return null and the caller leaves the field absent — never a throw, never a
 * block on the pull/link itself.
 */
export function resolveProjectItemId(
  deps: { client: GhClient; config: DittoConfigGithub | undefined },
  issueNumber: number,
): string | null {
  if (!deps.config) return null;
  const { owner, number } = deps.config.project;
  const itemList = deps.client.projectItemList(owner, number);
  if (!itemList.ok) return null;
  return parseBoardPosition(itemList.value, issueNumber)?.itemId ?? null;
}

/**
 * Map a Project v2 single-select option id → display name from a `field-list` payload.
 * The D7 status_map stores option IDS while the board item-list reports option NAMES;
 * this bridge lets divergence stay config-grounded (NOT free-text name matching, D7).
 * Option ids are unique, so flattening every field's options into one map is safe.
 */
export function statusOptionNameById(fieldList: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const fields = (fieldList as { fields?: unknown })?.fields;
  if (!Array.isArray(fields)) return out;
  for (const f of fields) {
    const options = (f as { options?: unknown })?.options;
    if (!Array.isArray(options)) continue;
    for (const o of options) {
      const id = (o as { id?: unknown })?.id;
      const name = (o as { name?: unknown })?.name;
      if (typeof id === 'string' && typeof name === 'string') out.set(id, name);
    }
  }
  return out;
}

const TERMINAL_WI_STATUSES = ['done', 'abandoned'] as const;

/**
 * Decide whether the board status and the work item status DIVERGE on the completion
 * axis. The comparison is config-grounded (D7): the board option name is resolved back
 * to a ditto terminal enum through status_map (id→option name via field-list), NOT by
 * free-text matching. Two divergence shapes, same concept (completion is ditto-gated):
 *   - board claims a ditto-terminal completion (e.g. Done) but the WI is not there yet
 *     — the headline case: the board is ahead of ditto's evidence gate;
 *   - the WI is already terminal but the board still shows a non-terminal status
 *     — the board lags the completed work item.
 * No board status / unmapped non-terminal board status with a non-terminal WI → no
 * assertion (nothing reliable to compare).
 */
export function assessDivergence(
  wiStatus: WorkItem['status'],
  boardStatusName: string | null,
  statusMap: DittoConfigGithub['status_map'],
  optionNameById: Map<string, string>,
): BoardDivergence {
  if (!boardStatusName) return { diverged: false, message: null };
  // Reverse the D7 mapping: board option NAME (lowercased) → ditto terminal enum.
  const nameToTerminal = new Map<string, 'done' | 'abandoned'>();
  for (const t of TERMINAL_WI_STATUSES) {
    const optId = statusMap[t];
    if (!optId) continue;
    const name = optionNameById.get(optId);
    if (name) nameToTerminal.set(name.toLowerCase(), t);
  }
  const boardTerminal = nameToTerminal.get(boardStatusName.toLowerCase());
  if (boardTerminal) {
    if (wiStatus === boardTerminal) return { diverged: false, message: null };
    return {
      diverged: true,
      message: `board=${boardStatusName} (ditto-terminal '${boardTerminal}') but WI=${wiStatus} — completion is ditto-gated (evidence unmet); the board is not backed by ditto evidence.`,
    };
  }
  if ((TERMINAL_WI_STATUSES as readonly string[]).includes(wiStatus)) {
    return {
      diverged: true,
      message: `WI=${wiStatus} but board=${boardStatusName} — the board has not been reflected to the completed state.`,
    };
  }
  return { diverged: false, message: null };
}

/**
 * Read the board position + assess divergence for a work item KNOWN to carry a
 * github_issue link. Never throws: a missing config / gh degradation / issue-not-on-
 * board each yields a `unavailable` view with the coord still present. Divergence
 * needs the option id→name map (status_map stores ids), so it also reads field-list;
 * a degraded field-list just yields an empty map (divergence falls back to no-assert).
 */
export function loadBoardView(deps: BoardStatusDeps, item: WorkItem): BoardView {
  const gi = item.github_issue;
  // Caller gates on presence; this keeps the function total if misused.
  const coord = gi ? `${gi.repo}#${gi.number}` : '(no link)';
  const noDivergence: BoardDivergence = { diverged: false, message: null };
  if (!gi)
    return {
      coord,
      position: null,
      divergence: noDivergence,
      unavailable: { reason: 'no github_issue link' },
    };
  if (!deps.config) {
    return {
      coord,
      position: null,
      divergence: noDivergence,
      unavailable: { reason: 'no project config', detail: 'run `ditto github setup`' },
    };
  }
  const { owner, number } = deps.config.project;
  const itemList = deps.client.projectItemList(owner, number);
  if (!itemList.ok) {
    return {
      coord,
      position: null,
      divergence: noDivergence,
      unavailable: { reason: itemList.reason, detail: itemList.detail },
    };
  }
  const position = parseBoardPosition(itemList.value, gi.number);
  if (!position) {
    return {
      coord,
      position: null,
      divergence: noDivergence,
      unavailable: { reason: 'issue not on the board' },
    };
  }
  const fieldList = deps.client.projectFieldList(owner, number);
  const optionNameById = fieldList.ok
    ? statusOptionNameById(fieldList.value)
    : new Map<string, string>();
  const divergence = assessDivergence(
    item.status,
    position.status,
    deps.config.status_map,
    optionNameById,
  );
  return { coord, position, divergence, unavailable: null };
}

/** Human-readable `work status` GitHub section. The axis asymmetry (completion=ditto
 *  write SoT, priority=GitHub read-only) is always stated; the DIVERGENCE line only
 *  when the board and the WI disagree on the completion axis. */
export function formatBoardLines(view: BoardView): string[] {
  const lines = ['github:', `  issue:  ${view.coord}`];
  if (view.unavailable) {
    lines.push(
      `  board:  unavailable (${view.unavailable.reason}${view.unavailable.detail ? `: ${view.unavailable.detail}` : ''})`,
    );
  } else if (view.position) {
    lines.push(
      `  board:  status=${view.position.status ?? '(none)'} · priority=${view.position.priority ?? '(none)'}`,
    );
  }
  lines.push('  axes:   completion = ditto (write SoT) · priority = GitHub (read-only)');
  if (view.divergence.diverged && view.divergence.message) {
    lines.push(`  DIVERGENCE: ${view.divergence.message}`);
  }
  return lines;
}

const workStatus = defineCommand({
  meta: {
    name: 'status',
    description: 'Show current state of one or all work items',
  },
  args: {
    workId: {
      type: 'positional',
      description: 'Work item id; if omitted, lists all work items',
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
    let repoRoot: string;
    try {
      repoRoot = await resolveRepoRootForCreate();
    } catch (err) {
      writeError(`cannot find repo root: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const store = new WorkItemStore(repoRoot);
    if (!args.workId) {
      const list = await store.list();
      if (format === 'json') {
        writeJson({ items: list });
      } else if (list.length === 0) {
        writeHuman('No work items.');
      } else {
        for (const s of list) {
          writeHuman(`${s.id}\t${s.status}\t${s.updated_at}\t${s.title}`);
        }
      }
      return;
    }
    try {
      const item = await store.get(args.workId);
      if (format === 'json') {
        writeJson(item);
      } else {
        writeHuman(`id:     ${item.id}`);
        writeHuman(`title:  ${item.title}`);
        writeHuman(`status: ${item.status}`);
        writeHuman(`goal:   ${item.goal}`);
        writeHuman(`updated_at: ${item.updated_at}`);
        writeHuman('acceptance:');
        for (const ac of item.acceptance_criteria) {
          writeHuman(`  - ${ac.id} [${ac.verdict}] ${ac.statement}`);
        }
        if (item.worktrees.length > 0) {
          writeHuman('worktrees:');
          for (const wt of item.worktrees) {
            writeHuman(`  - ${wt.owning_repo}\t${wt.branch}\t${wt.worktree_path}`);
          }
        }
        // M7 (ac-6): linked issue coord + board position + divergence. Only when a
        // github_issue link exists — otherwise no GitHub section at all (no gh call).
        if (item.github_issue) {
          let ghMalformed = false;
          const ghConfig = await readGithubConfig(repoRoot, () => {
            ghMalformed = true;
          });
          const view = loadBoardView({ client: createGhClient(), config: ghConfig }, item);
          for (const line of formatBoardLines(view)) writeHuman(line);
          if (ghMalformed) {
            writeHuman(
              '  note:   github config malformed — board read skipped (fix .ditto/local/config.json).',
            );
          }
        }
      }
    } catch (err) {
      writeError(`work status failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

const workHandoff = defineCommand({
  meta: {
    name: 'handoff',
    description: 'Generate or refresh the handoff document for a work item',
  },
  args: {
    workId: {
      type: 'positional',
      description: 'Work item id to hand off',
      required: true,
    },
    base: {
      type: 'string',
      description:
        'Git ref to diff against when collecting changed_files. Default tries started_at_sha, origin/main, origin/master, main, master.',
      required: false,
    },
    head: {
      type: 'string',
      description:
        'Git ref to diff up to when collecting changed_files. Default HEAD. Useful for correcting past handoffs (base...head frozen range).',
      required: false,
    },
    'declared-by': {
      type: 'string',
      description:
        'Agent role that declares this completion (who judged): main|planner|implementer|verifier|reviewer|researcher|synthesizer. Default main.',
      default: 'main',
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
    const declaredBy = declarerRole.safeParse(args['declared-by']);
    if (!declaredBy.success) {
      writeError(
        `--declared-by must be one of ${declarerRole.options.join('|')}; got "${args['declared-by']}"`,
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const store = new WorkItemStore(repoRoot);
    try {
      let result: Awaited<ReturnType<typeof writeWorkItemHandoff>>;
      try {
        result = await writeWorkItemHandoff(repoRoot, store, args.workId, {
          ...(args.base ? { base: args.base } : {}),
          ...(args.head ? { head: args.head } : {}),
          declaredBy: declaredBy.data,
        });
      } catch (err) {
        if (err instanceof InvalidBaseRefError || err instanceof InvalidHeadRefError) {
          writeError(err.message);
          process.exit(USAGE_ERROR_EXIT);
          return;
        }
        throw err;
      }
      if (format === 'json') {
        writeJson({
          work_item_id: args.workId,
          final_verdict: result.completion.final_verdict,
          handoff_path: result.handoffPath,
          completion_path: result.completionPath,
          base_used: result.baseUsed,
          changed_files: result.collectedChangedFiles,
        });
      } else {
        writeHuman(`Handoff for ${args.workId}`);
        writeHuman(`  final_verdict:  ${result.completion.final_verdict}`);
        writeHuman(`  base_used:      ${result.baseUsed ?? '(none)'}`);
        writeHuman(`  changed_files:  ${result.collectedChangedFiles.length}`);
        writeHuman(`  handoff:        ${result.handoffPath}`);
        writeHuman(`  completion.json: ${result.completionPath}`);
      }
    } catch (err) {
      writeError(`work handoff failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

const TERMINAL_STATUSES = ['done', 'abandoned'] as const;

const workAbandon = defineCommand({
  meta: {
    name: 'abandon',
    description: 'Close a work item as abandoned (give up; no evidence required)',
  },
  args: {
    workId: { type: 'positional', description: 'Work item id to abandon', required: true },
    'comment-issue': {
      type: 'boolean',
      description:
        'Post a result-summary comment to the linked GitHub issue + reflect the abandoned status on the Project board (G4/G5). No-op when no issue is linked.',
      default: false,
    },
    'close-issue': {
      type: 'boolean',
      description:
        'Also CLOSE the linked GitHub issue (implies --comment-issue). The only path that closes an issue.',
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
    const store = new WorkItemStore(repoRoot);
    try {
      const cur = await store.get(args.workId);
      if (cur.status === 'done' || cur.status === 'abandoned') {
        writeError(`work ${args.workId} is already terminal (status=${cur.status})`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const closed = await store.close(args.workId, 'abandoned');
      // G4/G5 reflection AFTER the terminal close lands (explicit flag opt-in;
      // never throws, so a gh failure can't undo the abandon).
      const closeIssue = args['close-issue'] === true;
      if (args['comment-issue'] === true || closeIssue) {
        await reflectManualTermination(repoRoot, closed, 'abandoned', { closeIssue });
      }
      if (format === 'json') {
        writeJson({ id: closed.id, status: closed.status, closed_at: closed.closed_at });
      } else {
        writeHuman(
          `Abandoned ${closed.id} (was ${cur.status}). Archive with: ditto work archive <label>`,
        );
      }
    } catch (err) {
      writeError(`work abandon failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

const workReopen = defineCommand({
  meta: {
    name: 'reopen',
    description:
      'Reopen a terminal work item (done|abandoned) back to in_progress — the inverse of done/abandon (e.g. to re-close to a different terminal state). No evidence required.',
  },
  args: {
    workId: { type: 'positional', description: 'Work item id to reopen', required: true },
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
    const store = new WorkItemStore(repoRoot);
    try {
      const reopened = await store.reopen(args.workId);
      if (format === 'json') {
        writeJson({ id: reopened.id, status: reopened.status });
      } else {
        writeHuman(`Reopened ${reopened.id} (now ${reopened.status}).`);
      }
    } catch (err) {
      writeError(`work reopen failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

const PARK_STATUSES = ['partial', 'blocked'] as const;

const workDone = defineCommand({
  meta: {
    name: 'done',
    description:
      'Close a work item: done (completion final_verdict=pass evidence gate), or --status partial|blocked to park it as resumable with re_entry',
  },
  args: {
    workId: { type: 'positional', description: 'Work item id to mark done', required: true },
    status: {
      type: 'string',
      description:
        'Park as a resumable status instead of done: partial|blocked. Requires --re-entry-command or --needs (re_entry is mandatory for these statuses).',
      required: false,
    },
    're-entry-command': {
      type: 'string',
      description: 'Concrete command to resume work, recorded in re_entry.command (with --status)',
      required: false,
    },
    needs: {
      type: 'string',
      description:
        'Semicolon-separated evidence still needed before resuming → re_entry.fresh_evidence_needed (with --status)',
      required: false,
    },
    'override-heavy': {
      type: 'boolean',
      description:
        'Allow the lightweight close on a declared-risk WI without going through the heavy (deep-interview) path. Requires --reason; the reason is recorded as an auditable risk note.',
      default: false,
    },
    reason: {
      type: 'string',
      description:
        'Why a lightweight close is acceptable for a declared-risk WI (with --override-heavy)',
      required: false,
    },
    'comment-issue': {
      type: 'boolean',
      description:
        'Post a result-summary comment to the linked GitHub issue + reflect the done status on the Project board (G4/G5). No-op when no issue is linked.',
      default: false,
    },
    'close-issue': {
      type: 'boolean',
      description:
        'Also CLOSE the linked GitHub issue (implies --comment-issue). The only path that closes an issue.',
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
    const store = new WorkItemStore(repoRoot);
    const completions = new CompletionStore(repoRoot);

    // Park path (ac-2 B): close as a resumable partial/blocked status instead of
    // done. Distinct from the evidence-gated pass close below — a partially-done
    // WI that cannot be verified is parked, not forced into a false done/abandon.
    if (args.status !== undefined) {
      if (!(PARK_STATUSES as readonly string[]).includes(args.status)) {
        writeError(
          `--status must be one of ${PARK_STATUSES.join('|')} (to park a resumable WI); got "${args.status}". Omit --status to close as done.`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const command = args['re-entry-command'];
      const needs = args.needs ? parseCriteriaStatements(args.needs) : [];
      if (!command && needs.length === 0) {
        writeError(
          `--status ${args.status} requires re_entry: pass --re-entry-command "<resume cmd>" and/or --needs "<evidence; …>".`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      try {
        const parked = await store.park(args.workId, args.status as 'partial' | 'blocked', {
          ...(command ? { command } : {}),
          fresh_evidence_needed: needs,
        });
        if (format === 'json') {
          writeJson({ id: parked.id, status: parked.status, re_entry: parked.re_entry });
        } else {
          writeHuman(`Parked ${parked.id} as ${parked.status} (resumable).`);
          if (parked.re_entry?.command) writeHuman(`  resume: ${parked.re_entry.command}`);
          if ((parked.re_entry?.fresh_evidence_needed ?? []).length > 0)
            writeHuman(`  needs:  ${parked.re_entry?.fresh_evidence_needed.join(', ')}`);
        }
      } catch (err) {
        writeError(
          `work done --status failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(USAGE_ERROR_EXIT);
      }
      return;
    }
    try {
      const item = await store.get(args.workId); // throws with a clear error if unknown
      // ac-4 C: an additional precondition (does NOT weaken the evidence gate
      // below). A self-caused high/critical bug discovered during this WI must be
      // resolved or fixed before the WI can close — you do not close work that
      // shipped its own high-severity regression.
      const blocking = blockingFollowUp(item);
      if (blocking) {
        writeError(
          `work ${args.workId} cannot close: unresolved self-caused ${blocking.severity}-severity bug follow-up "${blocking.note}"${
            blocking.materialized_wi ? ` (tracked as ${blocking.materialized_wi})` : ''
          }. Fix it, or mark the follow-up resolved, before closing.`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      // Evidence gate: done requires a completion contract with final_verdict=pass.
      // If none exists — a work item fixed directly, outside the autopilot pipeline
      // (wi_2606200ec) — synthesize one from the work item's OWN acceptance
      // verdicts/evidence (populated by `ditto verify`) through the SAME
      // buildCompletion + completionGate + completionEvidenceGate the autopilot path
      // uses. One evidence gate, no weaker parallel path; no intent.json/graph needed.
      if (!(await completions.exists(args.workId))) {
        const placeholders = item.acceptance_criteria.filter(
          (c) => c.statement === PLACEHOLDER_AC_STATEMENT,
        );
        if (placeholders.length > 0) {
          writeError(
            `work ${args.workId} still has placeholder acceptance criteria (${placeholders
              .map((c) => c.id)
              .join(
                ', ',
              )}) — lock real criteria via /ditto:deep-interview, or \`ditto work abandon\` to give up`,
          );
          process.exit(USAGE_ERROR_EXIT);
          return;
        }
        // ac-3 C: a declared-risk WI must not close silently on the lightweight
        // synthesis path (no intent.json = the heavy review never ran). Block
        // unless an explicit, recorded override is given. A WI that went heavy
        // (intent.json present) is unaffected — its review already happened.
        if (hasDeclaredRisk(item) && !(await new IntentStore(repoRoot).exists(args.workId))) {
          const overrideHeavy = args['override-heavy'] === true;
          if (!overrideHeavy) {
            writeError(
              `work ${args.workId} declares risk (${RISK_FLAGS.filter(
                (f) => item.declared_risk?.[f] === true,
              ).join(
                ', ',
              )}) but has no intent.json — the lightweight close skips the heavy review. Run /ditto:deep-interview (or \`ditto work promote ${args.workId}\`), or override with \`ditto work done ${args.workId} --override-heavy --reason "<why light is acceptable>"\`.`,
            );
            process.exit(USAGE_ERROR_EXIT);
            return;
          }
          if (!args.reason) {
            writeError(
              '--override-heavy requires --reason "<why a lightweight close is acceptable for this declared-risk WI>"',
            );
            process.exit(USAGE_ERROR_EXIT);
            return;
          }
          // Persist the override as an auditable risk note (not just printed).
          await store.update(args.workId, (cur) => ({
            ...cur,
            risks: [
              ...cur.risks,
              {
                description: `lightweight-close override (declared_risk present): ${args.reason}`,
                severity: 'medium' as const,
              },
            ],
          }));
        }
        const synthesized = assembleCompletionFromWorkItem(item, {
          declaredBy: 'main',
          summary: `Closed via lightweight completion path (ditto verify evidence) for ${args.workId}.`,
        });
        const gateReasons = [
          ...completionGate(item, synthesized).reasons,
          ...completionEvidenceGate(synthesized).reasons,
        ];
        if (synthesized.final_verdict !== 'pass' || gateReasons.length > 0) {
          const notPass = synthesized.acceptance
            .filter((a) => a.verdict !== 'pass')
            .map((a) => a.criterion_id);
          const detail =
            gateReasons.length > 0
              ? gateReasons.join('; ')
              : `not-pass criteria: ${notPass.join(', ')}`;
          writeError(
            `work ${args.workId} cannot close: ${detail}. Verify each criterion with \`ditto verify ${args.workId} --criterion <ac> -- <command>\`, or \`ditto work abandon\`.`,
          );
          process.exit(USAGE_ERROR_EXIT);
          return;
        }
        await completions.write(synthesized);
      }
      const completion = await completions.get(args.workId);
      if (completion.final_verdict !== 'pass') {
        writeError(
          `work ${args.workId} completion final_verdict=${completion.final_verdict} (not pass) — cannot mark done`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      // wi_260627273: mirror the completion's per-AC verdicts + evidence back onto
      // the work item BEFORE the close flip, so `work status`/`push-ready` read the
      // verified state instead of the stale `unverified` the criteria were created
      // with. Idempotent; a non-pass verdict is copied as-is (this done path only
      // reaches here on final_verdict=pass, but the mirror stays verdict-faithful).
      await store.update(args.workId, (cur) => mirrorAcceptanceVerdicts(cur, completion));
      const closed = await store.close(args.workId, 'done');
      // G4/G5 reflection AFTER the terminal close lands (explicit flag opt-in; never
      // throws, so a gh failure can't undo the done). `closed` carries the mirrored
      // verdicts, so the posted comment shows the verified state.
      const closeIssue = args['close-issue'] === true;
      if (args['comment-issue'] === true || closeIssue) {
        await reflectManualTermination(repoRoot, closed, 'done', { closeIssue, completion });
      }
      if (format === 'json') {
        writeJson({ id: closed.id, status: closed.status, closed_at: closed.closed_at });
      } else {
        writeHuman(
          `Done ${closed.id} (completion final_verdict=pass). Archive with: ditto work archive <label>`,
        );
      }
    } catch (err) {
      writeError(`work done failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

const workPromote = defineCommand({
  meta: {
    name: 'promote',
    description:
      'Upgrade a lightweight work item to the heavy (deep-interview) path IN PLACE — preserves the existing criteria, verdicts, evidence, and the WI id (no abandon+recreate)',
  },
  args: {
    workId: { type: 'positional', description: 'Work item id to promote', required: true },
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
    const store = new WorkItemStore(repoRoot);
    try {
      // In-place: set the heavy-path marker only. acceptance_criteria, verdicts,
      // evidence, and the id are left untouched (no reset to placeholder), so a WI
      // that already has real criteria carries them into the heavy path with no
      // data loss. The marker keeps the risk-driven heavy nudge firing.
      const promoted = await store.update(args.workId, (cur) => ({
        ...cur,
        promoted_to_heavy: true,
      }));
      if (format === 'json') {
        writeJson({
          work_item_id: promoted.id,
          promoted_to_heavy: promoted.promoted_to_heavy === true,
          acceptance_criteria: promoted.acceptance_criteria.map((c) => c.id),
        });
      } else {
        writeHuman(`Promoted ${promoted.id} to the heavy path (criteria + id preserved).`);
        writeHuman('Next: /ditto:deep-interview to deepen the existing criteria.');
      }
    } catch (err) {
      writeError(`work promote failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

// ac-4: the follow-up capture kinds. bug = a defect (materialized into a tracked
// WI); idea = a candidate only (not materialized).
const FOLLOW_UP_KINDS = ['bug', 'idea'] as const;

const workFollowUp = defineCommand({
  meta: {
    name: 'follow-up',
    description:
      'Capture a discovered follow-up on a work item (--kind bug|idea --note ...), or clear one with --resolve <n>: --kind bug materializes a tracked, back-linked WI; --kind idea records a candidate only',
  },
  args: {
    workId: {
      type: 'positional',
      description: 'Source work item the follow-up was discovered on',
      required: true,
    },
    kind: {
      type: 'string',
      description: 'bug|idea — a bug materializes a tracked WI; an idea is a candidate only',
      required: false,
    },
    note: { type: 'string', description: 'What was discovered', required: false },
    resolve: {
      type: 'string',
      description:
        'Clear an existing follow-up instead of appending: 1-based index n sets follow_ups[n].resolved=true (mutually exclusive with --kind/--note)',
      required: false,
    },
    severity: {
      type: 'string',
      description:
        'info|low|medium|high|critical — a self-caused high/critical bug blocks the source WI’s done',
      required: false,
    },
    'self-caused': {
      type: 'boolean',
      description: 'Mark a regression introduced by this work item itself',
      default: false,
    },
    batch: {
      type: 'boolean',
      description:
        'Materialize ALL captured out-of-scope follow-ups (intent.follow_up_candidates + unmaterialized idea follow_ups) into tracked, back-linked WIs on ONE approval; records the one-time approval in intent.follow_up_materialization (mutually exclusive with --kind/--note/--resolve)',
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
    const store = new WorkItemStore(repoRoot);

    // ── batch mode: materialize the WHOLE captured set of OUT-of-scope follow-ups
    // on ONE approval (ac-4, T1). The single `--kind bug` path below materializes
    // one bug per CLI call; this path takes the union of the intent sidecar's
    // `follow_up_candidates` (bare strings) and the WI's own unmaterialized idea
    // follow_ups, and turns each into a tracked, back-linked WI. A single
    // invocation IS the one-time batch approval — there is no per-item prompt
    // (per-item drip = SLOP). The approval + back-links are recorded in
    // intent.follow_up_materialization, which makes a re-run idempotent.
    // materialize != drive (R9): each created WI is a tracked record (status
    // 'draft'), never auto-started — auto-driving separate WIs is out of scope
    // (T3/ADR-0011 D2). Same-rooted sequential creation, no cross-root runner.
    if (args.batch === true) {
      if (args.kind !== undefined || args.note !== undefined || args.resolve !== undefined) {
        writeError(
          '--batch materializes all captured follow-ups at once and cannot be combined with --kind/--note/--resolve (one mode per invocation)',
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      try {
        const source = await store.get(args.workId); // clear error if the WI is unknown
        const intentStore = new IntentStore(repoRoot);
        if (!(await intentStore.exists(args.workId))) {
          writeError(
            `work follow-up --batch records the one-time approval in intent.json, but ${args.workId} has none (a lightweight work item). Capture follow-ups with --kind idea, or run /ditto:deep-interview first.`,
          );
          process.exit(USAGE_ERROR_EXIT);
          return;
        }
        const intent = await intentStore.get(args.workId);

        // Idempotent: the one-time batch already ran — the back-link is the record,
        // so a re-run is a no-op (no duplicate WIs).
        if (intent.follow_up_materialization?.batch_approved) {
          const already = intent.follow_up_materialization.materialized_wis;
          if (format === 'json') {
            writeJson({
              work_item_id: source.id,
              batch_approved: true,
              materialized_wis: already,
              already_materialized: true,
            });
          } else {
            writeHuman(
              `Batch already materialized for ${source.id}: ${already.length} work item(s) — nothing to do.`,
            );
          }
          return;
        }

        // Candidate set = intent.follow_up_candidates (bare strings, no parent entry
        // yet) ∪ the WI's own unmaterialized idea follow_ups (candidate-only entries;
        // bugs are already materialized by the single path, resolved ones are done).
        const stringCandidates = intent.follow_up_candidates;
        const ideaIndexes = (source.follow_ups ?? [])
          .map((f, i) => ({ f, i }))
          .filter(({ f }) => f.kind === 'idea' && !f.materialized_wi && f.resolved !== true);

        if (stringCandidates.length === 0 && ideaIndexes.length === 0) {
          if (format === 'json') {
            writeJson({ work_item_id: source.id, batch_approved: true, materialized_wis: [] });
          } else {
            writeHuman(`No captured out-of-scope follow-ups to materialize for ${source.id}.`);
          }
          return;
        }

        const materializeOne = async (note: string): Promise<string> => {
          const created = await store.create({
            title: `follow-up: ${note}`.slice(0, 200),
            source_request: `Out-of-scope follow-up discovered while working on ${source.id}: ${note}`,
            goal: note,
            acceptance_criteria: [
              {
                id: 'ac-1',
                statement: PLACEHOLDER_AC_STATEMENT,
                verdict: 'unverified' as const,
                evidence: [],
              },
            ],
            discovered_by: source.id,
          });
          return created.id;
        };

        const materializedWis: string[] = [];
        // (1) bare string candidates → new WI + an APPENDED parent follow_up entry.
        const appended: FollowUp[] = [];
        for (const note of stringCandidates) {
          const newId = await materializeOne(note);
          materializedWis.push(newId);
          appended.push({ kind: 'idea', note, materialized_wi: newId });
        }
        // (2) existing idea follow_ups → new WI + STAMP that entry's back-link.
        const stampedByIndex = new Map<number, string>();
        for (const { f, i } of ideaIndexes) {
          const newId = await materializeOne(f.note);
          materializedWis.push(newId);
          stampedByIndex.set(i, newId);
        }

        // Two-sided provenance (parent side): stamp the existing idea entries and
        // append the new string-candidate entries, each back-linking its WI. The
        // child side (discovered_by) was stamped by store.create above.
        await store.update(args.workId, (cur) => ({
          ...cur,
          follow_ups: [
            ...(cur.follow_ups ?? []).map((f, i) =>
              stampedByIndex.has(i) ? { ...f, materialized_wi: stampedByIndex.get(i) } : f,
            ),
            ...appended,
          ],
        }));

        // Record the one-time batch approval + back-links in the intent sidecar.
        await intentStore.write({
          ...intent,
          follow_up_materialization: { batch_approved: true, materialized_wis: materializedWis },
        });

        if (format === 'json') {
          writeJson({
            work_item_id: source.id,
            batch_approved: true,
            materialized_wis: materializedWis,
          });
        } else {
          writeHuman(
            `Batch-materialized ${materializedWis.length} out-of-scope follow-up(s) on one approval for ${source.id} (discovered_by ${source.id}); created: ${materializedWis.join(', ')}`,
          );
        }
      } catch (err) {
        writeError(
          `work follow-up --batch failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(USAGE_ERROR_EXIT);
      }
      return;
    }

    // ── resolve mode: clear an existing follow-up (1-based index). Mutually
    // exclusive with append (--kind/--note). This is the CLI path that clears the
    // Part C done-block; index is 1-based (human-facing), so n=1 is the first entry.
    if (args.resolve !== undefined) {
      if (args.kind !== undefined || args.note !== undefined) {
        writeError(
          '--resolve clears an existing follow-up and cannot be combined with --kind/--note (one mode per invocation)',
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const raw = String(args.resolve).trim();
      if (!/^\d+$/.test(raw)) {
        writeError(
          `--resolve must be a 1-based follow-up index (a positive integer); got "${args.resolve}"`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      const n = Number(raw);
      try {
        const item = await store.get(args.workId); // clear error if the WI is unknown
        const count = (item.follow_ups ?? []).length;
        if (n < 1 || n > count) {
          writeError(
            `--resolve ${n} is out of range: work ${args.workId} has ${count} follow-up(s) — valid range is 1..${count} (1-based)`,
          );
          process.exit(USAGE_ERROR_EXIT);
          return;
        }
        const idx = n - 1;
        const updated = await store.update(args.workId, (cur) => ({
          ...cur,
          follow_ups: (cur.follow_ups ?? []).map((f, i) =>
            i === idx ? { ...f, resolved: true } : f,
          ),
        }));
        const cleared = updated.follow_ups?.[idx];
        if (format === 'json') {
          writeJson({ work_item_id: updated.id, resolved_index: n, note: cleared?.note });
        } else {
          writeHuman(`Resolved follow-up ${n} on ${updated.id}: ${cleared?.note ?? ''}`);
        }
      } catch (err) {
        writeError(`work follow-up failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(USAGE_ERROR_EXIT);
      }
      return;
    }

    // ── append mode (default): record a new follow-up.
    if (args.kind === undefined) {
      writeError(
        '--kind is required (bug|idea) when appending a follow-up — or use --resolve <n> to clear an existing one',
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    if (!(FOLLOW_UP_KINDS as readonly string[]).includes(args.kind)) {
      writeError(`--kind must be one of ${FOLLOW_UP_KINDS.join('|')}; got "${args.kind}"`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const kind = args.kind as 'bug' | 'idea';
    const note = typeof args.note === 'string' ? args.note.trim() : '';
    if (note.length === 0) {
      writeError('--note must be a non-empty description of the follow-up');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    let severity: FollowUp['severity'];
    if (args.severity !== undefined) {
      const parsed = severityLevel.safeParse(args.severity);
      if (!parsed.success) {
        writeError(
          `--severity must be one of ${severityLevel.options.join('|')}; got "${args.severity}"`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      severity = parsed.data;
    }
    const selfCaused = args['self-caused'] === true;
    try {
      const source = await store.get(args.workId); // clear error if the source is unknown
      // (B) A bug is real, tracked work: materialize it into its OWN work item,
      // back-linked to the source via the `discovered_by` provenance field (kept
      // distinct from parent_id). An idea is a candidate only — no WI created.
      let materializedWi: string | undefined;
      if (kind === 'bug') {
        const created = await store.create({
          title: `bug: ${note}`.slice(0, 200),
          source_request: `Discovered while working on ${source.id}: ${note}`,
          goal: `Fix: ${note}`,
          acceptance_criteria: [
            {
              id: 'ac-1',
              statement: PLACEHOLDER_AC_STATEMENT,
              verdict: 'unverified' as const,
              evidence: [],
            },
          ],
          discovered_by: source.id,
        });
        materializedWi = created.id;
      }
      const entry: FollowUp = {
        kind,
        note,
        ...(severity ? { severity } : {}),
        ...(selfCaused ? { self_caused: true } : {}),
        ...(materializedWi ? { materialized_wi: materializedWi } : {}),
      };
      const updated = await store.update(args.workId, (cur) => ({
        ...cur,
        follow_ups: [...(cur.follow_ups ?? []), entry],
      }));
      if (format === 'json') {
        writeJson({
          work_item_id: updated.id,
          kind,
          note,
          ...(severity ? { severity } : {}),
          ...(materializedWi ? { materialized_wi: materializedWi } : {}),
        });
      } else {
        writeHuman(`Recorded ${kind} follow-up on ${updated.id}: ${note}`);
        if (materializedWi)
          writeHuman(`  materialized bug into ${materializedWi} (discovered_by ${updated.id})`);
      }
    } catch (err) {
      writeError(`work follow-up failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

const workStem = defineCommand({
  meta: {
    name: 'stem',
    description:
      'Work with a chain of related work items (the lineage formed by `follows` edges): --follows <prev> wires this WI to its predecessor; with no flag, show the derived chain; --close rolls the chain up once every member is terminal',
  },
  args: {
    workId: {
      type: 'positional',
      description: 'A work item anywhere in the chain',
      required: true,
    },
    follows: {
      type: 'string',
      description:
        'Wire <workId> to continue from this predecessor (chain lineage). Rejected if it would create a cycle.',
      required: false,
    },
    close: {
      type: 'boolean',
      description:
        'Roll the chain up: requires every member terminal (done/abandoned); emits the rolled-up verdict (all done → done; any abandoned → partial). Rejects and lists any non-terminal member.',
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
    const close = args.close === true;
    // --follows (set one edge) and --close (roll the whole chain up) are distinct
    // operations; combining them is ambiguous about what would mutate.
    if (args.follows !== undefined && close) {
      writeError('work stem takes either --follows <prev> or --close, not both');
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const store = new WorkItemStore(repoRoot);

    // ── set-edge mode: wire <workId> to continue from <follows>. Cycle-guarded.
    if (args.follows !== undefined) {
      const prev = args.follows;
      try {
        await store.get(args.workId); // clear error if <workId> is unknown
        if (!(await store.exists(prev))) {
          writeError(`--follows predecessor ${prev} does not exist`);
          process.exit(USAGE_ERROR_EXIT);
          return;
        }
        // A cycle would form iff <prev> already reaches <workId> (or is <workId>
        // itself) by walking its own `follows` chain upward.
        const prevAncestors = await store.chainAncestors(prev);
        if (prev === args.workId || prevAncestors.includes(args.workId)) {
          writeError(
            `--follows ${prev} would create a cycle (${args.workId} already precedes ${prev} in the chain); no write`,
          );
          process.exit(USAGE_ERROR_EXIT);
          return;
        }
        const updated = await store.update(args.workId, (cur) => ({ ...cur, follows: prev }));
        if (format === 'json') {
          writeJson({ work_item_id: updated.id, follows: updated.follows });
        } else {
          writeHuman(`Wired ${updated.id} to follow ${prev} (chain lineage).`);
        }
      } catch (err) {
        writeError(`work stem failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(USAGE_ERROR_EXIT);
      }
      return;
    }

    // ── close mode: roll the chain up. Every member must already be terminal
    // (done/abandoned) — the members are closed individually first; --close is the
    // chain-level assertion + rolled-up verdict, it does NOT itself archive or
    // mutate. If any member is non-terminal, reject and list those members.
    if (close) {
      try {
        const view = await store.stem(args.workId);
        const nonTerminal = view.members.filter(
          (m) => !(TERMINAL_STATUSES as readonly string[]).includes(m.status),
        );
        if (nonTerminal.length > 0) {
          writeError(
            `work stem ${args.workId} cannot close: ${nonTerminal.length} non-terminal member(s) — ${nonTerminal
              .map((m) => `${m.id}=${m.status}`)
              .join(', ')}. Close (done/abandon) each before rolling the chain up.`,
          );
          process.exit(USAGE_ERROR_EXIT);
          return;
        }
        if (format === 'json') {
          writeJson({ rolled_up: view.rolled_up, members: view.members });
        } else {
          writeHuman(
            `Chain rolled up for ${args.workId}: ${view.rolled_up} (${view.members.length} member(s)).`,
          );
          for (const m of view.members) writeHuman(`  ${m.id}\t${m.status}`);
        }
      } catch (err) {
        writeError(`work stem failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(USAGE_ERROR_EXIT);
      }
      return;
    }

    // ── view mode (default): show the derived chain, root → tip, + rolled-up line.
    try {
      const view = await store.stem(args.workId);
      if (format === 'json') {
        writeJson({ members: view.members, rolled_up: view.rolled_up });
      } else {
        writeHuman(`Chain for ${args.workId} (rolled_up: ${view.rolled_up}):`);
        for (const m of view.members) writeHuman(`  ${m.id}\t${m.status}`);
      }
    } catch (err) {
      writeError(`work stem failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

const workPushReady = defineCommand({
  meta: {
    name: 'push-ready',
    description:
      'PULL-ONLY: report whether a work item meets the STRONG push-readiness bar (every AC pass + real command evidence + no unresolved self-caused high/critical follow-up + a fully-done stem chain). Surfaces ready + reasons ONLY when you ask; ditto never proposes a push itself (push is your irreversible decision).',
  },
  args: {
    workId: {
      type: 'positional',
      description: 'Work item id to check push-readiness for',
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
    const repoRoot = await resolveRepoRootForCreate();
    const store = new WorkItemStore(repoRoot);
    try {
      const item = await store.get(args.workId); // clear error if the WI is unknown
      // Pass the derived chain so condition 4 (a half-finished stem is not
      // push-ready) can apply; pushReadiness ignores a single-member stem.
      const stem = await store.stem(args.workId);
      const result = pushReadiness(item, stem);
      if (format === 'json') {
        writeJson({ ready: result.ready, reasons: result.reasons });
      } else {
        writeHuman(`push-ready: ${result.ready}`);
        if (result.reasons.length > 0) {
          writeHuman('not ready because:');
          for (const reason of result.reasons) writeHuman(`  - ${reason}`);
        }
      }
    } catch (err) {
      writeError(`work push-ready failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

const workArchive = defineCommand({
  meta: {
    name: 'archive',
    description:
      'Move terminal (done/abandoned) work items to .ditto/local/archive/<label> (ADR-0005 D3)',
  },
  args: {
    label: {
      type: 'positional',
      description: 'Archive label / batch name (e.g. 2026-Q2). [A-Za-z0-9._-]+',
      required: true,
    },
    'dry-run': {
      type: 'boolean',
      description: 'List what would move without moving',
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
    const store = new WorkItemStore(repoRoot);
    try {
      if (args['dry-run']) {
        const candidates = (await store.list()).filter((s) =>
          (TERMINAL_STATUSES as readonly string[]).includes(s.status),
        );
        if (format === 'json') {
          writeJson({
            dry_run: true,
            label: args.label,
            would_archive: candidates.map((c) => c.id),
          });
        } else {
          writeHuman(`dry-run: ${candidates.length} item(s) would move to archive/${args.label}:`);
          for (const c of candidates) writeHuman(`  ${c.id}\t${c.status}\t${c.title}`);
        }
        return;
      }
      const moved = await store.archive(args.label);
      if (format === 'json') {
        writeJson({ label: args.label, archived: moved });
      } else {
        writeHuman(`Archived ${moved.length} item(s) to .ditto/local/archive/${args.label}.`);
        for (const id of moved) writeHuman(`  ${id}`);
      }
    } catch (err) {
      writeError(`work archive failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

const workChainDrive = defineCommand({
  meta: {
    name: 'drive',
    description:
      'Drive a follows-stem sequentially (root→tip): resolves the linear spine through <wi>, drives each non-terminal intent-locked member through its autopilot, skipping done members and resuming from the first non-terminal one. Halts (with a per-member verdict) on a missing intent.json, an abandoned member, or a member that ends not-done. Reports push-readiness on full completion; pushes ONLY with --push (never unasked, never force).',
  },
  args: {
    workId: {
      type: 'positional',
      description: 'A work item anywhere in the chain',
      required: true,
    },
    push: {
      type: 'boolean',
      description:
        'On a fully-done, push-ready chain, push the current branch HEAD to origin (no force; any push failure degrades to skipped, exit 0). Default: report push-readiness without pushing.',
      default: false,
    },
    'max-depth': {
      type: 'string',
      description: `Max members driven per invocation (stop-at-cap with a report; default ${DEFAULT_MAX_DEPTH})`,
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
    // INPUT (security): validate the id shape BEFORE any path/subprocess use — the
    // store trusts its caller and localDir does a bare join, so a malformed/`../`
    // id must be rejected at the entry.
    const idCheck = workItemId.safeParse(args.workId);
    if (!idCheck.success) {
      writeError(`invalid work item id "${args.workId}": ${idCheck.error.issues[0]?.message}`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    let maxDepth = DEFAULT_MAX_DEPTH;
    if (args['max-depth'] !== undefined) {
      const raw = String(args['max-depth']).trim();
      if (!/^\d+$/.test(raw) || Number(raw) < 1) {
        writeError(`--max-depth must be a positive integer; got "${args['max-depth']}"`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      maxDepth = Number(raw);
    }
    const repoRoot = await resolveRepoRootForCreate();
    const store = new WorkItemStore(repoRoot);
    const intentStore = new IntentStore(repoRoot);
    try {
      // Verify it is a real, known member before driving anything.
      await store.get(idCheck.data);
      const result = await driveChain(
        {
          store,
          intentExists: (id) => intentStore.exists(id),
          driveMember: productionDriveMember,
          attemptPush: (members) => productionAttemptPush(repoRoot, members),
        },
        { workId: idCheck.data, push: args.push === true, maxDepth },
      );
      if (format === 'json') {
        writeJson(result);
      } else {
        writeHuman(`Chain drive ${result.work_id} (rolled_up: ${result.rolled_up}):`);
        for (const e of result.ledger) {
          writeHuman(`  ${e.member_id}\t${e.disposition}${e.reason ? `\t(${e.reason})` : ''}`);
        }
        if (result.halted_member) writeHuman(`  HALTED at ${result.halted_member}`);
        if (result.stopped_at_cap)
          writeHuman(`  stopped at depth cap (${maxDepth}) — re-invoke to continue`);
        writeHuman(`  push_ready: ${result.push_ready}`);
        writeHuman(`  push: ${result.push}`);
      }
    } catch (err) {
      if (err instanceof BranchedStemError) {
        writeError(`work chain drive failed: ${err.message}`);
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      writeError(`work chain drive failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

const workChain = defineCommand({
  meta: {
    name: 'chain',
    description:
      'Drive a chain (follows-stem) of related work items end-to-end (subcommand: drive)',
  },
  subCommands: {
    drive: workChainDrive,
  },
});

const workLinkIssue = defineCommand({
  meta: {
    name: 'link-issue',
    description:
      'Link an EXISTING work item to a GitHub issue coordinate (owner/repo#n). Idempotent — the same coord twice is a no-op. A cross-repo coord is allowed (backlog link/display; execution stays per-repo, ADR-0011).',
  },
  args: {
    workId: { type: 'positional', description: 'Work item id to link', required: true },
    issue: {
      type: 'positional',
      description: 'GitHub issue coordinate: owner/repo#n',
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
    const coord = parseIssueCoord(args.issue);
    if (coord === null) {
      writeError(
        `<issue> must be an owner/repo#n coordinate (e.g. octo/app#42); got "${args.issue}"`,
      );
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const repoRoot = await resolveRepoRootForCreate();
    const store = new WorkItemStore(repoRoot);
    try {
      // Best-effort project_item_id population from the configured board (ac-5 target).
      const ghConfig = await readGithubConfig(repoRoot);
      const result = await linkIssue(store, args.workId, coord, {
        client: createGhClient(),
        config: ghConfig,
      });
      if (result.kind === 'conflict') {
        writeError(
          `work ${args.workId} is already linked to ${result.existing.repo}#${result.existing.number} (1 work item ↔ 1 issue, v1). Unlink is not supported in v1; create a separate work item for ${coord.repo}#${coord.number}.`,
        );
        process.exit(USAGE_ERROR_EXIT);
        return;
      }
      if (format === 'json') {
        writeJson({
          work_item_id: result.id,
          github_issue: { repo: coord.repo, number: coord.number },
          already_linked: result.alreadyLinked,
        });
      } else if (result.alreadyLinked) {
        writeHuman(
          `${args.workId} is already linked to ${coord.repo}#${coord.number} — no change.`,
        );
      } else {
        writeHuman(`Linked ${args.workId} to ${coord.repo}#${coord.number}.`);
      }
    } catch (err) {
      writeError(`work link-issue failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

const workMirrorHierarchy = defineCommand({
  meta: {
    name: 'mirror-hierarchy',
    description:
      "Mirror an EXISTING GitHub issue's sub-issue / task-list hierarchy into the work items' parent_id/child_ids. The <workId> must already be linked to the parent issue (`ditto work link-issue`). Resolution order: graphql sub-issues read → task-list `- [ ] #n` parse → manual degrade. ditto creates NO issues or work items — it only relates work items already linked to the child issues (an unlinked child issue is skipped).",
  },
  args: {
    workId: {
      type: 'positional',
      description: 'Work item id linked to the PARENT GitHub issue',
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
    const repoRoot = await resolveRepoRootForCreate();
    const store = new WorkItemStore(repoRoot);
    try {
      const result = await mirrorHierarchy({ client: createGhClient(), store }, args.workId);
      if (result.kind === 'degraded') {
        // Manual-input degrade (ADR-0018): NOT an error exit — the caller wires the
        // hierarchy by hand. Surface the notice so the skip is visible.
        if (format === 'json') {
          writeJson({
            work_item_id: args.workId,
            mirrored: false,
            reason: result.reason,
            detail: result.detail,
          });
        } else {
          writeHuman(
            `No hierarchy mirrored for ${args.workId}: gh ${result.reason} (${result.detail}). Wire parent_id/child_ids manually if needed.`,
          );
        }
        return;
      }
      if (format === 'json') {
        writeJson({
          work_item_id: result.parent_id,
          mirrored: true,
          source: result.source,
          child_work_ids: result.child_work_ids,
          child_issue_numbers: result.child_issue_numbers,
          unlinked_child_issues: result.unlinked_child_issues,
        });
      } else {
        writeHuman(
          `Mirrored ${result.child_work_ids.length} child(ren) onto ${result.parent_id} via ${result.source}.`,
        );
        for (const id of result.child_work_ids) writeHuman(`  child: ${id}`);
        if (result.unlinked_child_issues.length > 0) {
          writeHuman(
            `  skipped (no linked work item): #${result.unlinked_child_issues.join(', #')}`,
          );
        }
      }
    } catch (err) {
      writeError(
        `work mirror-hierarchy failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

const workSyncIssue = defineCommand({
  meta: {
    name: 'sync-issue',
    description:
      'Roll up UNPOSTED autopilot decisions (escalations / batch-escalations / blocked terminations) and post them to the linked GitHub issue in ONE comment (G8). Posts unposted-only (idempotent — already-posted decisions are skipped); routine churn (retry/auto_fix/surface) is excluded. No-op when nothing new. No linked issue (own or parent) → skip + notice, not an error.',
  },
  args: {
    workId: { type: 'positional', description: 'Work item id to sync', required: true },
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
    const store = new WorkItemStore(repoRoot);
    try {
      const res = await postUnpostedDecisions(
        { client: createGhClient(), store, aps: new AutopilotStore(repoRoot) },
        args.workId,
      );
      if (format === 'json') {
        writeJson(res);
        return;
      }
      switch (res.kind) {
        case 'posted':
          writeHuman(
            `Posted ${res.posted_ids.length} decision(s) to ${res.target.repo}#${res.target.number} in one comment.`,
          );
          break;
        case 'no_new':
          writeHuman(
            `No new decisions to post for ${args.workId} — already in sync with ${res.target.repo}#${res.target.number}.`,
          );
          break;
        case 'skipped':
          writeHuman(`  ${res.notice}`);
          break;
        case 'degraded':
          writeHuman(`  ${res.notice}`);
          break;
      }
    } catch (err) {
      writeError(`work sync-issue failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
  },
});

export const workCommand = defineCommand({
  meta: {
    name: 'work',
    description: 'Manage work items (start, status, handoff, done, abandon, promote, archive)',
  },
  subCommands: {
    start: workStart,
    'link-issue': workLinkIssue,
    'mirror-hierarchy': workMirrorHierarchy,
    'sync-issue': workSyncIssue,
    'set-criteria': workSetCriteria,
    status: workStatus,
    handoff: workHandoff,
    done: workDone,
    abandon: workAbandon,
    reopen: workReopen,
    promote: workPromote,
    'follow-up': workFollowUp,
    stem: workStem,
    chain: workChain,
    'push-ready': workPushReady,
    archive: workArchive,
  },
});
