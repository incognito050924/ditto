import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileExists } from '~/core/hosts/shared';
import { type PushGateHookStatus, installPushGateHook } from '~/core/setup';
import type { Recipe } from '~/schemas/recipe';

/**
 * `ditto workspace sync` core (wi_2606299kn) — clone the recipe `repos[]` sub-repos
 * that declare a `url` into the workspace, then gate each clone by the ROOT recipe's
 * push_gate (ROOT-ONLY trust). Every git/fs side effect lives here, but the recipe +
 * hook template + transport policy arrive via options so the CLI owns environment
 * resolution and tests can drive the real clone path deterministically.
 *
 * SECURITY (mandatory, see the helpers): a URL-scheme allowlist neutralizes the
 * `ext::`/`fd::` arbitrary-command transports (clone-time RCE) and option injection;
 * a dir-containment check keeps every write STRICTLY under the workspace root
 * (ADR-0011 session-rooting); a non-interactive git env fails fast on a
 * credential/host-key prompt instead of HANGING the command.
 */

/**
 * Test/e2e transport seam: when this env var is `1`, the URL allowlist additionally
 * permits LOCAL/`file://` transports so tests (and N6's e2e smoke) can clone from a
 * LOCAL source repo. It NEVER re-enables the RCE transports (`ext::`/`fd::`) or
 * option injection — those stay rejected. Production never sets it.
 */
export const LOCAL_CLONE_ENV_FLAG = 'DITTO_ALLOW_LOCAL_CLONE';
export type CloneTransportEnv = Record<string, string | undefined>;

export function localTransportAllowed(env: CloneTransportEnv = process.env): boolean {
  return env[LOCAL_CLONE_ENV_FLAG] === '1';
}

/** Schemes ditto will clone over: https, git://, ssh://, and scp-style `git@host:`. */
const ALLOWED_SCHEME = /^(https:\/\/|git:\/\/|ssh:\/\/|[^\s/]+@[^\s/]+:)/;
/** Arbitrary-command transports — `git clone ext::<cmd>` / `fd::` run a shell = RCE. */
const RCE_TRANSPORT = /^(ext|fd)::/i;

/**
 * True iff `url` is safe to hand to `git clone`. REJECTS (in priority order):
 *  - a leading `-` (would be parsed as a git OPTION — option injection),
 *  - `ext::`/`fd::` (arbitrary-command transports → clone-time RCE) — even under the
 *    local seam, since they are never a benign local path,
 * then ACCEPTS only the https/ssh/git allowlist. A local path / `file://` passes ONLY
 * when `allowLocal` (the DITTO_ALLOW_LOCAL_CLONE test/e2e seam).
 */
export function isAllowedCloneUrl(url: string, allowLocal = false): boolean {
  if (url.length === 0) return false;
  if (url.startsWith('-')) return false; // option injection
  if (RCE_TRANSPORT.test(url)) return false; // ext::/fd:: — RCE, never (even under the seam)
  if (ALLOWED_SCHEME.test(url)) return true;
  return allowLocal; // local path / file:// — test/e2e transport seam only
}

export class WorkspaceContainmentError extends Error {
  constructor(public readonly dir: string) {
    super(
      `repo dir "${dir}" is not strictly under the workspace root — refusing to write outside it (ADR-0011 session-rooting)`,
    );
    this.name = 'WorkspaceContainmentError';
  }
}

/** True iff `rel` (a path RELATIVE to the root) escapes or equals the root. */
function escapesRoot(rel: string): boolean {
  return rel === '' || rel === '.' || rel.startsWith('..') || isAbsolute(rel);
}

/**
 * Realpath the nearest EXISTING ancestor of `p` (the target may not exist yet — a clone
 * creates it), then re-append the not-yet-existing tail. Resolves symlinks in every
 * existing path component (and macOS `/var` -> `/private/var`) so a symlinked ancestor
 * cannot smuggle the real location outside the root.
 */
function realpathNearestExisting(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) return join(realpathSync(cur), ...tail); // filesystem root
    tail.unshift(basename(cur));
    cur = parent;
  }
  return tail.length === 0 ? realpathSync(cur) : join(realpathSync(cur), ...tail);
}

