import type { AcgReviewFile, AcgReviewGraph } from '~/schemas/acg-review-graph';
import { acgReviewGraph } from '~/schemas/acg-review-graph';
import type { ReviewerOutput } from '~/schemas/reviewer-output';

/**
 * ReviewGraph ↔ reviewer-output adapter (ACG binding D3).
 *
 * This projects a DITTO `reviewer-output` into the ACG `acg_review` view
 * (`acg.review-graph.v1`). Per D3 it ONLY READS the reviewer-output type — the
 * acg_review object is a SEPARATE artifact; reviewer-output is never mutated and
 * its schema is untouched.
 *
 * Binding rules (ReviewGraph←reviewer-output table):
 *  - finding.file        → files[].path
 *  - finding.severity    → files[].risk (critical/high→high, medium→medium, info/low→low)
 *  - finding.reason      → files[].risk_reason
 *  - unverified[]        → files[] entries with unresolved=true (OBJ-53: a flag,
 *                          NOT an evidence.kind=unresolved)
 *  - human_review_set    → derived view: files where risk==='high' OR unresolved===true
 */

/** finding.severity → ACG risk (위험도 규칙). */
function severityToRisk(
  severity: ReviewerOutput['findings'][number]['severity'],
): AcgReviewFile['risk'] {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'high';
    case 'medium':
      return 'medium';
    default:
      return 'low';
  }
}

/** Identity used in human_review_set: path, else journey_id. */
function fileIdentity(file: AcgReviewFile): string | undefined {
  return file.path ?? file.journey_id;
}

/**
 * Project a reviewer-output into the acg_review view. Thin pure function, no I/O.
 * The returned object is validated against `acgReviewGraph` before return.
 */
export function projectReviewerOutputToAcgReview(output: ReviewerOutput): AcgReviewGraph {
  // finding.file is optional in reviewer-output; the schema requires a path for
  // non-journey files, so drop findings without a location (they cannot be
  // placed in the review graph as a file entry).
  const findingFiles = output.findings
    .filter((finding): finding is typeof finding & { file: string } => finding.file !== undefined)
    .map((finding) => ({
      path: finding.file,
      risk: severityToRisk(finding.severity),
      risk_reason: finding.reason,
      unresolved: false,
    }));

  // unverified[] → files with unresolved=true (OBJ-53): evidence-absence flag,
  // never an evidence.kind. These carry no evidence object at all. The
  // unverified `item` (what was not verified) becomes the file path identity.
  const unresolvedFiles = output.unverified.map((u) => ({
    path: u.item,
    risk: 'low' as const,
    risk_reason: u.reason,
    unresolved: true,
  }));

  const draft = {
    kind: 'acg.review-graph.v1' as const,
    files: [...findingFiles, ...unresolvedFiles],
    human_review_set: [] as string[],
  };

  // human_review_set: derived high-risk/unresolved exception view (path|journey_id).
  const parsed = acgReviewGraph.parse(draft);
  const reviewSet: string[] = [];
  for (const file of parsed.files) {
    if (file.risk === 'high' || file.unresolved === true) {
      const id = fileIdentity(file);
      if (id !== undefined && !reviewSet.includes(id)) {
        reviewSet.push(id);
      }
    }
  }

  return acgReviewGraph.parse({ ...draft, human_review_set: reviewSet });
}
