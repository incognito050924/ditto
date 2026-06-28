import { execFileSync } from 'node:child_process';

/**
 * Injectable wrapper around the `gh` CLI (github-backlog-integration §8, OBJ-3).
 *
 * Two seams:
 *  - `createGhClient(exec)` — the live client; `exec` is the low-level argv→result
 *    seam so degradation can be tested without spawning `gh` (ac-7).
 *  - `createFakeGhClient()` — a high-level test double later nodes inject to assert
 *    call counts/args (ac-4 / ac-9 / ac-10).
 *
 * Degradation contract (ADR-0018, pre-mortem compat-version + external-env): ANY
 * wrapper-invocation failure — gh absent, unauth, insufficient perm, an old gh that
 * lacks a subcommand, a non-zero exit, unparseable output, or a network hang — is a
 * degradable condition. Every method returns a typed `GhDegradation` instead of
 * throwing, so no failure here can block an execution/completion path.
 *
 * No shell string is ever built: `exec` takes an argv array (see worktree.ts:126),
 * so a crafted repo/owner/body cannot shell-inject, and an `execFile` timeout caps
 * a network hang.
 */

/** Default per-call timeout; a network hang must not stall the caller (pre-mortem). */
export const DEFAULT_GH_TIMEOUT_MS = 30_000;

export type GhDegradeReason =
  | 'absent' // gh binary not found (ENOENT)
  | 'unauthenticated' // not logged in
  | 'rate_limited' // 403/429 secondary or primary rate limit — transient, surface retry/wait
  | 'insufficient_perm' // 403 / permission denied
  | 'unknown_command' // old gh lacks the subcommand/flag
  | 'timeout' // exec timed out — network-hang guard
  | 'unparseable' // exit 0 but output is not the expected shape
  | 'nonzero'; // any other non-zero exit / generic failure

export interface GhDegradation {
  ok: false;
  reason: GhDegradeReason;
  detail: string;
}

export type GhResult<T = void> = { ok: true; value: T } | GhDegradation;

/** Raw result of one `gh` invocation. `spawnError` marks a process that never ran
 *  (absent) or was killed (timeout) — distinct from one that ran and exited non-zero. */
export interface GhExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  spawnError?: 'absent' | 'timeout' | 'other';
}

/** The injectable exec seam: argv array, NO shell. Tests inject a fake to simulate
 *  every failure class. */
export type GhExec = (args: string[], timeoutMs: number) => GhExecResult;

/** Default exec — `execFileSync('gh', argv)`, no shell, with a timeout. */
export const defaultGhExec: GhExec = (args, timeoutMs) => {
  try {
    const stdout = execFileSync('gh', args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      status?: number | null;
      signal?: NodeJS.Signals | null;
      killed?: boolean;
      stdout?: Buffer | string | null;
      stderr?: Buffer | string | null;
    };
    if (e.code === 'ENOENT')
      return { exitCode: null, stdout: '', stderr: '', spawnError: 'absent' };
    if (e.killed && e.signal === 'SIGTERM') {
      return { exitCode: null, stdout: '', stderr: '', spawnError: 'timeout' };
    }
    const stdout = e.stdout == null ? '' : e.stdout.toString();
    const stderr = e.stderr == null ? '' : e.stderr.toString();
    return { exitCode: e.status ?? 1, stdout, stderr };
  }
};

/** Classify a failed invocation into a typed reason. Pure — string-matches gh's
 *  stderr; the `spawnError` cases short-circuit before any text match. */
export function classifyGhFailure(result: GhExecResult): GhDegradeReason {
  if (result.spawnError === 'absent') return 'absent';
  if (result.spawnError === 'timeout') return 'timeout';
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  if (
    /not logged in|gh auth login|authentication required|no oauth token|requires authentication/.test(
      text,
    )
  ) {
    return 'unauthenticated';
  }
  // Rate limit MUST be tested BEFORE the 403/perm branch: GitHub returns HTTP 403
  // (and sometimes 429) for a secondary/primary rate limit, which would otherwise
  // mis-classify as a permanent permission error. This is transient — surface
  // retry/wait guidance, NOT a retry loop (ADR-0018: a retry on a rate-limited
  // endpoint worsens it; the notice suffices).
  if (/rate limit|secondary rate limit|429|retry-after/.test(text)) {
    return 'rate_limited';
  }
  if (/http 403|permission|not accessible by|must have admin|forbidden|insufficient/.test(text)) {
    return 'insufficient_perm';
  }
  if (
    /unknown command|unknown flag|no such (sub)?command|accepts \d+ arg|not a gh command/.test(text)
  ) {
    return 'unknown_command';
  }
  return 'nonzero';
}

