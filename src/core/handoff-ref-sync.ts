import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { localDir } from './ditto-paths';
import { runGitBounded } from './git';
import { classifyPushRejection } from './git';
import { TOKEN_PATTERNS } from './github-redaction';
import { HANDOFF_REF } from './handoff-ref-store';

/**
 * refs/ditto/*-only auto push/fetch layer for the hidden-ref handoff baton store
 * (wi_260722g7h, g7h-impl-ref-sync — ac-3 / ac-scrub / ac-retention-invariant /
 * ac-concurrent-push). Used by the handoff write/consume/show CLI commands; NEVER by
 * hooks or the autopilot tick loop (network-free hook invariant — remote contact
 * fires only from explicit handoff CLI commands, and every remote loop here is
 * BOUNDED by a retry cap + per-attempt timeout so a caller can never hang).
 *
 * Contract summary:
 *  - ONLY the fully-qualified `refs/ditto/handoffs` refspec ever crosses the
 *    wire. `assertDittoPushRefspec` runs immediately before EVERY push/fetch
 *    subprocess and THROWS on a non-refs/ditto/* remote side (fail-closed): this
 *    module is the single enforcement point — the pre-tool-use force guard only
 *    checks main|master Bash strings and the pre-push gate only refs/heads/*.
 *  - Scrub gate (ac-scrub) is DETECT-AND-REFUSE, never scrub-and-proceed: every
 *    blob the push would transmit (objects reachable from the tip and not on the
 *    remote) is scanned against the shared TOKEN_PATTERNS blacklist plus a
 *    push-gate-only high-entropy heuristic; >=1 match OR a scan failure refuses
 *    the push with the offending entry named. (The store already scrubs
 *    pre-object; this is defense-in-depth for anything that bypassed it.)
 *  - Offline contract (ac-3): local operations always succeed. A push/fetch
 *    failure degrades to local-success + loud warning + jsonl log and is retried
 *    on the NEXT handoff command; a short in-command backoff retry runs first.
 *    Persistent-auth failures ('Permission denied', 'Authentication failed',
 *    'could not read Username', HTTP 403) get a DISTINCT credentials warning —
 *    and a failed consume-deletion push states that the remote baton still
 *    exists (re-consume window open). Failure classes are PRESERVED in the
 *    warning/log (never collapsed into one skipped bucket).
 *  - Remote-ahead (ac-concurrent-push): fetch + tree-level re-merge + bounded
 *    re-push. The re-merge is a TREE reconciliation (per-file union of live
 *    batons minus consumed ones), NEVER a commit-graph merge/rebase: the new
 *    commit's single parent is the REMOTE tip, so a truncation-cut history can
 *    never be reintroduced and unrelated histories reconcile without loss. A
 *    deletion converges to the CAS winner; a stale copy of a consumed baton is
 *    dropped (its exact blob is found in the other side's history), while a
 *    never-seen local baton is always re-applied ("at-most-duplicated, never
 *    lost" — an offline consume may deliver twice, it may never lose a baton).
 *  - Consume 1:1 finalization: an ONLINE consume is final only after the
 *    deletion commit lands on the remote (remote CAS); the offline local-success
 *    path warns that another PC may consume the same baton (CLI wires this).
 *  - Retention (ac-retention-invariant): at push time history is kept within
 *    max(7 days, 50 commits). Truncation rebuilds the kept chain with THE SAME
 *    per-commit trees (root chain cut; author/committer identity and dates
 *    preserved) — the ref TIP TREE never changes, so pending batons always
 *    survive. Truncation fetches FIRST (absorbing remote-only pending batons),
 *    pushes ONLY with --force-with-lease pinned to the fetched remote sha, and
 *    flips the local ref (update-ref CAS) only AFTER the remote accepted — a
 *    failed push leaves the local ref untouched and retryable, so the
 *    remote-ahead handler never sees a half-truncated state.
 *  - Force policy: this module contains NO plain force flag anywhere (a test
 *    greps the source). The ONLY force path is the truncation/purge lease push,
 *    isolated in a helper hard-coded to `refs/ditto/handoffs` — the single
 *    sanctioned exception to git.ts's NEVER-force invariant (gitPush /
 *    landBranchToOrigin), and only in the conditional old-value form.
 *  - Visibility authorization boundary: a custom ref is advertised by ls-remote
 *    and fetchable by anyone who can read the repo, and a consume deletion
 *    cannot un-publish already-pushed history — so repo visibility IS the baton
 *    readability scope. Auto-push is fail-closed: refused unless the caller
 *    proves 'private' or explicitly opts in ('unknown' counts as public).
 *  - Undetected-token recall path (chosen design): consume/rewrite the leaked
 *    baton, then `purgeHandoffHistory` rewrites local history to a single root
 *    commit (same tip tree) and lease-pushes it, cutting the leaked blob out of
 *    the remote history.
 *
 * The public API takes `cwd` and `remote` as EXPLICIT parameters — no
 * process.cwd() / 'origin' defaults. All remote contact goes through
 * runGitBounded (shared per-attempt timeout + SIGTERM/ETIMEDOUT classification).
 * Every failure path appends a jsonl record under .ditto/local/logs/ — the
 * console warning is an aid, the log is the durable channel.
 */

/** The fully-qualified push refspec — the ONLY refspec this module pushes. */
export const HANDOFF_PUSH_REFSPEC = `${HANDOFF_REF}:${HANDOFF_REF}`;
/** Bound on fetch+re-merge+re-push recovery attempts (mirrors LAND_MAX_RETRIES). */
export const SYNC_MAX_RETRIES = 3;
/** Per-attempt wall clock for every remote contact (LAND_RECOVERY_TIMEOUT_MS precedent). */
export const SYNC_TIMEOUT_MS = 120_000;
/** Short in-command retries after an offline failure (before degrading to next-command). */
export const OFFLINE_PUSH_RETRIES = 1;
export const OFFLINE_RETRY_BACKOFF_MS = 750;
/** Retention window: history is kept within max(7 days, 50 commits). */
export const RETENTION_MAX_COMMITS = 50;
export const RETENTION_MAX_AGE_DAYS = 7;
/** LOCAL bookkeeping ref recording the last successfully pushed tip — never pushed. */
export const SYNC_PUSHED_REF = 'refs/ditto/sync/handoffs-pushed';

const SYNC_LOG_FILE = 'handoff-sync.jsonl';
const ZERO_SHA = '0'.repeat(40);
/** Bounded local update-ref CAS attempts while applying a reconcile result. */
const MAX_LOCAL_CAS = 3;
/** Cap on history walked per entry when deciding write-vs-delete precedence. */
const HISTORY_SCAN_CAP = 200;

/**
 * Deletion-only visibility exemption: message + MASKED identity for the single
 * commit the exempt path publishes. The exempt push rebuilds one commit carrying
 * the post-deletion tip tree onto the observed remote sha — collapsing any
 * piggybacked ancestor commits and STRIPPING the real author/committer so a
 * public remote never learns WHO consumed the baton. This is a NEW mask (the
 * truncation/purge rebuild deliberately PRESERVES identity — not a mask precedent).
 */
