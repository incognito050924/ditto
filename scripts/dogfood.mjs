#!/usr/bin/env bun
/**
 * Dogfood launcher — enter a dogfooding session running the WORKING-TREE ditto
 * build, parameterized by host. One command, no flags to remember; the session
 * can never accidentally load the stale installed plugin (the failure this was
 * born from), because it IS the launch.
 *
 *   bun run dogfood                      # claude (default)
 *   bun run dogfood --host codex         # codex
 *   bun run dogfood --host codex --print     # show the steps, run nothing
 *   bun run dogfood --host codex --no-launch # run setup/registration, skip the session (CI/verify)
 *   bun run dogfood --host codex --dir <path># dogfood against another target
 *
 * The two hosts are fundamentally asymmetric (verified against codex 0.139.0):
 *   - claude  = stateless per-session  → `claude --plugin-dir <repoRoot>`
 *   - codex   = stateful per-CODEX_HOME → register a local marketplace + install
 *     the plugin into an ISOLATED CODEX_HOME, then launch. No `--plugin-dir`
 *     equivalent exists; the local-path marketplace is the analog.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);

const flag = (name) => argv.includes(`--${name}`);
const value = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const PRINT = flag('print');
const NO_LAUNCH = flag('no-launch');
const host = value('host', 'claude');
const target = resolve(value('dir', repoRoot));

/** Run a pre-launch step (build/register). Fails fast on non-zero. */
function step(cmd, args, { cwd = repoRoot, env } = {}) {
  console.error(`+ ${cmd} ${args.join(' ')}`);
  if (PRINT) return;
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd, env: { ...process.env, ...env } });
  if (r.status !== 0) {
    console.error(`✗ ${cmd} exited ${r.status ?? 'signal'}`);
    process.exit(r.status ?? 1);
  }
}

/** Hand off to the interactive host session. Skipped by --print / --no-launch. */
function launch(cmd, args, { cwd = target, env } = {}) {
  console.error(`+ ${cmd} ${args.join(' ')}   (interactive session)`);
  if (PRINT || NO_LAUNCH) return;
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd, env: { ...process.env, ...env } });
  process.exit(r.status ?? 0);
}

if (host === 'claude' || host === 'claude-code') {
  // Stateless: build the repo-root bin (hooks run it), load the repo as the plugin.
  step('bun', ['run', 'build:bin']);
  launch('claude', ['--plugin-dir', repoRoot], { cwd: target });
} else if (host === 'codex') {
  // Stateful: build the codex surface, stage it into the target, register a local
  // marketplace into an ISOLATED CODEX_HOME (keeps the user's real plugin registry
  // clean). KNOWN GAP: `ditto setup` still projects the global AGENTS.md to
  // ~/.codex/AGENTS.md (homedir-hardcoded, ignores CODEX_HOME) — idempotent today,
  // but full isolation needs a setup option to skip/redirect that global write.
  const codexHome = join(target, '.ditto', 'local', 'codex-home');
  const env = { CODEX_HOME: codexHome };
  step('bun', ['run', 'build:codex-plugin']);
  step('bun', [
    join(repoRoot, 'src', 'cli', 'index.ts'),
    'setup',
    '--host',
    'codex',
    '--dir',
    target,
    '--yes',
  ]);
  if (!PRINT) mkdirSync(codexHome, { recursive: true });
  if (!PRINT && !existsSync(target)) mkdirSync(target, { recursive: true });
  step('codex', ['plugin', 'marketplace', 'add', target], { cwd: target, env });
  step('codex', ['plugin', 'add', 'ditto@ditto-local'], { cwd: target, env });
  launch('codex', [], { cwd: target, env });
} else {
  console.error(`unknown --host: ${host} (use: claude | codex)`);
  process.exit(2);
}
