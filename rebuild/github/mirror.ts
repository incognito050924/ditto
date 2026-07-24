import type { CompletionContract } from '../schemas/completion-contract';
import type { RepoCoord } from './coord';
import type { MirrorWriter } from './gh';

/**
 * Layer 3 of the SoT 3-layer contract (ADR-20260628 D3): the completion mirror.
 * Completion is a ditto-evidence verdict; the mirror publishes it ONE WAY —
 * ditto → GitHub — as a result comment on the linked issue. It NEVER pulls
 * GitHub state back into the verdict, and it NEVER writes the backlog-
 * authoritative state (priority / board status / issue open-closed): the injected
 * `MirrorWriter` exposes only `postCompletionComment`, so that is the single
 * write this layer can make. The board/claim conveniences of the old
 * implementation are deliberately out of scope here.
 */

export interface MirrorDeps {
  writer: MirrorWriter;
}

export interface MirrorInput {
  /** The linked issue coordinate, or null when the work item is unlinked. */
  coord: RepoCoord | null;
  /** The ditto-side completion — the SOLE source of the mirror payload. */
  completion: CompletionContract;
}

export interface MirrorResult {
  commentPosted: boolean;
  notices: string[];
}

/**
 * Build the PUBLIC-SAFE result-summary comment body from ONLY safe completion
 * fields — the aggregate verdict and each criterion's id + verdict. It
 * deliberately omits the internal `work_item_id`, criterion statement text, and
 * evidence path/hash refs, so nothing internal leaks onto a (possibly public /
 * cross-repo) issue. Pure — derived solely from the ditto completion.
 */
export function buildResultSummary(completion: CompletionContract): string {
  const lines = [
    `DITTO completion mirror — final verdict: ${completion.final_verdict}`,
    '',
    'Per-criterion:',
    ...completion.criteria.map((c) => `- ${c.criterion_id}: ${c.verdict}`),
  ];
  return lines.join('\n');
}

/**
 * Mirror one completion onto its linked GitHub issue. Skips (with a notice) when
 * unlinked; degrades to a notice on a write failure (ADR-0018). The payload is
 * derived purely from `input.completion` — the GitHub side can neither change it
 * nor, structurally, be written to for anything but this comment.
 */
export function mirrorCompletion(deps: MirrorDeps, input: MirrorInput): MirrorResult {
  if (input.coord === null) {
    return {
      commentPosted: false,
      notices: ['No linked GitHub issue on the work item — completion mirror skipped.'],
    };
  }
  const body = buildResultSummary(input.completion);
  const posted = deps.writer.postCompletionComment(input.coord, body);
  if (!posted.ok) {
    return {
      commentPosted: false,
      notices: [`Completion mirror degraded (${posted.reason}) — comment not posted.`],
    };
  }
  return { commentPosted: true, notices: [] };
}
