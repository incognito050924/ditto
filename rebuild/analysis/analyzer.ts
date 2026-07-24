import { z } from 'zod';

/**
 * The three OPTIONAL static-analysis tools A17 wraps (issue #88). Per ADR-0006
 * CodeQL is the single deterministic extraction engine (relations / dataflow);
 * lsp and semantic are the other optional analyzers. All three obey the SAME
 * ADR-0018 graceful-degradation contract: their absence degrades to an explicit
 * `degraded` result — never a throw, never a false `ok` "all clear".
 */
export const analyzerKind = z.enum(['codeql', 'lsp', 'semantic']);
export type AnalyzerKind = z.infer<typeof analyzerKind>;

export const findingSeverity = z.enum(['error', 'warning', 'note']);
export type FindingSeverity = z.infer<typeof findingSeverity>;

/**
 * One static fact/diagnostic: a query/rule hit, an import edge violation, an LSP
 * diagnostic. Kept engine-neutral so an ACG consumer (#90) reads one shape
 * regardless of which analyzer produced it.
 */
export const analysisFinding = z
  .object({
    rule: z.string().min(1), // query id / diagnostic code / edge rule
    severity: findingSeverity,
    path: z.string().min(1),
    line: z.number().int().nonnegative().optional(),
    message: z.string().min(1),
  })
  .strict();
export type AnalysisFinding = z.infer<typeof analysisFinding>;

/** What the consumer asks the analyzer to scan — a change scoped to files. */
export const analysisRequest = z
  .object({
    // repo-relative files the change touches; the analyzer scopes to these.
    files: z.array(z.string().min(1)).min(1),
    // optional query/ruleset selector the host resolves to a real query pack.
    ruleset: z.string().min(1).optional(),
  })
  .strict();
export type AnalysisRequest = z.infer<typeof analysisRequest>;

/** Raw findings a present tool returns; validated at the seam boundary. */
export const rawAnalyzerOutput = z
  .object({ findings: z.array(analysisFinding) })
  .strict();
export type RawAnalyzerOutput = z.infer<typeof rawAnalyzerOutput>;

/**
 * Why a result is degraded rather than a real scan:
 *  - tool_absent: the probe reports the external tool is not installed/usable.
 *  - tool_error:  the tool was invoked but threw, timed out, or returned output
 *    the seam could not validate. Either way the STAGE must not crash.
 */
export const degradedReason = z.enum(['tool_absent', 'tool_error']);
export type DegradedReason = z.infer<typeof degradedReason>;

export const analysisStatus = z.enum(['ok', 'degraded']);
export type AnalysisStatus = z.infer<typeof analysisStatus>;

/**
 * The discriminated result an ACG consumer reads. The whole ADR-0018 invariant
 * lives in this union: a `degraded` result is structurally distinct from an
 * `ok` result with zero findings ("clean"), so a caller can NEVER mistake a
 * missing tool for a clean bill of health.
 */
export const analysisResult = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('ok'),
      analyzer: analyzerKind,
      findings: z.array(analysisFinding),
    })
    .strict(),
  z
    .object({
      status: z.literal('degraded'),
      analyzer: analyzerKind,
      reason: degradedReason,
      detail: z.string().min(1),
    })
    .strict(),
]);
export type AnalysisResult = z.infer<typeof analysisResult>;
