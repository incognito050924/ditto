/**
 * Build drift stamp (round-2 review R5).
 *
 * The hooks run a COMMITTED bundle (`bin/ditto`), not the source — so a stale
 * build silently enforces an old policy while unit tests (compiled from source)
 * stay green. The bundler embeds a deterministic stamp over the `.ts` contents
 * under `src/`; `ditto doctor distribution` recomputes it and flags drift via
 * the `binary_fresh` check.
 *
 * The embedding side lives in `scripts/build-bin.mjs` (`sourceStamp()`), which
 * MUST implement the identical algorithm: sha256 over repo-relative posix path
 * + NUL + file content + NUL for every `.ts` under `src/`, path-sorted.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Marker line appended to the bundle by scripts/build-bin.mjs. */
export const STAMP_PREFIX = '//# ditto-src-stamp=';

/** repo-relative posix paths of every `.ts` under `src/`, sorted. */
function listSourceFiles(repoRoot: string, rel = 'src'): string[] {
  const out: string[] = [];
  const entries = readdirSync(join(repoRoot, rel), { withFileTypes: true });
  for (const e of entries) {
    const childRel = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...listSourceFiles(repoRoot, childRel));
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(childRel);
  }
  return out.sort();
}

/** Deterministic content stamp over the sorted `.ts` files under `src/`. */
export function computeSourceStamp(repoRoot: string): string {
  const h = createHash('sha256');
  for (const rel of listSourceFiles(repoRoot)) {
    h.update(rel);
    h.update('\u0000');
    h.update(readFileSync(join(repoRoot, rel)));
    h.update('\u0000');
  }
  return h.digest('hex');
}

/** Extract the embedded stamp from a bundle's text; null when absent (pre-stamp build). */
export function readEmbeddedStamp(bundleText: string): string | null {
  const idx = bundleText.lastIndexOf(STAMP_PREFIX);
  if (idx === -1) return null;
  const m = bundleText.slice(idx + STAMP_PREFIX.length).match(/^[a-f0-9]{64}/);
  return m ? m[0] : null;
}