/** Extract assignee `login`s from an `issue view --json …,assignees` payload.
 *  Narrow-don't-cast (mirrors parseSubIssueNumbers / parseBoardPosition in work.ts):
 *  an `Array.isArray` guard + per-element `typeof` narrowing. A missing/empty/odd
 *  payload yields [], NEVER a throw — read-back stays inside the GhDegradation
 *  envelope (ADR-0018) so a malformed gh response cannot crash a claim check. */
export function parseAssigneeLogins(viewValue: unknown): string[] {
  const assignees = (viewValue as { assignees?: unknown })?.assignees;
  if (!Array.isArray(assignees)) return [];
  return assignees
    .map((a) => (a as { login?: unknown })?.login)
    .filter((l): l is string => typeof l === 'string' && l.length > 0);
}

/** True iff the invocation ran and exited cleanly (no spawn error, exit 0). Any
 *  other shape — spawn failure, null exit, or non-zero — is a degradable condition. */
function invocationOk(result: GhExecResult): boolean {
  return result.spawnError == null && result.exitCode === 0;
}

/** Build the typed degradation for a failed invocation (pre-mortem: every failure
 *  class — absent/unauth/rate-limit/perm/unknown-cmd/timeout/non-zero — maps to a reason). */
function degradationFor(result: GhExecResult): GhDegradation {
  const detail = (result.stderr || result.stdout || '').trim().slice(0, 200);
  return { ok: false, reason: classifyGhFailure(result), detail };
}

/** Run one invocation and reduce it to a degradable result: the raw stdout on
 *  success, a classified `GhDegradation` on ANY failure. Never throws. */
function run(exec: GhExec, args: string[], timeoutMs: number): GhResult<string> {
  const result = exec(args, timeoutMs);
  if (!invocationOk(result)) return degradationFor(result);
  return { ok: true, value: result.stdout };
}

function runJson<T>(exec: GhExec, args: string[], timeoutMs: number): GhResult<T> {
  const r = run(exec, args, timeoutMs);
  if ('reason' in r) return r;
  try {
    return { ok: true, value: JSON.parse(r.value) as T };
  } catch {
    return { ok: false, reason: 'unparseable', detail: r.value.slice(0, 200) };
  }
}

function toVoid(r: GhResult<string>): GhResult<void> {
  if ('reason' in r) return r;
  return { ok: true, value: undefined };
}

export interface ProjectItemEdit {
  projectId: string;
  itemId: string;
  fieldId: string;
  /** single-select option id (Projects v2 status). */
  optionId: string;
}

export interface GhClient {
  issueView(repo: string, issueNumber: number): GhResult<unknown>;
  issueComment(repo: string, issueNumber: number, body: string): GhResult<void>;
  issueClose(repo: string, issueNumber: number): GhResult<void>;
  /** `gh issue edit <n> --add-assignee <who>` — claim/assign (ac-1). `who` is an
   *  argv token (e.g. `@me`), never interpolated into a shell string. */
  issueAddAssignee(repo: string, issueNumber: number, assignee: string): GhResult<void>;
  /** `gh issue edit <n> --remove-assignee <who>` — unclaim (ac-7). Callers pass
   *  `@me` to remove ONLY the current actor; this never clears other assignees. */
  issueRemoveAssignee(repo: string, issueNumber: number, assignee: string): GhResult<void>;
  projectItemAdd(owner: string, projectNumber: number, contentUrl: string): GhResult<unknown>;
  projectItemEdit(edit: ProjectItemEdit): GhResult<void>;
  projectFieldList(owner: string, projectNumber: number): GhResult<unknown>;
  /** `gh project item-list` — read the board's CURRENT items + their single-select
   *  field values (status/priority), used to surface the board position (ac-6). */
  projectItemList(owner: string, projectNumber: number): GhResult<unknown>;
  /** `gh project view` — read the Project's metadata incl. its node id (`PVT_…`),
   *  which `project item-edit` needs as `--project-id` (captured by `github setup`). */
  projectView(owner: string, projectNumber: number): GhResult<unknown>;
  /** `gh api graphql` — used for sub-issue reads (gh has no native sub-issue cmd). */
  apiGraphql(query: string, fields?: Record<string, string>): GhResult<unknown>;
}

