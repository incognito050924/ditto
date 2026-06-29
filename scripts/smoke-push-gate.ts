/**
 * scripts/smoke-push-gate.ts — ac-6 (wi_260629i9c)
 *
 * SYNTHETIC FOREIGN-REPO SMOKE for the recipe-driven git pre-push gate. Proves,
 * end-to-end in a DISPOSABLE foreign repo (no network — a local BARE remote), that:
 *   - `ditto setup` installs a pre-push hook from a recipe.yaml `push_gate`, and
 *   - a FAILING `test_command` BLOCKS a push to a PROTECTED branch, while a
 *     PASSING `test_command` ALLOWS it, and a NON-protected branch pushes
 *     regardless (the gate is branch-scoped).
 *
 * How `ditto` is made resolvable for the FOREIGN repo's hook
 * ---------------------------------------------------------
 * resources/hooks/pre-push resolves the runnable ditto as (1) a repo-local
 * `$REPO/bin/ditto`, else (2) a `ditto` on PATH, else it FAILS CLOSED. A foreign
 * repo has no `./bin/ditto`, so this harness PREPENDS THIS repo's `bin/` dir to the
 * PATH used for `git push`. The hook's `command -v ditto` then resolves THIS repo's
 * freshly-built `bin/ditto` (a `#!/usr/bin/env bun` launcher), and `bun` itself
 * stays resolvable through the inherited PATH.
 *
 * Run:  `bun scripts/smoke-push-gate.ts`   (exit 0 = PASS, exit 1 = FAIL)
 *
 * CI-safe + idempotent: every run uses fresh `mkdtemp` dirs; an isolated fake HOME
 * keeps both setup's GLOBAL_* resources and git away from the developer's real
 * `~/.claude` / `~/.gitconfig`. Identity is set LOCALLY in the temp repo, so the
 * harness relies on no global git config beyond what it sets itself.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The script lives at <repo>/scripts/smoke-push-gate.ts, so the repo root is its
// grandparent and the built binary is <repo>/bin/ditto (resolved ABSOLUTELY).
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN_DIR = join(REPO_ROOT, 'bin');
const BIN_DITTO = join(BIN_DIR, 'ditto');
// Marker line the installed hook carries — proves the hook is ditto-managed
// (mirrors PUSH_GATE_HOOK_MARKER in src/core/setup.ts).
const HOOK_MARKER = 'ditto:managed:pre-push';

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): RunResult {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: env ?? process.env });
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Run a command that MUST succeed (repo plumbing); throw with output on failure. */
function mustRun(cmd: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): RunResult {
  const r = run(cmd, args, cwd, env);
  if (r.status !== 0) {
    throw new Error(
      `command failed (exit ${r.status}): ${cmd} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`,
    );
  }
  return r;
}

/**
 * Copy `process.env` WITHOUT the `DITTO_SKIP_HOOKS` bypass (an inherited bypass
 * would silently turn the BLOCKED assertion into a false pass) and drop undefined
 * values, then apply `overrides`.
 */
function envFor(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'DITTO_SKIP_HOOKS') out[k] = v;
  }
  return { ...out, ...overrides };
}

/** A recipe.yaml protecting `main` with the given test_command (double-quoted scalar). */
function recipeYaml(testCommand: string): string {
  return `push_gate:\n  protected_branches:\n    - main\n  test_command: ${JSON.stringify(
    testCommand,
  )}\n`;
}

export interface SmokeResult {
  /** Exit code of the protected push under a FAILING gate (expected non-zero). */
  blockedExit: number;
  /** Exit code of the protected push under a PASSING gate (expected 0). */
  allowedExit: number;
  /** Exit code of a NON-protected push under a FAILING gate (expected 0). */
  nonProtectedExit: number;
}

/**
 * Run the full foreign-repo smoke. Returns the observed push exit codes on
 * success; THROWS (never silently passes) on any unmet assertion so callers — the
 * CLI wrapper below and the optional SMOKE=1 test — can surface a real failure.
 */
