import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileExists } from '~/core/hosts/shared';
import { PUSH_GATE_HOOK_MARKER } from '~/core/setup';
import {
  WorkspaceContainmentError,
  isAllowedCloneUrl,
  resolveContainedDir,
  syncWorkspace,
} from '~/core/workspace/clone';
import type { Recipe } from '~/schemas/recipe';

// The real bundled pre-push template `ditto setup` installs.
const HOOK_TEMPLATE = join(import.meta.dir, '..', '..', '..', 'resources', 'hooks', 'pre-push');

/** A real local source repo with one commit — the clone REMOTE (allowLocal seam). */
async function makeSourceRepo(): Promise<string> {
  const src = await mkdtemp(join(tmpdir(), 'ditto-ws-src-'));
  execFileSync('git', ['init', '-q', '.'], { cwd: src });
  await writeFile(join(src, 'README.md'), '# source\n');
  execFileSync('git', ['add', '.'], { cwd: src });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], {
    cwd: src,
  });
  return src;
}

/** A workspace root that resolveRepoRootForCreate will anchor on (has a .ditto). */
async function makeWorkspace(): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), 'ditto-ws-root-'));
  await mkdir(join(ws, '.ditto'), { recursive: true });
  return ws;
}

function recipe(repos: { dir: string; url?: string }[]): Recipe {
  return { repos } as Recipe;
}

// ───────────────────────────────────────────── URL allowlist (security, REQUIRED)
describe('isAllowedCloneUrl — scheme allowlist neutralizes RCE / option injection', () => {
  test('accepts https / ssh / git:// schemes', () => {
    expect(isAllowedCloneUrl('https://github.com/o/r.git')).toBe(true);
    expect(isAllowedCloneUrl('git@github.com:o/r.git')).toBe(true);
    expect(isAllowedCloneUrl('ssh://git@host/o/r.git')).toBe(true);
    expect(isAllowedCloneUrl('git://host/o/r.git')).toBe(true);
  });

  test('rejects ext:: and fd:: arbitrary-command transports (clone-time RCE)', () => {
    expect(isAllowedCloneUrl('ext::sh -c "touch pwned"')).toBe(false);
    expect(isAllowedCloneUrl('fd::3')).toBe(false);
    // REJECTED even under the local-transport test seam — RCE transport, never benign.
    expect(isAllowedCloneUrl('ext::sh -c "touch pwned"', true)).toBe(false);
    expect(isAllowedCloneUrl('fd::3', true)).toBe(false);
  });

  test('rejects file:// and a leading-dash (option injection)', () => {
    expect(isAllowedCloneUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedCloneUrl('--upload-pack=touch pwned')).toBe(false);
    // leading-dash stays rejected even under the local seam.
    expect(isAllowedCloneUrl('--upload-pack=x', true)).toBe(false);
  });

  test('local paths/file:// pass ONLY under the allowLocal test seam', () => {
    expect(isAllowedCloneUrl('/tmp/local.git')).toBe(false);
    expect(isAllowedCloneUrl('/tmp/local.git', true)).toBe(true);
    expect(isAllowedCloneUrl('file:///tmp/local.git', true)).toBe(true);
  });
});

// ───────────────────────────────────────────── dir containment (security, REQUIRED)
describe('resolveContainedDir — every write stays STRICTLY under the workspace root', () => {
  test('a contained sub-dir resolves to an absolute path under the root', () => {
    const target = resolveContainedDir('/ws', 'sub');
    expect(target).toBe(join('/ws', 'sub'));
  });

  test('rejects ../escape', () => {
    expect(() => resolveContainedDir('/ws', '../escape')).toThrow(WorkspaceContainmentError);
  });

  test('rejects an absolute path outside the root', () => {
    expect(() => resolveContainedDir('/ws', '/etc/evil')).toThrow(WorkspaceContainmentError);
  });

  test('rejects the root itself (".")', () => {
    expect(() => resolveContainedDir('/ws', '.')).toThrow(WorkspaceContainmentError);
  });
});

