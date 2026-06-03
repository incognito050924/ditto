import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import type { DependencyEdge, EdgeAnalyzer } from './boundary';

/**
 * TS edge analyzer: reads the import/export module graph of the changed files.
 * Relative specifiers (./ ../) resolve to repo-relative paths (the .ts target);
 * bare specifiers (packages, path aliases) are kept verbatim so forbidden_deps
 * globs can still match them. Parsing import declarations is reading the module
 * graph, not symbol text-search.
 */
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

/** Resolve a specifier from a containing file to a repo-relative path, or keep it bare. */
function resolveSpecifier(spec: string, containingFile: string, repoRoot: string): string {
  if (spec.startsWith('.')) {
    const abs = resolve(dirname(containingFile), spec);
    return relative(repoRoot, abs);
  }
  return spec; // package / path-alias — match as-is against forbidden_deps globs
}

export class TsEdgeAnalyzer implements EdgeAnalyzer {
  constructor(private readonly repoRoot: string) {}

  async edges(input: { changedFiles: string[]; sourceRoot: string }): Promise<DependencyEdge[]> {
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
        edges.push({ from: rel, to: resolveSpecifier(spec, abs, this.repoRoot) });
      }
    }
    return edges;
  }
}
