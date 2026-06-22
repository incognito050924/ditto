#!/usr/bin/env node
// DITTO npx bootstrap — install | update | uninstall the Claude Code plugin AND
// the global `ditto` CLI in ONE idempotent command, straight from the GitHub
// source (no npm publish).
//
// Invoked as `npx github:incognito050924/ditto <verb>`: npm clones the repo,
// runs `npm install`, then runs the package `bin` (this file) with the verb. The
// final global `ditto` does NOT come from this package's bin field — it comes
// from the symlink we place below — so wiring `bin.ditto` to this bootstrap is
// safe: nobody runs `npm install -g` on a no-publish repo.
//
// Two halves, both idempotent:
//   plugin → shell out to `claude plugin marketplace/install/update/uninstall`.
//            Claude Code clones+manages the plugin under its own config dir; the
//            github-source install path is the one verified for wi_260608j2p.
//   cli    → COPY the committed `bin/ditto` bundle (THE distribution artifact —
//            see scripts/release.mjs) into a ditto-owned dir, then symlink it
//            onto PATH. Copy, not symlink-to-clone, because the npx clone is
//            ephemeral (vanishes after the command) and a symlink into it would
//            dangle.
//
// Pure Node, zero deps — it must run before `ditto`/bun exist. Honors HOME and
// CLAUDE_CONFIG_DIR so it can be exercised in a throwaway environment without
// touching the real install (the same isolation used for the j2p smoke check).

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WIN = platform() === 'win32';
const GH_SOURCE = 'incognito050924/ditto'; // `claude plugin marketplace add <source>`
const MARKETPLACE = 'ditto-local'; // name declared in .claude-plugin/marketplace.json
const PLUGIN = 'ditto';
const PLUGIN_REF = `${PLUGIN}@${MARKETPLACE}`;

// This file lives at <repo>/scripts/, so the clone root is one level up.
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// --------------------------------------------------------------- placement dirs
// Honor HOME (os.homedir() follows it on POSIX) so an isolated run lands its
// copy + symlink under a throwaway tree instead of the real ~/.local.
const shareBinDir = () => join(homedir(), '.local', 'share', 'ditto', 'bin'); // owned copy
const pathBinDir = () => join(homedir(), '.local', 'bin'); // PATH dir for the `ditto` symlink

// ---------------------------------------------------------- `claude plugin` shim
function claude(args, { capture = false } = {}) {
  return spawnSync('claude', ['plugin', ...args], {
    stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });
}
function claudeMissing() {
  const r = spawnSync('claude', ['--version'], { stdio: 'ignore' });
  return Boolean(r.error && r.error.code === 'ENOENT');
}
function marketplacePresent() {
  const r = claude(['marketplace', 'list'], { capture: true });
  return r.status === 0 && new RegExp(`\\b${MARKETPLACE}\\b`).test(r.stdout ?? '');
}
function pluginPresent() {
  const r = claude(['list'], { capture: true });
  return r.status === 0 && new RegExp(`${PLUGIN}@${MARKETPLACE}\\b`).test(r.stdout ?? '');
}

// ---------------------------------------------------------------- CLI placement
const sourceBundle = () => join(REPO, 'bin', 'ditto'); // committed distribution artifact
function linksTo(link, target) {
  try {
    return lstatSync(link).isSymbolicLink() && resolve(readlinkSync(link)) === resolve(target);
  } catch {
    return false;
  }
}
function lstatSafe(p) {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
}
function placeCli() {
  const src = sourceBundle();
  if (!existsSync(src))
    return { ok: false, fatal: true, message: `missing ${src} (corrupt clone?)` };
  const sdir = shareBinDir();
  mkdirSync(sdir, { recursive: true });
  const owned = join(sdir, 'ditto');
  copyFileSync(src, owned);
  if (!IS_WIN) chmodSync(owned, 0o755);
  if (existsSync(`${src}.cmd`)) copyFileSync(`${src}.cmd`, `${owned}.cmd`);

  if (IS_WIN)
    return { ok: true, message: `${owned} — add ${sdir} to PATH (symlink is POSIX-only)` };
  const link = join(pathBinDir(), 'ditto');
  if (linksTo(link, owned)) return { ok: true, message: `${link} (already linked)` };
  // Never clobber an existing `ditto` we did not place — a developer's dogfood
  // symlink (`→ dist/plugin/bin/ditto`) or any user-managed binary stays put.
  // Same refuse-don't-overwrite rule as scripts/install-plugin.mjs. CLI placement
  // is best-effort (the plugin half already succeeded), so this is a warning, not
  // a hard failure.
  if (lstatSafe(link)) {
    return {
      ok: false,
      message: `${link} already exists and is not ours — left untouched. Remove it (or adjust PATH), then re-run to place the ditto CLI; the plugin is installed regardless.`,
    };
  }
  mkdirSync(pathBinDir(), { recursive: true });
  symlinkSync(owned, link);
  return { ok: true, message: link };
}
function unplaceCli() {
  const out = [];
  const owned = join(shareBinDir(), 'ditto');
  const link = join(pathBinDir(), 'ditto');
  if (linksTo(link, owned)) {
    rmSync(link);
    if (existsSync(`${link}.cmd`)) rmSync(`${link}.cmd`);
    out.push(`removed ${link}`);
  } else {
    out.push(`left ${link} (not ours)`);
  }
  const shareRoot = dirname(shareBinDir()); // ~/.local/share/ditto
  if (existsSync(shareRoot)) {
    rmSync(shareRoot, { recursive: true, force: true });
    out.push(`removed ${shareRoot}`);
  }
  return out;
}

