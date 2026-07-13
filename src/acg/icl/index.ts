/**
 * ICL (Intent-Change Language) compiler — public entry.
 *
 * Compiles a single `.icl` source into ACG ChangeContract + FitnessFunction[]
 * (targets B). Targets A (agent constraints) and C
 * (Change Map) are intentionally out of scope (D6).
 */

export type {
  CompileResult,
  IclCompileEnv,
  IclError,
} from './compile';
export { compileIcl } from './compile';
