import type { Autopilot } from '~/schemas/autopilot';

/**
 * Pure approval-gate transitions for the `ditto autopilot approve/reject` CLI
 * (wi_260615xby A). These only WRITE the gate fields the schema already defines;
 * the autopilot loop core is untouched. The CLI persists the result through
 * `AutopilotStore.updateApprovalGate` so the mutation stays schema-validated and
 * atomic (§6.5). approve/reject are valid only from `pending` — a gate that is
 * already approved/rejected/not_required has nothing to act on, so the caller
 * gets a clear error instead of a silent no-op.
 */
export type ApprovalGate = Autopilot['approval_gate'];
export type ApprovalSourceValue = NonNullable<ApprovalGate['source']>;

export interface ApproveInput {
  /** Recorded as approved_by; defaults to 'user' for a manual CLI approval. */
  by?: string;
  /** Where the approval comes from; defaults to 'user' (a human ran the CLI). */
  source?: ApprovalSourceValue;
  now?: Date;
}

function requirePending(gate: ApprovalGate, action: string): void {
  if (gate.status !== 'pending') {
    throw new Error(`approval gate is not pending (current: ${gate.status}); nothing to ${action}`);
  }
}

export function applyApproval(gate: ApprovalGate, input: ApproveInput = {}): ApprovalGate {
  requirePending(gate, 'approve');
  return {
    ...gate,
    status: 'approved',
    source: input.source ?? 'user',
    approved_at: (input.now ?? new Date()).toISOString(),
    approved_by: input.by ?? 'user',
  };
}

export function applyRejection(gate: ApprovalGate, reason?: string): ApprovalGate {
  requirePending(gate, 'reject');
  const evidence_refs = reason
    ? [...gate.evidence_refs, { kind: 'note' as const, summary: reason }]
    : gate.evidence_refs;
  return { ...gate, status: 'rejected', evidence_refs };
}

/**
 * Presence marker for the pre-approval authoring regime (wi_2607105qy N2, piece 4).
 * The authoring-stage surfacing/gating keys off the PRESENCE of an authored
 * `plan_brief.test_spec` — NOT piggybacked on `change_surface` (the brief regime
 * marker). A legacy / mid-run graph written before the authoring stage carries no
 * `test_spec` (even when it has a `change_surface`), so it is never retro-gated by a
 * marker that keys on test_spec. Pure, read-only — the seam later increments (the
 * phantom-red hard gate, the approval-artifact renderer) build on.
 */
export function hasAuthoredTestSpec(gate: ApprovalGate): boolean {
  return gate.plan_brief?.test_spec !== undefined;
}

/**
 * Post-freeze drift escape (ac-3 Part C). After approval the plan is FROZEN, so
 * `applyRejection` (which only acts from `pending`) can no longer re-open it — the only
 * escape would be an out-of-band user unblock. This transition moves an APPROVED gate to
 * `rejected` explicitly, so the loop's rejection path then re-authors fresh (deletes the
 * authored files, clears the manifest, resets the test-author node). Recording the reason
 * keeps the re-author auditable. Valid ONLY from `approved` (a non-approved gate uses the
 * normal approve/reject transitions) — otherwise it throws rather than silently no-op.
 */
export function rejectForReauthor(gate: ApprovalGate, reason?: string): ApprovalGate {
  if (gate.status !== 'approved') {
    throw new Error(
      `rejectForReauthor requires an approved gate (post-freeze), got '${gate.status}'`,
    );
  }
  const summary = reason ?? 'plan rejected for re-authoring (post-freeze drift)';
  return {
    ...gate,
    status: 'rejected',
    evidence_refs: [...gate.evidence_refs, { kind: 'note' as const, summary }],
  };
}

/**
 * The repo-relative authored red-test files carried on the gate's test_spec (ac-3 Part C).
 * On approval REJECTION these are the orphan files the loop cleans up (the authored tests
 * were written speculatively before the plan was approved), so they never linger after a
 * rejected plan. Pure, read-only; an absent test_spec ⇒ [] (nothing authored).
 */
export function authoredTestPaths(gate: ApprovalGate): string[] {
  return (gate.plan_brief?.test_spec?.test_backed ?? []).map((t) => t.test_path);
}

/**
 * Render the human-readable APPROVAL ARTIFACT for a plan that carries an authored
 * test_spec (wi_2607105qy N2 ac-4/ac-6). This is the user-facing surface of the whole
 * pre-approval authoring feature: the file the user OPENS to review the red tests before
 * approving them. Pure — returns the markdown STRING; the loop owns the write to the
 * predictable `.ditto/local/work-items/<wi>/approval/` path (never a temp/scratch folder).
 *
 * ac-4 requires three things, all rendered here:
 *  - DISTINGUISH test-backed ACs (an executable red test guarantees them) from oracle-only
 *    ACs (static / soft_judgment — judged by review, no executable test);
 *  - show each AC's TEXT alongside its authored test, so the user can judge under/over-assert;
 *  - a per-AC-clause coverage ATTESTATION that asserts ONLY against the AC's DECLARED
 *    contract (no internal-call/signature assertions — the over-assert mitigation).
 *
 * `acById` maps a criterion id → its statement text (the loop builds it from the work item).
 * A criterion with no known statement renders `(statement unavailable)` rather than dropping
 * the row, so the artifact never silently hides an AC.
 */
export function renderApprovalArtifact(
  gate: ApprovalGate,
  acById: ReadonlyMap<string, string>,
): string {
  const spec = gate.plan_brief?.test_spec;
  const testBacked = spec?.test_backed ?? [];
  const oracleOnly = spec?.oracle_only ?? [];
  const statementFor = (id: string): string => acById.get(id) ?? '(statement unavailable)';

  const lines: string[] = [];
  lines.push('# Plan approval — authored red tests');
  lines.push('');
  lines.push(
    'Review the failing (red) tests authored for this plan BEFORE approving. Each ' +
      'test-backed AC below is guaranteed by an executable red test; approving FREEZES those ' +
      'tests (the implementation may not weaken or delete them). Oracle-only ACs carry no ' +
      'executable test and are judged by review/inspection.',
  );
  lines.push('');

  // (1) test-backed ACs — an executable red test guarantees each (distinguished section).
  lines.push('## Test-backed ACs (executable red test guarantees them)');
  if (testBacked.length === 0) {
    lines.push('(none)');
  } else {
    for (const t of testBacked) {
      lines.push(`- ${t.criterion_id}: ${statementFor(t.criterion_id)}`);
      lines.push(`  - authored test: ${t.test_path}`);
      if (t.frozen_hash) lines.push(`  - frozen_hash: ${t.frozen_hash}`);
      // Per-AC-clause coverage attestation — asserts ONLY the AC's declared contract
      // (over-assert mitigation: no internal-call/signature assertions).
      lines.push(
        `  - attestation: this test asserts ${t.criterion_id}'s declared contract ("${statementFor(t.criterion_id)}") and nothing beyond it — no internal-call or signature assertions.`,
      );
    }
  }
  lines.push('');

  // (2) oracle-only ACs — static / soft_judgment, judged by review (distinguished section).
  lines.push('## Oracle-only ACs (static / soft_judgment — no executable test)');
  if (oracleOnly.length === 0) {
    lines.push('(none)');
  } else {
    for (const id of oracleOnly) {
      lines.push(`- ${id}: ${statementFor(id)}`);
      lines.push('  - verified by review/inspection (no executable red test guarantees it)');
    }
  }
  lines.push('');

  return lines.join('\n');
}
