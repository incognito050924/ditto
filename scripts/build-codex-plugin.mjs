#!/usr/bin/env bun
// DITTO Codex deploy assembler (dual-host plan M1/M4). Runs under `bun` (it
// imports the TypeScript agent-projection module and bun resolves .ts + the
// `~/*` path alias natively). Spawns `bun` for the binary build.
//
// Assembles `dist/codex-plugin/` — the Codex plugin surface, separate from the
// Claude assembly in `dist/plugin/` (scripts/build-plugin.mjs). Neither build
// touches the other's output dir.
//   .codex-plugin/plugin.json    Codex plugin manifest (manifest under
//                                .codex-plugin/, skills/hooks at plugin root)
//   hooks/                       hook wiring (hooks.json → ${CLAUDE_PLUGIN_ROOT}/bin/ditto)
//   skills/                      skill definitions
//   resources/                   managed-instruction resources (ditto setup)
//   .codex/agents/*.toml         custom-agent projection of agents/*.md (M4).
//                                Emitted into the build artifact only; setup (M5)
//                                installs the project .codex/agents/ — Codex
//                                plugin-bundled agent paths are undocumented
//                                (plan M4 obj 2), so this is a generation
//                                artifact, not an install location.
//   bin/ditto                    the compiled hook/CLI binary
//
// hooks.json keeps `${CLAUDE_PLUGIN_ROOT}` verbatim: Codex provides
// CLAUDE_PLUGIN_ROOT to plugin hook commands as a legacy-compat variable, so it
// resolves under Codex too (plan F1, dual-host-codex-fact-verification.md).

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectAgent } from '../src/core/agent-projection.ts';
import { normalizedSha256 } from '../src/core/instruction-bridge.ts';
import { buildBinInto, syncManagedResources } from './build-bin.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO, 'dist', 'codex-plugin');

// Charter recognition data (marker-less AGENTS.md refresh). Append the CURRENT
// canonical charter's normalized sha to resources/managed/charter-manifest.json
// BEFORE syncManagedResources() regenerates the managed resources, so the committed
// manifest accumulates every shipped version and an N→N+1 upgrade recognizes the
// prior charter. This build runs under bun, so it reuses the real runtime
// normalizedSha256 (no duplicated normalization) for a build-time == runtime sha.
function appendCharterManifest() {
  const sha = normalizedSha256(readFileSync(join(REPO, 'AGENTS.md'), 'utf8'));
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

// Codex surface dirs. No agents/commands/marketplace: those are Claude-host
// constructs (plan C4/C6). skills + hooks are declared in the manifest.
const ALWAYS_DIRS = ['hooks', 'skills', 'resources'];

function copyInto(rel) {
  cpSync(join(REPO, rel), join(OUT, rel), { recursive: true });
}

// Deployment seam (OBJ-1): the copied hooks.json is the Claude source — its
// `ditto hook <event>` commands carry no `--host`, so under Codex `hook.ts`
// defaults host to `claude-code` and the apply_patch safety gate (gated on
// host==='codex') never fires (a false-green: secret/scope-out edits sail
// through). Rewrite ONLY the build artifact's commands to select the Codex
// envelope; the repo `hooks/hooks.json` (Claude source) stays untouched.
function injectCodexHost() {
  const path = join(OUT, 'hooks', 'hooks.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  for (const event of Object.keys(manifest.hooks ?? {})) {
    for (const group of manifest.hooks[event]) {
      for (const h of group.hooks ?? []) {
        if (
          typeof h.command === 'string' &&
          /\bditto"?\s+hook\s/.test(h.command) &&
          !h.command.includes('--host')
        ) {
          h.command = `${h.command} --host codex`;
        }
      }
    }
  }
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

// Project agents/*.md → dist/codex-plugin/.codex/agents/<name>.toml (M4).
function projectAgents() {
  const agentsDir = join(REPO, 'agents');
  if (!existsSync(agentsDir)) throw new Error('missing surface dir: agents/');
  const outDir = join(OUT, '.codex', 'agents');
  mkdirSync(outDir, { recursive: true });
  const names = [];
  // Fail loud on a duplicate projected name (OBJ-7): two agents/*.md projecting to
  // the same name would silently overwrite one TOML, breaking surface parity with
  // no failing signal. A collision is a build error, not a silent last-writer-wins.
  const seen = new Set();
  for (const file of readdirSync(agentsDir).sort()) {
    if (!file.endsWith('.md')) continue;
    const projection = projectAgent(readFileSync(join(agentsDir, file), 'utf8'));
    if (seen.has(projection.name)) {
      throw new Error(
        `duplicate projected agent name "${projection.name}" (from ${file}) — would overwrite ${projection.name}.toml`,
      );
    }
    seen.add(projection.name);
    writeFileSync(join(outDir, `${projection.name}.toml`), projection.toml);
    names.push(`${projection.name}=${projection.sandboxMode}`);
  }
  return names;
}

function main() {
  // 0. Record the current charter sha into the recognition manifest BEFORE
  //    regenerating the managed resources from the canonical charter.
  appendCharterManifest();
  syncManagedResources();

  // 1. Fresh output tree (only dist/codex-plugin — never dist/plugin).
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  // 2. Bundle the bin straight into the output tree (never touches repo bin/).
  //    Portable JS bundle `ditto` (run by `bun`) + Windows launcher `ditto.cmd`.
  const binName = 'ditto';
  mkdirSync(join(OUT, 'bin'), { recursive: true });
  buildBinInto(join(OUT, 'bin', binName));
  if (!existsSync(join(OUT, 'bin', binName))) {
    throw new Error(`expected ${join(OUT, 'bin', binName)} after bundle`);
  }

  // 3. Assemble the Codex surface.
  copyInto(join('.codex-plugin', 'plugin.json'));
  for (const d of ALWAYS_DIRS) {
    if (!existsSync(join(REPO, d))) throw new Error(`missing surface dir: ${d}/`);
    copyInto(d);
  }

  // Make the bundled hooks select the Codex envelope (OBJ-1 deployment seam).
  injectCodexHost();

  // 4. Project Claude agents/*.md into Codex custom-agent TOMLs (M4).
  const agents = projectAgents();

  console.log(`[ditto] build:codex-plugin OK → ${OUT}`);
  console.log(
    `  surface: .codex-plugin/plugin.json, ${ALWAYS_DIRS.join('/, ')}/, .codex/agents/ (${agents.length}), bin/${binName}`,
  );
}

try {
  main();
} catch (err) {
  console.error(`[ditto] build:codex-plugin FAILED — ${err.message}`);
  process.exit(1);
}
