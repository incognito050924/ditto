/**
 * CodeQL taint finding → Dataflow Definition-of-Done (WI-5).
 *
 * A CodeQL taint result carries a source→sink dataflow path. This module lifts
 * that path into a *verifiable proposition* of what closes the finding — not a
 * content-free "tests pass", but: GIVEN untrusted input at the source, WHEN it
 * reaches the sink, THEN a sanitizer/barrier must break the path. The `oracle`
 * names the exact source→sink positions the proof must address.
 *
 * Pure (no IO). Only findings that actually carry a dataflow path get a DoD;
 * generic (non-taint) findings return null — we do not over-apply a dataflow
 * proposition to a structural rule match.
 */
import type { CodeqlFinding, DataflowStep } from './sarif';

/** A verifiable Definition-of-Done proposition for a CodeQL taint finding. */
export interface DataflowDoD {
  /** Precondition: untrusted input enters at the source. */
  given: string;
  /** Trigger: the value reaches the sensitive sink along the tracked path. */
  when: string;
  /** Obligation: the source→sink path is broken by a sanitizer/barrier. */
  then: string;
  /** What proving the DoD must address: source→sink positions. */
  oracle: string;
  rule_id: string;
}

/** "file:line" for a dataflow step (line omitted when absent). */
function pos(step: DataflowStep): string {
  return step.startLine != null ? `${step.file}:${step.startLine}` : step.file;
}

/**
 * Build a DataflowDoD for a finding that carries a dataflow path; null otherwise.
 * source = first step, sink = last step.
 */
export function toDataflowDoD(f: CodeqlFinding): DataflowDoD | null {
  const first = f.dataflow[0];
  const last = f.dataflow[f.dataflow.length - 1];
  if (first === undefined || last === undefined) return null;
  const source = pos(first);
  const sink = pos(last);
  return {
    given: `Untrusted input enters at the source ${source}.`,
    when: `The value reaches the sensitive sink ${sink} along the tracked dataflow path (${f.ruleId}).`,
    // biome-ignore lint/suspicious/noThenProperty: GIVEN/WHEN/THEN DoD vocabulary; plain data field, never a thenable.
    then: 'The source→sink path is broken by a validated sanitizer/barrier, or the source is proven trusted.',
    oracle: `${source} → ${sink}`,
    rule_id: f.ruleId,
  };
}

/** Map a batch, dropping findings without a dataflow path. */
export function toDataflowDoDs(findings: CodeqlFinding[]): DataflowDoD[] {
  return findings.map(toDataflowDoD).filter((d): d is DataflowDoD => d !== null);
}
