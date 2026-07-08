import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RiskAxes } from '~/core/gates';
import { type FinalizeResult, finalizeInterview } from '~/core/interview-driver';
import { compileSpecDoc } from '~/core/spec-doc';
import { PrismStore } from './store';

/**
 * The prism → deep-interview compile (wi_260707oi1, node oi1-compile-wiring).
 *
 * Prism refinement emits an isomorphic `.ditto/specs` design document; CONFIRMATION
 * compiles that document into intent.json THROUGH the single writer
 * (`finalizeInterview`) and binds the result to the document by digest, so a
 * post-finalize edit of a compile-input section (요약·목표·비목표·완료 조건·위험)
 * trips the preserved autopilot freshness gate (ac-6).
 *
 * Single-writer invariant (ac-7): this NEVER writes intent.json itself — it builds
 * the finalize payload and delegates to `finalizeInterview`, which stays the sole
 * IntentStore.write for the deep-interview path. No second writer is added.
 *
 * Idempotent / safe re-entry (design point 4): a second call recompiles the current
 * document and re-finalizes (finalizeInterview is itself idempotent), so re-running
 * after a partial state is a safe resume, not a divergent write path.
 */
export interface FinalizeFromDesignDocInput {
  workItemId: string;
  /** Repo-relative design doc path; defaults to `.ditto/specs/<wi>-design.md`. */
  docPath?: string;
  /** The user's confirmation of the refined design (the 확정 half of the finalize gate). */
  userConfirmation: { confirmed: boolean; statement: string; confirmed_at?: string };
  /** Risk axes of the planned mutation (drives the approval gate); defaults to all-false. */
  risk?: RiskAxes;
  approvedSource?: 'approved_spec' | 'issue' | 'prd' | 'user';
  now?: Date;
}

export type FinalizeFromDesignDocResult =
  | { status: 'compile_rejected'; reasons: string[] }
  | FinalizeResult;

export async function finalizeFromDesignDoc(
  repoRoot: string,
  input: FinalizeFromDesignDocInput,
): Promise<FinalizeFromDesignDocResult> {
  const docPath = input.docPath ?? `.ditto/specs/${input.workItemId}-design.md`;
  let markdown: string;
  try {
    markdown = await readFile(join(repoRoot, docPath), 'utf8');
  } catch {
    return { status: 'compile_rejected', reasons: [`design document not found: ${docPath}`] };
  }
  const compiled = compileSpecDoc(markdown);
  if (compiled.status !== 'compiled') {
    return { status: 'compile_rejected', reasons: compiled.reasons };
  }

  // Carry prism-surfaced risks into the pre-mortem seed (design point 4): the still-open
  // issue-map nodes are surviving risk, merged into intent.unknowns so the plan-stage
  // coverage sweep sees them. Fail-open — no issue map means no extra seed.
  const prismRisks = await collectOpenPrismRiskLabels(repoRoot, input.workItemId);
  const seen = new Set<string>();
  const unknowns = [...compiled.fields.unknowns, ...prismRisks].filter((u) => {
    const key = u.trim();
    if (key.length === 0 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return finalizeInterview(repoRoot, {
    workItemId: input.workItemId,
    payload: {
      goal: compiled.fields.goal,
      in_scope: compiled.fields.in_scope,
      out_of_scope: compiled.fields.out_of_scope,
      acceptance_criteria: compiled.fields.acceptance_criteria,
      unknowns,
      follow_up_candidates: [],
      question_policy: 'ask_only_if_user_only_can_answer',
      risk: input.risk ?? { non_local: false, irreversible: false, unaudited: false },
      user_confirmation: input.userConfirmation,
      ...(input.approvedSource ? { approved_source: input.approvedSource } : {}),
    },
    sourceDigest: { doc_path: docPath, sha256: compiled.digest },
    ...(input.now ? { now: input.now } : {}),
  });
}

/** Still-open prism issue-map node labels — surviving risk to carry into the seed. */
async function collectOpenPrismRiskLabels(repoRoot: string, workItemId: string): Promise<string[]> {
  const store = new PrismStore(repoRoot);
  if (!(await store.exists(workItemId))) return [];
  const map = await store.getMap(workItemId);
  return map.tree.nodes
    .filter((n) => n.state === 'open' && n.id !== map.tree.root_id)
    .map((n) => n.label);
}
