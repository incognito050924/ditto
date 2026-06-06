#!/usr/bin/env node
// DITTO install orchestrator (cross-platform). Pure Node — no external deps;
// runs identically under `node` or `bun`. Spawns `bun` only for the binary
// build (the self-contained hook/CLI binary requires bun's --compile).
//
// Five steps (install mode):
//   1. register     patch ~/.claude/settings.json so the local plugin loads
//   2. build        `bun run build:bin` → <repo>/bin/ditto (hooks + CLI binary)
//   3. place        symlink the binary onto PATH so skills' bare `ditto …` work
//   4. init         `ditto init --dir <target>` scaffolds the target's .ditto/
//   5. allowlist    patch <target>/.claude/settings.json so `ditto …` never prompts
//
// Steps 4–5 are project-level and need a target; 1–3 are global/repo-level.
// Everything is idempotent; `uninstall` reverses 1/3/5 and leaves the target's
// .ditto/ runtime data intact (it is the user's work-item history).
//
// Paths derive from homedir() so a `HOME` override fully sandboxes a dry run.

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MARKETPLACE = 'ditto-local';
const PLUGIN_NAME = 'ditto';
const ALLOW_RULE = 'Bash(ditto:*)';
const IS_WIN = platform() === 'win32';

// Official CodeQL CLI bundle (CLI-only, not the action bundle). `latest`
// redirects to the current versioned asset; verified reachable per platform.
const CODEQL_ASSET = {
  darwin: 'codeql-osx64.zip',
  linux: 'codeql-linux64.zip',
  win32: 'codeql-win64.zip',
};
const codeqlUrl = (asset) =>
  `https://github.com/github/codeql-cli-binaries/releases/latest/download/${asset}`;

// ---------------------------------------------------------------- arg parsing
function parseArgs(argv) {
  const out = { mode: 'install', target: null, build: true, codeql: true };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') out.target = argv[++i];
    else if (a === '--no-build') out.build = false;
    else if (a === '--no-codeql') out.codeql = false;
    else positional.push(a);
  }
  if (positional[0]) out.mode = positional[0];
  return out;
}

// ------------------------------------------------------------------ repo/target
function resolveRepo() {
  const envHome = process.env.DITTO_HOME;
  if (envHome && existsSync(join(envHome, '.claude-plugin', 'plugin.json'))) {
    return resolve(envHome);
  }
  const here = dirname(fileURLToPath(import.meta.url)); // <repo>/scripts/
  const guess = resolve(here, '..');
  if (existsSync(join(guess, '.claude-plugin', 'plugin.json'))) return guess;
  throw new Error(
    'Could not locate DITTO repo. Set DITTO_HOME to the repo root (containing .claude-plugin/plugin.json).',
  );
}

/**
 * Resolve the project-level target. Defaults to cwd. `selfHost` is true when
 * the target IS the ditto repo — project steps (init/allowlist) are then
 * skipped, encoding the lesson that the repo must not be its own managed target.
 */
function resolveTarget(repo, targetArg) {
  const target = resolve(targetArg ?? process.cwd());
  return { target, selfHost: target === repo };
}

