/**
 * CodeQL → ACG ledger orchestration — the turnkey "CodeQL provider 연결".
 *
 * Wires the existing deterministic pieces end to end:
 *   doctor gate (fail-closed) → runner (analyze → SARIF + evidence) →
 *   assembleReviewerOutput → projectReviewerOutputToAcgReview → acg-review.json
 * so a high-severity CodeQL finding lands in the risk ledger the Stop gate reads
 * (`acgReviewForcesContinuation`), blocking completion until it carries evidence.
 *
 * Deps are injected so the whole pipeline is testable with a fixture SARIF and
 * no CodeQL binary; the CLI supplies real (Bun-backed) deps.
 *
 * SAFETY (why doctor 先行): an empty/incomplete extraction reads as "clean" and a
 * misconfigured run as false-positive — either poisons a BLOCKING gate. So if the
 * doctor pass finds any HIGH issue (no CLI, no source, compiled-lang build
 * unverified), we DO NOT analyze and DO NOT write a ledger; the caller must fix
 * the precondition first. This is the reviewer-invoked path only — auto-running
 * CodeQL inside the autonomous Stop loop is deliberately out of scope.
 */
import { projectReviewerOutputToAcgReview } from '~/acg/review/acg-review-adapter';
import type { AcgReviewGraph } from '~/schemas/acg-review-graph';
import { type ReviewerOutput, reviewerOutput } from '~/schemas/reviewer-output';
import { type CodeqlDoctorDeps, type CodeqlDoctorReport, inspectCodeqlTarget } from './doctor';
import { type CodeqlReviewDeps, type RunCodeqlReviewInput, runCodeqlReview } from './review';
import { assembleReviewerOutput } from './sarif-adapter';

export interface CodeqlLedgerDeps extends CodeqlReviewDeps, CodeqlDoctorDeps {
  /** Generate a reviewer-output id (rv_…). */
  genReviewId: () => Promise<string>;
  /** Persist the assembled reviewer-output (audit trail; input to the producer). */
  persistReviewerOutput: (workItemId: string, output: ReviewerOutput) => Promise<void>;
  /** Persist the projected acg_review ledger (.ditto/local/work-items/<wi>/acg-review.json). */
  persistLedger: (workItemId: string, graph: AcgReviewGraph) => Promise<void>;
}

export interface CodeqlReviewToLedgerInput extends RunCodeqlReviewInput {
  /** A clean build was reproduced (unblocks compiled languages in the doctor gate). */
  buildVerified?: boolean;
}

export interface CodeqlReviewToLedgerResult {
  /** True when the doctor gate blocked: no analysis ran, no ledger written. */
  gated: boolean;
  doctor: CodeqlDoctorReport;
  findings: number;
  fromCache: boolean;
  verdict: ReviewerOutput['verdict'] | null;
  /** Files in the ledger that block completion (high-risk without evidence). */
  highRiskWithoutEvidence: number;
  ledgerWritten: boolean;
}

/** Doctor findings that mean the analysis itself cannot be trusted. */
function doctorBlocks(report: CodeqlDoctorReport): boolean {
  return report.findings.some((f) => f.severity === 'high');
}

export async function runCodeqlReviewToLedger(
  input: CodeqlReviewToLedgerInput,
  deps: CodeqlLedgerDeps,
): Promise<CodeqlReviewToLedgerResult> {
  // 1. Doctor 先行 (fail-closed): never feed a BLOCKING gate from an untrusted run.
  const doctor = await inspectCodeqlTarget(
    { sourceRoot: input.sourceRoot, buildVerified: input.buildVerified },
    deps,
  );
  if (doctorBlocks(doctor)) {
    return {
      gated: true,
      doctor,
      findings: 0,
      fromCache: false,
      verdict: null,
      highRiskWithoutEvidence: 0,
      ledgerWritten: false,
    };
  }

  // 2. Analyze (records the raw SARIF as artifact evidence) — reuses review.ts.
  const { result } = await runCodeqlReview(input, deps);

  // 3. Assemble a complete reviewer-output and validate it.
  const assembled = assembleReviewerOutput(result.findings, {
    workItemId: input.workItemId,
    id: await deps.genReviewId(),
    startedAt: deps.now(),
  });
  const output = reviewerOutput.parse(assembled);
  await deps.persistReviewerOutput(input.workItemId, output);

  // 4. Project deterministically into the acg_review ledger and persist it.
  const graph = projectReviewerOutputToAcgReview(output);
  await deps.persistLedger(input.workItemId, graph);

  const highRiskWithoutEvidence = graph.files.filter(
    (f) => f.risk === 'high' && f.evidence === undefined,
  ).length;

  return {
    gated: false,
    doctor,
    findings: result.findings.length,
    fromCache: result.fromCache,
    verdict: output.verdict,
    highRiskWithoutEvidence,
    ledgerWritten: true,
  };
}