export async function runSmoke(): Promise<SmokeResult> {
  if (!existsSync(BIN_DITTO)) {
    throw new Error(`built binary not found at ${BIN_DITTO} — run \`bun run build:bin\` first`);
  }

  const root = mkdtempSync(join(tmpdir(), 'ditto-smoke-pushgate-'));
  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  const home = join(root, 'home');
  mkdirSync(work);
  mkdirSync(home);

  try {
    // 1) Local BARE remote + working repo on `main`; identity set LOCALLY (CI-safe).
    mustRun('git', ['init', '--bare', '-q', remote], root);
    mustRun('git', ['init', '-q', '-b', 'main', work], root);
    mustRun('git', ['config', 'user.email', 'smoke@ditto.test'], work);
    mustRun('git', ['config', 'user.name', 'ditto smoke'], work);
    mustRun('git', ['config', 'commit.gpgsign', 'false'], work);
    writeFileSync(join(work, 'README.md'), '# smoke\n');
    mustRun('git', ['add', 'README.md'], work);
    mustRun('git', ['commit', '-q', '-m', 'initial'], work);
    mustRun('git', ['remote', 'add', 'origin', remote], work);

    // 2) recipe.yaml: protect `main`, start with a FAILING test_command.
    writeFileSync(join(work, 'recipe.yaml'), recipeYaml('false'));

    // 3) Headless `ditto setup` → installs the pre-push gate hook (discovers the
    //    recipe.yaml under --dir). Isolated HOME/CODEX_HOME so GLOBAL_* resources
    //    land in a throwaway dir, never the developer's real ~/.claude.
    const setupEnv = envFor({ HOME: home, CODEX_HOME: join(home, '.codex') });
    const setup = run('bun', [BIN_DITTO, 'setup', '--dir', work, '--yes'], REPO_ROOT, setupEnv);
    if (setup.status !== 0) {
      throw new Error(
        `ditto setup failed (exit ${setup.status}):\n${setup.stdout}\n${setup.stderr}`,
      );
    }
    const hookPath = join(work, '.git', 'hooks', 'pre-push');
    if (!existsSync(hookPath) || !readFileSync(hookPath, 'utf8').includes(HOOK_MARKER)) {
      throw new Error(
        `pre-push hook not installed (or missing marker) at ${hookPath}\nsetup stdout:\n${setup.stdout}`,
      );
    }
    console.log(`[smoke] hook installed → ${hookPath}`);

    // PUSH env: prepend THIS repo's bin/ dir so the foreign hook's `command -v ditto`
    // resolves THIS repo's bin/ditto. HOME stays the isolated dir so the walk-up
    // cap + git config never reach the developer's real home.
    const pushEnv = envFor({ HOME: home, PATH: `${BIN_DIR}:${process.env.PATH ?? ''}` });

    // 4) FAILING gate → protected `main` push is BLOCKED (non-zero), nothing reaches
    //    the remote.
    const blocked = run('git', ['push', 'origin', 'main'], work, pushEnv);
    const mainAfterBlock = mustRun(
      'git',
      ['ls-remote', remote, 'refs/heads/main'],
      work,
    ).stdout.trim();
    if (blocked.status === 0) {
      throw new Error(`expected protected push BLOCKED (non-zero); got exit 0\n${blocked.stderr}`);
    }
    if (mainAfterBlock !== '') {
      throw new Error(`expected NO main on remote after block; found:\n${mainAfterBlock}`);
    }
    console.log(`[smoke] FAILING gate → protected push BLOCKED (exit ${blocked.status})`);

    // 5) PASSING gate → protected `main` push is ALLOWED (exit 0), reaches the remote.
    writeFileSync(join(work, 'recipe.yaml'), recipeYaml('true'));
    const allowed = run('git', ['push', 'origin', 'main'], work, pushEnv);
    const mainAfterAllow = mustRun(
      'git',
      ['ls-remote', remote, 'refs/heads/main'],
      work,
    ).stdout.trim();
    if (allowed.status !== 0) {
      throw new Error(
        `expected protected push ALLOWED (exit 0); got ${allowed.status}\n${allowed.stderr}`,
      );
    }
    if (mainAfterAllow === '') {
      throw new Error('expected main on remote after allow; found none');
    }
    console.log(`[smoke] PASSING gate → protected push ALLOWED (exit ${allowed.status})`);

    // 6) NON-protected branch pushes even under a FAILING gate (branch-scoped).
    writeFileSync(join(work, 'recipe.yaml'), recipeYaml('false'));
    mustRun('git', ['checkout', '-q', '-b', 'feature'], work);
    mustRun('git', ['commit', '-q', '--allow-empty', '-m', 'feature work'], work);
    const nonProtected = run('git', ['push', 'origin', 'feature'], work, pushEnv);
    const featureOnRemote = mustRun(
      'git',
      ['ls-remote', remote, 'refs/heads/feature'],
      work,
    ).stdout.trim();
    if (nonProtected.status !== 0) {
      throw new Error(
        `expected non-protected push ALLOWED (exit 0); got ${nonProtected.status}\n${nonProtected.stderr}`,
      );
    }
    if (featureOnRemote === '') {
      throw new Error('expected feature on remote; found none');
    }
    console.log(
      `[smoke] FAILING gate, NON-protected branch → ALLOWED (exit ${nonProtected.status})`,
    );

    return {
      blockedExit: blocked.status,
      allowedExit: allowed.status,
      nonProtectedExit: nonProtected.status,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  runSmoke().then(
    (r) => {
      console.log('--- push-gate foreign-repo smoke: PASS ---');
      console.log(`  protected push, FAILING gate → BLOCKED (exit ${r.blockedExit}, non-zero)`);
      console.log(`  protected push, PASSING gate → ALLOWED (exit ${r.allowedExit})`);
      console.log(`  non-protected push, FAILING  → ALLOWED (exit ${r.nonProtectedExit})`);
      process.exit(0);
    },
    (err: unknown) => {
      console.error('--- push-gate foreign-repo smoke: FAIL ---');
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