// ------------------------------------------------------------- settings helpers
function globalSettingsPath() {
  // Claude Code uses ~/.claude/settings.json on every OS (homedir() = %USERPROFILE% on Windows).
  return join(homedir(), '.claude', 'settings.json');
}
function projectSettingsPath(target) {
  return join(target, '.claude', 'settings.json');
}
function readSettings(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8').trim();
  return text ? JSON.parse(text) : {};
}
function backup(path) {
  if (!existsSync(path)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${path}.bak.${stamp}`;
  copyFileSync(path, dest);
  return dest;
}
function writeSettings(path, settings) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

// --------------------------------------------------------------- (1) register
function registerPlugin(settings, repo) {
  const manifest = join(repo, '.claude-plugin', 'marketplace.json');
  const url = pathToFileURL(manifest).href; // cross-OS, handles Windows drive letters
  const markets = settings.extraKnownMarketplaces ?? {};
  markets[MARKETPLACE] = { source: { source: 'url', url } };
  settings.extraKnownMarketplaces = markets;
  const enabled = settings.enabledPlugins ?? {};
  enabled[`${PLUGIN_NAME}@${MARKETPLACE}`] = true;
  settings.enabledPlugins = enabled;
  return settings;
}
function unregisterPlugin(settings) {
  if (settings.extraKnownMarketplaces) delete settings.extraKnownMarketplaces[MARKETPLACE];
  if (settings.enabledPlugins) delete settings.enabledPlugins[`${PLUGIN_NAME}@${MARKETPLACE}`];
  return settings;
}

// ------------------------------------------------------------------ (2) build
function binaryPath(repo) {
  return join(repo, 'bin', IS_WIN ? 'ditto.exe' : 'ditto');
}
function buildBinary(repo) {
  const r = spawnSync('bun', ['run', IS_WIN ? 'build:bin:win' : 'build:bin'], {
    cwd: repo,
    stdio: 'inherit',
  });
  if (r.error && r.error.code === 'ENOENT') {
    return {
      ok: false,
      message: 'bun not found on PATH — install bun ≥1.3 then re-run (hooks need the binary)',
    };
  }
  if (r.status !== 0) return { ok: false, message: `build failed (exit ${r.status})` };
  return { ok: existsSync(binaryPath(repo)), message: binaryPath(repo) };
}

// ------------------------------------------------------------------ (3) place
function placeDir() {
  return join(homedir(), '.local', 'bin');
}
/** True when `linkPath` is a symlink that already points at `binary`. */
function linksTo(linkPath, binary) {
  try {
    return (
      lstatSync(linkPath).isSymbolicLink() && resolve(readlinkSync(linkPath)) === resolve(binary)
    );
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
function placeBinary(repo) {
  const binary = binaryPath(repo);
  if (!existsSync(binary)) return { ok: false, message: 'binary not built; skipped placement' };
  if (IS_WIN) {
    return {
      ok: false,
      message: `add ${dirname(binary)} to PATH so \`ditto\` resolves (symlink placement is POSIX-only)`,
    };
  }
  const dir = placeDir();
  const link = join(dir, 'ditto');
  if (linksTo(link, binary)) return { ok: true, message: `${link} (already linked)` };
  if (lstatSafe(link)) {
    // A foreign `ditto` (e.g. a global bun install) — do not clobber it.
    return {
      ok: false,
      message: `${link} exists and is not ours; remove it or adjust PATH manually`,
    };
  }
  mkdirSync(dir, { recursive: true });
  symlinkSync(binary, link);
  return { ok: true, message: link };
}
function unplaceBinary(repo) {
  const link = join(placeDir(), 'ditto');
  if (linksTo(link, binaryPath(repo))) {
    rmSync(link);
    return { ok: true, message: `removed ${link}` };
  }
  return { ok: false, message: `left ${link} (not ours or absent)` };
}