const HANDOFF_DELETION_COMMIT_MSG = 'ditto handoff baton: consume (deletion-only, identity-masked)';
const MASK_IDENTITY_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: 'ditto handoff',
  GIT_AUTHOR_EMAIL: 'handoff@ditto.invalid',
  GIT_COMMITTER_NAME: 'ditto handoff',
  GIT_COMMITTER_EMAIL: 'handoff@ditto.invalid',
};

/**
 * The full env for a masked commit: identity constants + UTC-pinned dates. Left
 * unmasked, the commit dates would carry the consumer's local timezone offset —
 * a weak identity signal — onto a public remote.
 */
function maskIdentityEnv(now: Date = new Date()): Record<string, string> {
  const utc = now.toISOString();
  return { ...MASK_IDENTITY_ENV, GIT_AUTHOR_DATE: utc, GIT_COMMITTER_DATE: utc };
}

export type RemoteVisibility = 'private' | 'public' | 'unknown';
export type SyncOp = 'write' | 'consume' | 'command';
export type SyncFailureClass = 'auth' | 'non-ff' | 'offline' | 'other';
export type SyncStatus =
  | 'pushed'
  | 'nothing-to-push'
  | 'public-remote-refused'
  | 'scrub-refused'
  | 'local-only-offline'
  | 'local-only-auth'
  | 'sync-retry-exhausted'
  | 'sync-error';

export interface SecretMatch {
  pattern: string;
  index: number;
}

export interface ScrubFinding {
  /** Tree path of the offending blob (the baton entry the user must fix). */
  entry: string;
  pattern: string;
  index: number;
}

/**
 * Test seam: fires immediately before a push subprocess so a test can inject a
 * competing writer deterministically (remote-ahead / lease-race fault injection).
 */
export interface SyncHooks {
  beforePush?: (attempt: number) => void;
  beforeForcePush?: (attempt: number) => void;
}

export interface SyncOptions {
  /**
   * Caller-resolved remote visibility. Fail-closed: anything other than
   * 'private' (including 'unknown') refuses auto-push unless allowPublicRemote.
   */
  visibility: RemoteVisibility;
  /** Explicit opt-in for a public/unknown remote (the CLI pairs it with a warning). */
  allowPublicRemote?: boolean;
  /** Which command is syncing — shapes the warning text (consume → re-consume window). */
  op?: SyncOp;
  maxRetries?: number;
  timeoutMs?: number;
  offlineRetries?: number;
  offlineBackoffMs?: number;
  /** Retention clock injection (tests); defaults to wall clock. */
  now?: Date;
  /**
   * Remote tip already observed by THIS command — set when a preceding
   * fetchHandoffRef in the same command has fetched + reconciled (null =
   * remote-unborn was observed). When provided, syncInner SKIPS its initial
   * fetch and starts from this sha (if the remote moved in the meantime, the
   * non-FF re-fetch loop converges); undefined keeps fetch-first behavior.
   */
  knownRemoteSha?: string | null;
  hooks?: SyncHooks;
}

export interface SyncResult {
  status: SyncStatus;
  warnings: string[];
  /** Baton stems present at the pushed tip — WHAT was sent, surfaced to the user. */
  pushedStems: string[];
  scrubFindings: ScrubFinding[];
}

export interface PendingState {
  pending: boolean;
  localTip: string | null;
  lastPushed: string | null;
}

export interface PurgeResult {
  status: 'purged' | 'scrub-refused' | 'public-remote-refused' | 'nothing-to-purge' | 'failed';
  warnings: string[];
  detail: string;
}

// ─── refspec guard ────────────────────────────────────────────────────────────

/**
 * Fail-closed refspec guard, run immediately before EVERY push/fetch subprocess:
 * the remote side (what would land on the remote) must be under refs/ditto/,
 * fully qualified, with no wildcard and no `+` force marker. A violation THROWS
 * before any subprocess is spawned — a code branch can never ride this module.
 */
export function assertDittoPushRefspec(refspec: string): void {
  if (refspec.startsWith('+')) {
    throw new Error(`handoff-ref-sync: force-marker refspec refused: ${refspec}`);
  }
  if (refspec.includes('*')) {
    throw new Error(`handoff-ref-sync: wildcard refspec refused: ${refspec}`);
  }
  const colon = refspec.indexOf(':');
  const remoteSide = colon === -1 ? refspec : refspec.slice(colon + 1);
  if (!/^refs\/ditto\//.test(remoteSide)) {
    throw new Error(
      `handoff-ref-sync: refspec remote side must be under refs/ditto/ (got: ${refspec})`,
    );
  }
}

// ─── secret detection (ac-scrub) ──────────────────────────────────────────────

/** Push-gate-only heuristic: long mixed-class tokens that look like credentials. */
const HIGH_ENTROPY_CANDIDATE = /[A-Za-z0-9+/=_-]{40,}/g;

/**
 * DETECT credential-shaped substrings (no replacement): the shared
 * TOKEN_PATTERNS blacklist (PATs, AWS keys, key=value secrets, PEM blocks,
 * JWTs, URL-embedded credentials) plus a push-gate-only high-entropy heuristic
 * (>=40 chars mixing upper+lower+digit — a lowercase-hex git sha never trips
 * it). Returns the match list; the gate refuses on >=1 match. scrubTokens is a
 * pure replacement with no failure signal, so it can NEVER be the gate.
 */
export function detectSecretMatches(text: string): SecretMatch[] {
  const out: SecretMatch[] = [];
  for (const re of TOKEN_PATTERNS) {
    for (const m of text.matchAll(re)) {
      out.push({ pattern: re.source, index: m.index ?? 0 });
    }
  }
  for (const m of text.matchAll(HIGH_ENTROPY_CANDIDATE)) {
    const token = m[0];
    if (/[A-Z]/.test(token) && /[a-z]/.test(token) && /[0-9]/.test(token)) {
      out.push({ pattern: 'high-entropy', index: m.index ?? 0 });
    }
  }
  return out;
}

// ─── failure classification (ac-3) ────────────────────────────────────────────

const AUTH_FAILURE =
  /permission denied|authentication failed|could not read username|could not read password|returned error: 403|http 403|status 403/i;

/**
 * Classify a failed push/fetch, PRESERVING the class (never the chain-drive
 * "everything → skipped" collapse):
 *  - 'auth'    — persistent credential failure: distinct warning (check creds).
 *  - 'non-ff'  — remote moved ahead (incl. lease 'stale info'): recoverable.
 *  - 'other'   — a client push-gate declined: surfaced, never retried.
 *  - 'offline' — everything else (unreachable/network/unknown): local success +
 *    warning + retry on the next handoff command.
 */
export function classifySyncFailure(output: string): SyncFailureClass {
  if (AUTH_FAILURE.test(output)) return 'auth';
  const cls = classifyPushRejection(output);
  if (cls === 'non-ff') return 'non-ff';
  if (cls === 'push-gate') return 'other';
  return 'offline';
}

