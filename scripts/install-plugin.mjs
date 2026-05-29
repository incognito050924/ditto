#!/usr/bin/env node
// DITTO plugin installer (cross-platform).
// Patches ~/.claude/settings.json so the local plugin loads in every session.
// Pure Node — no external deps; runs identically under `node` or `bun`.

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MARKETPLACE = 'ditto-local';
const PLUGIN_NAME = 'ditto';

function resolveRepo() {
  const envHome = process.env.DITTO_HOME;
  if (envHome && existsSync(join(envHome, '.claude-plugin', 'plugin.json'))) {
    return resolve(envHome);
  }
  // Script lives at <repo>/scripts/install-plugin.mjs.
  const here = dirname(fileURLToPath(import.meta.url));
  const guess = resolve(here, '..');
  if (existsSync(join(guess, '.claude-plugin', 'plugin.json'))) return guess;
  throw new Error(
    `Could not locate DITTO repo. Set DITTO_HOME to the repo root (containing .claude-plugin/plugin.json).`,
  );
}

function settingsPath() {
  // Claude Code uses ~/.claude/settings.json on every OS, including Windows
  // (homedir() returns %USERPROFILE% there).
  return join(homedir(), '.claude', 'settings.json');
}

function readSettings(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return {};
  return JSON.parse(text);
}

function backup(path) {
  if (!existsSync(path)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${path}.bak.${stamp}`;
  copyFileSync(path, dest);
  return dest;
}

function patch(settings, repo) {
  const manifest = join(repo, '.claude-plugin', 'marketplace.json');
  // file:// URL works cross-OS; pathToFileURL handles Windows drive letters.
  const url = pathToFileURL(manifest).href;

  const markets = settings.extraKnownMarketplaces ?? {};
  markets[MARKETPLACE] = { source: { source: 'url', url } };
  settings.extraKnownMarketplaces = markets;

  const enabled = settings.enabledPlugins ?? {};
  enabled[`${PLUGIN_NAME}@${MARKETPLACE}`] = true;
  settings.enabledPlugins = enabled;

  return settings;
}

function unpatch(settings) {
  if (settings.extraKnownMarketplaces) delete settings.extraKnownMarketplaces[MARKETPLACE];
  if (settings.enabledPlugins) delete settings.enabledPlugins[`${PLUGIN_NAME}@${MARKETPLACE}`];
  return settings;
}

function write(path, settings) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
}

function main() {
  const mode = process.argv[2] ?? 'install';
  if (!['install', 'uninstall', 'status'].includes(mode)) {
    console.error(`usage: install-plugin.mjs [install|uninstall|status]`);
    process.exit(64);
  }

  const repo = resolveRepo();
  const sp = settingsPath();

  if (mode === 'status') {
    const cur = readSettings(sp);
    const market = cur.extraKnownMarketplaces?.[MARKETPLACE];
    const on = cur.enabledPlugins?.[`${PLUGIN_NAME}@${MARKETPLACE}`] === true;
    console.log(JSON.stringify({ repo, settings: sp, marketplace: market ?? null, enabled: on }, null, 2));
    return;
  }

  const before = readSettings(sp);
  const next = mode === 'install' ? patch({ ...before }, repo) : unpatch({ ...before });
  const bak = backup(sp);
  write(sp, next);

  console.log(`[ditto] ${mode} OK`);
  console.log(`  repo:     ${repo}`);
  console.log(`  settings: ${sp}`);
  if (bak) console.log(`  backup:   ${bak}`);
  if (mode === 'install') {
    console.log(`  added:    extraKnownMarketplaces.${MARKETPLACE} (url → marketplace.json)`);
    console.log(`  enabled:  ${PLUGIN_NAME}@${MARKETPLACE}`);
    console.log(``);
    console.log(`Next: start a new Claude Code session, then verify with`);
    console.log(`  /plugin                       # list installed plugins`);
    console.log(`  /ditto:verify --help          # any /ditto:* skill is reachable`);
    console.log(``);
    console.log(`Per-session fallback (no settings.json change):`);
    console.log(`  claude --plugin-dir "${repo}"`);
  }
}

main();
