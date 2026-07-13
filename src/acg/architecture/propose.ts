import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { EdgeAnalyzer } from '~/acg/boundary/boundary';
import type { AcgArchitectureSpec } from '~/schemas/acg-architecture-spec';
import { acgArchitectureSpec } from '~/schemas/acg-architecture-spec';

/**
 * ArchitectureSpec agent candidate proposer (ADR-0004 Q3, fast-follow #4).
 *
 * The agent path is NON-AUTHORITATIVE and default-disabled (ADR-0004): it only
 * proposes OBSERVABLE structure for a human to ratify. The load-bearing
 * invariants this module guarantees:
 *   - produced_by = 'agent' (a candidate, never the authoritative spec);
 *   - forbidden_dependencies = [] ALWAYS — rules are the human's to declare;
 *     auto-forbidding would fossilize the current code as the intended boundary;
 *   - layers carry NAMES only (can_call empty) — observed structure, not rules.
 *
 * `public_surfaces` are observed cross-layer import targets (a module imported
 * from another layer is, in fact, a public surface). This is observation, not a
 * rule. A PoC of layer-classification accuracy is the activation precondition
 * before this candidate is trusted (ADR-0004).
 */

export interface ArchObservation {
  layers: string[];
  publicSurfaces: string[];
}

/** Top-level layer of a repo-relative src path: `src/<layer>/…` → `<layer>`. */
export function layerOf(repoRelPath: string): string | undefined {
  const parts = repoRelPath.split('/');
  return parts[0] === 'src' && parts.length > 2 ? parts[1] : undefined;
}

/**
 * Assemble a NON-AUTHORITATIVE candidate ArchitectureSpec. Pure; the invariants
 * (produced_by=agent, no forbidden_dependencies, empty can_call) are enforced
 * here regardless of input.
 */
export function buildCandidateSpec(obs: ArchObservation, producedAt: string): AcgArchitectureSpec {
  return acgArchitectureSpec.parse({
    schema_version: '0.1.0',
    kind: 'acg.architecture-spec.v1',
    produced_by: 'agent',
    produced_at: producedAt,
    // layer NAMES only — the human declares can_call (no auto-rules).
    layers: Object.fromEntries([...new Set(obs.layers)].sort().map((l) => [l, { can_call: [] }])),
    public_surfaces: [...new Set(obs.publicSurfaces)].sort(),
    // INVARIANT: never auto-forbid. Rules are ratified by a human.
    forbidden_dependencies: [],
    module_invariants: [],
  });
}

async function walkTsFiles(repoRoot: string, dir: string, acc: string[]): Promise<void> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) await walkTsFiles(repoRoot, full, acc);
    else if (/\.[cm]?tsx?$/.test(e.name) && !/\.(test|spec)\./.test(e.name))
      acc.push(relative(repoRoot, full));
  }
}

/**
 * Observe the repo's import graph: layers = top-level src dirs; public_surfaces =
 * modules imported across layer boundaries. Reuses the boundary edge analyzer.
 */
export async function observeArchitecture(
  repoRoot: string,
  sourceRoot: string,
  edgeAnalyzer: EdgeAnalyzer,
): Promise<ArchObservation> {
  const files: string[] = [];
  await walkTsFiles(repoRoot, sourceRoot, files);
  const edges = await edgeAnalyzer.edges({ changedFiles: files, sourceRoot });

  const layers = new Set<string>();
  for (const f of files) {
    const l = layerOf(f);
    if (l) layers.add(l);
  }

  const publicSurfaces = new Set<string>();
  for (const e of edges) {
    if (!e.to.startsWith('src/')) continue;
    const fromLayer = layerOf(e.from);
    const toLayer = layerOf(`${e.to}.ts`); // edge.to has no extension
    if (fromLayer && toLayer && fromLayer !== toLayer) publicSurfaces.add(e.to);
  }

  return { layers: [...layers], publicSurfaces: [...publicSurfaces] };
}
