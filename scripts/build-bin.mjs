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
import { dirname, join, resolve } from 'node:path';
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
export function sourceStamp() {
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
  for (const rel of list('src').sort()) {
    h.update(rel);
    h.update(NUL);
    h.update(readFileSync(join(REPO, rel)));
    h.update(NUL);
  }
  return h.digest('hex');
}

export function buildBinInto(outFile) {
  const args = ['build', 'src/cli/index.ts', '--target=bun', '--outfile', outFile];
  const r = spawnSync('bun', args, { cwd: REPO, stdio: 'inherit' });
  if (r.error && r.error.code === 'ENOENT') {
    throw new Error('bun not found on PATH — install bun ≥1.3 to bundle the CLI');
  }
  if (r.status !== 0) throw new Error(`bin bundle failed (exit ${r.status})`);
  const bundle = readFileSync(outFile, 'utf8');
  // Trailing stamp lets `ditto doctor distribution` flag a stale build (R5).
  writeFileSync(outFile, `#!/usr/bin/env bun\n${bundle}\n//# ditto-src-stamp=${sourceStamp()}\n`);
  if (!IS_WIN) chmodSync(outFile, 0o755);
}

// CLI entry: `node scripts/build-bin.mjs <outfile>`. No-op when imported.
if (resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? '')) {
  const outArg = process.argv[2];
  if (!outArg) {
    console.error('[ditto] build-bin: missing <outfile> argument');
    process.exit(1);
  }
  try {
    buildBinInto(resolve(process.cwd(), outArg));
    syncManagedResources();
    console.log(`[ditto] build-bin OK → ${outArg}`);
  } catch (err) {
    console.error(`[ditto] build-bin FAILED — ${err.message}`);
    process.exit(1);
  }
}