// ----------------------------------------------------------- (3b) codeql (host)
// CodeQL powers ditto impact/boundary/acg-review. Detection mirrors
// src/core/codeql/doctor.ts cliAvailable (CODEQL_BIN → PATH → gh extension),
// plus a ditto-managed copy. Install is graceful: a download/extract failure
// reports the exact manual step and never fails the overall install.
function whichCmd(name) {
  const r = spawnSync(IS_WIN ? 'where' : 'which', [name], { encoding: 'utf8' });
  if (r.status === 0 && typeof r.stdout === 'string' && r.stdout.trim()) {
    return r.stdout.split(/\r?\n/)[0].trim();
  }
  return null;
}
function codeqlInstallDir() {
  return join(homedir(), '.local', 'share', 'ditto', 'codeql');
}
function codeqlBinaryPath() {
  // The bundle extracts to a top-level `codeql/` dir holding the launcher.
  return join(codeqlInstallDir(), 'codeql', IS_WIN ? 'codeql.exe' : 'codeql');
}
function detectCodeql() {
  const env = process.env.CODEQL_BIN;
  if (env && existsSync(env)) return { source: 'CODEQL_BIN', path: env };
  const onPath = whichCmd('codeql');
  if (onPath) return { source: 'PATH', path: onPath };
  const gh = join(homedir(), '.local', 'share', 'gh', 'extensions', 'gh-codeql');
  if (existsSync(gh)) return { source: 'gh-extension', path: gh };
  if (existsSync(codeqlBinaryPath())) return { source: 'ditto-managed', path: codeqlBinaryPath() };
  return null;
}
function manualCodeql(url, why) {
  return {
    ok: false,
    message: `${why} — download ${url}, unzip it, and put its codeql/ dir on PATH (or set CODEQL_BIN)`,
  };
}
function installCodeql() {
  const found = detectCodeql();
  if (found) return { ok: true, message: `reuse ${found.source} (${found.path})` };

  const asset = CODEQL_ASSET[platform()];
  if (!asset) return { ok: false, message: `no CodeQL asset for ${platform()}; install manually` };
  const url = codeqlUrl(asset);
  const dir = codeqlInstallDir();
  mkdirSync(dir, { recursive: true });
  const zip = join(dir, asset);

  const dl = spawnSync('curl', ['-fsSL', '-o', zip, url], { stdio: 'inherit' });
  if (dl.error && dl.error.code === 'ENOENT') return manualCodeql(url, 'curl not found');
  if (dl.status !== 0) return manualCodeql(url, `download failed (curl exit ${dl.status})`);

  // unzip preferred; fall back to tar (bsdtar reads zip) when absent.
  const ex = spawnSync('unzip', ['-q', '-o', zip, '-d', dir], { stdio: 'inherit' });
  if (ex.error && ex.error.code === 'ENOENT') {
    const tx = spawnSync('tar', ['-xf', zip, '-C', dir], { stdio: 'inherit' });
    if (tx.error || tx.status !== 0) return manualCodeql(url, 'need unzip or tar to extract');
  } else if (ex.status !== 0) {
    return manualCodeql(url, `extract failed (unzip exit ${ex.status})`);
  }
  rmSync(zip, { force: true });

  const bin = codeqlBinaryPath();
  if (!existsSync(bin)) return manualCodeql(url, 'extracted but codeql launcher not found');
  if (IS_WIN) {
    return { ok: true, message: `installed ${bin}; add ${dirname(bin)} to PATH` };
  }
  // Place on PATH like the ditto binary; the launcher resolves the symlink to
  // find its toolchain, so a single link is enough.
  const link = join(placeDir(), 'codeql');
  if (!lstatSafe(link)) {
    mkdirSync(placeDir(), { recursive: true });
    symlinkSync(bin, link);
  }
  return { ok: true, message: `installed ${bin} → ${link}` };
}

// ------------------------------------------------------------------- (4) init
function initTarget(repo, target) {
  const binary = binaryPath(repo);
  if (!existsSync(binary)) {
    return { ok: false, message: 'binary not built; cannot run `ditto init`' };
  }
  const r = spawnSync(binary, ['init', '--dir', target], { stdio: 'inherit' });
  if (r.status !== 0) return { ok: false, message: `ditto init failed (exit ${r.status})` };
  return { ok: true, message: `scaffolded ${join(target, '.ditto')}` };
}

// -------------------------------------------------------------- (5) allowlist
function allowlistTarget(target) {
  const path = projectSettingsPath(target);
  const settings = readSettings(path);
  const perms = settings.permissions ?? {};
  const allow = Array.isArray(perms.allow) ? perms.allow : [];
  if (allow.includes(ALLOW_RULE)) {
    return { ok: true, path, message: 'already allowlisted', bak: null };
  }
  allow.push(ALLOW_RULE);
  perms.allow = allow;
  settings.permissions = perms;
  const bak = backup(path);
  writeSettings(path, settings);
  return { ok: true, path, message: `added ${ALLOW_RULE}`, bak };
}
function unallowlistTarget(target) {
  const path = projectSettingsPath(target);
  if (!existsSync(path)) return { ok: false, path, message: 'no project settings' };
  const settings = readSettings(path);
  const allow = settings.permissions?.allow;
  if (!Array.isArray(allow) || !allow.includes(ALLOW_RULE)) {
    return { ok: false, path, message: 'rule absent' };
  }
  settings.permissions.allow = allow.filter((r) => r !== ALLOW_RULE);
  const bak = backup(path);
  writeSettings(path, settings);
  return { ok: true, path, message: `removed ${ALLOW_RULE}`, bak };
}

