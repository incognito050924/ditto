import ts from 'typescript';

/**
 * O7 (wi_260605de1) — static signature extractor for the semantic producer.
 *
 * The dialectic put the static/meaning split at the heart of OBJ-43: the static
 * layer may only state facts a parser can prove (the signature shape changed),
 * never the meaning. This module is that static layer. It uses the TypeScript
 * parser (AST only — no type-checker, no program) so generics/overloads/arrows
 * are read structurally rather than by a regex the Opponent showed would miss
 * them. Default exports and re-exports are deliberately out of scope (no stable
 * local name to key a before→after pair on).
 */

export interface SignatureChange {
  symbol: string;
  before: string;
  after: string;
}

function normalizeFunctionDecl(node: ts.FunctionDeclaration, name: string): string {
  const typeParams = node.typeParameters?.map((p) => p.getText()).join(', ');
  const params = node.parameters.map((p) => p.getText()).join(', ');
  const ret = node.type ? `: ${node.type.getText()}` : '';
  return `${name}${typeParams ? `<${typeParams}>` : ''}(${params})${ret}`;
}

function normalizeArrowOrFn(name: string, fn: ts.ArrowFunction | ts.FunctionExpression): string {
  const typeParams = fn.typeParameters?.map((p) => p.getText()).join(', ');
  const params = fn.parameters.map((p) => p.getText()).join(', ');
  const ret = fn.type ? `: ${fn.type.getText()}` : '';
  return `${name}${typeParams ? `<${typeParams}>` : ''}(${params})${ret}`;
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)
  );
}

function isDefaultExport(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false)
  );
}

/**
 * Map exported symbol name → its normalized signature text. Overloads collapse
 * into one entry joined with ` | ` so an overload-set change is still visible.
 */
export function extractExportedSignatures(sourceText: string): Map<string, string> {
  const sf = ts.createSourceFile('m.ts', sourceText, ts.ScriptTarget.Latest, true);
  const out = new Map<string, string[]>();
  const add = (name: string, sig: string) => {
    const prev = out.get(name) ?? [];
    prev.push(sig);
    out.set(name, prev);
  };

  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && hasExportModifier(stmt)) {
      if (isDefaultExport(stmt)) continue; // default export: no stable named pair
      add(stmt.name.text, normalizeFunctionDecl(stmt, stmt.name.text));
      continue;
    }
    if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
          add(decl.name.text, normalizeArrowOrFn(decl.name.text, decl.initializer));
        }
      }
    }
    // ExportDeclaration (`export { x } from './y'`) carries no signature → skip.
  }

  return new Map([...out].map(([name, sigs]) => [name, sigs.join(' | ')]));
}

/**
 * Signatures that exist in BOTH versions and differ. Added/deleted exports are
 * not signature-shape changes (O8 scope) and are excluded.
 */
export function diffExportedSignatures(before: string, after: string): SignatureChange[] {
  const a = extractExportedSignatures(before);
  const b = extractExportedSignatures(after);
  const changes: SignatureChange[] = [];
  for (const [symbol, beforeSig] of a) {
    const afterSig = b.get(symbol);
    if (afterSig !== undefined && afterSig !== beforeSig) {
      changes.push({ symbol, before: beforeSig, after: afterSig });
    }
  }
  return changes;
}
