/**
 * ICL (Intent-Change Language) AST types.
 *
 * Mirrors the EBNF in reports/design/agentic-governance/30-intent-change-dsl.md §2.
 * The parser builds these nodes; compile.ts maps them onto ACG schemas (§3).
 *
 * Scope boundary (D6): this AST covers ICL program structure only. It does not
 * model targets A (agent-constraint text) or C (Change Map); those are not part
 * of this compiler.
 */

export type IclScopeKind = 'path' | 'glob' | 'symbol' | 'surface' | 'layer';
export type IclEvidenceKind = 'test' | 'build' | 'log' | 'diff' | 'screen' | 'manual' | 'e2e';
export type IclRiskLevel = 'low' | 'medium' | 'high';
export type IclFitnessKind =
  | 'architectural'
  | 'dependency'
  | 'semantic'
  | 'coverage'
  | 'consistency'
  | 'performance'
  | 'duplication'
  | 'complexity'
  | 'user_journey';
export type IclFrequency = 'daily' | 'weekly' | 'on_release';
export type IclViolationAction = 'block' | 'warn' | 'track';

export interface IclScopeRef {
  kind: IclScopeKind;
  ref: string;
  /** `as "<alias>"` */
  alias?: string;
  /** `# <note>` */
  note?: string;
  /** Source line of the scope_kind keyword, for diagnostics. */
  line: number;
}

export interface IclInvariant {
  statement: string;
  promote: boolean;
}

export interface IclAcceptance {
  criterion: string;
  evidence: IclEvidenceKind;
}

export interface IclMeta {
  risk?: IclRiskLevel;
  decision?: string;
  /** `rationale` is parsed then dropped (Change Map only, §3); kept here for fidelity. */
  rationale?: string;
}

export interface IclIntent {
  purpose: string;
  allow: IclScopeRef[];
  forbid: IclScopeRef[];
  invariants: IclInvariant[];
  acceptance: IclAcceptance[];
  meta: IclMeta;
}

export type IclCheck =
  | { mode: 'cmd'; spec: string }
  | { mode: 'query'; spec: string }
  | { mode: 'judge'; spec: string };

export type IclCadence =
  | { mode: 'per_change' }
  | { mode: 'periodic'; frequency: IclFrequency }
  | { mode: 'both'; frequency: IclFrequency };

export interface IclFitness {
  name: string;
  statement: string;
  kind: IclFitnessKind;
  check: IclCheck;
  when: IclCadence;
  on_violation: IclViolationAction;
}

export interface IclProgram {
  intentTitle: string;
  intent: IclIntent;
  fitness: IclFitness[];
}
