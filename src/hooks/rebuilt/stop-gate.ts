import type { z } from 'zod';
import {
  type AttestationState,
  type RiskAxes,
  attestAcVerdicts,
  completionEvidenceGate,
  completionGate,
  convergenceGate,
  decisionConflictRequiresApproval,
  directionForkGate,
  highRiskAssumption,
  intentDriftGate,
  landGate,
  nonPassTerminationGate,
} from '~/core/gates';
import type { AcgAssuranceSnapshot } from '~/schemas/acg-assurance-snapshot';
import type { AcgImpactGraph } from '~/schemas/acg-impact-graph';
import type { AcgReviewGraph } from '~/schemas/acg-review-graph';
import type { AcgSemanticCompatibility } from '~/schemas/acg-semantic-compatibility';
import type { Autopilot } from '~/schemas/autopilot';
import type { completionContract } from '~/schemas/completion-contract';
import type { convergence as convergenceSchema } from '~/schemas/convergence';
import type { DecisionConflictCarrier } from '~/schemas/decision-conflict-carrier';
import type { Dialectic } from '~/schemas/dialectic';
import type { directionForkCarrier } from '~/schemas/direction-fork-carrier';
import type { intentContract } from '~/schemas/intent';
import type { KnowledgeGateCarrier } from '~/schemas/knowledge-gate-carrier';
import type { WorkItem } from '~/schemas/work-item';
// The per-ledger continuation semantics are IMPORTED from the dormant legacy
// module (they are its exported pure functions, themselves thin wrappers over
// src/core/gates.ts) — re-deriving their wording/routing here would only risk
// decision drift.
import {
  acgReviewForcesContinuation,
  assuranceSnapshotForcesContinuation,
  autopilotBypassForcesContinuation,
  autopilotForcesContinuation,
  decisionConflictForcesContinuation,
  dialecticForcesContinuation,
  impactForcesContinuation,
  knowledgeForcesContinuation,
  residualResolvabilityForcesContinuation,
  riskRecordForcesContinuation,
  semanticForcesContinuation,
} from '../stop';

/**
 * Stop-hook PURE completion gate (rebuild increment 3). Given the parsed
 * work-item ledgers, decide whether the session may stop (exit 0) or must
 * continue (exit 2), plus the side effects the IO shell must perform. Verdict
 * semantics come from `src/core/gates.ts` (and the legacy module's exported
 * per-ledger wrappers); this module owns only the ordering / assembly:
 * malformed fail-closed, the yield-precedence classifier, the continuation
 * cascade, the strong-block, and the advisory/attestation tails.
 */

export type ArtifactRead<T> =
  | { status: 'absent' }
  | { status: 'malformed'; name: string }
  | { status: 'ok'; data: T };

export type DialecticsRead =
  | { status: 'ok'; items: Dialectic[] }
  | { status: 'malformed'; name: string };

export interface StopLedgers {
  completion: ArtifactRead<z.infer<typeof completionContract>>;
  conv: ArtifactRead<z.infer<typeof convergenceSchema>>;
  pilot: ArtifactRead<Autopilot>;
  intent: ArtifactRead<z.infer<typeof intentContract>>;
  dialectics: DialecticsRead;
  acgReview: ArtifactRead<AcgReviewGraph>;
  assurance: ArtifactRead<AcgAssuranceSnapshot>;
  impact: ArtifactRead<AcgImpactGraph>;
  semantic: ArtifactRead<AcgSemanticCompatibility>;
  knowledge: ArtifactRead<KnowledgeGateCarrier>;
  decisionConflicts: ArtifactRead<DecisionConflictCarrier>;
  directionFork: ArtifactRead<z.infer<typeof directionForkCarrier>>;
}

export interface StopGateInput {
  workItem: WorkItem;
  ledgers: StopLedgers;
  /** Passed through to the dialectic anchor-existence probe (file-shaped maps_to). */
  repoRoot: string;
  /** Lazy: currently-uncommitted files (git); consulted only when a pass-close lands. */
  uncommittedFiles: () => string[];
  /** Lazy: the non-blocking semantic-scan nudge; consulted only on a clean stop. */
  computeNudge: () => string | null;
}

export interface StopEffects {
  /** P6 routine procedure-punt was force-continued — record it (dedup-guarded). */
  recordProcedurePunt: boolean;
  /** Intent-drift gate ran — persist its verdict to metrics.jsonl (dedup-guarded). */
  intentDrift?: { reasons: string[]; advisories: string[] };
}

export interface StopGateDecision {
  exitCode: 0 | 2;
  stderr?: string;
  effects: StopEffects;
}

