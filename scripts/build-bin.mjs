#!/usr/bin/env node
// DITTO CLI bundler. Emits a small JS bundle (~1MB) at the given outfile via
// `--target=bun` (no standalone-executable compile step). The CLI relies on Bun.* globals
// (Bun.file/spawn/Glob/which), so the bundle runs under bun via a
// `#!/usr/bin/env bun` shebang. `--target=bun` resolves the tsconfig `~/*` path
// alias natively. `bun build --outfile` emits no shebang, so we prepend one +
// chmod +x.
//
// Reused by scripts/build-plugin.mjs (which bundles into dist/plugin/bin) and
// invoked directly by the `build` / `build:bin` package.json scripts.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { platform } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const IS_WIN = platform() === 'win32';
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Regenerate the committed managed-instruction resources from the canonical
// charter (repo-root AGENTS.md) so they never drift from it. Both files carry
// the IDENTICAL charter body; setup reads them from
// ${CLAUDE_PLUGIN_ROOT}/resources/managed. Like bin/ditto, these are committed
// artifacts — REBUILD BEFORE COMMITTING whenever AGENTS.md changes.
export function syncManagedResources() {
  const src = join(REPO, 'AGENTS.md');
  const dir = join(REPO, 'resources', 'managed');
  copyFileSync(src, join(dir, 'AGENTS.md'));
  copyFileSync(src, join(dir, 'CLAUDE.md'));
}

// Build drift stamp (round-2 review R5). MUST stay in sync with the identical
// algorithm in src/core/build-stamp.ts (the doctor's `binary_fresh` check):
// sha256 over repo-relative posix path + NUL + content + NUL for every `.ts`
// under src/, path-sorted.
const NUL = String.fromCharCode(0); // same separator as build-stamp.ts
// Stamp over a source tree (default `src`). The rebuild host surface stamps over
// `rebuild` instead — same algorithm, different tree — so the stamp stays a
// faithful build-drift marker for whichever CLI the bin was bundled from.
export function sourceStamp(stampDir = 'src') {
  const list = (rel) => {
    const out = [];
    for (const e of readdirSync(join(REPO, rel), { withFileTypes: true })) {
      const childRel = `${rel}/${e.name}`;
      if (e.isDirectory()) out.push(...list(childRel));
      else if (e.isFile() && e.name.endsWith('.ts')) out.push(childRel);
    }
    return out;
  };
  const h = createHash('sha256');
  for (const rel of list(stampDir).sort()) {
    h.update(rel);
    h.update(NUL);
    h.update(readFileSync(join(REPO, rel)));
    h.update(NUL);
  }
  return h.digest('hex');
}

// `entry` is the CLI entrypoint to bundle; `stampDir` the tree the drift stamp
// hashes. Both default to the old `src` surface so the live `bin/ditto` build
// (and build-plugin's call) is unchanged; the rebuild host surface passes
// `rebuild/cli/index.ts` + `rebuild` (the #69 flip repoints the defaults).
export function buildBinInto(outFile, entry = 'src/cli/index.ts', stampDir = 'src') {
  const args = ['build', entry, '--target=bun', '--outfile', outFile];
  const r = spawnSync('bun', args, { cwd: REPO, stdio: 'inherit' });
  if (r.error && r.error.code === 'ENOENT') {
    throw new Error('bun not found on PATH — install bun ≥1.3 to bundle the CLI');
  }
  if (r.status !== 0) throw new Error(`bin bundle failed (exit ${r.status})`);
  const bundle = readFileSync(outFile, 'utf8');
  // Trailing stamp lets `ditto doctor distribution` flag a stale build (R5).
  writeFileSync(outFile, `#!/usr/bin/env bun\n${bundle}\n//# ditto-src-stamp=${sourceStamp(stampDir)}\n`);
  if (!IS_WIN) chmodSync(outFile, 0o755);
  // Thin-launcher separation: the bundle is portable JS, so `bun <bundle>` runs it
  // on ANY OS — Windows needs no native PE compile, only this batch shim that
  // invokes bun on the sibling bundle. (A `#!/usr/bin/env bun` shebang file is not
  // executable on Windows; the previous `ditto.exe` was such a file, hence unrunnable.)
  // Emitted on every build OS so a dist/ built on mac/linux still runs on Windows.
  // %~dp0 = this .cmd's own directory (trailing backslash); %* forwards all args.
  writeFileSync(`${outFile}.cmd`, `@bun "%~dp0${basename(outFile)}" %*\r\n`);
}

// CLI entry: `node scripts/build-bin.mjs <outfile> [entry] [stampDir]`. The
// optional entry/stampDir bundle the rebuild host surface
// (`rebuild/cli/index.ts rebuild`) without touching the default src build.
// No-op when imported.
if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? '')) {
  const outArg = process.argv[2];
  const entryArg = process.argv[3];
  const stampArg = process.argv[4];
  if (!outArg) {
    console.error('[ditto] build-bin: missing <outfile> argument');
    process.exit(1);
  }
  try {
    buildBinInto(resolve(process.cwd(), outArg), entryArg, stampArg);
    // syncManagedResources regenerates resources/managed from the repo-root
    // charter; it is independent of which CLI surface was bundled.
    syncManagedResources();
    console.log(`[ditto] build-bin OK → ${outArg}${entryArg ? ` (entry ${entryArg})` : ''}`);
  } catch (err) {
    console.error(`[ditto] build-bin FAILED — ${err.message}`);
    process.exit(1);
  }
}