/** One loud, class-specific user warning line (the jsonl log is the durable copy). */
export function buildSyncWarning(
  kind: 'offline' | 'auth' | 'exhausted' | 'other',
  op: SyncOp,
  remote: string,
  detail: string,
): string {
  const first = (detail.split('\n').find((l) => l.trim().length > 0) ?? '').trim();
  const consumeNote =
    op === 'consume'
      ? ' NOTE: the consume deletion was NOT pushed — the remote baton still exists, so another PC may still consume it (re-consume window open; at-most-duplicated, never lost).'
      : '';
  switch (kind) {
    case 'auth':
      return `handoff sync: PERSISTENT AUTH FAILURE against '${remote}' — check your git credentials (permission denied / HTTP 403). Local handoff state is intact.${consumeNote} [${first}]`;
    case 'offline':
      return `handoff sync: could not reach '${remote}' — local handoff state is safe and will be re-synced on the next handoff command.${consumeNote} [${first}]`;
    case 'exhausted':
      return `handoff sync: push retries exhausted against '${remote}' (remote kept moving) — local state is safe; sync will retry on the next handoff command.${consumeNote} [${first}]`;
    case 'other':
      return `handoff sync: push to '${remote}' failed and is surfaced (not retried).${consumeNote} [${first}]`;
  }
}

// ─── durable failure log (.ditto/local/logs/handoff-sync.jsonl) ───────────────

/**
 * Append one jsonl record (logClassification precedent, but O_APPEND single
 * write — sufficient per the append-atomicity decision). NEVER an empty catch:
 * a failed log write is itself surfaced on stderr.
 */
function appendSyncLog(cwd: string, entry: Record<string, unknown>): void {
  try {
    const dir = localDir(cwd, 'logs');
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, SYNC_LOG_FILE),
      `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
    );
  } catch (err) {
    console.error(
      `handoff-ref-sync: failed to append sync log: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── local git plumbing (local-only; remote contact goes through runGitBounded) ─

interface LocalGitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function gitLocal(
  cwd: string,
  args: string[],
  stdin?: string,
  env?: Record<string, string>,
): LocalGitResult {
  try {
    const proc = Bun.spawnSync(['git', ...args], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      ...(stdin === undefined ? {} : { stdin: new TextEncoder().encode(stdin) }),
      ...(env === undefined ? {} : { env: { ...process.env, ...env } }),
    });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout?.toString() ?? '',
      stderr: proc.stderr?.toString() ?? '',
    };
  } catch (err) {
    throw new Error(
      `handoff-ref-sync: git spawn failed (git ${args.join(' ')}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function gitLocalOrThrow(
  cwd: string,
  args: string[],
  stdin?: string,
  env?: Record<string, string>,
): string {
  const r = gitLocal(cwd, args, stdin, env);
  if (r.exitCode !== 0) {
    throw new Error(`handoff-ref-sync: git ${args[0]} failed: ${r.stderr.trim()}`);
  }
  return r.stdout;
}

function revParseQuiet(cwd: string, ref: string): string | null {
  const r = gitLocal(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  return r.exitCode === 0 ? r.stdout.trim() : null;
}

function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  return gitLocal(cwd, ['merge-base', '--is-ancestor', ancestor, descendant]).exitCode === 0;
}

interface TreeEntry {
  mode: string;
  type: string;
  sha: string;
  name: string;
}

function treeEntries(cwd: string, commit: string): TreeEntry[] {
  const out = gitLocalOrThrow(cwd, ['ls-tree', '-z', commit]);
  const entries: TreeEntry[] = [];
  for (const line of out.split('\0')) {
    if (line.length === 0) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const [mode, type, sha] = line.slice(0, tab).split(' ');
    if (!mode || !type || !sha) {
      throw new Error(`handoff-ref-sync: unparsable ls-tree entry: ${line}`);
    }
    entries.push({ mode, type, sha, name: line.slice(tab + 1) });
  }
  return entries;
}

function mktree(cwd: string, entries: TreeEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const input = sorted.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}\0`).join('');
  return gitLocalOrThrow(cwd, ['mktree', '-z'], input).trim();
}

function treeOf(cwd: string, commit: string): string {
  return gitLocalOrThrow(cwd, ['rev-parse', `${commit}^{tree}`]).trim();
}

function commitTree(
  cwd: string,
  tree: string,
  parent: string | null,
  message: string,
  env?: Record<string, string>,
): string {
  const args = ['commit-tree', tree, ...(parent === null ? [] : ['-p', parent]), '-m', message];
  return gitLocalOrThrow(cwd, args, undefined, env).trim();
}

// ─── remote contact (runGitBounded only; refspec guard before every call) ─────

interface FetchOutcome {
  ok: boolean;
  /** Remote tip, or null when the remote does not have the ref yet (0-state). */
  sha: string | null;
  out: string;
  timedOut: boolean;
}

function fetchRemoteTip(cwd: string, remote: string, timeoutMs: number): FetchOutcome {
  assertDittoPushRefspec(HANDOFF_REF); // source side is the same fully-qualified ref
  const r = runGitBounded(cwd, ['fetch', remote, '--', HANDOFF_REF], timeoutMs);
  if (!r.ok) {
    if (/couldn't find remote ref/i.test(r.stderr)) {
      return { ok: true, sha: null, out: '', timedOut: false };
    }
    return { ok: false, sha: null, out: `${r.stderr}\n${r.stdout}`.trim(), timedOut: r.timedOut };
  }
  return { ok: true, sha: revParseQuiet(cwd, 'FETCH_HEAD'), out: '', timedOut: false };
}

// ─── tree-level reconciliation (ac-concurrent-push) ───────────────────────────

/**
 * Every blob sha `name` has ever pointed at in `tip`'s history (bounded walk).
 * "This side has SEEN this exact content" is the precedence signal that decides
 * write-vs-delete: absence at a tip that has seen the blob means CONSUMED.
 */
function historicalBlobShas(cwd: string, tip: string, name: string): Set<string> {
  const shas = new Set<string>();
  const log = gitLocal(cwd, [
    'log',
    tip,
    '--format=%H',
    '-n',
    String(HISTORY_SCAN_CAP),
    '--',
    name,
  ]);
  if (log.exitCode !== 0) return shas;
  for (const commit of log.stdout.split('\n')) {
    if (commit.length === 0) continue;
    const r = gitLocal(cwd, ['rev-parse', '--verify', '--quiet', `${commit}:${name}`]);
    if (r.exitCode === 0) shas.add(r.stdout.trim());
  }
  return shas;
}

/**
 * Tree-level reconciliation of a diverged (possibly UNRELATED, post-truncation)
 * local/remote pair. Per entry:
 *  - both sides, same blob → keep;
 *  - both sides, different blob → the side whose history contains the other's
 *    blob supersedes it; tie-break: remote (CAS winner holds);
 *  - local only → dropped when the remote's history has seen the exact blob
 *    (remote consume wins), re-applied otherwise (pending write survives);
 *  - remote only → dropped when the local history has seen the exact blob
 *    (local consume propagates), kept otherwise (new remote baton).
 * The result commit has the REMOTE tip as its ONLY parent — local-only commits
 * are replayed as content, never re-linked, so a cut history stays cut.
 */
