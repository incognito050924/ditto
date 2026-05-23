import { join, resolve } from 'node:path';
import { surfaceCatalog } from '~/schemas/surface-catalog';
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
  try {
    const raw = await readJsonIfExists(path);
    const parsed = surfaceCatalog.safeParse(raw);
    return parsed.success ? parsed.data.surfaces : [];
  } catch {
    return [];
  }
}

function keyOf(surface: Pick<SurfaceEntry, 'host' | 'kind' | 'id'>): string {
  return `${surface.host}:${surface.kind}:${surface.id}`;
}

export async function collectSurfaceInventory(
  adapters: HostAdapter[],
  repoRoot: string,
): Promise<{ surfaces: SurfaceEntry[]; mismatch_count: number; findings: SurfaceEntry[] }> {
  const inventories = await Promise.all(
    adapters.map((adapter) => adapter.loadSurfaceInventory(repoRoot)),
  );
  const actual = inventories.flatMap((inv) => inv.surfaces);
  const expected = await loadExpected(repoRoot);
  if (expected.length === 0) {
    return { surfaces: actual, mismatch_count: 0, findings: [] };
  }

  const actualByKey = new Map(actual.map((surface) => [keyOf(surface), surface]));
  const expectedByKey = new Map(expected.map((surface) => [keyOf(surface), surface]));
  const findings: SurfaceEntry[] = [];

  for (const exp of expected) {
    const actualSurface = actualByKey.get(keyOf(exp));
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

  for (const surface of actual) {
    if (!expectedByKey.has(keyOf(surface))) findings.push({ ...surface, mismatch: 'extra_file' });
  }

  return {
    surfaces: actual,
    mismatch_count: findings.length,
    findings,
  };
}
