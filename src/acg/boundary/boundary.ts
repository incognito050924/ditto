import type { AcgArchitectureSpec } from '~/schemas/acg-architecture-spec';

/**
 * Boundary gate core ("boundary 위반 0").
 *
 * Clean Architecture's Dependency Rule, machine-checked: given the dependency
 * edges a change introduces, flag those that violate the ArchitectureSpec —
 *   (a) forbidden_dependencies: a from-glob → to-glob edge that is declared
 *       forbidden (fully spec-grounded; from/to are path globs);
 *   (b) layers.can_call: an edge whose source layer may not call the target
 *       layer. A file's layer is the layers-key that appears as a path segment
 *       (boxwood convention: …/controller/… ⇒ controller). When neither end maps
 *       to a known layer, the layer rule does not apply (only forbidden_deps does).
 *
 * Edge EXTRACTION (parsing the module graph) is the binding's analyzer; this
 * module owns the pure rule check. Returned violations are projected to the
 * acg-review ledger by the caller so the existing Stop gate blocks completion.
 */

export interface DependencyEdge {
  /** Repo-relative path of the importing module. */
  from: string;
  /** Repo-relative path (or package specifier) of the imported module. */
  to: string;
}

export interface BoundaryViolation {
  rule: 'forbidden_dependency' | 'layer';
  from: string;
  to: string;
  reason: string;
}

/** Minimal glob → RegExp: `**` = any chars (incl. `/`), `*` = non-slash run. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

function matchesGlob(path: string, glob: string): boolean {
  return globToRegExp(glob).test(path);
}

/** The layer a path belongs to: a layers-key appearing as a `/`-delimited segment. */
export function pathToLayer(
  path: string,
  layers: AcgArchitectureSpec['layers'],
): string | undefined {
  const segments = path.split('/');
  for (const layer of Object.keys(layers)) {
    if (segments.includes(layer)) return layer;
  }
  return undefined;
}

/** Check one edge against the spec; returns the violations it triggers (0–2). */
export function checkEdge(edge: DependencyEdge, spec: AcgArchitectureSpec): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];

  for (const rule of spec.forbidden_dependencies) {
    if (matchesGlob(edge.from, rule.from) && matchesGlob(edge.to, rule.to)) {
      violations.push({
        rule: 'forbidden_dependency',
        from: edge.from,
        to: edge.to,
        reason: rule.reason,
      });
    }
  }

  const fromLayer = pathToLayer(edge.from, spec.layers);
  const toLayer = pathToLayer(edge.to, spec.layers);
  if (fromLayer && toLayer && fromLayer !== toLayer) {
    const canCall = spec.layers[fromLayer]?.can_call ?? [];
    if (!canCall.includes(toLayer)) {
      violations.push({
        rule: 'layer',
        from: edge.from,
        to: edge.to,
        reason: `layer '${fromLayer}' may not call '${toLayer}' (can_call: [${canCall.join(', ')}])`,
      });
    }
  }

  return violations;
}

/** Check all edges; the gate passes iff the returned list is empty (boundary 위반 0). */
export function checkBoundary(
  spec: AcgArchitectureSpec,
  edges: DependencyEdge[],
): BoundaryViolation[] {
  return edges.flatMap((e) => checkEdge(e, spec));
}

/** Binding-provided edge extractor (parses the change's module graph). */
export interface EdgeAnalyzer {
  edges(input: { changedFiles: string[]; sourceRoot: string }): Promise<DependencyEdge[]>;
}
