import type { AnalysisRequest, AnalyzerKind } from './analyzer';
import type { StaticAnalysisHost } from './provider';

interface FakeAnalyzerScript {
  // present tools return raw output; absent tools are simply omitted (probe → false).
  present?: Partial<Record<AnalyzerKind, unknown>>;
  // tools scripted to throw when invoked (present but failing).
  throws?: Partial<Record<AnalyzerKind, string>>;
}

/**
 * In-memory StaticAnalysisHost for unit-testing the A17 seam with NO live tool —
 * the analysis-layer parallel to seam/FakeHost. A tool is "present" iff it has a
 * scripted output or throw; everything else probes absent. Fully deterministic.
 * This is the exact wiring an ACG consumer (#90) test uses in place of a real
 * codeql/LSP binary.
 */
export class FakeStaticAnalysisHost implements StaticAnalysisHost {
  constructor(private readonly script: FakeAnalyzerScript = {}) {}

  probe(kind: AnalyzerKind): Promise<boolean> {
    const present =
      this.script.present?.[kind] !== undefined ||
      this.script.throws?.[kind] !== undefined;
    return Promise.resolve(present);
  }

  invoke(kind: AnalyzerKind, _request: AnalysisRequest): Promise<unknown> {
    const boom = this.script.throws?.[kind];
    if (boom !== undefined) throw new Error(boom);
    const out = this.script.present?.[kind];
    if (out === undefined) {
      // probe() guards this; a direct invoke on an absent tool fails loud.
      throw new Error(`FakeStaticAnalysisHost: ${kind} not scripted present`);
    }
    return Promise.resolve(out);
  }
}