function computeReconcileTarget(cwd: string, localTip: string | null, remoteTip: string): string {
  if (localTip === null || localTip === remoteTip) return remoteTip;
  if (isAncestor(cwd, localTip, remoteTip)) return remoteTip; // remote strictly ahead
  if (isAncestor(cwd, remoteTip, localTip)) return localTip; // local strictly ahead — plain push suffices
  const local = new Map(treeEntries(cwd, localTip).map((e) => [e.name, e]));
  const remote = new Map(treeEntries(cwd, remoteTip).map((e) => [e.name, e]));
  const merged: TreeEntry[] = [];
  const names = new Set([...local.keys(), ...remote.keys()]);
  for (const name of names) {
    const l = local.get(name);
    const r = remote.get(name);
    if (l && r) {
      if (l.sha === r.sha) {
        merged.push(r);
      } else if (historicalBlobShas(cwd, localTip, name).has(r.sha)) {
        merged.push(l); // local has seen (and superseded) the remote version
      } else {
        merged.push(r); // remote superseded, or true tie → remote CAS winner holds
      }
    } else if (l) {
      if (!historicalBlobShas(cwd, remoteTip, name).has(l.sha)) merged.push(l);
      // else: the remote saw this exact blob and its tip dropped it — consumed, deletion wins
    } else if (r) {
      if (!historicalBlobShas(cwd, localTip, name).has(r.sha)) merged.push(r);
      // else: local consumed it — the deletion commit propagates through the merge
    }
  }
  const tree = mktree(cwd, merged);
  if (tree === treeOf(cwd, remoteTip)) return remoteTip; // everything resolved to remote state
  return commitTree(cwd, tree, remoteTip, 'ditto handoff baton: reconcile (tree-level re-merge)');
}

/**
 * Apply the reconcile target to the local ref via update-ref CAS (expected-old =
 * the tip the target was computed from; bounded rebuild on a lost race — the
 * same discipline the ref store uses). Returns the resulting local tip.
 */
function applyReconcile(cwd: string, remoteTip: string): string {
  for (let attempt = 0; attempt < MAX_LOCAL_CAS; attempt++) {
    const localTip = revParseQuiet(cwd, HANDOFF_REF);
    const target = computeReconcileTarget(cwd, localTip, remoteTip);
    if (target === localTip) return localTip;
    const r = gitLocal(cwd, ['update-ref', HANDOFF_REF, target, localTip ?? ZERO_SHA]);
    if (r.exitCode === 0) return target;
    // CAS loss (a concurrent local writer) → re-read and recompute
  }
  throw new Error('handoff-ref-sync: reconcile update-ref CAS exhausted');
}

// ─── scrub gate (ac-scrub) ────────────────────────────────────────────────────

interface ScrubScan {
  ok: boolean;
  findings: ScrubFinding[];
  error?: string;
}

/**
 * Scan surface = every blob the push would TRANSMIT: objects reachable from
 * `tip` and not already on the remote (full reachable set when the remote is
 * unborn/unknown) — the entire serialized payload, never a field enumeration.
 * Any scan failure is fail-closed (the caller refuses the push).
 */
function scrubScan(cwd: string, tip: string, remoteSha: string | null): ScrubScan {
  const args = [
    'rev-list',
    '--objects',
    tip,
    ...(remoteSha === null ? [] : [`^${remoteSha}`]),
    '--',
  ];
  const listed = gitLocal(cwd, args);
  if (listed.exitCode !== 0) return { ok: false, findings: [], error: listed.stderr.trim() };
  const findings: ScrubFinding[] = [];
  for (const line of listed.stdout.split('\n')) {
    if (line.length === 0) continue;
    const sp = line.indexOf(' ');
    if (sp === -1) continue; // commit / root tree — no path, no blob content of its own
    const sha = line.slice(0, sp);
    const path = line.slice(sp + 1);
    if (path.length === 0) continue;
    const type = gitLocal(cwd, ['cat-file', '-t', sha]);
    if (type.exitCode !== 0) return { ok: false, findings, error: type.stderr.trim() };
    if (type.stdout.trim() !== 'blob') continue;
    const blob = gitLocal(cwd, ['cat-file', 'blob', sha]);
    if (blob.exitCode !== 0) return { ok: false, findings, error: blob.stderr.trim() };
    for (const m of detectSecretMatches(blob.stdout)) {
      findings.push({ entry: path, pattern: m.pattern, index: m.index });
    }
  }
  return { ok: true, findings };
}

// ─── deletion-only visibility exemption (object-set based) ────────────────────

export interface DeletionOnlyDecision {
  exempt: boolean;
  /** Why it is / isn't exempt — surfaced in the refusal warning + jsonl log. */
  reason: string;
}

/**
 * Decide whether an unauthorized (public/unknown, no opt-in) push may proceed as
 * a narrow DELETION-ONLY exemption, judged by the actual TRANSMIT OBJECT SET —
 * NEVER by op==='consume': computeReconcileTarget re-applies unpushed local write
 * batons onto the consume tip, so a "consume" can still carry new bodies. Called
 * ONCE PER push attempt against the currently-observed remoteSha, so a re-merge
 * that re-introduces a local-only baton flips a prior exemption to a refusal.
 *
 * Exempt iff the push publishes NO new readable content:
 *  - remoteSha must be an ACTUALLY-observed published base — null (offline /
 *    unborn remote) is fail-closed refused (nothing to delete against; a first
 *    push would publish everything);
 *  - every entry (name→blob sha) in the local tip tree is ALREADY present at the
 *    observed remote tip — a strict subset, i.e. a pure deletion: no new blob AND
 *    no new stem NAME crosses the wire (this catches the un-scannable tree-entry
 *    name / session-id leak, not just blob bodies — scrubScan sees blobs only);
 *  - defense in depth: the rev-list --objects enumeration of the local tip TREE
 *    minus the remote tip TREE carries zero NEW blob objects (nested content
 *    reachable only via a subtree). TREE-scoped on BOTH sides deliberately: the
 *    exempt push transmits ONE rebuilt commit carrying the local tip tree, so
 *    commit-history reachability is NOT the transmit surface — enumerating
 *    history would drag in blobs of collapsed intermediate commits (e.g. a
 *    handoff written AND consumed locally since the last push) that never cross
 *    the wire, and refuse a genuinely pure net-deletion.
 * Any enumeration error is fail-closed (not exempt). The only objects the exempt
 * push then adds are the deletion commit + reduced root tree — the commit's
 * identity is MASKED (MASK_IDENTITY_ENV) and the tree's entries are all already
 * published.
 */
