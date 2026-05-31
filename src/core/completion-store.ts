import { join } from 'node:path';
import type { z } from 'zod';
import type { declarerRole, evidenceRef, verdict } from '~/schemas/common';
import { type CompletionContract, completionContract } from '~/schemas/completion-contract';
import type { WorkItem } from '~/schemas/work-item';
import { readJson, writeJson } from './fs';

type Verdict = z.infer<typeof verdict>;
type EvidenceRef = z.infer<typeof evidenceRef>;
type DeclarerRole = z.infer<typeof declarerRole>;

/**
 * Build a completion contract from verifier output (M3.2). Deterministic
 * assembly: one acceptance entry per work-item criterion (so the AC set matches
 * exactly and `completionGate` cannot trip on missing/extra/duplicate), and
 * `final_verdict` derived — pass only when every criterion passes and no in-scope
 * item is unverified.
 */
export interface CompletionInput {
  workItem: WorkItem;
  declaredBy: DeclarerRole;
  summary: string;
  /** Per-criterion verdicts keyed by criterion id; missing ids default to unverified. */
  verdicts: Array<{
    criterion_id: string;
    verdict: Verdict;
    evidence?: EvidenceRef[];
    notes?: string;
  }>;
  verifications?: CompletionContract['verifications'];
  unverified?: CompletionContract['unverified'];
  remainingRisks?: string[];
  nextHandoffPath?: string;
  now?: Date;
}

function deriveFinalVerdict(
  acceptance: CompletionContract['acceptance'],
  unverified: NonNullable<CompletionInput['unverified']>,
): Verdict {
  const hasInScopeUnverified = unverified.some((u) => !u.out_of_scope);
  if (acceptance.every((a) => a.verdict === 'pass') && !hasInScopeUnverified) return 'pass';
  if (acceptance.some((a) => a.verdict === 'fail')) return 'fail';
  if (acceptance.some((a) => a.verdict === 'partial')) return 'partial';
  return 'unverified';
}

export function buildCompletion(input: CompletionInput): CompletionContract {
  const byId = new Map(input.verdicts.map((v) => [v.criterion_id, v]));
  const acceptance = input.workItem.acceptance_criteria.map((c) => {
    const provided = byId.get(c.id);
    return {
      criterion_id: c.id,
      verdict: provided?.verdict ?? ('unverified' as Verdict),
      evidence: provided?.evidence ?? [],
      ...(provided?.notes ? { notes: provided.notes } : {}),
    };
  });
  const unverified = input.unverified ?? [];
  const finalVerdict = deriveFinalVerdict(acceptance, unverified);

  const candidate = {
    schema_version: '0.1.0' as const,
    work_item_id: input.workItem.id,
    declared_by: input.declaredBy,
    declared_at: (input.now ?? new Date()).toISOString(),
    summary: input.summary,
    changed_files: input.workItem.changed_files,
    acceptance,
    verifications: input.verifications ?? [],
    unverified,
    remaining_risks: input.remainingRisks ?? [],
    // Non-pass requires a handoff path (schema refine); default if not provided.
    ...(finalVerdict === 'pass'
      ? {}
      : {
          next_handoff_path:
            input.nextHandoffPath ?? `.ditto/work-items/${input.workItem.id}/handoff.md`,
        }),
    final_verdict: finalVerdict,
  };
  return completionContract.parse(candidate);
}

export class CompletionStore {
  constructor(public readonly repoRoot: string) {}

  private path(workItemId: string): string {
    return join(this.repoRoot, '.ditto', 'work-items', workItemId, 'completion.json');
  }

  async exists(workItemId: string): Promise<boolean> {
    return Bun.file(this.path(workItemId)).exists();
  }

  async get(workItemId: string): Promise<CompletionContract> {
    return readJson(this.path(workItemId), completionContract);
  }

  async write(completion: CompletionContract): Promise<CompletionContract> {
    return writeJson(this.path(completion.work_item_id), completionContract, completion);
  }
}
