import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeTreeState, gitOut } from '~/core/git-tree';

// n-gate-engine (finding 12): the git-tree I/O helpers extracted from the CLI into
// core so the push-gate and e2e-gate share ONE home for reading git tree identity.
// These are the ONLY I/O in the gate stack; the decision cores stay pure.

/** Run a git subcommand in `cwd`, throwing on failure (test setup only). */
function run(args: string[], cwd: string): void {
  const p = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
  });
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}`);
}

/** A fresh git repo with one commit; caller must rm it. */
function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ditto-gittree-'));
  run(['init', '-q'], dir);
  run(['config', 'user.email', 't@example.com'], dir);
  run(['config', 'user.name', 'Test'], dir);
  run(['config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'a.txt'), 'hello\n');
  run(['add', '.'], dir);
  run(['commit', '-q', '-m', 'init'], dir);
  return dir;
}

describe('computeTreeState — HEAD tree hash + clean flag', () => {
  test('a committed repo → defined 40-hex tree + clean=true', () => {
    const dir = freshRepo();
    try {
      const st = computeTreeState(dir);
      expect(st).toBeDefined();
      expect(st?.tree).toMatch(/^[0-9a-f]{40}$/);
      expect(st?.clean).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an uncommitted change → clean=false (same tree HEAD)', () => {
    const dir = freshRepo();
    try {
      writeFileSync(join(dir, 'b.txt'), 'new\n');
      const st = computeTreeState(dir);
      expect(st).toBeDefined();
      expect(st?.clean).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a non-git dir (no HEAD) → undefined (fail-safe: run the full gate)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ditto-nogit-'));
    try {
      expect(computeTreeState(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('gitOut — trimmed stdout or null on any failure', () => {
  test('a failing subcommand (rev-parse outside a repo) → null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ditto-gitout-'));
    try {
      expect(gitOut(['rev-parse', 'HEAD'], dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a succeeding subcommand → its trimmed stdout', () => {
    const dir = freshRepo();
    try {
      expect(gitOut(['rev-parse', '--is-inside-work-tree'], dir)).toBe('true');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
