import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanSignatureChanges } from '~/acg/semantic/signature-codeql';
import { makeRelationDeps } from '~/core/codeql/host-deps';

/**
 * O7 (wi_260605de1) — real CodeQL signature scan. Unit tests cover the pure
 * row→map→diff; this proves CodeQL actually reconstructs the before→after
 * signature change on a real git repo, including an UNCOMMITTED after state.
 *
 *   CODEQL_E2E=1 CODEQL_BIN=~/.local/bin/codeql bun test tests/acg/signature-codeql-e2e.test.ts
 */
const CODEQL_BIN = process.env.CODEQL_BIN ?? `${process.env.HOME}/.local/bin/codeql`;
const enabled = process.env.CODEQL_E2E === '1' && existsSync(CODEQL_BIN);
const d = enabled ? describe : describe.skip;

d('scanSignatureChanges — real CodeQL', () => {
  test('detects an exported signature change between a base ref and the working tree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-sigcq-'));
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
    try {
      await mkdir(join(dir, 'src'), { recursive: true });
      git(['init']);
      git(['config', 'user.email', 't@t.t']);
      git(['config', 'user.name', 't']);
      await writeFile(
        join(dir, 'src/user.ts'),
        'export function getUser(id: string): User | null { return null; }\n',
      );
      git(['add', '-A']);
      git(['commit', '-m', 'base']);

      // Uncommitted change: drop the null return. base = HEAD, after = working tree.
      await writeFile(
        join(dir, 'src/user.ts'),
        'export function getUser(id: string): User { return {} as User; }\n',
      );

      const changes = await scanSignatureChanges(
        {
          repoRoot: dir,
          baseRef: 'HEAD',
          language: 'javascript',
          sourceRootRel: 'src',
          binary: CODEQL_BIN,
        },
        makeRelationDeps(),
      );

      // CodeQL reconstructs parameter TYPES (not names) — that is the
      // compatibility-relevant shape: `getUser(string): User | null` → `...: User`.
      expect(changes).toEqual([
        {
          file: 'user.ts',
          symbol: 'getUser',
          before: 'getUser(string): User | null',
          after: 'getUser(string): User',
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test('a body-only change produces no signature change', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-sigcq2-'));
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
    try {
      await mkdir(join(dir, 'src'), { recursive: true });
      git(['init']);
      git(['config', 'user.email', 't@t.t']);
      git(['config', 'user.name', 't']);
      await writeFile(
        join(dir, 'src/u.ts'),
        'export function f(a: number): number { return a; }\n',
      );
      git(['add', '-A']);
      git(['commit', '-m', 'base']);
      await writeFile(
        join(dir, 'src/u.ts'),
        'export function f(a: number): number { return a * 2; }\n',
      );

      const changes = await scanSignatureChanges(
        {
          repoRoot: dir,
          baseRef: 'HEAD',
          language: 'javascript',
          sourceRootRel: 'src',
          binary: CODEQL_BIN,
        },
        makeRelationDeps(),
      );
      expect(changes).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

/**
 * wi_260605ml1 (A) — multi-language signature bindings. Same scanSignatureChanges
 * path, language-bound CodeQL query. Java extracts buildless (build-mode none);
 * Kotlin reuses the java query and is proven on a real kotlinc-built DB in the
 * ac-0 probe (no build-system dependency dragged into the test suite).
 */
d('scanSignatureChanges — java (real CodeQL, build-mode none)', () => {
  test('detects a public-method return-type change', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-sigcq-java-'));
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
    try {
      await mkdir(join(dir, 'src'), { recursive: true });
      git(['init']);
      git(['config', 'user.email', 't@t.t']);
      git(['config', 'user.name', 't']);
      await writeFile(
        join(dir, 'src/Svc.java'),
        'public class Svc {\n  public int compute(int n) { return n; }\n}\n',
      );
      git(['add', '-A']);
      git(['commit', '-m', 'base']);

      // Uncommitted change: widen the return type int → long.
      await writeFile(
        join(dir, 'src/Svc.java'),
        'public class Svc {\n  public long compute(int n) { return n; }\n}\n',
      );

      const changes = await scanSignatureChanges(
        {
          repoRoot: dir,
          baseRef: 'HEAD',
          language: 'java',
          sourceRootRel: 'src',
          buildMode: 'none',
          binary: CODEQL_BIN,
        },
        makeRelationDeps(),
      );
      expect(changes).toEqual([
        {
          file: 'Svc.java',
          symbol: 'compute',
          before: 'compute(int): int',
          after: 'compute(int): long',
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});

d('scanSignatureChanges — python (real CodeQL)', () => {
  test('detects an added parameter on a module-level function', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ditto-sigcq-py-'));
    const git = (args: string[]) =>
      execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
    try {
      await mkdir(join(dir, 'src'), { recursive: true });
      git(['init']);
      git(['config', 'user.email', 't@t.t']);
      git(['config', 'user.name', 't']);
      await writeFile(join(dir, 'src/svc.py'), 'def get_user(id):\n    return id\n');
      git(['add', '-A']);
      git(['commit', '-m', 'base']);

      // Uncommitted change: add a parameter — arity/name shift breaks callers.
      await writeFile(join(dir, 'src/svc.py'), 'def get_user(id, active):\n    return id\n');

      const changes = await scanSignatureChanges(
        {
          repoRoot: dir,
          baseRef: 'HEAD',
          language: 'python',
          sourceRootRel: 'src',
          binary: CODEQL_BIN,
        },
        makeRelationDeps(),
      );
      // Python signature = name(param-names); return type omitted (dynamic typing).
      expect(changes).toEqual([
        {
          file: 'svc.py',
          symbol: 'get_user',
          before: 'get_user(id)',
          after: 'get_user(id, active)',
        },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