export function evaluateDeletionOnlyExemption(
  cwd: string,
  localTip: string,
  remoteSha: string | null,
): DeletionOnlyDecision {
  if (remoteSha === null) {
    return {
      exempt: false,
      reason: 'remote ref is unborn/unobserved — no published base to delete against',
    };
  }
  let localEntries: TreeEntry[];
  let remoteByName: Map<string, string>;
  try {
    localEntries = treeEntries(cwd, localTip);
    remoteByName = new Map(treeEntries(cwd, remoteSha).map((e) => [e.name, e.sha]));
  } catch (err) {
    return {
      exempt: false,
      reason: `transmit tree enumeration failed (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  for (const e of localEntries) {
    const remoteEntrySha = remoteByName.get(e.name);
    if (remoteEntrySha === undefined || remoteEntrySha !== e.sha) {
      return {
        exempt: false,
        reason: `transmit set adds or modifies '${e.name}' — not deletion-only`,
      };
    }
  }
  // TREE-scoped on both sides — the transmit surface of the exempt push is the
  // local tip TREE (one rebuilt commit), never the local commit history.
  const objs = gitLocal(cwd, [
    'rev-list',
    '--objects',
    `${localTip}^{tree}`,
    `^${remoteSha}^{tree}`,
    '--',
  ]);
  if (objs.exitCode !== 0) {
    return { exempt: false, reason: `transmit object enumeration failed (${objs.stderr.trim()})` };
  }
  for (const line of objs.stdout.split('\n')) {
    if (line.length === 0) continue;
    const sp = line.indexOf(' ');
    if (sp === -1) continue; // commit / root tree — anonymous (no path)
    const sha = line.slice(0, sp);
    const type = gitLocal(cwd, ['cat-file', '-t', sha]);
    if (type.exitCode !== 0) {
      return { exempt: false, reason: `object type probe failed (${type.stderr.trim()})` };
    }
    if (type.stdout.trim() === 'blob') {
      return {
        exempt: false,
        reason: `transmit set carries a new blob at '${line.slice(sp + 1)}'`,
      };
    }
  }
  return {
    exempt: true,
    reason: 'deletion-only: local tip tree is a subset of the published remote tip',
  };
}

// ─── pending-unpushed bookkeeping ─────────────────────────────────────────────

/**
 * Is there local baton state the remote has not accepted yet? Backed by a LOCAL
 * bookkeeping ref (last successfully pushed tip) so every subsequent ditto
 * command can re-surface the warning — a one-shot console line scrolls away.
 */
export function pendingUnpushed(cwd: string): PendingState {
  const localTip = revParseQuiet(cwd, HANDOFF_REF);
  const lastPushed = revParseQuiet(cwd, SYNC_PUSHED_REF);
  return { pending: localTip !== null && localTip !== lastPushed, localTip, lastPushed };
}

function recordPushed(cwd: string, sha: string): void {
  const r = gitLocal(cwd, ['update-ref', SYNC_PUSHED_REF, sha]);
  if (r.exitCode !== 0) {
    appendSyncLog(cwd, {
      event: 'bookkeeping-failed',
      ref: SYNC_PUSHED_REF,
      detail: r.stderr.trim(),
    });
  }
}

// ─── retention truncation (ac-retention-invariant) ────────────────────────────

/**
 * Newest-first kept-commit list when history exceeds max(7 days, 50 commits),
 * or null when nothing needs truncation. Returned oldest→newest for rebuild.
 */
function retentionKeepList(cwd: string, tip: string, now: Date): string[] | null {
  const out = gitLocalOrThrow(cwd, ['log', '--format=%H %ct', tip]);
  const rows: { sha: string; ct: number }[] = [];
  for (const line of out.split('\n')) {
    if (line.length === 0) continue;
    const [sha, ct] = line.split(' ');
    if (!sha || !ct) continue;
    rows.push({ sha, ct: Number.parseInt(ct, 10) });
  }
  if (rows.length <= RETENTION_MAX_COMMITS) return null;
  const cutoff = Math.floor(now.getTime() / 1000) - RETENTION_MAX_AGE_DAYS * 24 * 60 * 60;
  const withinAge = rows.filter((r) => r.ct >= cutoff).length;
  const keep = Math.max(withinAge, RETENTION_MAX_COMMITS);
  if (rows.length <= keep) return null;
  return rows
    .slice(0, keep)
    .map((r) => r.sha)
    .reverse();
}

/**
 * Rebuild the kept chain with identical per-commit TREES (the oldest kept commit
 * becomes the new parentless root; identity, dates and messages preserved so
 * future retention windows stay correct). Asserts the tip-tree invariant before
 * returning — a tree-changing truncation can never be pushed.
 */
function rebuildTruncatedChain(cwd: string, keptOldestFirst: string[]): string {
  let parent: string | null = null;
  let lastSource = '';
  for (const sha of keptOldestFirst) {
    const meta = gitLocalOrThrow(cwd, [
      'show',
      '-s',
      '--format=%an%x00%ae%x00%aI%x00%cn%x00%ce%x00%cI%x00%B',
      sha,
    ]);
    const parts = meta.split('\0');
    const [an, ae, ad, cn, ce, cd] = parts;
    const message = (parts.slice(6).join('\0') || 'ditto handoff baton').replace(/\n+$/, '');
    parent = commitTree(cwd, treeOf(cwd, sha), parent, message || 'ditto handoff baton', {
      GIT_AUTHOR_NAME: an ?? 'ditto',
      GIT_AUTHOR_EMAIL: ae ?? 'ditto@local.invalid',
      GIT_AUTHOR_DATE: ad ?? '',
      GIT_COMMITTER_NAME: cn ?? 'ditto',
      GIT_COMMITTER_EMAIL: ce ?? 'ditto@local.invalid',
      GIT_COMMITTER_DATE: cd ?? '',
    });
    lastSource = sha;
  }
  if (parent === null) throw new Error('handoff-ref-sync: empty truncation keep list');
  if (treeOf(cwd, parent) !== treeOf(cwd, lastSource)) {
    throw new Error('handoff-ref-sync: truncation invariant violated — tip tree changed');
  }
  return parent;
}

/**
 * The ONLY force-capable push in this module, and the single sanctioned
 * exception to git.ts's NEVER-force invariant (gitPush / landBranchToOrigin):
 * a CONDITIONAL old-value force, lease-pinned to the remote sha OBSERVED by the
 * preceding fetch (remote-side CAS — first-wins symmetry with the local store).
 * The ref is the hard-coded `refs/ditto/handoffs` constant: the signature
 * cannot be called with an arbitrary ref, and the refspec guard still runs.
 */
function forcePushTruncated(
  cwd: string,
  remote: string,
  newTip: string,
  expectedRemoteSha: string,
  timeoutMs: number,
): ReturnType<typeof runGitBounded> {
  if (!/^[0-9a-f]{40}$/.test(expectedRemoteSha)) {
    throw new Error(`handoff-ref-sync: lease sha must be a full sha: ${expectedRemoteSha}`);
  }
  if (!/^[0-9a-f]{40}$/.test(newTip)) {
    throw new Error(`handoff-ref-sync: truncation tip must be a full sha: ${newTip}`);
  }
  // The SOURCE side is the rebuilt commit sha (the local ref flips only AFTER
  // the remote accepted); the REMOTE side is the hard-coded constant ref.
  const refspec = `${newTip}:${HANDOFF_REF}`;
  assertDittoPushRefspec(refspec);
  const lease = `--force-with-lease=${HANDOFF_REF}:${expectedRemoteSha}`;
  return runGitBounded(cwd, ['push', remote, lease, '--', refspec], timeoutMs);
}

/**
 * Retention at push time. Preconditions handled here: truncation NEVER relies on
 * a push rejection (force is not rejected) — it runs only on a tip the remote is
 * known to hold (fetch/push happened first, absorbing remote-only batons), and
 * the LOCAL ref flips only after the remote accepted the lease push. A lease
 * rejection re-fetches, re-merges and recomputes (bounded); any other failure
 * defers truncation with a logged warning (never fatal to the sync).
 */
function runRetention(
  cwd: string,
  remote: string,
  observedRemote: string,
  opts: SyncOptions,
  warnings: string[],
): void {
  const maxRetries = opts.maxRetries ?? SYNC_MAX_RETRIES;
  const timeoutMs = opts.timeoutMs ?? SYNC_TIMEOUT_MS;
  const now = opts.now ?? new Date();
  let observed = observedRemote;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const localTip = revParseQuiet(cwd, HANDOFF_REF);
    // Only truncate a tip the remote is known to hold; a concurrent local writer
    // moved the tip → skip this round, the next sync reconciles and retries.
    if (localTip === null || localTip !== observed) return;
    const kept = retentionKeepList(cwd, localTip, now);
    if (kept === null) return;
    let newTip: string;
    try {
      newTip = rebuildTruncatedChain(cwd, kept);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      appendSyncLog(cwd, { event: 'truncation-failed', remote, detail });
      warnings.push(`handoff sync: retention truncation failed and was deferred. [${detail}]`);
      return;
    }
    opts.hooks?.beforeForcePush?.(attempt);
    const push = forcePushTruncated(cwd, remote, newTip, observed, timeoutMs);
    if (push.ok) {
      // Local ref flips ONLY after the remote accepted — a failed push leaves the
      // local ref untouched/retryable, so divergence handlers never see a half state.
      const cas = gitLocal(cwd, ['update-ref', HANDOFF_REF, newTip, localTip]);
      if (cas.exitCode !== 0) {
        appendSyncLog(cwd, {
          event: 'truncation-local-cas-lost',
          remote,
          detail: cas.stderr.trim(),
        });
      } else {
        recordPushed(cwd, newTip);
      }
      appendSyncLog(cwd, { event: 'truncated', remote, kept: kept.length, tip: newTip });
      return;
    }
    const out = `${push.stderr}\n${push.stdout}`.trim();
    const cls: SyncFailureClass = push.timedOut ? 'offline' : classifySyncFailure(out);
    if (cls === 'non-ff') {
      // Lease rejected — the remote moved between snapshot and push. Re-fetch,
      // re-merge (absorbing the racing baton), recompute the truncation, retry.
      const fetched = fetchRemoteTip(cwd, remote, timeoutMs);
      if (!fetched.ok || fetched.sha === null) {
        appendSyncLog(cwd, { event: 'truncation-deferred', remote, class: cls, detail: out });
        warnings.push('handoff sync: retention truncation deferred (re-fetch failed).');
        return;
      }
      applyReconcile(cwd, fetched.sha);
      observed = fetched.sha;
      continue;
    }
    appendSyncLog(cwd, { event: 'truncation-deferred', remote, class: cls, detail: out });
    warnings.push(
      `handoff sync: retention truncation deferred (${cls}). [${out.split('\n')[0] ?? ''}]`,
    );
    return;
  }
  appendSyncLog(cwd, { event: 'truncation-retry-exhausted', remote });
  warnings.push('handoff sync: retention truncation retries exhausted — deferred to a later sync.');
}

// ─── main entry points ────────────────────────────────────────────────────────

/**
 * Sync the hidden handoff ref with `remote`: fetch-first (adopt/re-merge remote
 * batons; elided when opts.knownRemoteSha carries a same-command observation),
 * scrub-gate, push (bounded retries), then retention truncation at push time.
 * Local state is NEVER lost on any failure; every failure is class-preserved in
 * the warning and the jsonl log. Called ONLY from explicit handoff CLI commands
 * (never hooks / the autopilot tick).
 */
export function syncHandoffRef(cwd: string, remote: string, opts: SyncOptions): SyncResult {
  const warnings: string[] = [];
  try {
    return syncInner(cwd, remote, opts, warnings);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    appendSyncLog(cwd, { event: 'sync-error', remote, detail });
    warnings.push(`handoff sync: unexpected error — ${detail}`);
    return { status: 'sync-error', warnings, pushedStems: [], scrubFindings: [] };
  }
}

export interface FetchHandoffResult {
  /**
   * 'fetched' — remote tip adopted/reconciled into the local ref;
   * 'remote-unborn' — the remote has no handoff ref yet (clean 0-state);
   * 'fetch-failed' — degrade to local-only resolution (warning carries the class).
   */
  status: 'fetched' | 'remote-unborn' | 'fetch-failed';
  /**
   * Observed remote tip: the fetched sha on 'fetched', null on 'remote-unborn'
   * and on 'fetch-failed'. Feed it into SyncOptions.knownRemoteSha so a
   * follow-up sync in the SAME command can skip its initial fetch.
   */
  sha: string | null;
  warnings: string[];
}

/**
 * Fetch-only entry (READ path — wi_2607220o1): adopt/reconcile the remote
 * handoff ref WITHOUT pushing anything. Used by consume/show BEFORE resolving
 * pending batons, so a fresh clone / another PC sees origin's batons instead of
 * the local unborn-ref 0-state. Fetch is read-safe, so there is NO visibility
 * gate here — the fail-closed gate concerns publication (push) only. A fetch
 * failure degrades to local-only resolution with the same class-preserved
 * warning + jsonl log as the sync path. When the reconciled local tip equals
 * the remote tip, the pushed-bookkeeping ref is updated (local and remote
 * agree — nothing pending), mirroring syncInner's agreement branch.
 */
export function fetchHandoffRef(
  cwd: string,
  remote: string,
  opts: { op?: SyncOp; timeoutMs?: number } = {},
): FetchHandoffResult {
  const op = opts.op ?? 'command';
  const timeoutMs = opts.timeoutMs ?? SYNC_TIMEOUT_MS;
  const warnings: string[] = [];
  try {
    const fetched = fetchRemoteTip(cwd, remote, timeoutMs);
    if (!fetched.ok) {
      const cls = fetched.timedOut ? 'offline' : classifySyncFailure(fetched.out);
      const kind = cls === 'auth' ? 'auth' : cls === 'other' ? 'other' : 'offline';
      warnings.push(buildSyncWarning(kind, op, remote, fetched.out));
      appendSyncLog(cwd, {
        event: 'sync-failed',
        class: cls,
        phase: 'fetch',
        remote,
        op,
        detail: fetched.out.split('\n')[0] ?? '',
      });
      return { status: 'fetch-failed', sha: null, warnings };
    }
    if (fetched.sha === null) return { status: 'remote-unborn', sha: null, warnings };
    const localTip = applyReconcile(cwd, fetched.sha);
    if (localTip === fetched.sha) recordPushed(cwd, localTip);
    return { status: 'fetched', sha: fetched.sha, warnings };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    appendSyncLog(cwd, { event: 'sync-error', remote, detail });
    warnings.push(`handoff sync: unexpected error — ${detail}`);
    return { status: 'fetch-failed', sha: null, warnings };
  }
}

function failureResult(
  cwd: string,
  remote: string,
  op: SyncOp,
  cls: SyncFailureClass,
  phase: 'fetch' | 'push',
  detail: string,
  warnings: string[],
): SyncResult {
  const kind = cls === 'auth' ? 'auth' : cls === 'other' ? 'other' : 'offline';
  warnings.push(buildSyncWarning(kind, op, remote, detail));
  appendSyncLog(cwd, {
    event: 'sync-failed',
    class: cls,
    phase,
    remote,
    op,
    detail: detail.split('\n')[0] ?? '',
  });
  const status: SyncStatus =
    cls === 'auth' ? 'local-only-auth' : cls === 'other' ? 'sync-error' : 'local-only-offline';
  return { status, warnings, pushedStems: [], scrubFindings: [] };
}

function scrubRefusal(
  cwd: string,
  remote: string,
  scan: ScrubScan,
  warnings: string[],
): SyncResult {
  const entries = [...new Set(scan.findings.map((f) => f.entry))];
  const reason = scan.ok
    ? `secret-shaped content detected in: ${entries.join(', ')}`
    : `scrub scan failed (${scan.error ?? 'unknown'})`;
  warnings.push(
    `handoff sync: PUSH REFUSED (fail-closed) — ${reason}. Nothing was sent. Fix the baton body (rewrite or consume the offending baton) and retry; if the secret is already in local ref history, run the purge path to rewrite it out before pushing.`,
  );
  appendSyncLog(cwd, {
    event: 'scrub-refused',
    remote,
    scan_ok: scan.ok,
    entries,
    patterns: [...new Set(scan.findings.map((f) => f.pattern))],
  });
  return { status: 'scrub-refused', warnings, pushedStems: [], scrubFindings: scan.findings };
}

/** Fail-closed visibility refusal (a public/unknown remote that earned no
 *  deletion-only exemption). `reason` names WHY the exemption was denied. */
function publicRemoteRefused(
  cwd: string,
  remote: string,
  op: SyncOp,
  visibility: RemoteVisibility,
  reason: string,
  warnings: string[],
): SyncResult {
  warnings.push(
    `handoff sync: auto-push to '${remote}' refused — remote visibility is '${visibility}'. Custom refs are advertised and fetchable by anyone who can read the repo, and pushed history cannot be un-published. ${reason}. Confirm the repo is private, or explicitly opt in.`,
  );
  appendSyncLog(cwd, { event: 'public-remote-refused', remote, visibility, op, reason });
  return { status: 'public-remote-refused', warnings, pushedStems: [], scrubFindings: [] };
}

function syncInner(cwd: string, remote: string, opts: SyncOptions, warnings: string[]): SyncResult {
  const op = opts.op ?? 'command';
  const maxRetries = opts.maxRetries ?? SYNC_MAX_RETRIES;
  const timeoutMs = opts.timeoutMs ?? SYNC_TIMEOUT_MS;
  const offlineBackoffMs = opts.offlineBackoffMs ?? OFFLINE_RETRY_BACKOFF_MS;
  let offlineRetriesLeft = opts.offlineRetries ?? OFFLINE_PUSH_RETRIES;

  // Visibility authorization boundary — fail-closed: only a PROVEN-private remote
  // (or an explicit opt-in) may receive an UNRESTRICTED baton auto-push. A
  // public/unknown remote without opt-in is NOT refused outright here: the gate
  // moved INTO the push retry loop below, where — per attempt, against the OBSERVED
  // remote sha — a strictly deletion-only transmit set earns a narrow, identity-
  // masked exemption (evaluateDeletionOnlyExemption). The decision needs the
  // fetched remote sha, so it cannot live before the fetch.
  const pushAuthorized = opts.visibility === 'private' || opts.allowPublicRemote === true;

  // Fetch-first: absorb remote batons and observe the remote sha (lease base).
  // When the caller already observed the remote in THIS command (knownRemoteSha
  // from a preceding fetchHandoffRef), the initial fetch is skipped — a remote
  // that moved in the meantime is caught by the non-FF re-fetch loop below.
  let remoteSha: string | null;
  if (opts.knownRemoteSha !== undefined) {
    remoteSha = opts.knownRemoteSha;
  } else {
    let fetched = fetchRemoteTip(cwd, remote, timeoutMs);
    if (!fetched.ok && offlineRetriesLeft > 0) {
      const cls = fetched.timedOut ? 'offline' : classifySyncFailure(fetched.out);
      if (cls === 'offline') {
        offlineRetriesLeft -= 1;
        Bun.sleepSync(offlineBackoffMs);
        fetched = fetchRemoteTip(cwd, remote, timeoutMs);
      }
    }
    if (!fetched.ok) {
      const cls = fetched.timedOut ? 'offline' : classifySyncFailure(fetched.out);
      return failureResult(cwd, remote, op, cls, 'fetch', fetched.out, warnings);
    }
    remoteSha = fetched.sha;
  }

  let localTip = revParseQuiet(cwd, HANDOFF_REF);
  if (remoteSha !== null) localTip = applyReconcile(cwd, remoteSha);
  if (localTip === null) {
    return { status: 'nothing-to-push', warnings, pushedStems: [], scrubFindings: [] };
  }

  let status: SyncStatus = 'nothing-to-push';
  let pushedStems: string[] = [];
  if (localTip !== remoteSha) {
    let pushed = false;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Scrub gate before EVERY push attempt (the transmit delta changes as the
      // remote moves): detect-and-refuse, fail-closed on scan failure. Runs BEFORE
      // the visibility gate below, so a secret blocks the push even on a public
      // remote / an otherwise deletion-only delta.
      const scan = scrubScan(cwd, localTip, remoteSha);
      if (!scan.ok || scan.findings.length > 0) return scrubRefusal(cwd, remote, scan, warnings);

      // Visibility gate, per attempt, against the observed remoteSha. Authorized
      // (proven-private / opt-in) → the full local tip is pushed unchanged.
      // Otherwise ONLY a strictly deletion-only transmit set proceeds — republished
      // as an identity-masked single commit; anything that would publish new
      // content (a new blob or a new stem name) is refused fail-closed.
      let sourceTip = localTip;
      let exemptThisPush = false;
      if (!pushAuthorized) {
        const decision = evaluateDeletionOnlyExemption(cwd, localTip, remoteSha);
        if (!decision.exempt) {
          return publicRemoteRefused(cwd, remote, op, opts.visibility, decision.reason, warnings);
        }
        // Rebuild ONE masked commit carrying the post-deletion tip tree onto the
        // observed remote sha (collapses any piggybacked ancestor commits; the tree
        // is a subset of the published remote, so no baton is lost or newly leaked).
        sourceTip = commitTree(
          cwd,
          treeOf(cwd, localTip),
          remoteSha,
          HANDOFF_DELETION_COMMIT_MSG,
          maskIdentityEnv(opts.now),
        );
        exemptThisPush = true;
      }

      const refspec = exemptThisPush ? `${sourceTip}:${HANDOFF_REF}` : HANDOFF_PUSH_REFSPEC;
      opts.hooks?.beforePush?.(attempt);
      assertDittoPushRefspec(refspec);
      let push = runGitBounded(cwd, ['push', remote, '--', refspec], timeoutMs);
      if (!push.ok && !push.timedOut && offlineRetriesLeft > 0) {
        // Short in-command backoff for a transient offline blip (write-side contract).
        if (classifySyncFailure(`${push.stderr}\n${push.stdout}`) === 'offline') {
          offlineRetriesLeft -= 1;
          Bun.sleepSync(offlineBackoffMs);
          push = runGitBounded(cwd, ['push', remote, '--', refspec], timeoutMs);
        }
      }
      if (push.ok) {
        pushed = true;
        if (exemptThisPush) {
          // Flip the local ref to the masked commit (identical tip tree — no baton
          // lost) so local and remote agree and pending clears.
          const cas = gitLocal(cwd, ['update-ref', HANDOFF_REF, sourceTip, localTip]);
          if (cas.exitCode !== 0) {
            appendSyncLog(cwd, {
              event: 'exempt-local-cas-lost',
              remote,
              detail: cas.stderr.trim(),
            });
          }
        }
        remoteSha = sourceTip;
        localTip = sourceTip;
        recordPushed(cwd, sourceTip);
        pushedStems = treeEntries(cwd, sourceTip)
          .filter((e) => e.type === 'blob' && e.name.endsWith('.md'))
          .map((e) => e.name.replace(/\.md$/, ''));
        // Auto-push fires at a moment the user is not watching — record WHAT
        // was sent and where, durably.
        appendSyncLog(cwd, {
          event: exemptThisPush ? 'pushed-deletion-exempt' : 'pushed',
          remote,
          tip: sourceTip,
          stems: pushedStems,
          op,
        });
        break;
      }
      const out = `${push.stderr}\n${push.stdout}`.trim();
      const cls: SyncFailureClass = push.timedOut ? 'offline' : classifySyncFailure(out);
      if (cls !== 'non-ff') return failureResult(cwd, remote, op, cls, 'push', out, warnings);
      if (attempt >= maxRetries) {
        // Explicit terminal state: bounded retries spent → degrade to
        // local-success + warning (never an infinite loop; retried next command).
        warnings.push(buildSyncWarning('exhausted', op, remote, out));
        appendSyncLog(cwd, {
          event: 'sync-retry-exhausted',
          remote,
          op,
          detail: out.split('\n')[0] ?? '',
        });
        return { status: 'sync-retry-exhausted', warnings, pushedStems: [], scrubFindings: [] };
      }
      // non-FF: the remote moved ahead → fetch, tree-level re-merge, retry.
      const refetched = fetchRemoteTip(cwd, remote, timeoutMs);
      if (!refetched.ok || refetched.sha === null) {
        const rcls = refetched.timedOut ? 'offline' : classifySyncFailure(refetched.out);
        return failureResult(cwd, remote, op, rcls, 'fetch', refetched.out, warnings);
      }
      remoteSha = refetched.sha;
      localTip = applyReconcile(cwd, remoteSha);
      if (localTip === remoteSha) break; // re-merge resolved to remote state — nothing left to push
    }
    if (pushed) status = 'pushed';
  } else {
    recordPushed(cwd, localTip); // local and remote agree — clear pending state
  }

  // Retention truncation at push time (fetch/push above established that the
  // remote holds `remoteSha`; observed lease base = that sha). SKIPPED on an
  // unauthorized (public/unknown, no opt-in) remote: rebuildTruncatedChain
  // deliberately PRESERVES the original author/committer identity (for future-
  // window correctness), which on a public remote would re-leak exactly the
  // identity the deletion-only exemption just masked — and the force-push would
  // itself be an unauthorized publication. Truncation runs only on a proven-
  // private / opted-in remote.
  if (pushAuthorized && remoteSha !== null && revParseQuiet(cwd, HANDOFF_REF) === remoteSha) {
    runRetention(cwd, remote, remoteSha, opts, warnings);
  }
  return { status, warnings, pushedStems, scrubFindings: [] };
}

/**
 * Undetected-token recall path (the chosen recovery design): rewrite the WHOLE
 * local history to a single parentless root carrying the current tip tree, then
 * lease-push it — the leaked blob becomes unreachable on the remote (subject to
 * remote GC). The caller consumes/rewrites the offending baton FIRST; the new
 * root is itself scrub-gated so a still-dirty tree can never be purge-pushed.
 */
export function purgeHandoffHistory(cwd: string, remote: string, opts: SyncOptions): PurgeResult {
  const warnings: string[] = [];
  const timeoutMs = opts.timeoutMs ?? SYNC_TIMEOUT_MS;
  try {
    if (opts.visibility !== 'private' && opts.allowPublicRemote !== true) {
      appendSyncLog(cwd, {
        event: 'public-remote-refused',
        remote,
        visibility: opts.visibility,
        op: 'purge',
      });
      return {
        status: 'public-remote-refused',
        warnings,
        detail: `remote visibility is '${opts.visibility}' — purge push refused (fail-closed)`,
      };
    }
    const fetched = fetchRemoteTip(cwd, remote, timeoutMs);
    if (!fetched.ok) {
      appendSyncLog(cwd, { event: 'purge-failed', remote, detail: fetched.out });
      return { status: 'failed', warnings, detail: `purge requires the remote: ${fetched.out}` };
    }
    const remoteSha = fetched.sha;
    let localTip = revParseQuiet(cwd, HANDOFF_REF);
    if (remoteSha !== null) localTip = applyReconcile(cwd, remoteSha);
    if (localTip === null) return { status: 'nothing-to-purge', warnings, detail: 'ref is unborn' };

    const newRoot = commitTree(
      cwd,
      treeOf(cwd, localTip),
      null,
      'ditto handoff baton: purge history (secret recall)',
    );
    const scan = scrubScan(cwd, newRoot, null);
    if (!scan.ok || scan.findings.length > 0) {
      const entries = [...new Set(scan.findings.map((f) => f.entry))];
      appendSyncLog(cwd, {
        event: 'scrub-refused',
        remote,
        scan_ok: scan.ok,
        entries,
        phase: 'purge',
      });
      return {
        status: 'scrub-refused',
        warnings,
        detail: `tip tree still carries secret-shaped content (${entries.join(', ')}) — consume/rewrite the offending baton first`,
      };
    }
    let push: ReturnType<typeof runGitBounded>;
    if (remoteSha === null) {
      // Unborn remote ref: plain (force-free) push of the clean new root by
      // sha-source refspec — the local ref flips only after the remote accepted.
      const refspec = `${newRoot}:${HANDOFF_REF}`;
      assertDittoPushRefspec(refspec);
      push = runGitBounded(cwd, ['push', remote, '--', refspec], timeoutMs);
    } else {
      push = forcePushTruncated(cwd, remote, newRoot, remoteSha, timeoutMs);
    }
    if (!push.ok) {
      const out = `${push.stderr}\n${push.stdout}`.trim();
      appendSyncLog(cwd, { event: 'purge-failed', remote, detail: out });
      return { status: 'failed', warnings, detail: out };
    }
    const cas = gitLocal(cwd, ['update-ref', HANDOFF_REF, newRoot, localTip]);
    if (cas.exitCode !== 0) {
      appendSyncLog(cwd, { event: 'purge-local-cas-lost', remote, detail: cas.stderr.trim() });
    }
    recordPushed(cwd, newRoot);
    appendSyncLog(cwd, { event: 'purged', remote, tip: newRoot });
    return { status: 'purged', warnings, detail: `history rewritten to single root ${newRoot}` };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    appendSyncLog(cwd, { event: 'purge-failed', remote, detail });
    return { status: 'failed', warnings, detail };
  }
}
