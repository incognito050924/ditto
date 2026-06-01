import { join, relative, resolve } from 'node:path';
import { type SurfaceCatalog, surfaceCatalog } from '~/schemas/surface-catalog';
import type { HostAdapter, HostId, SurfaceEntry, SurfaceKind } from './hosts';
import { readJsonIfExists } from './hosts/shared';

interface ExpectedSurface {
  host: HostId;
  kind: SurfaceKind;
  id: string;
  path: string;
}

async function loadExpected(repoRoot: string): Promise<ExpectedSurface[]> {
  const path = join(repoRoot, '.ditto', 'surfaces.json');
  let raw: unknown;
  try {
    raw = await readJsonIfExists(path);
  } catch {
    // File exists but is not valid JSON — a malformed catalog must NOT pass
    // silently (M1.6 false-green fix); surface it as an explicit error.
    throw new Error(`surface catalog is malformed JSON: ${path}`);
  }
  if (raw === null) {
    // Absent catalog is a false-green trap (M1.6, plan §3): the inventory has
    // nothing to compare actual surfaces against, which would silently pass on a
    // catalog deletion. Fail loudly — symmetric with the present-but-empty case.
    throw new Error(`surface catalog is missing: ${path}`);
  }
  const parsed = surfaceCatalog.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`surface catalog failed schema validation: ${path}`);
  }
  if (parsed.data.surfaces.length === 0) {
    // A present-but-empty catalog is a false-green trap (M1.6); fail loudly.
    throw new Error(`surface catalog is present but declares no surfaces: ${path}`);
  }
  return parsed.data.surfaces;
}

function keyOf(surface: Pick<SurfaceEntry, 'host' | 'kind' | 'id'>): string {
  return `${surface.host}:${surface.kind}:${surface.id}`;
}

/**
 * Generate the surface catalog from the code itself (W4-2 / G6) instead of
 * hand-maintaining `.ditto/surfaces.json`. Discovers every *local* surface via
 * the host adapters, relativises paths to the repo root, and sorts
 * deterministically so the output is stable. The committed catalog is this
 * generator's output; a test regenerates and compares, so a surface added
 * without regenerating fails loudly rather than silently drifting.
 */
export async function generateSurfaceCatalog(
  adapters: HostAdapter[],
  repoRoot: string,
): Promise<SurfaceCatalog> {
  const inventories = await Promise.all(
    adapters.map((adapter) => adapter.loadSurfaceInventory(repoRoot)),
  );
  const surfaces = inventories
    .flatMap((inv) => inv.localSurfaces)
    .map((s) => ({
      host: s.host,
      kind: s.kind,
      id: s.id,
      path: relative(repoRoot, s.path),
    }))
    .sort((a, b) => keyOf(a).localeCompare(keyOf(b)) || a.path.localeCompare(b.path));
  return surfaceCatalog.parse({ schema_version: '0.1.0', surfaces });
}

export async function collectSurfaceInventory(
  adapters: HostAdapter[],
  repoRoot: string,
): Promise<{ surfaces: SurfaceEntry[]; mismatch_count: number; findings: SurfaceEntry[] }> {
  const inventories = await Promise.all(
    adapters.map((adapter) => adapter.loadSurfaceInventory(repoRoot)),
  );
  const localActual = inventories.flatMap((inv) => inv.localSurfaces);
  const homeActual = inventories.flatMap((inv) => inv.homeSurfaces);
  const allInventory = [...localActual, ...homeActual];
  const expected = await loadExpected(repoRoot);
  if (expected.length === 0) {
    return { surfaces: allInventory, mismatch_count: 0, findings: [] };
  }

  const localByKey = new Map(localActual.map((surface) => [keyOf(surface), surface]));
  const expectedByKey = new Map(expected.map((surface) => [keyOf(surface), surface]));
  const findings: SurfaceEntry[] = [];

  for (const exp of expected) {
    const actualSurface = localByKey.get(keyOf(exp));
    if (!actualSurface) {
      findings.push({
        host: exp.host,
        kind: exp.kind,
        id: exp.id,
        path: resolve(repoRoot, exp.path),
        mismatch: 'missing_file',
      });
      continue;
    }
    if (resolve(actualSurface.path) !== resolve(repoRoot, exp.path)) {
      findings.push({ ...actualSurface, mismatch: 'renamed' });
    }
  }

  for (const surface of localActual) {
    if (!expectedByKey.has(keyOf(surface))) findings.push({ ...surface, mismatch: 'extra_file' });
  }

  return {
    surfaces: allInventory,
    mismatch_count: findings.length,
    findings,
  };
}