export function createGhClient(
  exec: GhExec = defaultGhExec,
  timeoutMs: number = DEFAULT_GH_TIMEOUT_MS,
): GhClient {
  return {
    issueView: (repo, issueNumber) =>
      runJson(
        exec,
        [
          'issue',
          'view',
          String(issueNumber),
          '-R',
          repo,
          '--json',
          'number,title,state,body,url,assignees',
        ],
        timeoutMs,
      ),
    issueComment: (repo, issueNumber, body) =>
      toVoid(
        run(exec, ['issue', 'comment', String(issueNumber), '-R', repo, '--body', body], timeoutMs),
      ),
    issueClose: (repo, issueNumber) =>
      toVoid(run(exec, ['issue', 'close', String(issueNumber), '-R', repo], timeoutMs)),
    issueAddAssignee: (repo, issueNumber, assignee) =>
      toVoid(
        run(
          exec,
          ['issue', 'edit', String(issueNumber), '-R', repo, '--add-assignee', assignee],
          timeoutMs,
        ),
      ),
    issueRemoveAssignee: (repo, issueNumber, assignee) =>
      toVoid(
        run(
          exec,
          ['issue', 'edit', String(issueNumber), '-R', repo, '--remove-assignee', assignee],
          timeoutMs,
        ),
      ),
    projectItemAdd: (owner, projectNumber, contentUrl) =>
      runJson(
        exec,
        [
          'project',
          'item-add',
          String(projectNumber),
          '--owner',
          owner,
          '--url',
          contentUrl,
          '--format',
          'json',
        ],
        timeoutMs,
      ),
    projectItemEdit: (edit) =>
      toVoid(
        run(
          exec,
          [
            'project',
            'item-edit',
            '--project-id',
            edit.projectId,
            '--id',
            edit.itemId,
            '--field-id',
            edit.fieldId,
            '--single-select-option-id',
            edit.optionId,
          ],
          timeoutMs,
        ),
      ),
    projectFieldList: (owner, projectNumber) =>
      runJson(
        exec,
        ['project', 'field-list', String(projectNumber), '--owner', owner, '--format', 'json'],
        timeoutMs,
      ),
    projectItemList: (owner, projectNumber) =>
      runJson(
        exec,
        ['project', 'item-list', String(projectNumber), '--owner', owner, '--format', 'json'],
        timeoutMs,
      ),
    projectView: (owner, projectNumber) =>
      runJson(
        exec,
        ['project', 'view', String(projectNumber), '--owner', owner, '--format', 'json'],
        timeoutMs,
      ),
    apiGraphql: (query, fields) => {
      const args = ['api', 'graphql', '-f', `query=${query}`];
      for (const [k, v] of Object.entries(fields ?? {})) args.push('-F', `${k}=${v}`);
      return runJson(exec, args, timeoutMs);
    },
  };
}

// ── Test double: high-level fake GhClient later nodes inject (ac-4/9/10) ─────────

export interface RecordedGhCall {
  method: keyof GhClient;
  args: unknown[];
}

export interface FakeGhClientOptions {
  /** When set, EVERY method returns this degradation instead of ok (simulate gh down). */
  degrade?: GhDegradation;
  /** Per-method canned ok value. */
  values?: Partial<Record<keyof GhClient, unknown>>;
}

/** A recording fake implementing `GhClient`. Returns ok by default; `degrade` makes
 *  every method return a degradation. Callers assert on `calls`. */
export function createFakeGhClient(options: FakeGhClientOptions = {}): {
  client: GhClient;
  calls: RecordedGhCall[];
} {
  const calls: RecordedGhCall[] = [];
  const make =
    (method: keyof GhClient) =>
    (...args: unknown[]): GhResult<unknown> => {
      calls.push({ method, args });
      if (options.degrade) return options.degrade;
      return { ok: true, value: options.values?.[method] };
    };
  const client = {
    issueView: make('issueView'),
    issueComment: make('issueComment'),
    issueClose: make('issueClose'),
    issueAddAssignee: make('issueAddAssignee'),
    issueRemoveAssignee: make('issueRemoveAssignee'),
    projectItemAdd: make('projectItemAdd'),
    projectItemEdit: make('projectItemEdit'),
    projectFieldList: make('projectFieldList'),
    projectItemList: make('projectItemList'),
    projectView: make('projectView'),
    apiGraphql: make('apiGraphql'),
  } as unknown as GhClient;
  return { client, calls };
}
