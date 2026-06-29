import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ───────────────────────────────────────────────────────────────────────────
// HOOK PROVENANCE (wi_2606299kn ac-3, part B). The installed pre-push hook must
// NOT blind-prefer a CLONED sub-repo's own `bin/ditto`: a malicious clone that
// ships a tracked `bin/ditto` would get it executed on the victim's next
// `git push` (push-time RCE). These tests run the REAL shell hook template.
//
// Hermetic tool resolution: PATH carries ONLY `git` (symlinked in). bun and EVERY
// `ditto` (incl. macOS's own /usr/bin/ditto) are excluded, so the hook either runs
// an explicit `bin/ditto` path or fails closed — never some ambient binary. The
// planted `bin/ditto` scripts write their marker with shell builtins only (echo +
// redirect), so a marker proves the SCRIPT ran, not that `touch` happened to exist.
// ───────────────────────────────────────────────────────────────────────────

const REPO_ROOT = join(import.meta.dir, '..', '..');
const HOOK_TEMPLATE = join(REPO_ROOT, 'resources', 'hooks', 'pre-push');
const PUSH_MAIN = 'refs/heads/main a refs/heads/main b\n';

let toolbin: string;

beforeAll(async () => {
  const gitPath = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  toolbin = await mkdtemp(join(tmpdir(), 'ditto-pgw-toolbin-'));
  await symlink(gitPath, join(toolbin, 'git'));
});

afterAll(async () => {
  await rm(toolbin, { recursive: true, force: true });
});

/**
 * Materialize the hook from the shipped template. `wsRoot=null` → a root/single
 * install (WS_ROOT stays `""`). A path → simulate the N5 sub-repo install by
 * rewriting the `WS_ROOT=""` seam to pin the trusted workspace root.
 */
async function hookWith(wsRoot: string | null): Promise<string> {
  const template = await readFile(HOOK_TEMPLATE, 'utf8');
  if (wsRoot === null) return template;
  const out = template.replace('WS_ROOT=""', `WS_ROOT="${wsRoot}"`);
  expect(out).not.toBe(template); // the substitution seam must exist
  return out;
}

/** A `bin/ditto` script that records it ran by writing `marker` (builtins only). */
async function plantBinDitto(dir: string, marker: string): Promise<void> {
  await mkdir(join(dir, 'bin'), { recursive: true });
  await writeFile(join(dir, 'bin', 'ditto'), `#!/bin/sh\necho ran > "${marker}"\nexit 0\n`);
  await chmod(join(dir, 'bin', 'ditto'), 0o755);
}

function runHook(hookPath: string, cwd: string, stdin: string) {
  const proc = Bun.spawnSync(['/bin/sh', hookPath], {
    cwd,
    env: { PATH: toolbin, HOME: cwd },
    stdin: new TextEncoder().encode(stdin),
  });
  return { exitCode: proc.exitCode, stderr: proc.stderr?.toString() ?? '' };
}

describe('pre-push hook provenance — a cloned sub-repo bin/ditto is never executed (ac-3)', () => {
  test('sub-repo install (WS_ROOT pinned) does NOT run the clone own bin/ditto → fail-closed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ditto-pgw-prov-'));
    try {
      const sub = join(root, 'evil');
      execFileSync('git', ['init', '-q', sub]);
      const pwned = join(root, 'PWNED');
      await plantBinDitto(sub, pwned); // the CLONE ships its own (malicious) bin/ditto
      const wsRoot = join(root, 'trusted-root'); // trusted root, no bin/ditto here
      await mkdir(wsRoot, { recursive: true });

      const hookPath = join(root, 'pre-push');
      await writeFile(hookPath, await hookWith(wsRoot));
      const r = runHook(hookPath, sub, PUSH_MAIN);

      expect(existsSync(pwned)).toBe(false); // the clone's bin/ditto NEVER executed
      expect(r.exitCode).not.toBe(0); // no trusted ditto resolvable → fail-closed
      expect(r.stderr).toMatch(/DITTO_SKIP_HOOKS/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('NO regression: a root/single install still executes REPO/bin/ditto (dogfood)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ditto-pgw-prov-'));
    try {
      execFileSync('git', ['init', '-q', root]);
      const ran = join(root, 'RAN');
      await plantBinDitto(root, ran); // ditto's OWN repo bin/ditto IS trusted
      const hookPath = join(root, 'pre-push');
      await writeFile(hookPath, await hookWith(null)); // WS_ROOT empty → REPO is root

      const r = runHook(hookPath, root, PUSH_MAIN);

      expect(existsSync(ran)).toBe(true); // REPO/bin/ditto executed
      expect(r.exitCode).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
