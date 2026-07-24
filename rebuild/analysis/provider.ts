import {
  type AnalysisRequest,
  type AnalysisResult,
  type AnalyzerKind,
  rawAnalyzerOutput,
} from './analyzer';

/**
 * The injected access to an OPTIONAL static-analysis tool. The seam depends only
 * on this interface — never on a real `codeql`/LSP subprocess — so the whole
 * A17 contract is unit-testable with no live binary (ADR-0018, mirroring the
 * host-adapter seam pattern). A host wires `probe`/`invoke` to real tools; tests
 * inject stubs. `invoke` MAY throw / return junk — runAnalysis contains that.
 */
export interface StaticAnalysisHost {
  probe(kind: AnalyzerKind): Promise<boolean>;
  invoke(kind: AnalyzerKind, request: AnalysisRequest): Promise<unknown>;
}

/**
 * The A17 seam an ACG consumer (#90) calls. Runs one optional analyzer over a
 * change and ALWAYS returns a well-formed AnalysisResult — the ADR-0018
 * invariant: a missing or failing tool degrades to an explicit `degraded`
 * result, never a throw and never a false `ok`.
 */
export async function runAnalysis(
  kind: AnalyzerKind,
  request: AnalysisRequest,
  host: StaticAnalysisHost,
): Promise<AnalysisResult> {
  // Probe first: `probe` is the availability check (mirrors the old cliAvailable /
  // resolveServerPath idiom). A real host wires this to a subprocess (`which
  // codeql`), so it CAN throw — contain it with the same D1 discipline as the
  // invoke boundary below. A convention that "probe must not throw" is exactly
  // the silently-broken convention ADR-0018 D3 rejects.
  let present: boolean;
  try {
    present = Boolean(await host.probe(kind));
  } catch (err) {
    return {
      status: 'degraded',
      analyzer: kind,
      reason: 'tool_error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  if (!present) {
    return {
      status: 'degraded',
      analyzer: kind,
      reason: 'tool_absent',
      detail: `${kind} is not available; scan skipped (unverified, not clean)`,
    };
  }
  // Present path: the raw tool boundary MAY throw (old runner/relations fail-loud
  // idiom) or return output we cannot trust. Contain both here so the invariant
  // holds — a failing tool degrades to tool_error, it never crashes the stage
  // and never becomes a false `ok`.
  try {
    const raw = rawAnalyzerOutput.parse(await host.invoke(kind, request));
    return { status: 'ok', analyzer: kind, findings: raw.findings };
  } catch (err) {
    return {
      status: 'degraded',
      analyzer: kind,
      reason: 'tool_error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * The three-way an ACG consumer (#90) routes on, re-expressing the old fitness
 * `outcome: skip|pass|fail`:
 *  - unverified: tool degraded (absent/failed) — governance must NOT treat this
 *    as a clean bill of health; the AC stays honestly unverified (ADR-0018 D2).
 *  - clean:      the tool ran and found nothing — a real pass.
 *  - findings:   the tool ran and produced violations to act on.
 * Making this a total function over AnalysisResult is what structurally forbids
 * a `degraded` result from ever collapsing into `clean`.
 */
export type AnalysisDisposition = 'unverified' | 'clean' | 'findings';

export function analysisDisposition(
  result: AnalysisResult,
): AnalysisDisposition {
  if (result.status === 'degraded') return 'unverified';
  return result.findings.length === 0 ? 'clean' : 'findings';
}

/** True only for a genuine clean scan — never for a degraded (absent) tool. */
export function isClean(result: AnalysisResult): boolean {
  return analysisDisposition(result) === 'clean';
}

/** True when the tool was absent or failed; the caller owes honest unverified. */
export function isDegraded(result: AnalysisResult): boolean {
  return result.status === 'degraded';
}