/**
 * Work item statuses that still owe a verdict; 'done'/'abandoned' are terminal.
 */
const NON_TERMINAL_STATUSES: ReadonlyArray<WorkItem['status']> = [
  'draft',
  'in_progress',
  'blocked',
  'partial',
  'unverified',
];

/** A real mutating plan awaiting approval: an implementer-owned node still pending. */
function hasPendingMutatingNode(a: Autopilot): boolean {
  return a.nodes.some((n) => n.owner === 'implementer' && n.status === 'pending');
}

/**
 * A degenerate-pending autopilot is PRESENT but provides no verification path:
 * approval pending yet no pending mutating node to surface — treated as
 * "no real plan" so the strong-block fires.
 */
function isDegeneratePendingAutopilot(a: Autopilot): boolean {
  return a.approval_gate.status === 'pending' && !hasPendingMutatingNode(a);
}

/** Disk-derived risk axes: the work item's `declared_risk` flags (absent → safe). */
function riskOf(workItem: WorkItem): RiskAxes {
  const r = workItem.declared_risk;
  return {
    non_local: !!r?.non_local,
    irreversible: !!r?.irreversible,
    unaudited: !!r?.unaudited,
  };
}

/**
 * ADR-0024 oracle-gap presence: assignment is in play iff some AC carries an
 * oracle; then every AC a design node covers must carry one. An in-play covered
 * AC WITHOUT an oracle is the gap the pending plan awaits.
 */
function oracleGapPending(workItem: WorkItem, graph: Autopilot): boolean {
  const assignmentInPlay = workItem.acceptance_criteria.some((ac) => ac.oracle !== undefined);
  if (!assignmentInPlay) return false;
  const inPlay = new Set(
    graph.nodes.filter((n) => n.kind === 'design').flatMap((n) => n.acceptance_refs),
  );
  return workItem.acceptance_criteria.some((ac) => inPlay.has(ac.id) && ac.oracle === undefined);
}

/**
 * Korean gloss for the per-AC attestation state. The `AttestationState` VALUE is
 * a structural enum consumed by code; this only adds the reader-facing Korean.
 */
const ATTESTATION_STATE_GLOSS: Record<AttestationState, string> = {
  'verified-by-evidence': '증거로 검증됨',
  'reasoned-honest-partial': '정직한 부분완료(근거 있음)',
  'blocked-for-user': '사용자 판단 필요(차단)',
};

const NO_EFFECTS: StopEffects = { recordProcedurePunt: false };