/**
 * Resolve `dir` (a recipe `repos[].dir`) against the workspace root and assert it is
 * STRICTLY under that root. Throws `WorkspaceContainmentError` for a `../escape`, an
 * absolute path outside the root, or the root itself (`.`). The non-clobber guard
 * alone is insufficient — an empty external path would still be written — so this
 * containment runs BEFORE any fs/git op.
 *
 * SYMLINK ESCAPE (defense-in-depth): a LEXICAL check alone lets a pre-planted symlink at
 * the target (or an ancestor) pointing OUTSIDE the root be followed by `git clone`,
 * writing the clone + pushed hook outside the workspace root. So, beyond the lexical
 * check, this (a) REFUSES a target that is itself a symlink — never legitimate for a
 * clone target — and (b) realpaths the nearest existing ancestor of both the root and
 * the target and re-asserts containment, catching a symlinked intermediate component.
 */
export function resolveContainedDir(workspaceRoot: string, dir: string): string {
  const root = resolve(workspaceRoot);
  const target = resolve(root, dir);
  // (1) lexical containment — keeps ../escape, absolute-outside, mid-path .., '.'.
  if (escapesRoot(relative(root, target))) {
    throw new WorkspaceContainmentError(dir);
  }
  // (2) the target itself must not be a symlink (empty/dangling/foreign — never a clone target).
  if (lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new WorkspaceContainmentError(dir);
  }
  // (3) symlink-resolved containment — a symlinked ancestor cannot escape the realpath'd root.
  if (escapesRoot(relative(realpathNearestExisting(root), realpathNearestExisting(target)))) {
    throw new WorkspaceContainmentError(dir);
  }
  return target;
}

/** Non-interactive git env: a credential / host-key prompt FAILS FAST, never hangs. */
const NONINTERACTIVE_GIT: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
};

