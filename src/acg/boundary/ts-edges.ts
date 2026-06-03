import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import type { DependencyEdge, EdgeAnalyzer } from './boundary';

/**
 * TS edge analyzer: reads the import/export module graph of the changed files.
 * Specifiers resolve to repo-relative paths so ArchitectureSpec rules written in
 * the natural repo-path form (e.g. `src/schemas/**`) match:
 *   - relative (./ ../)              → resolved against the file dir;
 *   - tsconfig path alias (~/x)      → resolved through `compilerOptions.paths`;
 *   - bare package / unresolved      → kept verbatim (so package globs still match).
 *
 * Resolving the alias is what avoids the false-clean where a `~/schemas/...`
 * import slips past a `src/schemas/**` forbidden-dependency rule. Parsing import
 * declarations is reading the module graph, not symbol text-search.
 */

/** A tsconfig path-alias mapping reduced to prefixes: `~/` → absolute `…/src/`. */
export interface PathAlias {
  prefix: string;
  targetAbsPrefix: string;
}

/** Load `compilerOptions.paths` wildcard aliases as resolved absolute prefixes. */
export function loadAliases(tsconfigPath: string): PathAlias[] {
  const cfg = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config ?? {}, ts.sys, dirname(tsconfigPath));
  const baseUrl = parsed.options.baseUrl ?? dirname(tsconfigPath);
  const paths = parsed.options.paths ?? {};
  const aliases: PathAlias[] = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    const target = targets?.[0];
    if (!pattern.endsWith('/*') || !target?.endsWith('/*')) continue; // only `x/*` → `y/*`
    const targetAbs = isAbsolute(target) ? target : resolve(baseUrl, target);
    aliases.push({
      prefix: pattern.slice(0, -1), // `~/*` → `~/`
      targetAbsPrefix: targetAbs.slice(0, -1), // `…/src/*` → `…/src/`
    });
  }
  return aliases;
}

/** Resolve a specifier to a repo-relative path (relative + path-alias), or keep it bare. */
export function resolveSpecifier(
  spec: string,
  containingFile: string,
  repoRoot: string,
  aliases: PathAlias[],
): string {
  if (spec.startsWith('.')) {
    return relative(repoRoot, resolve(dirname(containingFile), spec));
  }
  for (const alias of aliases) {
    if (spec.startsWith(alias.prefix)) {
      const abs = `${alias.targetAbsPrefix}${spec.slice(alias.prefix.length)}`;
      return relative(repoRoot, abs);
    }
  }
  return spec; // package / unresolved alias — match as-is against globs
}

function specifiersOf(sourceText: string, fileName: string): string[] {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);
  const specs: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specs.push(node.moduleSpecifier.text);
    }
    // require('x') and dynamic import('x')
    if (ts.isCallExpression(node)) {
      const isReq = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const isDyn = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const arg = node.arguments[0];
      if ((isReq || isDyn) && arg && ts.isStringLiteral(arg)) specs.push(arg.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

export class TsEdgeAnalyzer implements EdgeAnalyzer {
  constructor(private readonly repoRoot: string) {}

  async edges(input: { changedFiles: string[]; sourceRoot: string }): Promise<DependencyEdge[]> {
    const tsconfigPath =
      ts.findConfigFile(input.sourceRoot, ts.sys.fileExists, 'tsconfig.json') ??
      ts.findConfigFile(this.repoRoot, ts.sys.fileExists, 'tsconfig.json');
    const aliases = tsconfigPath ? loadAliases(tsconfigPath) : [];

    const edges: DependencyEdge[] = [];
    for (const rel of input.changedFiles) {
      if (!/\.[cm]?tsx?$/.test(rel)) continue;
      const abs = join(this.repoRoot, rel);
      let text: string;
      try {
        text = await readFile(abs, 'utf8');
      } catch {
        continue; // deleted/unreadable — no edges to add
      }
      for (const spec of specifiersOf(text, abs)) {
        edges.push({ from: rel, to: resolveSpecifier(spec, abs, this.repoRoot, aliases) });
      }
    }
    return edges;
  }
}
