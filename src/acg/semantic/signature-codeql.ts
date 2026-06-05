import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type RelationDeps,
  type RunRelationInput,
  runRelationQuery,
} from '~/core/codeql/relations';
import type { BuildMode, CodeqlLanguage } from '~/core/codeql/runner';
import { addDetachedWorktree, gitRevParse, removeWorktree } from '~/core/git';

/**
 * O7 (wi_260605de1) — CodeQL signature extractor for the semantic producer.
 *
 * The 1차 TS-compiler approach violated ADR-0006 (per-language compiler analyzer
 * + silent false-clean on non-TS). This is the ADR-compliant replacement: a
 * CodeQL "fact extraction" query (D3) that reconstructs each exported function's
 * signature from the AST, run on a base-ref DB and an after DB, then diffed.
 *
 * Multi-language is structural: a per-language query binding + fail-loud on an
 * unbound language (never the silent empty result that read as "clean"). The JS
 * binding is probed/verified (ac-0); other languages plug into SIGNATURE_QUERIES.
 */

export interface SignatureChange {
  file: string;
  symbol: string;
  before: string;
  after: string;
}

/**
 * Exported-signature extraction (JS/TS). Reconstructs `name(paramTypes): ret`
 * for every exported function/arrow, including generics, union types, and
 * untyped params (`?`). Verified against a real DB in ac-0:
 *   getUser → string / "User | null", map<T,U> → "T, (t: T) => U" / U,
 *   noArgs → "" / void, untyped → "?, ?" / number, hidden (non-export) excluded.
 */
export const SIGNATURE_QUERY_JS = `/**
 * @name ditto signatures js
 * @id ditto/signature-relations
 * @kind table
 */
import javascript

string paramOne(Function f, int i) {
  exists(Parameter p | p = f.getParameter(i) |
    if exists(p.getTypeAnnotation()) then result = p.getTypeAnnotation().toString() else result = "?")
}

string paramText(Function f) {
  result = concat(int i | exists(f.getParameter(i)) | paramOne(f, i), ", " order by i)
  or (not exists(f.getParameter(0)) and result = "")
}

string retText(Function f) {
  if exists(f.getReturnTypeAnnotation()) then result = f.getReturnTypeAnnotation().toString() else result = ""
}

predicate isExportedFn(Function f) {
  exists(ExportDeclaration ed, string n | ed.exportsAs(f.(FunctionDeclStmt).getVariable(), n))
  or exists(ExportDeclaration ed, string n, VariableDeclarator vd |
       ed.exportsAs(vd.getBindingPattern().(VarDecl).getVariable(), n) and vd.getInit() = f)
}

from Function f
where isExportedFn(f) and f.getName() != ""
select f.getFile().getRelativePath(), f.getName(), paramText(f), retText(f)
`;

/** language → exported-signature query. Unbound languages fail loud (see below). */
export const SIGNATURE_QUERIES: Partial<Record<CodeqlLanguage, string>> = {
  javascript: SIGNATURE_QUERY_JS,
};

/**
 * The signature query for a language, or a loud error. Never returns an empty
 * result that a caller could read as "no signature changes" — an unbound
 * language must fail closed (the 1차 bug was a silent TS-only false-clean).
 */
export function signatureQuery(language: CodeqlLanguage): string {
  const q = SIGNATURE_QUERIES[language];
  if (!q) {
    const supported = Object.keys(SIGNATURE_QUERIES).join(', ');
    throw new Error(
      `CodeQL signature query not bound for language '${language}' (supported: ${supported})`,
    );
  }
  return q;
}

/** Normalized signature text: `name(params)` plus `: ret` when a return type exists. */
export function formatSignature(name: string, params: string, ret: string): string {
  return `${name}(${params})${ret.length > 0 ? `: ${ret}` : ''}`;
}

export interface ExportedSignature {
  file: string;
  symbol: string;
  signature: string;
}

/**
 * CSV rows (path, name, params, ret) → map keyed by `file::symbol`. Keying on the
 * file makes same-named exports in different files distinct identities.
 */
export function rowsToSignatureMap(rows: string[][]): Map<string, ExportedSignature> {
  const out = new Map<string, ExportedSignature>();
  for (const row of rows) {
    const [file, name, params, ret] = row;
    if (!file || !name) continue;
    out.set(`${file}::${name}`, {
      file,
      symbol: name,
      signature: formatSignature(name, params ?? '', ret ?? ''),
    });
  }
  return out;
}