/** `remote.origin.url` of the repo at `dir`, or null when absent / not a git repo. */
function gitOriginUrl(dir: string): string | null {
  try {
    const v = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Light url normalization for the idempotent same-url check (trailing `/` and `.git`). */
function normalizeUrl(u: string): string {
  return u.replace(/\.git$/, '').replace(/\/+$/, '');
}

type DirState = 'empty' | 'same-url' | 'foreign';

/**
 * Classify the clone target by its on-disk state:
 *  - absent or empty → `empty` (cloneable),
 *  - a git repo whose `origin` matches `url` → `same-url` (idempotent skip — OUR clone,
 *    left untouched even if the user has since edited it),
 *  - anything else non-empty (a different-url repo, or loose/foreign files) → `foreign`
 *    (refused — never overwritten).
 */
async function classifyDir(target: string, url: string): Promise<DirState> {
  if (!(await fileExists(target))) return 'empty';
  let entries: string[];
  try {
    entries = await readdir(target);
  } catch {
    return 'foreign'; // exists but unreadable as a dir → don't touch
  }
  if (entries.length === 0) return 'empty';
  const origin = gitOriginUrl(target);
  if (origin !== null && normalizeUrl(origin) === normalizeUrl(url)) return 'same-url';
  return 'foreign';
}

export type RepoSyncStatus = 'cloned' | 'skipped' | 'refused' | 'failed';

export interface CloneRepoOutcome {
  /** The recipe `repos[].dir`, as declared. */
  dir: string;
  /** The recipe `repos[].url`. */
  url: string;
  status: RepoSyncStatus;
  /** Why, for refused / failed / skipped. */
  reason?: string;
  /** Push-gate hook install status for a cloned/managed sub-repo. */
  hook?: PushGateHookStatus;
}

interface CloneRepoInput {
  workspaceRoot: string;
  dir: string;
  url: string;
  hookTemplatePath: string;
  allowLocal: boolean;
  env: CloneTransportEnv;
}

/** Scrub a child-process error to a single-line reason (drop noisy stack/url echoes). */
function scrub(err: unknown): string {
  const raw =
    err && typeof err === 'object' && 'stderr' in err && (err as { stderr?: unknown }).stderr
      ? String((err as { stderr: unknown }).stderr)
      : err instanceof Error
        ? err.message
        : String(err);
  return raw.trim().split('\n')[0] ?? 'clone failed';
}

/** Install the ROOT-recipe pre-push hook into a managed clone, WS_ROOT pinned to root. */
async function installRootGateHook(
  target: string,
  workspaceRoot: string,
  hookTemplatePath: string,
): Promise<PushGateHookStatus> {
  const r = await installPushGateHook({ projectRoot: target, hookTemplatePath, workspaceRoot });
  return r.status;
}

/** Append `dir/` to the parent `.gitignore` (idempotent) so the clone never pollutes git status. */
async function addToParentGitignore(workspaceRoot: string, dir: string): Promise<void> {
  const giPath = join(workspaceRoot, '.gitignore');
  const entry = `${dir.replace(/\/+$/, '')}/`;
  const bare = dir.replace(/\/+$/, '');
  let cur = '';
  if (await fileExists(giPath)) cur = await readFile(giPath, 'utf8');
  const lines = cur.split('\n').map((l) => l.trim());
  if (lines.includes(entry) || lines.includes(bare)) return; // already ignored
  const next =
    cur.length === 0
      ? `${entry}\n`
      : cur.endsWith('\n')
        ? `${cur}${entry}\n`
        : `${cur}\n${entry}\n`;
  await writeFile(giPath, next);
}

/**
 * Clone (or idempotently reconcile) ONE recipe repo. The security gates run BEFORE any
 * fs/git op (allowlist → containment → non-clobber). A clone only ever runs into an
 * empty/absent target, which is why the failure cleanup (`rm -rf target`) can never
 * destroy pre-existing user content.
 */
async function cloneRepoEntry(inp: CloneRepoInput): Promise<CloneRepoOutcome> {
  const { workspaceRoot, dir, url, hookTemplatePath, allowLocal, env } = inp;

  // 1) URL allowlist (RCE / option-injection guard).
  if (!isAllowedCloneUrl(url, allowLocal)) {
    return {
      dir,
      url,
      status: 'refused',
      reason: `url scheme not allowed (only https / ssh / git:// are accepted): ${url}`,
    };
  }

  // 2) Dir containment (write-outside-root guard).
  let target: string;
  try {
    target = resolveContainedDir(workspaceRoot, dir);
  } catch (err) {
    return { dir, url, status: 'refused', reason: scrub(err) };
  }

  // 3) Non-clobber: classify the target.
  const state = await classifyDir(target, url);
  if (state === 'foreign') {
    return {
      dir,
      url,
      status: 'refused',
      reason: `${dir} already holds non-matching content — refusing to overwrite. Remove it or point the recipe elsewhere.`,
    };
  }
  if (state === 'same-url') {
    // Our clone already there — leave it untouched; just (re)converge the gate hook.
    const hook = await installRootGateHook(target, workspaceRoot, hookTemplatePath);
    return { dir, url, status: 'skipped', reason: 'already cloned (same url)', hook };
  }

  // 4) Empty/absent → clone. Full depth, ambient auth, non-interactive, option-safe `--`.
  try {
    execFileSync('git', ['clone', '--', url, target], {
      env: { ...env, ...NONINTERACTIVE_GIT },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch (err) {
    // Clean up ONLY the partial dir ditto created (target was empty/absent → safe).
    await rm(target, { recursive: true, force: true });
    return { dir, url, status: 'failed', reason: scrub(err) };
  }

  await addToParentGitignore(workspaceRoot, dir);
  const hook = await installRootGateHook(target, workspaceRoot, hookTemplatePath);
  return { dir, url, status: 'cloned', hook };
}

export interface SyncWorkspaceOptions {
  workspaceRoot: string;
  recipe: Recipe;
  hookTemplatePath: string;
  /** Transport env (GIT_* + the DITTO_ALLOW_LOCAL_CLONE seam). Defaults to process.env. */
  env?: CloneTransportEnv;
  /** Explicit local-transport override; defaults to the DITTO_ALLOW_LOCAL_CLONE seam in `env`. */
  allowLocal?: boolean;
}

export interface SyncWorkspaceResult {
  outcomes: CloneRepoOutcome[];
  /** True iff any repo's clone genuinely FAILED (a refusal is not a failure). */
  anyFailed: boolean;
}

/**
 * Sync the whole workspace: clone every recipe `repos[]` entry that declares a `url`.
 * MULTI-REPO RESILIENT — a failed/refused repo does NOT abort the rest; each repo's
 * outcome is collected so the caller can summarize and exit non-zero iff `anyFailed`.
 */
export async function syncWorkspace(opts: SyncWorkspaceOptions): Promise<SyncWorkspaceResult> {
  const env = opts.env ?? process.env;
  const allowLocal = opts.allowLocal ?? localTransportAllowed(env);
  const repos = (opts.recipe.repos ?? []).filter(
    (r): r is { dir: string; url: string } => typeof r.url === 'string' && r.url.length > 0,
  );
  const outcomes: CloneRepoOutcome[] = [];
  for (const r of repos) {
    outcomes.push(
      await cloneRepoEntry({
        workspaceRoot: opts.workspaceRoot,
        dir: r.dir,
        url: r.url,
        hookTemplatePath: opts.hookTemplatePath,
        allowLocal,
        env,
      }),
    );
  }
  return { outcomes, anyFailed: outcomes.some((o) => o.status === 'failed') };
}
