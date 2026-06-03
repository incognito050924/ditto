/**
 * ICL compiler — AST → { changeContract, fitnessFunctions } (30 §3 mappings).
 *
 * Targets B-only of the §4 fan-out: ChangeContract + FitnessFunction. Targets A
 * (agent-constraint text) and C (Change Map) are out of scope (D6).
 *
 * The emitted objects are validated through the Zod schemas (D2 — Zod is the
 * source of truth; no hand-authored JSON Schema). A Zod failure becomes an
 * IclError{kind:'schema'}.
 */

import type { AcgChangeContract, AcgScopeRef } from '~/schemas/acg-change-contract';
import { acgChangeContract } from '~/schemas/acg-change-contract';
import type { AcgFitnessFunction } from '~/schemas/acg-fitness-function';
import { acgFitnessFunction } from '~/schemas/acg-fitness-function';
import type {
  IclCadence,
  IclCheck,
  IclFitness,
  IclProgram,
  IclScopeKind,
  IclScopeRef,
} from './ast';
import { parse } from './parser';
import { IclParseError } from './parser';
import { staticCheck } from './static-check';
import { IclTokenizeError } from './tokenizer';

export interface IclCompileEnv {
  work_item_id: string;
  produced_by: 'agent' | 'user';
  produced_at: string;
  judge_model_version: string;
}

export type IclError =
  | { kind: 'parse'; message: string; line?: number }
  | { kind: 'static'; rule: 1 | 2 | 3 | 4; severity: 'error' | 'warning'; message: string }
  | { kind: 'schema'; message: string; path: string };

export type CompileResult =
  | {
      ok: true;
      changeContract: AcgChangeContract;
      fitnessFunctions: AcgFitnessFunction[];
      warnings?: IclError[];
    }
  | { ok: false; errors: IclError[] };

const SCOPE_KIND_MAP: Record<IclScopeKind, AcgScopeRef['kind']> = {
  path: 'path',
  glob: 'glob',
  symbol: 'symbol',
  surface: 'public_surface',
  layer: 'layer',
};

/** `as "x"` alias + `# note` merge into a single scopeRef.note (lossless, §3). */
function mergeNote(scope: IclScopeRef): string | undefined {
  const parts: string[] = [];
  if (scope.alias !== undefined) parts.push(scope.alias);
  if (scope.note !== undefined) parts.push(scope.note);
  return parts.length > 0 ? parts.join(' — ') : undefined;
}

function mapScopeRef(scope: IclScopeRef): AcgScopeRef {
  const note = mergeNote(scope);
  const out: AcgScopeRef = { kind: SCOPE_KIND_MAP[scope.kind], ref: scope.ref };
  if (note !== undefined) out.note = note;
  return out;
}

function mapCadence(when: IclCadence): {
  per_change: boolean;
  periodic: 'none' | 'daily' | 'weekly' | 'on_release';
} {
  switch (when.mode) {
    case 'per_change':
      return { per_change: true, periodic: 'none' };
    case 'periodic':
      return { per_change: false, periodic: when.frequency };
    case 'both':
      return { per_change: true, periodic: when.frequency };
  }
}

function buildEvaluator(
  check: IclCheck,
  judgeModelVersion: string,
): AcgFitnessFunction['evaluator'] {
  if (check.mode === 'judge') {
    return {
      mode: 'llm_judged',
      spec: check.spec,
      reproducibility: {
        model_version: judgeModelVersion,
        votes: 3,
        tie_break: 'fail_closed',
        input_fixing: '변경 diff 전체',
      },
    };
  }
  // cmd | query → deterministic, spec = raw string
  return { mode: 'deterministic', spec: check.spec };
}

function fitnessId(name: string): string {
  return name;
}

function buildFitness(f: IclFitness, env: IclCompileEnv): unknown {
  return {
    schema_version: '0.1.0',
    kind: 'acg.fitness-function.v1',
    produced_by: env.produced_by,
    produced_at: env.produced_at,
    id: fitnessId(f.name),
    statement: f.statement,
    fitness_kind: f.kind,
    evaluator: buildEvaluator(f.check, env.judge_model_version),
    cadence: mapCadence(f.when),
    on_violation: f.on_violation,
    source_change: env.work_item_id,
  };
}

function buildChangeContract(program: IclProgram, env: IclCompileEnv): unknown {
  const { intent } = program;
  return {
    schema_version: '0.1.0',
    kind: 'acg.change-contract.v1',
    work_item_id: env.work_item_id,
    produced_by: env.produced_by,
    produced_at: env.produced_at,
    purpose: intent.purpose,
    allowed_scope: intent.allow.map(mapScopeRef),
    forbidden_scope: intent.forbid.map(mapScopeRef),
    invariants: intent.invariants.map((inv) => ({
      statement: inv.statement,
      promotable: inv.promote,
    })),
    acceptance: intent.acceptance.map((a) => ({
      criterion: a.criterion,
      evidence_kind: a.evidence,
    })),
    decision_ref: intent.meta.decision ?? null,
    risk_default: intent.meta.risk ?? 'low',
  };
}

export function compileIcl(source: string, env: IclCompileEnv): CompileResult {
  // 1. parse (tokenize + parse). Single error on first malformed token (D6).
  let program: IclProgram;
  try {
    program = parse(source);
  } catch (err) {
    if (err instanceof IclParseError || err instanceof IclTokenizeError) {
      return {
        ok: false,
        errors: [
          err.line !== undefined
            ? { kind: 'parse', message: err.message, line: err.line }
            : { kind: 'parse', message: err.message },
        ],
      };
    }
    throw err;
  }

  // 2. static checks (before emit).
  const { errors: staticErrors, warnings: staticWarnings } = staticCheck(program);
  if (staticErrors.length > 0) {
    return {
      ok: false,
      errors: staticErrors.map((e) => ({
        kind: 'static',
        rule: e.rule,
        severity: e.severity,
        message: e.message,
      })),
    };
  }

  // 3. map → emit candidate objects, then validate via Zod (D2 SoT).
  const contractParsed = acgChangeContract.safeParse(buildChangeContract(program, env));
  if (!contractParsed.success) {
    return { ok: false, errors: zodErrors(contractParsed.error) };
  }

  const fitnessFunctions: AcgFitnessFunction[] = [];
  for (const f of program.fitness) {
    const parsed = acgFitnessFunction.safeParse(buildFitness(f, env));
    if (!parsed.success) {
      return { ok: false, errors: zodErrors(parsed.error) };
    }
    fitnessFunctions.push(parsed.data);
  }

  const warnings: IclError[] = staticWarnings.map((w) => ({
    kind: 'static',
    rule: w.rule,
    severity: w.severity,
    message: w.message,
  }));

  return warnings.length > 0
    ? { ok: true, changeContract: contractParsed.data, fitnessFunctions, warnings }
    : { ok: true, changeContract: contractParsed.data, fitnessFunctions };
}

function zodErrors(error: {
  issues: { path: (string | number)[]; message: string }[];
}): IclError[] {
  return error.issues.map((issue) => ({
    kind: 'schema',
    message: issue.message,
    path: issue.path.join('.'),
  }));
}
