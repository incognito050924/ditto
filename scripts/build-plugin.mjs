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

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBinInto, syncManagedResources } from './build-bin.mjs';

const IS_WIN = platform() === 'win32';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'dist', 'plugin');

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
  // 0. Regenerate committed managed resources from the canonical charter
  //    (repo-root AGENTS.md) so resources/managed/{AGENTS,CLAUDE}.md never drift.
  syncManagedResources();

  // 1. Fresh output tree.
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  // 2. Compile the bin straight into the output tree (never touches repo bin/).
  const binName = IS_WIN ? 'ditto.exe' : 'ditto';
  mkdirSync(join(OUT, 'bin'), { recursive: true });
  buildBinInto(join(OUT, 'bin', binName));
  if (!existsSync(join(OUT, 'bin', binName))) {
    throw new Error(`expected ${join(OUT, 'bin', binName)} after compile`);
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
