#!/usr/bin/env node
// DITTO deploy assembler (axis ①). Pure Node — no external deps; runs under
// `node` or `bun`. Spawns `bun` only for the binary build (--target=bun needs bun).
//
// Assembles `dist/plugin/` containing ONLY the product surface that a Claude
// Code plugin needs at runtime:
//   .claude-plugin/plugin.json   plugin manifest
//   hooks/                       hook wiring (hooks.json → ${CLAUDE_PLUGIN_ROOT}/bin/ditto)
//   agents/                      the 13 product agent definitions (ROOT agents/, NOT .ditto/agents)
//   skills/                      skill definitions
//   commands/                    slash commands (only if present)
//   bin/ditto                    the compiled hook/CLI binary
//
// Excluded by construction (never copied): src/, tests/, schemas/, .ditto/
// (dogfooding runtime + project-global governance), reports/. The 3-tier model:
//   ① product (this dist/plugin) ② project-global (.ditto/knowledge,agents)
//   ③ per-developer (.ditto/local) — only ① is the deploy unit.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBinInto, syncManagedResources } from './build-bin.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'dist', 'plugin');

// Charter recognition data (marker-less AGENTS.md refresh). Append the CURRENT
// canonical charter's normalized sha to resources/managed/charter-manifest.json
// BEFORE syncManagedResources() regenerates resources/managed/{AGENTS,CLAUDE}.md,
// so the committed manifest accumulates every shipped version and an N→N+1 upgrade
// recognizes the prior charter. `ditto setup` reads this manifest at install time.
//
// The normalization MUST stay in sync with normalizeInstructionText /
// normalizedSha256 in src/core/instruction-bridge.ts (CRLF→LF, strip per-line
// trailing spaces) so a build-time sha matches the runtime recognition sha.
function normalizedCharterSha(text) {
  const normalized = text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n');
  return createHash('sha256').update(normalized).digest('hex');
}

export function appendCharterManifest() {
  const sha = normalizedCharterSha(readFileSync(join(REPO, 'AGENTS.md'), 'utf8'));
  const manifestPath = join(REPO, 'resources', 'managed', 'charter-manifest.json');
  let shas = [];
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (Array.isArray(parsed.shas)) shas = parsed.shas.filter((s) => typeof s === 'string');
    } catch {
      // Malformed manifest → start fresh from the current sha (recognition degrades
      // to "current only"; no crash on a hand-corrupted asset).
    }
  }
  if (!shas.includes(sha)) shas.push(sha);
  writeFileSync(manifestPath, `${JSON.stringify({ shas }, null, 2)}\n`);
}

// Product surface dirs that always ship. `commands` is conditional (absent today).
// `resources` must ship: `ditto setup` resolves resources/managed under the
// installed plugin root — without it setup silently installs zero resources.
const ALWAYS_DIRS = ['hooks', 'agents', 'skills', 'resources'];
const OPTIONAL_DIRS = ['commands'];

// Bundle straight into dist/plugin/bin so assembly never clobbers the live
// repo `bin/ditto` (which the running session's hooks invoke). `buildBinInto`
// (shared with scripts/build-bin.mjs) emits a small JS bundle (~1MB) that runs
// under bun via a `#!/usr/bin/env bun` shebang.

function copyInto(rel) {
  cpSync(join(REPO, rel), join(OUT, rel), { recursive: true });
}

function main() {
  // 0. Record the current charter sha into the recognition manifest BEFORE
  //    regenerating the managed resources, then regenerate resources/managed/
  //    {AGENTS,CLAUDE}.md from the canonical charter so they never drift.
  appendCharterManifest();
  syncManagedResources();

  // 1. Fresh output tree.
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  // 2. Bundle the bin straight into the output tree (never touches repo bin/).
  //    buildBinInto emits the portable JS bundle `ditto` (run by `bun`) plus a
  //    Windows launcher `ditto.cmd` — no OS-specific binary name.
  const binName = 'ditto';
  mkdirSync(join(OUT, 'bin'), { recursive: true });
  buildBinInto(join(OUT, 'bin', binName));
  if (!existsSync(join(OUT, 'bin', binName))) {
    throw new Error(`expected ${join(OUT, 'bin', binName)} after bundle`);
  }

  // 3. Assemble the product surface.
  copyInto(join('.claude-plugin', 'plugin.json'));
  for (const d of ALWAYS_DIRS) {
    if (!existsSync(join(REPO, d))) throw new Error(`missing product surface dir: ${d}/`);
    copyInto(d);
  }
  for (const d of OPTIONAL_DIRS) {
    if (existsSync(join(REPO, d))) copyInto(d);
  }

  // 4. Make dist/plugin its OWN marketplace root with a self-referential
  // plugin source ("./"). Claude Code bug #11278: a relative plugin SUBPATH
  // (e.g. "./dist/plugin") in a file-source marketplace resolves against the
  // marketplace.json FILE path, not its directory, so it never loads — only
  // source "./" (the marketplace root itself) works. By emitting a marketplace
  // here and registering THIS file, the plugin dir == marketplace root, so the
  // relative source resolves and hooks fire. Reuse the repo marketplace's
  // name/owner/description; force source to "./".
  const mkt = JSON.parse(readFileSync(join(REPO, '.claude-plugin', 'marketplace.json'), 'utf8'));
  for (const p of mkt.plugins ?? []) p.source = './';
  writeFileSync(
    join(OUT, '.claude-plugin', 'marketplace.json'),
    `${JSON.stringify(mkt, null, 2)}\n`,
  );

  console.log(`[ditto] build:plugin OK → ${OUT}`);
  const shipped = [...ALWAYS_DIRS, ...OPTIONAL_DIRS.filter((d) => existsSync(join(OUT, d)))];
  console.log(
    `  surface: .claude-plugin/{plugin,marketplace}.json, ${shipped.join('/, ')}/, bin/${binName}`,
  );
}

try {
  main();
} catch (err) {
  console.error(`[ditto] build:plugin FAILED — ${err.message}`);
  process.exit(1);
}