// ───────────────────────────────────────────── clone behavior (ac-1 / ac-2 / ac-4 / ac-5)
describe('syncWorkspace — clone / skip / refuse / fail', () => {
  test('ac-1: empty-dir clone of a declared url', async () => {
    const src = await makeSourceRepo();
    const ws = await makeWorkspace();
    try {
      const res = await syncWorkspace({
        workspaceRoot: ws,
        recipe: recipe([{ dir: 'sub', url: src }]),
        hookTemplatePath: HOOK_TEMPLATE,
        allowLocal: true,
      });
      expect(res.anyFailed).toBe(false);
      const o = res.outcomes[0];
      expect(o?.status).toBe('cloned');
      expect(await fileExists(join(ws, 'sub', 'README.md'))).toBe(true);
    } finally {
      await rm(src, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    }
  });

  test('ac-1: same-url re-sync is an idempotent skip (no overwrite)', async () => {
    const src = await makeSourceRepo();
    const ws = await makeWorkspace();
    try {
      const opts = {
        workspaceRoot: ws,
        recipe: recipe([{ dir: 'sub', url: src }]),
        hookTemplatePath: HOOK_TEMPLATE,
        allowLocal: true,
      };
      const first = await syncWorkspace(opts);
      expect(first.outcomes[0]?.status).toBe('cloned');
      // user-edits the clone: a re-sync must NOT clobber it.
      await writeFile(join(ws, 'sub', 'README.md'), '# locally edited\n');
      const second = await syncWorkspace(opts);
      expect(second.outcomes[0]?.status).toBe('skipped');
      expect(await readFile(join(ws, 'sub', 'README.md'), 'utf8')).toBe('# locally edited\n');
    } finally {
      await rm(src, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    }
  });

  test('ac-2: a foreign/dirty dir is refused (never overwritten)', async () => {
    const src = await makeSourceRepo();
    const ws = await makeWorkspace();
    try {
      // pre-existing user content (NOT our clone) at the target dir.
      await mkdir(join(ws, 'sub'), { recursive: true });
      await writeFile(join(ws, 'sub', 'user-file.txt'), 'precious\n');
      const res = await syncWorkspace({
        workspaceRoot: ws,
        recipe: recipe([{ dir: 'sub', url: src }]),
        hookTemplatePath: HOOK_TEMPLATE,
        allowLocal: true,
      });
      expect(res.outcomes[0]?.status).toBe('refused');
      expect(res.outcomes[0]?.reason).toBeTruthy();
      // The user's file is untouched.
      expect(await readFile(join(ws, 'sub', 'user-file.txt'), 'utf8')).toBe('precious\n');
    } finally {
      await rm(src, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    }
  });

  test('security: url allowlist refuses ext:: even under the local seam (no RCE)', async () => {
    const ws = await makeWorkspace();
    try {
      const res = await syncWorkspace({
        workspaceRoot: ws,
        recipe: recipe([{ dir: 'sub', url: `ext::sh -c "touch ${join(ws, 'pwned')}"` }]),
        hookTemplatePath: HOOK_TEMPLATE,
        allowLocal: true,
      });
      expect(res.outcomes[0]?.status).toBe('refused');
      expect(existsSync(join(ws, 'pwned'))).toBe(false);
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test('security: dir containment refuses ../escape (no write outside the root)', async () => {
    const src = await makeSourceRepo();
    const ws = await makeWorkspace();
    try {
      const res = await syncWorkspace({
        workspaceRoot: ws,
        recipe: recipe([{ dir: '../escape', url: src }]),
        hookTemplatePath: HOOK_TEMPLATE,
        allowLocal: true,
      });
      expect(res.outcomes[0]?.status).toBe('refused');
      expect(existsSync(join(ws, '..', 'escape'))).toBe(false);
    } finally {
      await rm(src, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    }
  });

  test('security: a pre-planted symlink at the target escaping the root is refused (no clone through it)', async () => {
    const src = await makeSourceRepo();
    const ws = await makeWorkspace();
    // an OUTSIDE-root location the planted symlink points at — an EMPTY dir, which
    // `git clone` happily follows and writes through (the empirical ESCAPE vector).
    const outside = await mkdtemp(join(tmpdir(), 'ditto-ws-outside-'));
    const escapeTarget = join(outside, 'escaped');
    await mkdir(escapeTarget, { recursive: true });
    try {
      // EXPLOIT: a checked-in symlink at <ws>/sub -> an empty path OUTSIDE the root.
      // A lexical-only containment classifies it `empty` and lets `git clone` follow
      // the symlink and write the cloned repo + pushed hook OUTSIDE the workspace root.
      await symlink(escapeTarget, join(ws, 'sub'));
      const res = await syncWorkspace({
        workspaceRoot: ws,
        recipe: recipe([{ dir: 'sub', url: src }]),
        hookTemplatePath: HOOK_TEMPLATE,
        allowLocal: true,
      });
      // the symlink target must be REFUSED — never cloned through.
      expect(res.outcomes[0]?.status).toBe('refused');
      // and nothing was written OUTSIDE the workspace root via the symlink.
      expect(existsSync(join(escapeTarget, 'README.md'))).toBe(false);
      expect(existsSync(join(escapeTarget, '.git'))).toBe(false);
    } finally {
      await rm(src, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('ac-5: a clone failure cleans up ONLY the ditto-made dir, leaves siblings', async () => {
    const ws = await makeWorkspace();
    try {
      // a pre-existing unrelated file in the workspace must survive the cleanup.
      await writeFile(join(ws, 'keep.txt'), 'keep\n');
      const res = await syncWorkspace({
        workspaceRoot: ws,
        // a local path that is not a repo → clone fails (allowLocal lets it reach git).
        recipe: recipe([{ dir: 'sub', url: join(tmpdir(), 'ditto-no-such-repo-zzz.git') }]),
        hookTemplatePath: HOOK_TEMPLATE,
        allowLocal: true,
      });
      expect(res.outcomes[0]?.status).toBe('failed');
      expect(res.anyFailed).toBe(true);
      // the partial clone dir ditto created is gone…
      expect(existsSync(join(ws, 'sub'))).toBe(false);
      // …but the pre-existing sibling is intact.
      expect(await readFile(join(ws, 'keep.txt'), 'utf8')).toBe('keep\n');
    } finally {
      await rm(ws, { recursive: true, force: true });
    }
  });

  test('ac-5: multi-repo partial-fail continues, summarizes, flags anyFailed', async () => {
    const good = await makeSourceRepo();
    const ws = await makeWorkspace();
    try {
      const res = await syncWorkspace({
        workspaceRoot: ws,
        recipe: recipe([
          { dir: 'ok', url: good },
          { dir: 'bad', url: join(tmpdir(), 'ditto-no-such-repo-yyy.git') },
        ]),
        hookTemplatePath: HOOK_TEMPLATE,
        allowLocal: true,
      });
      expect(res.outcomes.length).toBe(2);
      const byDir = Object.fromEntries(res.outcomes.map((o) => [o.dir, o.status]));
      expect(byDir.ok).toBe('cloned'); // the good one still cloned despite the bad one
      expect(byDir.bad).toBe('failed');
      expect(res.anyFailed).toBe(true);
    } finally {
      await rm(good, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    }
  });

  test('ac-5: a newly-cloned dir is added to the parent .gitignore (idempotently)', async () => {
    const src = await makeSourceRepo();
    const ws = await makeWorkspace();
    try {
      const opts = {
        workspaceRoot: ws,
        recipe: recipe([{ dir: 'sub', url: src }]),
        hookTemplatePath: HOOK_TEMPLATE,
        allowLocal: true,
      };
      await syncWorkspace(opts);
      const gi1 = await readFile(join(ws, '.gitignore'), 'utf8');
      expect(gi1).toContain('sub/');
      // a second sync (skip) must not duplicate the entry.
      await syncWorkspace(opts);
      const gi2 = await readFile(join(ws, '.gitignore'), 'utf8');
      const count = gi2.split('\n').filter((l) => l.trim() === 'sub/').length;
      expect(count).toBe(1);
    } finally {
      await rm(src, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    }
  });

  test('ac-4: the cloned sub-repo gets the pre-push hook with WS_ROOT set to the workspace root', async () => {
    const src = await makeSourceRepo();
    const ws = await makeWorkspace();
    try {
      const res = await syncWorkspace({
        workspaceRoot: ws,
        recipe: recipe([{ dir: 'sub', url: src }]),
        hookTemplatePath: HOOK_TEMPLATE,
        allowLocal: true,
      });
      expect(res.outcomes[0]?.hook).toBe('installed');
      const hookPath = join(ws, 'sub', '.git', 'hooks', 'pre-push');
      const body = await readFile(hookPath, 'utf8');
      expect(body).toContain(PUSH_GATE_HOOK_MARKER);
      // ROOT-ONLY: WS_ROOT baked to the absolute workspace root, not left empty.
      expect(body).toContain(`WS_ROOT="${ws}"`);
      expect(body).not.toContain('WS_ROOT=""');
    } finally {
      await rm(src, { recursive: true, force: true });
      await rm(ws, { recursive: true, force: true });
    }
  });
});
