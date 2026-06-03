import { dirname, relative } from 'node:path';
import ts from 'typescript';
import type { AnalyzerResult, ImpactAnalyzer } from './impact-graph';

/**
 * TypeScript binding impact analyzer (10-methodology.md §3 — symbol resolution,
 * NOT text search). Builds a Program from the nearest tsconfig, resolves the
 * target exported symbol, and walks every source file's identifiers through the
 * type checker (alias-aware) to find references, classifying each:
 *   - referenced as a call callee     → direct_caller
 *   - used in a type position         → type_contract
 *   - in a *.test.ts / *.spec.ts file → test
 * Plus an `external_surface` node when the target is exported (gate: exported
 * symbol must be surfaced).
 *
 * Honest limits (recorded by the producer/caller, never hidden): static
 * resolution does not see dynamic dispatch / reflection / string-dispatch /
 * cross-repo — those are inherently `unresolved` and TS will not flag them, so
 * this analyzer reports only what the checker resolves (spec: "정적으로 잡히는
 * 것은 다 잡았는가"). Transitive-caller chaining is not walked in v0.
 */
export interface TsTarget {
  /** File declaring the changed symbol (absolute or repo-relative). */
  file: string;
  /** Exported symbol name being changed. */
  symbol: string;
  /** tsconfig path; defaults to <sourceRoot>/../tsconfig.json discovery. */
  tsconfigPath?: string;
}

function isTestFile(f: string): boolean {
  return /\.(test|spec)\.[cm]?tsx?$/.test(f);
}

/** Is this identifier the callee of a call expression? */
function isCallCallee(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isCallExpression(p) && p.expression === id) return true;
  if (ts.isPropertyAccessExpression(p) && p.name === id && ts.isCallExpression(p.parent))
    return true;
  return false;
}

/** Is this identifier used in a type position (type reference)? */
function isTypePosition(id: ts.Identifier): boolean {
  return ts.isTypeReferenceNode(id.parent) || ts.isTypeQueryNode(id.parent);
}

function loadProgram(tsconfigPath: string): ts.Program {
  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config ?? {},
    ts.sys,
    dirname(tsconfigPath),
  );
  return ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
}

export class TsImpactAnalyzer implements ImpactAnalyzer {
  constructor(private readonly target: TsTarget) {}

  async analyze(input: { changeTarget: string; sourceRoot: string }): Promise<AnalyzerResult> {
    const tsconfigPath =
      this.target.tsconfigPath ??
      ts.findConfigFile(input.sourceRoot, ts.sys.fileExists, 'tsconfig.json');
    if (!tsconfigPath) {
      return {
        affected: [],
        unresolved: [
          {
            kind: 'config_driven',
            path: input.changeTarget,
            reason:
              'no tsconfig.json found; TS analyzer could not build a program (provider unwired)',
          },
        ],
      };
    }
    const program = loadProgram(tsconfigPath);
    const checker = program.getTypeChecker();
    const repoRoot = dirname(tsconfigPath);

    const targetSf = program
      .getSourceFiles()
      .find(
        (sf) => sf.fileName === this.target.file || sf.fileName.endsWith(`/${this.target.file}`),
      );
    if (!targetSf) {
      return {
        affected: [],
        unresolved: [
          {
            kind: 'config_driven',
            path: this.target.file,
            reason: `target file ${this.target.file} not in the TS program`,
          },
        ],
      };
    }

    // Resolve the target symbol's declarations (the identity we compare against).
    const targetDecls = new Set<ts.Node>();
    let exported = false;
    const findDecl = (node: ts.Node): void => {
      if (
        (ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isVariableDeclaration(node)) &&
        node.name &&
        ts.isIdentifier(node.name) &&
        node.name.text === this.target.symbol
      ) {
        targetDecls.add(node);
        const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
        if (mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) exported = true;
        // variable declarations carry export on the statement
        if (ts.isVariableDeclaration(node)) {
          const stmt = node.parent.parent;
          if (
            ts.isVariableStatement(stmt) &&
            ts.getModifiers(stmt)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
          )
            exported = true;
        }
      }
      ts.forEachChild(node, findDecl);
    };
    findDecl(targetSf);

    if (targetDecls.size === 0) {
      return {
        affected: [],
        unresolved: [
          {
            kind: 'config_driven',
            path: this.target.file,
            reason: `symbol ${this.target.symbol} not declared in ${this.target.file}`,
          },
        ],
      };
    }

    const resolvesToTarget = (id: ts.Identifier): boolean => {
      let sym = checker.getSymbolAtLocation(id);
      if (!sym) return false;
      if (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
      return (sym.getDeclarations() ?? []).some((d) => targetDecls.has(d));
    };

    const affected: AnalyzerResult['affected'] = [];
    const seen = new Set<string>();
    for (const sf of program.getSourceFiles()) {
      if (sf.isDeclarationFile || sf.fileName.includes('node_modules')) continue;
      const relPath = relative(repoRoot, sf.fileName);
      const inTargetDecl = sf === targetSf;
      const visit = (node: ts.Node): void => {
        if (
          ts.isIdentifier(node) &&
          node.text === this.target.symbol &&
          !targetDecls.has(node.parent)
        ) {
          if (resolvesToTarget(node)) {
            // skip the declaration site itself
            if (inTargetDecl && [...targetDecls].some((d) => d === node.parent)) {
              // declaration name node — not a reference
            } else {
              const kind = isTypePosition(node)
                ? 'type_contract'
                : isTestFile(sf.fileName)
                  ? 'test'
                  : isCallCallee(node)
                    ? 'direct_caller'
                    : 'direct_caller';
              const line = sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
              const key = `${relPath}:${line}:${kind}`;
              if (!seen.has(key)) {
                seen.add(key);
                affected.push({
                  kind,
                  path: relPath,
                  symbol: this.target.symbol,
                  reason: `references ${this.target.symbol} at line ${line}`,
                });
              }
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }

    if (exported) {
      affected.push({
        kind: 'external_surface',
        path: relative(repoRoot, targetSf.fileName),
        symbol: this.target.symbol,
        reason: 'exported symbol — public surface (단계3 gate: exported must be surfaced)',
      });
    }

    return { affected, unresolved: [] };
  }
}
