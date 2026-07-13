/**
 * ② Tidy scope contract — build the cleanup-profile
 * ChangeContract: allowed_scope = the just-made diff, forbidden_scope = 그외.
 * Enforced as a WHITELIST (scope_mode) so PreToolUse blocks any edit outside the
 * diff. Opt-in scope_mode keeps existing (blacklist) contracts unchanged.
 */
import { type AcgChangeContract, acgChangeContract } from '~/schemas/acg-change-contract';

export interface TidyContractInput {
  workItemId: string;
  /** Repo-relative paths of the just-made diff (allowed_scope). */
  changedFiles: string[];
  /** ISO timestamp (caller-supplied for testability). */
  producedAt: string;
  purpose?: string;
}

/** Build a whitelist-mode (cleanup-profile) ChangeContract for a Tidy pass. */
export function buildTidyChangeContract(input: TidyContractInput): AcgChangeContract {
  return acgChangeContract.parse({
    schema_version: '0.1.0',
    kind: 'acg.change-contract.v1',
    work_item_id: input.workItemId,
    produced_by: 'agent',
    produced_at: input.producedAt,
    purpose:
      input.purpose ??
      'Tidy (동작 보존 정리) — change-scoped: only the just-made diff may be edited',
    allowed_scope: input.changedFiles.map((ref) => ({ kind: 'path' as const, ref })),
    forbidden_scope: [
      {
        kind: 'glob' as const,
        ref: '**',
        note: '그외 — whitelist: everything outside allowed_scope',
      },
    ],
    acceptance: [
      {
        criterion: 'behavior is preserved — DoD replay is green after tidy',
        evidence_kind: 'test' as const,
      },
    ],
    scope_mode: 'whitelist',
    risk_default: 'low',
  });
}