// ----------------------------------------------------------------------- modes
function doInstall(repo, target, selfHost, build, codeql) {
  const log = [];
  const gsp = globalSettingsPath();
  const before = readSettings(gsp);
  const gbak = backup(gsp);
  writeSettings(gsp, registerPlugin({ ...before }, repo));
  log.push(`register:  ${PLUGIN_NAME}@${MARKETPLACE} → ${gsp}${gbak ? ` (backup ${gbak})` : ''}`);

  if (build) {
    const b = buildBinary(repo);
    log.push(`build:     ${b.ok ? 'ok' : 'SKIPPED'} — ${b.message}`);
  } else {
    log.push('build:     skipped (--no-build)');
  }

  const p = placeBinary(repo);
  log.push(`place:     ${p.ok ? 'ok' : 'SKIPPED'} — ${p.message}`);

  if (codeql) {
    const c = installCodeql();
    log.push(`codeql:    ${c.ok ? 'ok' : 'SKIPPED (graceful)'} — ${c.message}`);
  } else {
    log.push('codeql:    skipped (--no-codeql)');
  }

  if (selfHost) {
    log.push('init:      skipped (self-host: target IS the ditto repo)');
    log.push('allowlist: skipped (self-host)');
  } else {
    const i = initTarget(repo, target);
    log.push(`init:      ${i.ok ? 'ok' : 'SKIPPED'} — ${i.message}`);
    const a = allowlistTarget(target);
    log.push(`allowlist: ${a.message} → ${a.path}${a.bak ? ` (backup ${a.bak})` : ''}`);
  }
  return log;
}

function doUninstall(repo, target, selfHost) {
  const log = [];
  const gsp = globalSettingsPath();
  const before = readSettings(gsp);
  const gbak = backup(gsp);
  writeSettings(gsp, unregisterPlugin({ ...before }));
  log.push(`unregister: ${PLUGIN_NAME}@${MARKETPLACE} ← ${gsp}${gbak ? ` (backup ${gbak})` : ''}`);

  const up = unplaceBinary(repo);
  log.push(`unplace:    ${up.message}`);

  if (!selfHost) {
    const ua = unallowlistTarget(target);
    log.push(`allowlist:  ${ua.message} (${ua.path})`);
    log.push(
      `data:       left ${join(target, '.ditto')} intact (remove manually to purge work-item history)`,
    );
  }
  return log;
}

function doStatus(repo, target, selfHost) {
  const cur = readSettings(globalSettingsPath());
  const link = join(placeDir(), 'ditto');
  const projAllow = readSettings(projectSettingsPath(target)).permissions?.allow;
  return {
    repo,
    target,
    self_host: selfHost,
    global_settings: globalSettingsPath(),
    marketplace: cur.extraKnownMarketplaces?.[MARKETPLACE] ?? null,
    plugin_enabled: cur.enabledPlugins?.[`${PLUGIN_NAME}@${MARKETPLACE}`] === true,
    binary_built: existsSync(binaryPath(repo)),
    binary_on_path: IS_WIN ? null : linksTo(link, binaryPath(repo)),
    codeql: detectCodeql(),
    target_initialized: existsSync(join(target, '.ditto', 'knowledge', 'glossary.json')),
    allowlisted: !selfHost && Array.isArray(projAllow) && projAllow.includes(ALLOW_RULE),
  };
}

function main() {
  const { mode, target: targetArg, build, codeql } = parseArgs(process.argv.slice(2));
  if (!['install', 'uninstall', 'status'].includes(mode)) {
    console.error(
      'usage: install-plugin.mjs [install|uninstall|status] [--target <dir>] [--no-build] [--no-codeql]',
    );
    process.exit(64);
  }
  const repo = resolveRepo();
  const { target, selfHost } = resolveTarget(repo, targetArg);

  if (mode === 'status') {
    console.log(JSON.stringify(doStatus(repo, target, selfHost), null, 2));
    return;
  }

  const log =
    mode === 'install'
      ? doInstall(repo, target, selfHost, build, codeql)
      : doUninstall(repo, target, selfHost);
  console.log(`[ditto] ${mode} OK`);
  console.log(`  repo:   ${repo}`);
  console.log(`  target: ${target}${selfHost ? ' (self-host — project steps skipped)' : ''}`);
  for (const line of log) console.log(`  ${line}`);

  if (mode === 'install') {
    console.log('');
    console.log('Next: start a new Claude Code session in the target, then verify with');
    console.log('  /plugin                 # ditto@ditto-local listed & enabled');
    console.log('  ditto doctor            # binary on PATH, runtime reachable');
  }
}

main();
