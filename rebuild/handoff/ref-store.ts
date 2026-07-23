import { execFileSync } from 'node:child_process';

/**
 * Handoff baton store on the single hidden ref `refs/ditto/handoffs`.
 *
 * Pure git plumbing — no working-tree file, no branch ever exists. A write is
 * a commit whose tree gains one blob entry (the baton body); a consume is a
 * commit whose tree drops that entry, and the body is returned ONLY after the
 * compare-and-swap ref update succeeds — that CAS is what makes the baton
 * first-consumer-wins across racing checkouts. An absent baton consumes to
 * null (idempotent), never an error.
 */

export const HANDOFFS_REF = 'refs/ditto/handoffs';
const ZERO_SHA = '0'.repeat(40);
const MAX_CAS_ATTEMPTS = 3;

export class UnsafeBatonNameError extends Error {
  constructor(name: string) {
    super(
      `unsafe handoff baton name ${JSON.stringify(name)} — allowed: [A-Za-z0-9._-]+ not starting with "."`,
    );
    this.name = 'UnsafeBatonNameError';
  }
}

export class BatonExistsError extends Error {
  constructor(name: string) {
    super(`handoff baton "${name}" already exists — consume it first, batons are never overwritten`);
    this.name = 'BatonExistsError';
  }
}

export class HandoffCasExhaustedError extends Error {
  constructor(op: string) {
    super(`handoff ${op} lost the ref CAS ${MAX_CAS_ATTEMPTS} times — giving up`);
    this.name = 'HandoffCasExhaustedError';
  }
}

/** Deterministic identity for baton commits — no reliance on user git config. */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'ditto-handoff',
  GIT_AUTHOR_EMAIL: 'ditto-handoff@local',
  GIT_COMMITTER_NAME: 'ditto-handoff',
  GIT_COMMITTER_EMAIL: 'ditto-handoff@local',
};

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: GIT_ENV,
    ...(input !== undefined ? { input } : {}),
  });
}

/** mktree line-format injection guard: one conservative charset, no dot-leading names. */
function assertSafeBatonName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith('.')) {
    throw new UnsafeBatonNameError(name);
  }
}

function readTip(cwd: string): string | null {
  try {
    return git(cwd, ['rev-parse', '--verify', '--quiet', HANDOFFS_REF]).trim();
  } catch {
    return null; // unborn ref
  }
}

interface TreeEntry {
  sha: string;
  name: string;
}

function listEntries(cwd: string, tip: string): TreeEntry[] {
  const out = git(cwd, ['ls-tree', '-z', tip]);
  return out
    .split('\0')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [meta, name] = line.split('\t') as [string, string];
      const sha = meta.split(' ')[2]!;
      return { sha, name };
    });
}

function writeTreeCommit(
  cwd: string,
  entries: TreeEntry[],
  message: string,
  parent: string | null,
): string {
  const treeInput = entries
    .map((e) => `100644 blob ${e.sha}\t${e.name}\0`)
    .join('');
  const treeSha = git(cwd, ['mktree', '-z'], treeInput).trim();
  const args = ['commit-tree', treeSha, '-m', message];
  if (parent !== null) args.push('-p', parent);
  return git(cwd, args).trim();
}

/** CAS: succeeds only when the ref still points at `expectedOld`. */
function casUpdateRef(
  cwd: string,
  next: string,
  expectedOld: string | null,
): boolean {
  try {
    git(cwd, ['update-ref', HANDOFFS_REF, next, expectedOld ?? ZERO_SHA]);
    return true;
  } catch {
    return false;
  }
}

export async function writeHandoff(
  repoRoot: string,
  name: string,
  body: string,
): Promise<{ commit: string }> {
  assertSafeBatonName(name);
  const blobSha = git(repoRoot, ['hash-object', '-w', '--stdin'], body).trim();

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const tip = readTip(repoRoot);
    const entries = tip === null ? [] : listEntries(repoRoot, tip);
    if (entries.some((e) => e.name === name)) throw new BatonExistsError(name);

    const commit = writeTreeCommit(
      repoRoot,
      [...entries, { sha: blobSha, name }],
      `handoff: write ${name}`,
      tip,
    );
    if (casUpdateRef(repoRoot, commit, tip)) return { commit };
  }
  throw new HandoffCasExhaustedError('write');
}

/**
 * Return the baton body exactly once. The body is read before the removal
 * commit but returned only after the CAS lands — a racing consumer that loses
 * the CAS retries, finds the entry gone, and gets null.
 */
export async function consumeHandoff(
  repoRoot: string,
  name: string,
): Promise<string | null> {
  assertSafeBatonName(name);

  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const tip = readTip(repoRoot);
    if (tip === null) return null;
    const entries = listEntries(repoRoot, tip);
    const entry = entries.find((e) => e.name === name);
    if (entry === undefined) return null; // already consumed — idempotent

    const body = git(repoRoot, ['cat-file', 'blob', entry.sha]);
    const commit = writeTreeCommit(
      repoRoot,
      entries.filter((e) => e.name !== name),
      `handoff: consume ${name}`,
      tip,
    );
    if (casUpdateRef(repoRoot, commit, tip)) return body;
  }
  throw new HandoffCasExhaustedError('consume');
}