export function evaluateStopGate(input: StopGateInput): StopGateDecision {
  const { workItem, ledgers, repoRoot } = input;
  const {
    completion,
    conv,
    pilot,
    intent,
    dialectics,
    acgReview,
    assurance,
    impact,
    semantic,
    knowledge,
    decisionConflicts,
    directionFork,
  } = ledgers;
  const effects: StopEffects = { recordProcedurePunt: false };

  // Malformed artifact = gate-input violation → fail CLOSED (exit 2). Order pins
  // which file the block names when several are malformed at once.
  const malformed = [
    completion,
    conv,
    pilot,
    intent,
    dialectics,
    acgReview,
    assurance,
    impact,
    semantic,
    knowledge,
    decisionConflicts,
    directionFork,
  ].find((a) => a.status === 'malformed');
  if (malformed && malformed.status === 'malformed') {
    return {
      exitCode: 2,
      stderr: `DITTO Stop gate: ${malformed.name} 파일이 malformed(형식 오류)라 완료를 검증할 수 없음. 멈추기 전에 고치거나 제거하라.\n`,
      effects: NO_EFFECTS,
    };
  }

  const reasons: string[] = [];
  // Non-blocking advisories: surfaced even on exit 0, never force continuation.
  const advisories: string[] = [];

  // ── Yield precedence classifier ────────────────────────────────────────────
  // YIELDS (P1-P4) early-return exit 0; FORCES (P5-P6) push a blocking reason so
  // the cascade below exits 2. A malformed carrier (P0) already fail-closed.
  const forkGate =
    directionFork.status === 'ok' ? directionForkGate(directionFork.data) : undefined;
  // P1: a VALID 3-condition direction fork yields so it can surface.
  if (forkGate?.pass === true) return { exitCode: 0, effects: NO_EFFECTS };

  // P2-P4 / P6: a pending mutating plan yields ONLY for a real decision
  // (intent-conflict / high-risk / oracle-gap); a routine procedure punt is
  // force-continued instead of stalling forever.
  if (
    pilot.status === 'ok' &&
    pilot.data.approval_gate.status === 'pending' &&
    hasPendingMutatingNode(pilot.data)
  ) {
    // P2: ADR-0020 intent-level conflict — only the user can resolve it → YIELD.
    if (
      decisionConflicts.status === 'ok' &&
      decisionConflictRequiresApproval(decisionConflicts.data.conflicts)
    ) {
      return { exitCode: 0, effects: NO_EFFECTS };
    }
    // P3: a high-risk bootstrap (non_local / irreversible / unaudited) — YIELD.
    if (highRiskAssumption(riskOf(workItem))) return { exitCode: 0, effects: NO_EFFECTS };
    // P4: ADR-0024 oracle gap — YIELD so the gap surfaces.
    if (oracleGapPending(workItem, pilot.data)) return { exitCode: 0, effects: NO_EFFECTS };
    // P6: a ROUTINE procedure punt — force-continue and record once.
    effects.recordProcedurePunt = true;
    reasons.push(
      `autopilot 승인이 일상적 절차 미루기(procedure-punt) 상태로 대기 중임 — 양보할 만한 결정(의도 충돌 / 고위험 / 완료 판정 근거 공백(oracle-gap))이 없음 — 계속 진행함; 다시 묻지 않게 하려면 계획을 승인하라("ditto autopilot approve ${workItem.id}")`,
    );
  }

  // P5: a direction-fork carrier PRESENT but INCOMPLETE — force-continue and
  // name the missing / empty condition (fail-closed).
  if (forkGate && forkGate.pass === false) {
    reasons.push(...forkGate.reasons.map((r) => `방향 분기(direction fork)가 불완전함 — ${r}`));
  }

  // Whether the completion passes its OWN gates (the work is actually closing).
  let completionWouldClose = false;
  if (completion.status === 'ok') {
    const g = completionGate(workItem, completion.data);
    const e = completionEvidenceGate(completion.data);
    completionWouldClose = g.pass && e.pass;
    // A TERMINAL work item (done/abandoned) is already closed by an explicit
    // decision — a stale non-pass completion must not re-force continuation.
    if (NON_TERMINAL_STATUSES.includes(workItem.status)) {
      if (!g.pass) reasons.push(...g.reasons);
      if (!e.pass) reasons.push(...e.reasons);
      // Non-pass termination gate: a non-pass completion that PARKS an in-scope
      // unverified/fail criterion without an honest non_pass_status declaration
      // must not silent-terminate; an honest partial/blocked terminates.
      const np = nonPassTerminationGate(completion.data);
      if (!np.pass) reasons.push(...np.reasons);
    }
  }
  // Convergence gate — non-terminal items only (a stale non-converged ledger on
  // a terminal item must not re-force continuation forever).
  if (conv.status === 'ok' && NON_TERMINAL_STATUSES.includes(workItem.status)) {
    const g = convergenceGate(conv.data);
    if (!g.pass) reasons.push(...g.reasons);
  }
  // Autopilot runnable-node continuation — non-terminal, non-exempt items only.
  if (
    pilot.status === 'ok' &&
    autopilotForcesContinuation(pilot.data) &&
    NON_TERMINAL_STATUSES.includes(workItem.status) &&
    workItem.autopilot_exempt !== true
  ) {
    reasons.push('autopilot에 실행 가능한 노드가 남아 있음 — 작업 항목이 아직 완료되지 않음');
  }
  // plan→autopilot transition gate: a work item CLOSING on a passing completion
  // with no real autopilot plan ever run bypassed finalize→bootstrap→drive.
  reasons.push(
    ...autopilotBypassForcesContinuation(workItem, completion, pilot, completionWouldClose),
  );
  // Residual gates — fire only on a completion that actually passes its own
  // gates (never double-message on a partial/handoff checkpoint).
  if (completion.status === 'ok' && completionWouldClose) {
    reasons.push(...residualResolvabilityForcesContinuation(completion.data, workItem));
    reasons.push(...riskRecordForcesContinuation(completion.data, workItem));
    // Last-mile land gate: a done ∧ pass close whose changed_files still sit
    // uncommitted is "verified but not landed".
    const uncommitted = new Set(input.uncommittedFiles());
    const uncommittedChanged = completion.data.changed_files.filter((f) => uncommitted.has(f));
    reasons.push(
      ...landGate(workItem.status, completion.data.final_verdict, uncommittedChanged).reasons,
    );
  }
  // Axis-2 intent drift: catches post-finalize divergence (goal rewrite, AC
  // grow/shrink, invented refs). Deterministic floor; semantics stay with review.
  if (intent.status === 'ok' && pilot.status === 'ok') {
    const d = intentDriftGate({
      intent: intent.data,
      workItem,
      graph: pilot.data,
      ...(completion.status === 'ok' ? { completion: completion.data } : {}),
    });
    if (!d.pass) reasons.push(...d.reasons.map((r) => `의도 표류(intent drift) — ${r}`));
    advisories.push(...d.advisories.map((r) => `의도 표류(intent drift, 참고) — ${r}`));
    // Side effect only — persisted by the shell, never touches the verdict.
    effects.intentDrift = { reasons: d.reasons, advisories: d.advisories };
  }
  if (dialectics.status === 'ok') {
    for (const d of dialectics.items) reasons.push(...dialecticForcesContinuation(d, repoRoot));
  }
  if (acgReview.status === 'ok') {
    reasons.push(...acgReviewForcesContinuation(acgReview.data));
  }
  if (assurance.status === 'ok') {
    reasons.push(...assuranceSnapshotForcesContinuation(assurance.data));
  }
  if (impact.status === 'ok') {
    reasons.push(...impactForcesContinuation(impact.data));
  }
  if (semantic.status === 'ok') {
    reasons.push(...semanticForcesContinuation(semantic.data));
  }
  // Axis-4 knowledge-update gate: inert unless the graph has a terminal
  // knowledge node AND a carrier is present.
  if (pilot.status === 'ok') {
    reasons.push(
      ...knowledgeForcesContinuation(
        pilot.data,
        knowledge.status === 'ok' ? knowledge.data : undefined,
      ),
    );
  }
  // Decision-conflict guardrail (ADR-0020): intent conflicts block; every
  // detected conflict is disclosed even when auto-aligned.
  const dc = decisionConflictForcesContinuation(
    decisionConflicts.status === 'ok' ? decisionConflicts.data : undefined,
  );
  reasons.push(...dc.reasons);
  advisories.push(...dc.advisories);

  const advisoryBlock =
    advisories.length > 0
      ? `DITTO Stop advisory(비차단 참고) — ${advisories.length}건:\n- ${advisories.join('\n- ')}\n`
      : '';

  // Per-AC positive attestation, folded from the completion's own per-AC
  // verdicts — appended (non-blocking) to whatever this gate returns.
  const attestation =
    completion.status === 'ok'
      ? attestAcVerdicts(
          completion.data.acceptance.map((a) => ({
            criterion_id: a.criterion_id,
            verdict: a.verdict,
            ...(a.notes !== undefined ? { notes: a.notes } : {}),
          })),
        )
      : [];
  const attestationBlock =
    attestation.length > 0
      ? `DITTO Stop attestation(완료 조건별 증거 확인) — 완료 조건 ${attestation.length}건:\n${attestation
          .map(
            (a) =>
              `- ${a.criterion_id}: ${a.state}(${ATTESTATION_STATE_GLOSS[a.state]})${a.basis ? ` — ${a.basis}` : ''}`,
          )
          .join('\n')}\n`
      : '';

  if (reasons.length > 0) {
    return {
      exitCode: 2,
      stderr: `DITTO Stop gate: 계속 진행 — 남은 항목 ${reasons.length}건:\n- ${reasons.join('\n- ')}\n${advisoryBlock}${attestationBlock}`,
      effects,
    };
  }

  // Strong-block: a NON_TERMINAL work item stopping with completion /
  // convergence / autopilot (real plan) ALL absent has no verification path.
  if (
    completion.status === 'absent' &&
    conv.status === 'absent' &&
    (pilot.status === 'absent' ||
      (pilot.status === 'ok' && isDegeneratePendingAutopilot(pilot.data))) &&
    NON_TERMINAL_STATUSES.includes(workItem.status)
  ) {
    return {
      exitCode: 2,
      stderr: `DITTO Stop gate: 작업 항목 ${workItem.id}이(가) ${workItem.status} 상태인데 실질적 검증 경로가 없음(no real verification path) — completion.json/convergence.json도 없고(no completion.json / convergence.json), 실행할 계획이 담긴 autopilot.json도 없음. 멈추기 전에 /ditto:verify를 실행하거나(completion.json 생성) 작업 항목을 done/abandoned로 전환하라.\n`,
      effects,
    };
  }

  // Nothing left to force. Surface the non-blocking semantic-scan nudge (plus
  // any advisory/attestation tail) on the way out.
  const nudge = input.computeNudge();
  const tail = `${advisoryBlock}${attestationBlock}${nudge ?? ''}`;
  return tail.length > 0 ? { exitCode: 0, stderr: tail, effects } : { exitCode: 0, effects };
}
