#!/usr/bin/env node
// DITTO deploy assembler (axis ①). Pure Node — no external deps; runs under
// `node` or `bun`. Spawns `bun` only for the binary build (--compile needs bun).
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

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WIN = platform() === 'win32';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'dist', 'plugin');

// Product surface dirs that always ship. `commands` is conditional (absent today).
const ALWAYS_DIRS = ['hooks', 'agents', 'skills'];
const OPTIONAL_DIRS = ['commands'];

// Compile straight into dist/plugin/bin so assembly never clobbers the live
// repo `bin/ditto` (which the running session's hooks invoke).
function buildBinInto(outFile) {
  const args = ['build', 'src/cli/index.ts', '--compile'];
  if (IS_WIN) args.push('--target=bun-windows-x64');
  args.push('--outfile', outFile);
  const r = spawnSync('bun', args, { cwd: REPO, stdio: 'inherit' });
  if (r.error && r.error.code === 'ENOENT') {
    throw new Error('bun not found on PATH — install bun ≥1.3 to compile the binary');
  }
  if (r.status !== 0) throw new Error(`bin compile failed (exit ${r.status})`);
}

function copyInto(rel) {
  cpSync(join(REPO, rel), join(OUT, rel), { recursive: true });
}

function main() {
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

  console.log(`[ditto] build:plugin OK → ${OUT}`);
  const shipped = [...ALWAYS_DIRS, ...OPTIONAL_DIRS.filter((d) => existsSync(join(OUT, d)))];
  console.log(`  surface: .claude-plugin/plugin.json, ${shipped.join('/, ')}/, bin/${binName}`);
}

try {
  main();
} catch (err) {
  console.error(`[ditto] build:plugin FAILED — ${err.message}`);
  process.exit(1);
}
