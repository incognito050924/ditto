import { type Handoff, handoff as handoffSchema } from '~/schemas/handoff';
import {
  gitAuthorSlug,
  parseHandoffFile,
  renderHandoff,
  scopeKey,
  scrubHandoffForCommit,
  slugifyAuthor,
} from './handoff-store';

/**
 * Hidden-ref baton store (wi_260722g7h): handoff batons live as file entries in a
 * tree committed onto `refs/ditto/handoffs` — a per-repo ref OUTSIDE refs/heads.
 * Everything is done with git plumbing (hash-object / mktree / commit-tree /
 * update-ref), so a write touches NO working-tree file, lands NO commit on the
 * current branch and shows up NOWHERE in `git branch`; and because loose/packed
 * refs are per-repo (shared by every linked worktree), a consumed baton disappears
 * for all worktrees at once.
 *
 * Concurrency: every mutation is a compare-and-swap — read tip, build the new
 * tree + commit, then `update-ref <ref> <new> <expected-old>`. A CAS loss re-reads
 * and rebuilds (bounded); the consume loser then finds the entry gone and refuses
 * idempotently (first-consumer-wins, the body is returned ONLY after CAS success).
 * Ref-lock contention (`.lock` + `File exists`) is retried with bounded backoff;
 * any other update-ref failure surfaces immediately.
 *
 * Reads (`list`) are LOCAL ref lookups only — this module never fetches, pushes or
 * touches any remote. 0-state contract: an unborn ref and an emptied tip tree are
 * both "no handoffs", never an error.
 *
 * Safety: the baton body is token-scrubbed FAIL-CLOSED before any git object is
 * created (parity with the old store's pre-commit scrub — a secret must never
 * reach the object DB, where it would be irreversible), and every tree entry name
 * passes `assertSafeRefTreeName` before it can reach mktree's line format.
 */

/** The hidden per-repo ref all handoff batons live on (shared across worktrees). */
export const HANDOFF_REF = 'refs/ditto/handoffs';

const ZERO_SHA = '0'.repeat(40);
/** Bounded CAS rebuild attempts (read-tip → build → update-ref) per mutation. */
const MAX_CAS_ATTEMPTS = 3;
/** Bounded retries when the ref's .lock file is contended (backoff between tries). */
const MAX_LOCK_ATTEMPTS = 5;

export type UpdateRefFailureClass = 'cas_loss' | 'lock_contention' | 'error';

export interface RefWriteResult {
  ref: string;
  commit: string;
  stem: string;
  /** How many CAS losses were absorbed by rebuild-retry before landing. */
  casRetries: number;
}

export type RefConsumeResult =
  | { status: 'consumed'; handoff: Handoff; body: string; commit: string }
  /** The baton existed on the ref's history but is gone — idempotent refusal. */
  | { status: 'already_consumed' }
  /** No such baton ever existed on this ref (includes the unborn-ref 0-state). */
  | { status: 'not_found' };

export interface RefBaton {
  stem: string;
  handoff: Handoff;
  body: string;
}

export interface RefListResult {
  batons: RefBaton[];
  /** Entries at the tip that failed to parse — surfaced, never silently dropped. */
  failures: { name: string; error: string }[];
}

export interface RefWriteOptions {
  /** Explicit author slug (else derived from git identity, `anon` fallback). */
  author?: string;
}

/**
 * Test seam: invoked after the new commit object is built but BEFORE update-ref.
 * A test hooks a competing writer/consumer in here to deterministically force the
 * CAS-loss path (a real interleaving cannot be produced with sync spawns).
 */
export interface HandoffRefStoreHooks {
  beforeUpdateRef?: (op: 'write' | 'consume') => void;
}

/** A ref-store operation failed in a way that must surface (never fail-open). */
export class HandoffRefStoreError extends Error {
  constructor(
    public readonly code: 'git_failed' | 'update_ref_failed' | 'cas_exhausted',
    message: string,
  ) {
    super(message);
    this.name = 'HandoffRefStoreError';
  }
}