// ----------------------------------------------------------------------- output
const log = [];
function note(stage, message) {
  log.push(`${stage.padEnd(11)}${message}`);
}
function step(stage, r, tolerant = false) {
  if (r.error && r.error.code === 'ENOENT') fail(stage, '`claude` not found on PATH');
  if (r.status !== 0 && !tolerant) fail(stage, `exited ${r.status}`);
  note(stage, r.status === 0 ? 'ok' : `exit ${r.status} (tolerated)`);
}
function fail(stage, message) {
  console.error(`[ditto] ${VERB} FAILED`);
  for (const line of log) console.error(`  ${line}`);
  console.error(`  ${stage.padEnd(11)}${message}`);
  process.exit(1);
}
function requireClaude() {
  if (claudeMissing()) {
    console.error(
      '[ditto] `claude` (Claude Code CLI) not found on PATH — install it first, then re-run.',
    );
    process.exit(2);
  }
}
function bunHint() {
  if (spawnSync('bun', ['--version'], { stdio: 'ignore' }).error) {
    note('note', 'bun not on PATH — `ditto` needs bun ≥1.3 at runtime; install it to use the CLI');
  }
}

// ------------------------------------------------------------------------- verbs
function doInstall() {
  requireClaude();
  step(
    'marketplace',
    marketplacePresent()
      ? claude(['marketplace', 'update', MARKETPLACE])
      : claude(['marketplace', 'add', GH_SOURCE]),
  );
  step(
    'plugin',
    pluginPresent() ? claude(['update', PLUGIN_REF]) : claude(['install', PLUGIN_REF]),
  );
  const c = placeCli();
  if (!c.ok && c.fatal) fail('cli', c.message);
  note('cli', c.ok ? c.message : `SKIPPED — ${c.message}`);
  bunHint();
}
function doUpdate() {
  requireClaude();
  step('marketplace', claude(['marketplace', 'update', MARKETPLACE]));
  step(
    'plugin',
    pluginPresent() ? claude(['update', PLUGIN_REF]) : claude(['install', PLUGIN_REF]),
  );
  const c = placeCli();
  if (!c.ok && c.fatal) fail('cli', c.message);
  note('cli', c.ok ? c.message : `SKIPPED — ${c.message}`);
  bunHint();
}
function doUninstall() {
  requireClaude();
  if (pluginPresent()) step('plugin', claude(['uninstall', PLUGIN_REF]), true);
  else note('plugin', 'not installed (skip)');
  if (marketplacePresent())
    step('marketplace', claude(['marketplace', 'remove', MARKETPLACE]), true);
  else note('marketplace', 'not configured (skip)');
  for (const line of unplaceCli()) note('cli', line);
}

// -------------------------------------------------------------------------- main
const VERB = process.argv[2] ?? '';
const RUN = { install: doInstall, update: doUpdate, uninstall: doUninstall }[VERB];
if (!RUN) {
  console.error('usage: npx github:incognito050924/ditto <install|update|uninstall>');
  process.exit(64);
}
RUN();
console.log(`[ditto] ${VERB} OK`);
for (const line of log) console.log(`  ${line}`);
if (VERB !== 'uninstall') {
  console.log('');
  console.log('Verify in a NEW Claude Code session:');
  console.log('  claude            # /plugins → ditto enabled, 0 errors');
  console.log('  ditto doctor      # CLI on PATH, runtime reachable');
}
