import { isAbsolute, resolve } from 'node:path';
import { sarifToViolationIds } from './codeql-provider';
import type { EvaluatorProvider } from './fitness-runner';

const CODEQL_SARIF_PREFIX = 'codeql-sarif:';

/**
 * Deterministic evaluator provider. Two deterministic sources, selected by
 * `evaluator.spec`:
 *  - `codeql-sarif:<path>` → parse the SARIF and project findings to normalized
 *    violation identities. A missing SARIF is fail-closed: skipped with a reason
 *    (never a fabricated pass — the caller must produce it first via `ditto codeql review`).
 *  - anything else → run `spec` as a shell command, one (caller-normalized)
 *    violation identity per stdout line.
 * Non-deterministic modes (llm_judged/executed) are not wired in v0 → skip+reason.
 *
 * fitness CLI(`ditto fitness run`)와 stop 훅(자동 트리거)이 공유한다.
 */
export function commandProvider(repoRoot: string): EvaluatorProvider {
  return {
    evaluate: async (fn) => {
      if (fn.evaluator.mode !== 'deterministic') {
        return {
          skipped: { reason: `${fn.evaluator.mode} provider not wired (v0: deterministic only)` },
          violationIds: [],
        };
      }
      const spec = fn.evaluator.spec;
      if (spec.startsWith(CODEQL_SARIF_PREFIX)) {
        const rel = spec.slice(CODEQL_SARIF_PREFIX.length).trim();
        const sarifPath = isAbsolute(rel) ? rel : resolve(repoRoot, rel);
        const file = Bun.file(sarifPath);
        if (!(await file.exists())) {
          return {
            skipped: {
              reason: `codeql-sarif source not found: ${sarifPath} (run ditto codeql review first)`,
            },
            violationIds: [],
          };
        }
        return { violationIds: sarifToViolationIds(await file.text()) };
      }
      const proc = Bun.spawnSync(['sh', '-c', spec], { cwd: repoRoot });
      const out = proc.stdout?.toString() ?? '';
      const violationIds = out
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return { violationIds };
    },
  };
}