/**
 * Reject a tree-entry name component BEFORE it reaches mktree/commit-tree. The old
 * store's assertSafeKey (fs/argv oriented) does NOT reject newline or tab — but
 * mktree's line format is `<mode> <type> <sha>\t<name>\n`, so a newline or tab in a
 * free-text key (session_id has no charset lock) would be a tree-entry INJECTION.
 * Rejected: empty, leading `-` (git option injection), `/` or `\` (path
 * separators), `..`, NUL, newline (\n, \r), tab.
 */
export function assertSafeRefTreeName(value: string, label: string): void {
  if (value.length === 0) throw new Error(`handoff ${label} must not be empty`);
  if (value.startsWith('-')) throw new Error(`handoff ${label} must not start with '-': ${value}`);
  if (/[\\/]/.test(value))
    throw new Error(`handoff ${label} must not contain a path separator: ${value}`);
  if (value.includes('..')) throw new Error(`handoff ${label} must not contain '..': ${value}`);
  if (/[\0\n\r\t]/.test(value))
    throw new Error(`handoff ${label} must not contain NUL/newline/tab: ${JSON.stringify(value)}`);
}

/**
 * 3-way classification of an update-ref failure (the runGit index.lock regex of the
 * old store does NOT cover ref locks — refs use `<ref>.lock`, not `index.lock`):
 *  - cas_loss: the expected-old check failed (`is at … but expected …`), or the ref
 *    vanished/appeared underneath us (`unable to resolve reference`, `reference
 *    already exists`). Recover by re-reading the tip and rebuilding — no point
 *    retrying the same update-ref.
 *  - lock_contention: another process holds `<ref>.lock` (`.lock` + `File exists`).
 *    The same update-ref may be retried after a short backoff.
 *  - error: anything else — surface immediately.
 */
export function classifyUpdateRefFailure(stderr: string): UpdateRefFailureClass {
  if (/but expected|unable to resolve reference|reference already exists/i.test(stderr)) {
    return 'cas_loss';
  }
  if (/\.lock/.test(stderr) && /File exists/i.test(stderr)) return 'lock_contention';
  return 'error';
}

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface TreeEntry {
  mode: string;
  type: string;
  sha: string;
  name: string;
}

/** Same serialized form as the file store: 1-line JSON frontmatter + markdown body. */
function serializeBaton(h: Handoff): string {
  return `---\n${JSON.stringify(h)}\n---\n\n${renderHandoff(h)}\n`;
}

export class HandoffRefStore {
  constructor(
    public readonly repoRoot: string,
    private readonly hooks: HandoffRefStoreHooks = {},
  ) {}

