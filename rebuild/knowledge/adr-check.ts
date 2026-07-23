import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { adrIdFromFilename } from '../schemas/adr-id';
import { dittoDir } from '../util/paths';

export interface AdrConsistencyResult {
  ok: boolean;
  violations: string[];
}

/**
 * Fail-closed consistency check over `.ditto/knowledge/adr/`. Returns the full
 * list of violations (empty ⇒ clean). Two checks, both file-driven:
 *   1. Filename format — every `*.md` must be legacy `ADR-NNNN-<slug>.md` or
 *      new `ADR-YYYYMMDD-<slug>.md`.
 *   2. Identifier uniqueness — no two files may extract the same identifier
 *      (e.g. two legacy `ADR-0026-*.md` from concurrent branches).
 * The `adr/*.md` files are the source of truth; there is no separate index to
 * reconcile (a hand-maintained index would be drift-prone duplication of the
 * same facts). Scope guards: number-sequence gaps are never flagged; legacy
 * `ADR-NNNN-<slug>.md` files are grandfathered and pass unchanged.
 */
export async function checkAdrConsistency(repoRoot: string): Promise<AdrConsistencyResult> {
  const adrDir = join(dittoDir(repoRoot), 'knowledge', 'adr');
  const violations: string[] = [];

  let files: string[] = [];
  try {
    files = (await readdir(adrDir)).filter((f) => f.endsWith('.md')).sort();
  } catch {
    files = [];
  }

  // Check 1 + identifier extraction.
  const idToFiles = new Map<string, string[]>();
  for (const f of files) {
    const id = adrIdFromFilename(f);
    if (id === null) {
      violations.push(
        `malformed ADR filename: ${f} (expected ADR-NNNN-<slug>.md or ADR-YYYYMMDD-<slug>.md)`,
      );
      continue;
    }
    const bucket = idToFiles.get(id) ?? [];
    bucket.push(f);
    idToFiles.set(id, bucket);
  }

  // Check 2: identifier uniqueness.
  for (const [id, owners] of idToFiles) {
    if (owners.length > 1) {
      violations.push(`duplicate ADR identifier ${id}: ${owners.join(', ')}`);
    }
  }

  return { ok: violations.length === 0, violations };
}
