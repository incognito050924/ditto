/**
 * scripts/smoke-workspace-sync.ts — ac-6 / ac-7 (wi_2606299kn)
 *
 * SYNTHETIC MULTI-REPO END-TO-END SMOKE for `ditto workspace sync`. Proves, in
 * DISPOSABLE foreign repos with LOCAL bare/working remotes (no network), the full
 *   sync -> clone -> hook-install -> push-gate
 * chain, plus the ROOT-ONLY trust guarantee (ac-3 runtime, the key security
 * evidence):
 *   1. `ditto workspace sync` CLONES a recipe `repos[].url` sub-repo into <ws>/sub
 *      and installs a pre-push hook there with WS_ROOT pinned to the WORKSPACE root.
 *   2. From inside the clone, a `git push` of the PROTECTED branch (main) is BLOCKED
 *      under a FAILING root-recipe `test_command` and ALLOWED under a PASSING one —
 *      proving the ROOT recipe's gate governs the sub-repo.
 *   3. ROOT-ONLY: even when the CLONED sub-repo ships its OWN malicious recipe whose
 *      `test_command` would `touch <ws>/PWNED`, that recipe is NEVER executed — only
 *      the workspace-root recipe's gate runs (it leaves a `<ws>/ROOT_RAN` marker).
 *
 * How `ditto` is made resolvable for the FOREIGN clone's hook
 * ----------------------------------------------------------
 * The installed sub-repo hook bakes WS_ROOT=<ws> and resolves ditto as
 * `<ws>/bin/ditto` (absent in this fixture) else `ditto` on PATH else FAIL-CLOSED.
 * So this harness PREPENDS THIS repo's `bin/` to the PATH used for `git push`, exactly
 * like scripts/smoke-push-gate.ts — the hook's `command -v ditto` then resolves THIS
 * repo's freshly-built `bin/ditto`, run via the inherited `bun`.
 *
 * Run:  `bun scripts/smoke-workspace-sync.ts`   (exit 0 = PASS, exit 1 = FAIL)
 *
 * CI-safe + idempotent: every run uses fresh `mkdtemp` dirs (realpath-normalized so
 * the baked WS_ROOT matches), and an isolated fake HOME keeps setup's GLOBAL_*
 * resources and git away from the developer's real `~/.claude` / `~/.gitconfig`.
 * Identity is set LOCALLY in each temp repo, so the harness relies on no global git
 * config beyond what it sets itself.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The script lives at <repo>/scripts/smoke-workspace-sync.ts, so the repo root is its
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
 * Copy `process.env` WITHOUT the `DITTO_SKIP_HOOKS` bypass (an inherited bypass would
 * silently turn the BLOCKED assertion into a false pass) and drop undefined values,
 * then apply `overrides`.
 */
function envFor(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== 'DITTO_SKIP_HOOKS') out[k] = v;
  }
  return { ...out, ...overrides };
}

/** Set a local git identity (CI-safe — no reliance on global git config). */
function gitIdentity(repo: string): void {
  mustRun('git', ['config', 'user.email', 'smoke@ditto.test'], repo);
  mustRun('git', ['config', 'user.name', 'ditto smoke'], repo);
  mustRun('git', ['config', 'commit.gpgsign', 'false'], repo);
}

/**
 * The ROOT workspace recipe: declares the `sub` repo (with its clone url) and the
 * push_gate that protects `main` with `testCommand`. `ditto workspace sync` reads
 * `repos[].url` to clone, and the installed sub-repo hook resolves THIS recipe (not
 * the clone's own) to gate a push.
 */
function rootRecipeYaml(subDir: string, url: string, testCommand: string): string {
  return [
    'repos:',
    `  - dir: ${JSON.stringify(subDir)}`,
    `    url: ${JSON.stringify(url)}`,
    '    push_gate:',
    '      protected_branches:',
    '        - main',
    `      test_command: ${JSON.stringify(testCommand)}`,
    '',
  ].join('\n');
}

/** A sub-repo's OWN (malicious) top-level recipe — the one ROOT-ONLY trust must IGNORE. */
function subOwnRecipeYaml(testCommand: string): string {
  return [
    'push_gate:',
    '  protected_branches:',
    '    - main',
    `  test_command: ${JSON.stringify(testCommand)}`,
    '',
  ].join('\n');
}

/** Extract the baked `WS_ROOT="..."` value from an installed hook (empty if absent). */
function bakedWsRoot(hookText: string): string {
  const m = hookText.match(/^WS_ROOT=(.+)$/m);
  if (!m) return '';
  try {
    return String(JSON.parse(m[1] ?? ''));
  } catch {
    return '';
  }
}

export interface SmokeResult {
  /** Sub-repo was cloned into <ws>/sub. */
  cloned: boolean;
  /** The WS_ROOT baked into the installed sub-repo hook (should equal the workspace). */
  wsRootPinned: string;
  /** Exit code of the protected push under a FAILING root gate (expected non-zero). */
  blockedExit: number;
  /** Exit code of the protected push under a PASSING root gate (expected 0). */
  allowedExit: number;
  /** Exit code of the protected push in the ROOT-ONLY scenario (expected 0). */
  rootOnlyExit: number;
  /** Root recipe's gate actually ran (left <ws>/ROOT_RAN). */
  rootRan: boolean;
  /** The clone's OWN recipe ran (<ws>/PWNED) — MUST be false (ROOT-ONLY proof). */
  pwnedCreated: boolean;
}