  /**
   * Commit a baton onto the hidden ref. Pre-commit invariants, in order:
   * key guard (tree-entry injection) → fail-closed token scrub → THEN the first
   * git object. CAS loop: a lost race re-reads the tip and rebuilds (bounded).
   */
  write(h: Handoff, opts: RefWriteOptions = {}): RefWriteResult {
    const author =
      opts.author !== undefined ? slugifyAuthor(opts.author) : gitAuthorSlug(this.repoRoot);
    assertSafeRefTreeName(author, 'author-slug');
    const key = scopeKey(h.scope);
    assertSafeRefTreeName(key, h.scope.kind === 'work_item' ? 'work_item_id' : 'session_id');
    const stem = h.scope.kind === 'work_item' ? `${key}__${author}` : `session__${key}__${author}`;
    const name = `${stem}.md`;

    // Fail-closed scrub BEFORE any git object exists — the object DB is irreversible.
    const content = serializeBaton(scrubHandoffForCommit(h));

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const tip = this.tip();
      const kept = tip === null ? [] : this.treeEntries(tip).filter((e) => e.name !== name);
      const blob = this.hashObject(content);
      const tree = this.mktree([...kept, { mode: '100644', type: 'blob', sha: blob, name }]);
      const commit = this.commitTree(tree, tip, `ditto handoff baton: write ${stem}`);
      this.hooks.beforeUpdateRef?.('write');
      const res = this.updateRefWithLockRetry(commit, tip);
      if (res.ok) return { ref: HANDOFF_REF, commit, stem, casRetries: attempt };
      if (res.cls !== 'cas_loss') {
        throw new HandoffRefStoreError('update_ref_failed', `update-ref failed: ${res.stderr}`);
      }
      // cas_loss → loop re-reads the tip and rebuilds on top of it
    }
    throw new HandoffRefStoreError(
      'cas_exhausted',
      `write ${stem}: lost the update-ref CAS ${MAX_CAS_ATTEMPTS} times`,
    );
  }

  /**
   * Consume a baton: return its body and land a deletion commit. First-consumer-
   * wins: the body is returned ONLY after the CAS succeeds — a loser re-reads,
   * finds the entry gone and refuses idempotently (`already_consumed`), never a
   * silent no-op and never an unhandled throw. Unborn ref / never-written stem is
   * the `not_found` 0-state.
   */
  consume(stem: string): RefConsumeResult {
    assertSafeRefTreeName(stem, 'stem');
    const name = `${stem}.md`;

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
      const tip = this.tip();
      if (tip === null) return { status: 'not_found' }; // unborn ref — no handoffs
      const entries = this.treeEntries(tip);
      const entry = entries.find((e) => e.name === name);
      if (entry === undefined) {
        // Absent at the tip: distinguish "was here once" (idempotent refusal)
        // from "never existed" via the ref's own history — a local-only lookup.
        return this.everTouched(tip, name)
          ? { status: 'already_consumed' }
          : { status: 'not_found' };
      }
      const parsed = parseHandoffFile(this.catBlob(entry.sha));
      // Re-validate through the schema so a foreign/hand-crafted entry can't
      // smuggle an unparsed shape past consume.
      const handoff = handoffSchema.parse(parsed.handoff);
      const tree = this.mktree(entries.filter((e) => e.name !== name));
      const commit = this.commitTree(tree, tip, `ditto handoff baton: consume ${stem}`);
      this.hooks.beforeUpdateRef?.('consume');
      const res = this.updateRefWithLockRetry(commit, tip);
      if (res.ok) return { status: 'consumed', handoff, body: parsed.body, commit };
      if (res.cls !== 'cas_loss') {
        throw new HandoffRefStoreError('update_ref_failed', `update-ref failed: ${res.stderr}`);
      }
      // cas_loss → someone raced us; re-read (they may have consumed this baton)
    }
    throw new HandoffRefStoreError(
      'cas_exhausted',
      `consume ${stem}: lost the update-ref CAS ${MAX_CAS_ATTEMPTS} times`,
    );
  }

  /**
   * Every baton at the ref tip (LOCAL lookup only — never fetch/push/sync; this is
   * the read path autopilot/doctor handoff-round counters ride). Unborn ref and
   * emptied tree are both the empty list. Unparsable entries are surfaced.
   */
  list(): RefListResult {
    const tip = this.tip();
    if (tip === null) return { batons: [], failures: [] };
    const batons: RefBaton[] = [];
    const failures: { name: string; error: string }[] = [];
    for (const entry of this.treeEntries(tip)) {
      if (entry.type !== 'blob' || !entry.name.endsWith('.md')) continue;
      try {
        const parsed = parseHandoffFile(this.catBlob(entry.sha));
        batons.push({
          stem: entry.name.replace(/\.md$/, ''),
          handoff: parsed.handoff,
          body: parsed.body,
        });
      } catch (err) {
        failures.push({
          name: entry.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    batons.sort((a, b) => a.handoff.created_at.localeCompare(b.handoff.created_at));
    return { batons, failures };
  }

  // ── git plumbing ────────────────────────────────────────────────────────────

  private git(args: string[], stdin?: Uint8Array): GitResult {
    const proc = Bun.spawnSync(['git', ...args], {
      cwd: this.repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
      ...(stdin === undefined ? {} : { stdin }),
    });
    return {
      exitCode: proc.exitCode,
      stdout: proc.stdout?.toString() ?? '',
      stderr: proc.stderr?.toString() ?? '',
    };
  }

  /** Plumbing helper that must succeed — a failure is surfaced, never swallowed. */
  private gitOrThrow(args: string[], stdin?: Uint8Array): string {
    const r = this.git(args, stdin);
    if (r.exitCode !== 0) {
      throw new HandoffRefStoreError('git_failed', `git ${args[0]} failed: ${r.stderr.trim()}`);
    }
    return r.stdout;
  }

  /**
   * Ref tip commit, or null for an unborn ref. `--verify --quiet` exits nonzero on
   * absence — that is the EXPECTED 0-state signal, not an error (explicit branch;
   * the readdir-catch convention of the file store does not apply here).
   */
  private tip(): string | null {
    const r = this.git(['rev-parse', '--verify', '--quiet', `${HANDOFF_REF}^{commit}`]);
    return r.exitCode === 0 ? r.stdout.trim() : null;
  }

  /** Entries of the tip tree, read NUL-terminated (`-z`) so no name quoting applies. */
  private treeEntries(tip: string): TreeEntry[] {
    const out = this.gitOrThrow(['ls-tree', '-z', tip]);
    const entries: TreeEntry[] = [];
    for (const line of out.split('\0')) {
      if (line.length === 0) continue;
      const tab = line.indexOf('\t');
      if (tab === -1) continue;
      const [mode, type, sha] = line.slice(0, tab).split(' ');
      if (!mode || !type || !sha) {
        throw new HandoffRefStoreError('git_failed', `unparsable ls-tree entry: ${line}`);
      }
      entries.push({ mode, type, sha, name: line.slice(tab + 1) });
    }
    return entries;
  }

  private hashObject(content: string): string {
    return this.gitOrThrow(
      ['hash-object', '-w', '--stdin'],
      new TextEncoder().encode(content),
    ).trim();
  }

  /** Build a tree via `mktree -z` (NUL-terminated input — no line-format parsing). */
  private mktree(entries: TreeEntry[]): string {
    const input = entries.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}\0`).join('');
    return this.gitOrThrow(['mktree', '-z'], new TextEncoder().encode(input)).trim();
  }

  private commitTree(tree: string, parent: string | null, message: string): string {
    const args = ['commit-tree', tree, ...(parent === null ? [] : ['-p', parent]), '-m', message];
    return this.gitOrThrow(args).trim();
  }

  private catBlob(sha: string): string {
    return this.gitOrThrow(['cat-file', 'blob', sha]);
  }

  /**
   * Whether `name` was ever present on the ref's history (deletion commits keep
   * the trail) — distinguishes `already_consumed` from `not_found`. Local-only.
   */
  private everTouched(tip: string, name: string): boolean {
    return this.gitOrThrow(['log', tip, '--format=%H', '-n', '1', '--', name]).trim().length > 0;
  }

  /**
   * `update-ref <ref> <new> <expected-old>` — the CAS. Ref-lock contention is
   * retried in place with bounded backoff; a CAS loss is returned to the caller's
   * rebuild loop; anything else (incl. lock exhaustion) surfaces as an error class.
   */
  private updateRefWithLockRetry(
    newSha: string,
    expectedOld: string | null,
  ): { ok: true } | { ok: false; cls: 'cas_loss' | 'error'; stderr: string } {
    let lastStderr = '';
    for (let i = 0; i < MAX_LOCK_ATTEMPTS; i++) {
      const r = this.git(['update-ref', HANDOFF_REF, newSha, expectedOld ?? ZERO_SHA]);
      if (r.exitCode === 0) return { ok: true };
      lastStderr = r.stderr;
      const cls = classifyUpdateRefFailure(r.stderr);
      if (cls === 'cas_loss') return { ok: false, cls: 'cas_loss', stderr: r.stderr };
      if (cls === 'lock_contention' && i < MAX_LOCK_ATTEMPTS - 1) {
        Bun.sleepSync(20 * (i + 1));
        continue;
      }
      return { ok: false, cls: 'error', stderr: r.stderr };
    }
    return { ok: false, cls: 'error', stderr: lastStderr };
  }
}