/**
 * Signatures present in BOTH maps whose text differs. Added/deleted exports are
 * not signature-shape changes (O8) and are excluded.
 */
export function diffSignatureMaps(
  before: Map<string, ExportedSignature>,
  after: Map<string, ExportedSignature>,
): SignatureChange[] {
  const changes: SignatureChange[] = [];
  for (const [key, b] of before) {
    const a = after.get(key);
    if (a && a.signature !== b.signature) {
      changes.push({ file: b.file, symbol: b.symbol, before: b.signature, after: a.signature });
    }
  }
  return changes;
}

export interface ExtractSignaturesInput {
  repoRoot: string;
  sourceRoot: string;
  language: CodeqlLanguage;
  /** DB cache dir; built if absent (runRelationQuery handles create). */
  dbPath: string;
  /** Scratch dir for the query/bqrs/csv. */
  workDir: string;
  buildMode?: BuildMode;
  buildCommand?: string;
  binary?: string;
}

/** Run the signature query against one DB and return the exported-signature map. */
export async function extractSignatures(
  input: ExtractSignaturesInput,
  deps: RelationDeps,
): Promise<Map<string, ExportedSignature>> {
  const run: RunRelationInput = {
    repoRoot: input.repoRoot,
    sourceRoot: input.sourceRoot,
    language: input.language,
    dbPath: input.dbPath,
    workDir: input.workDir,
    query: signatureQuery(input.language),
    ...(input.buildMode ? { buildMode: input.buildMode } : {}),
    ...(input.buildCommand ? { buildCommand: input.buildCommand } : {}),
    ...(input.binary ? { binary: input.binary } : {}),
  };
  return rowsToSignatureMap(await runRelationQuery(run, deps));
}

export interface ScanSignatureInput {
  repoRoot: string;
  baseRef: string;
  language: CodeqlLanguage;
  /** Source root relative to the repo (e.g. 'src', '.'). Same in base worktree. */
  sourceRootRel: string;
  buildMode?: BuildMode;
  binary?: string;
}

/**
 * Diff exported signatures between a base ref and the current working tree.
 *
 * The base DB is keyed by the base sha and cached — a base worktree is only
 * checked out the first time that sha is analyzed. The after DB is built fresh
 * each scan so it reflects uncommitted changes (the change being evaluated),
 * then discarded. Both passes go through the same CodeQL query, so a non-TS
 * language with no binding fails loud rather than returning empty.
 */
export async function scanSignatureChanges(
  input: ScanSignatureInput,
  deps: RelationDeps,
): Promise<SignatureChange[]> {
  const baseSha = gitRevParse(input.repoRoot, input.baseRef);
  const cacheBase = join(input.repoRoot, '.ditto', 'cache', 'codeql');
  const baseCache = join(cacheBase, `${baseSha}-${input.language}`);
  const baseDb = join(baseCache, 'db');

  // before: reuse the cached base DB; only check out a worktree when it must be built.
  const needWorktree = !existsSync(baseDb);
  const worktree = join(cacheBase, 'worktrees', `${baseSha}-${input.language}`);
  if (needWorktree) addDetachedWorktree(input.repoRoot, worktree, baseSha);
  let before: Map<string, ExportedSignature>;
  try {
    before = await extractSignatures(
      {
        repoRoot: input.repoRoot,
        sourceRoot: join(needWorktree ? worktree : input.repoRoot, input.sourceRootRel),
        language: input.language,
        dbPath: baseDb,
        workDir: join(baseCache, 'q-sig'),
        ...(input.buildMode ? { buildMode: input.buildMode } : {}),
        ...(input.binary ? { binary: input.binary } : {}),
      },
      deps,
    );
  } finally {
    if (needWorktree) removeWorktree(input.repoRoot, worktree);
  }

  // after: current working tree, fresh DB (reflects uncommitted changes), discarded.
  const afterDir = join(cacheBase, `after-${process.pid}-${input.language}`);
  try {
    const after = await extractSignatures(
      {
        repoRoot: input.repoRoot,
        sourceRoot: join(input.repoRoot, input.sourceRootRel),
        language: input.language,
        dbPath: join(afterDir, 'db'),
        workDir: join(afterDir, 'q-sig'),
        ...(input.buildMode ? { buildMode: input.buildMode } : {}),
        ...(input.binary ? { binary: input.binary } : {}),
      },
      deps,
    );
    return diffSignatureMaps(before, after);
  } finally {
    await rm(afterDir, { recursive: true, force: true });
  }
}