/**
 * Run the full multi-repo sync smoke. Returns the observed evidence on success;
 * THROWS (never silently passes) on any unmet assertion so callers — the CLI wrapper
 * below and the optional SMOKE=1 test — can surface a real failure.
 */
export async function runSmoke(): Promise<SmokeResult> {
  if (!existsSync(BIN_DITTO)) {
    throw new Error(`built binary not found at ${BIN_DITTO} — run \`bun run build:bin\` first`);
  }

  // realpath so the WS_ROOT the CLI bakes (from its process.cwd()) matches our paths
  // even where tmpdir is a symlink (macOS /var -> /private/var).
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ditto-smoke-wssync-')));
  const source = join(root, 'source'); // the clone SOURCE (a local working git repo)
  const ws = join(root, 'ws'); // the WORKSPACE root (carries the .ditto marker)
  const sub = join(ws, 'sub'); // where sync clones `source`
  const gateRemote = join(root, 'gate.git'); // bare remote the sub pushes to in the gate test
  const home = join(root, 'home'); // isolated HOME
  const rootRanMarker = join(ws, 'ROOT_RAN'); // left by the ROOT gate (proves it ran)
  const pwnedMarker = join(ws, 'PWNED'); // would be left by the clone's OWN gate (must NOT exist)

  try {
    // 1) SOURCE: a local working repo on `main` with one commit — the clone source.
    mustRun('git', ['init', '-q', '-b', 'main', source], root);
    gitIdentity(source);
    writeFileSync(join(source, 'README.md'), '# source sub-repo\n');
    mustRun('git', ['add', 'README.md'], source);
    mustRun('git', ['commit', '-q', '-m', 'source initial'], source);

    // 2) WORKSPACE: .ditto marker (so it is the workspace root) + a root recipe that
    //    declares the `sub` repo and protects `main` with a FAILING test_command.
    mkdirSync(ws);
    mkdirSync(join(ws, '.ditto'));
    writeFileSync(join(ws, 'recipe.yaml'), rootRecipeYaml('sub', source, 'false'));

    // bare remote the cloned sub will push to during the gate test.
    mustRun('git', ['init', '--bare', '-q', gateRemote], root);
    mkdirSync(home);

    // 3) `ditto workspace sync` with DITTO_ALLOW_LOCAL_CLONE=1 → clones `source` into
    //    <ws>/sub and installs the ROOT-recipe pre-push hook (WS_ROOT pinned to <ws>).
    const syncEnv = envFor({
      HOME: home,
      CODEX_HOME: join(home, '.codex'),
      DITTO_ALLOW_LOCAL_CLONE: '1',
    });
    const sync = run('bun', [BIN_DITTO, 'workspace', 'sync'], ws, syncEnv);
    console.log(`[smoke] workspace sync exit=${sync.status}`);
    if (sync.stdout.trim()) console.log(sync.stdout.trim());
    if (sync.status !== 0) {
      throw new Error(`ditto workspace sync failed (exit ${sync.status}):\n${sync.stderr}`);
    }

    // Assert: sub CLONED + a git repo + carries the source's README.
    const cloned = existsSync(join(sub, '.git')) && existsSync(join(sub, 'README.md'));
    if (!cloned) {
      throw new Error(`expected sub-repo cloned at ${sub} (with .git + README.md); not found`);
    }

    // Assert: pre-push hook installed in the CLONE, ditto-managed, WS_ROOT pinned to <ws>.
    const hookPath = join(sub, '.git', 'hooks', 'pre-push');
    if (!existsSync(hookPath)) throw new Error(`pre-push hook not installed at ${hookPath}`);
    const hookText = readFileSync(hookPath, 'utf8');
    if (!hookText.includes(HOOK_MARKER)) {
      throw new Error(`installed hook is missing the ditto marker at ${hookPath}`);
    }
    const wsRootPinned = bakedWsRoot(hookText);
    if (wsRootPinned === '') {
      throw new Error(`installed sub-repo hook did not pin WS_ROOT at ${hookPath}`);
    }
    if (realpathSync(wsRootPinned) !== realpathSync(ws)) {
      throw new Error(`WS_ROOT pinned to "${wsRootPinned}", expected the workspace root "${ws}"`);
    }
    if (resolve(wsRootPinned) === resolve(sub)) {
      throw new Error(`WS_ROOT pinned to the CLONE "${sub}" — ROOT-ONLY trust broken`);
    }
    console.log(`[smoke] sub-repo cloned → ${sub}`);
    console.log(`[smoke] hook installed, WS_ROOT pinned → ${wsRootPinned}`);

    // Prepare the clone to push: local identity + a dedicated bare remote `gate`.
    gitIdentity(sub);
    mustRun('git', ['remote', 'add', 'gate', gateRemote], sub);

    // PUSH env: prepend THIS repo's bin/ so the foreign hook's `command -v ditto`
    // resolves THIS repo's bin/ditto; isolated HOME; DITTO_SKIP_HOOKS scrubbed.
    const pushEnv = envFor({ HOME: home, PATH: `${BIN_DIR}:${process.env.PATH ?? ''}` });

    // 4) END-TO-END GATE, FAILING root test_command → protected `main` push BLOCKED.
    const blocked = run('git', ['push', 'gate', 'main'], sub, pushEnv);
    const mainAfterBlock = mustRun(
      'git',
      ['ls-remote', gateRemote, 'refs/heads/main'],
      sub,
    ).stdout.trim();
    if (blocked.status === 0) {
      throw new Error(`expected protected push BLOCKED (non-zero); got exit 0\n${blocked.stderr}`);
    }
    if (mainAfterBlock !== '') {
      throw new Error(`expected NO main on remote after block; found:\n${mainAfterBlock}`);
    }
    console.log(`[smoke] FAILING root gate → protected push BLOCKED (exit ${blocked.status})`);

    // 5) PASSING root test_command → protected `main` push ALLOWED, reaches the remote.
    writeFileSync(join(ws, 'recipe.yaml'), rootRecipeYaml('sub', source, 'true'));
    const allowed = run('git', ['push', 'gate', 'main'], sub, pushEnv);
    const mainAfterAllow = mustRun(
      'git',
      ['ls-remote', gateRemote, 'refs/heads/main'],
      sub,
    ).stdout.trim();
    if (allowed.status !== 0) {
      throw new Error(
        `expected protected push ALLOWED (exit 0); got ${allowed.status}\n${allowed.stderr}`,
      );
    }
    if (mainAfterAllow === '') throw new Error('expected main on remote after allow; found none');
    console.log(`[smoke] PASSING root gate → protected push ALLOWED (exit ${allowed.status})`);

    // 6) ROOT-ONLY PROOF (ac-3 runtime). Give the CLONE its OWN recipe whose gate would
    //    `touch <ws>/PWNED`, and make it look root-able (its own .ditto marker) so a
    //    naive walk-up WOULD root at the clone. The ROOT recipe's gate instead `touch`es
    //    <ws>/ROOT_RAN. Push a fresh commit on `main`:
    //      - ALLOWED (exit 0, ROOT gate's `touch` passes),
    //      - <ws>/ROOT_RAN created  → the WORKSPACE-ROOT recipe ran,
    //      - <ws>/PWNED  NEVER      → the clone's OWN recipe was never executed.
    mkdirSync(join(sub, '.ditto'));
    writeFileSync(join(sub, 'recipe.yaml'), subOwnRecipeYaml(`touch '${pwnedMarker}'`));
    writeFileSync(
      join(ws, 'recipe.yaml'),
      rootRecipeYaml('sub', source, `touch '${rootRanMarker}'`),
    );
    // a new commit so there is something to push to the already-updated `main`.
    writeFileSync(join(sub, 'work.txt'), 'root-only proof\n');
    mustRun('git', ['add', 'work.txt'], sub);
    mustRun('git', ['commit', '-q', '-m', 'root-only proof commit'], sub);
    const rootOnly = run('git', ['push', 'gate', 'main'], sub, pushEnv);
    const rootRan = existsSync(rootRanMarker);
    const pwnedCreated = existsSync(pwnedMarker);
    if (rootOnly.status !== 0) {
      throw new Error(
        `expected ROOT-ONLY protected push ALLOWED (exit 0); got ${rootOnly.status}\n${rootOnly.stderr}`,
      );
    }
    if (!rootRan) {
      throw new Error('expected <ws>/ROOT_RAN — the workspace-root gate did not run');
    }
    if (pwnedCreated) {
      throw new Error(
        'SECURITY: <ws>/PWNED was created — the CLONE’s OWN recipe executed (ROOT-ONLY trust BROKEN)',
      );
    }
    console.log(
      `[smoke] ROOT-ONLY → push ALLOWED (exit ${rootOnly.status}); ROOT_RAN created, PWNED NEVER created`,
    );

    return {
      cloned,
      wsRootPinned,
      blockedExit: blocked.status,
      allowedExit: allowed.status,
      rootOnlyExit: rootOnly.status,
      rootRan,
      pwnedCreated,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  runSmoke().then(
    (r) => {
      console.log('--- workspace-sync multi-repo e2e smoke: PASS ---');
      console.log(`  sub-repo cloned + hook installed, WS_ROOT pinned → ${r.wsRootPinned}`);
      console.log(
        `  protected push, FAILING root gate → BLOCKED (exit ${r.blockedExit}, non-zero)`,
      );
      console.log(`  protected push, PASSING root gate → ALLOWED (exit ${r.allowedExit})`);
      console.log(
        `  ROOT-ONLY: push ALLOWED (exit ${r.rootOnlyExit}); ROOT_RAN=${r.rootRan}, PWNED_created=${r.pwnedCreated}`,
      );
      process.exit(0);
    },
    (err: unknown) => {
      console.error('--- workspace-sync multi-repo e2e smoke: FAIL ---');
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
