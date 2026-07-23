import type { z } from 'zod';
import type { evidenceRef } from '~/schemas/common';
import { type Handoff, type HandoffScope, handoff as handoffSchema } from '~/schemas/handoff';
import type { WorkItem } from '~/schemas/work-item';
import { scrubTokens } from './github-redaction';
// NOTE: module cycle with handoff-ref-store (it imports this module's format
// helpers; we import only the ref NAME constant, used strictly at call time) —
// safe under ESM live bindings, and it keeps the ref name single-sourced.
import { HANDOFF_REF } from './handoff-ref-store';

type EvidenceRef = z.infer<typeof evidenceRef>;

/**
 * Handoff handoff FORMAT module (wi_260722g7h ac-rewire).
 *
 * The two-tier FILE store that used to live here (local gitignored actives under
 * `.ditto/local/handoff/` + committed remote files under `.ditto/handoff/`, with
 * soft consumed-markers, archive moves and an mtime age-sweep) was REMOVED:
 * handoffs now live solely as tree entries on the hidden per-repo ref
 * `refs/ditto/handoffs`, written/consumed via `HandoffRefStore`
 * (`handoff-ref-store.ts`). Consume lands a deletion commit, so no sweep /
 * archive / consumed-marker machinery exists anymore.
 *
 * What remains here is the handoff FORMAT + BUILD surface the ref store (and its
 * tests) consume:
 *  - build: `buildHandoff` / `buildSessionHandoff` (+ the blocked-handoff guard),
 *  - render/parse: 1-line JSON frontmatter (machine round-trip) + human markdown
 *    body — round-trip(write→read 동일 객체) preserved,
 *  - commit hardening: `scrubHandoffForCommit` (fail-closed token scrub reusing
 *    `github-redaction`'s scrubTokens — no second token-pattern list),
 *  - routing keys: `scopeKey` / `slugifyAuthor` / `gitAuthorSlug`,
 *  - metrics: `countHandoffRounds` (persistent per-WI round count off the
 *    ref history).
 */
export interface HandoffBuildInput {
  workItem: WorkItem;
  fromContext: string;
  currentState: string;
  nextFirstCheck: string;
  autopilotId?: string;
  toOwner?: string;
  decisionsMade?: string[];
  criticalDecisions?: { decision: string; rationale: string }[];
  irreversibleRisks?: { risk: string; why_irreversible: string }[];
  evidenceRefs?: EvidenceRef[];
  failedOrUnverified?: string[];
  openThreads?: string[];
  forbiddenScopeCreep?: string[];
  artifactAvailable?: boolean;
  changedFiles?: string[];
  // wi_2607148yg (ac-4/ac-9): marks this as a fail / condition-(b) BLOCKED handoff
  // — a direction-reversal / 진행불가 or a 보안·시스템·프로젝트·기능설계-의도 decision
  // that autopilot must NOT auto-drive. This is the blocked-handoff DISCRIMINATOR:
  // when true, `userDecisionBlock` MUST be non-empty (guardBlockedHandoffDecision),
  // so a blocked handoff hands off a decision to MAKE, not just a dead end. It is a
  // build-time input, NOT a persisted field — the handoff schema stays statusless so
  // a legacy on-disk handoff (which never runs through buildHandoff) is never
  // retro-rejected. Absent/false ⇒ a normal pass/partial handoff, no requirement.
  blocked?: boolean;
  // The concrete decision(s) the user must make: each option set + the agent's
  // CURRENT interpretation/lean. Rendered as a distinct block by renderHandoff.
  userDecisionBlock?: { decision: string; options: string[]; agent_interpretation: string }[];
  now?: Date;
}

/**
 * Thrown when a BLOCKED (fail / condition-(b)) handoff is built without a
 * user_decision_block. A blocked handoff whose only content is a dead end pushes
 * the procedural decision back on the user with nothing to act on; the guard
 * forces the concrete options + the agent's current interpretation to be present.
 */
export class BlockedHandoffMissingDecisionError extends Error {
  constructor() {
    super(
      'blocked (fail / condition-(b)) handoff requires a non-empty user_decision_block — surface the concrete options + the agent current interpretation, not just a dead end',
    );
    this.name = 'BlockedHandoffMissingDecisionError';
  }
}

/**
 * ac-9 required-WHEN-blocked guard. Mirrors the conditional-require precedent
 * (completion-contract `non_pass_status` → the gate): the persisted schema keeps
 * `user_decision_block` additive/optional (`.default([])`) so a legacy on-disk
 * handoff parses unchanged, and the "required when blocked" check lives here at
 * BUILD time keyed on the `blocked` discriminator — it therefore rejects only a
 * NEW blocked handoff and never retro-rejects a handoff that predates the field.
 */
function guardBlockedHandoffDecision(input: HandoffBuildInput): void {
  if (input.blocked && (input.userDecisionBlock?.length ?? 0) === 0) {
    throw new BlockedHandoffMissingDecisionError();
  }
}

export function buildHandoff(input: HandoffBuildInput): Handoff {
  guardBlockedHandoffDecision(input);
  return handoffSchema.parse({
    schema_version: '0.1.0',
    // work_item scope: the historical shape, now nested under the discriminated
    // union. Callers keep passing `{workItem}` — the scope is derived here so the
    // signature is unchanged.
    scope: { kind: 'work_item', work_item_id: input.workItem.id },
    ...(input.autopilotId ? { autopilot_id: input.autopilotId } : {}),
    from_context: input.fromContext,
    ...(input.toOwner ? { to_owner: input.toOwner } : {}),
    original_intent: input.workItem.source_request,
    current_state: input.currentState,
    decisions_made: input.decisionsMade ?? [],
    // ac-6: re-fetch-impossible substance preserved INLINE (tier rule).
    critical_decisions: input.criticalDecisions ?? [],
    irreversible_risks: input.irreversibleRisks ?? [],
    user_decision_block: input.userDecisionBlock ?? [],
    changed_files: input.changedFiles ?? input.workItem.changed_files,
    evidence_refs: input.evidenceRefs ?? [],
    failed_or_unverified: input.failedOrUnverified ?? [],
    open_threads: input.openThreads ?? [],
    next_first_check: input.nextFirstCheck,
    forbidden_scope_creep: input.forbiddenScopeCreep ?? [],
    artifact_available: input.artifactAvailable ?? true,
    created_at: (input.now ?? new Date()).toISOString(),
  });
}

/**
 * A SESSION-scoped handoff (not tied to any work item) — the entry for
 * `ditto handoff` with no work item. Its required key is `session_id`; there
 * is no `original_intent` from a work item, so the caller states it directly.
 */
export interface SessionHandoffBuildInput {
  sessionId: string;
  originalIntent: string;
  fromContext: string;
  currentState: string;
  nextFirstCheck: string;
  autopilotId?: string;
  toOwner?: string;
  decisionsMade?: string[];
  criticalDecisions?: { decision: string; rationale: string }[];
  irreversibleRisks?: { risk: string; why_irreversible: string }[];
  evidenceRefs?: EvidenceRef[];
  failedOrUnverified?: string[];
  openThreads?: string[];
  forbiddenScopeCreep?: string[];
  artifactAvailable?: boolean;
  changedFiles?: string[];
  now?: Date;
}

export function buildSessionHandoff(input: SessionHandoffBuildInput): Handoff {
  return handoffSchema.parse({
    schema_version: '0.1.0',
    scope: { kind: 'session', session_id: input.sessionId },
    ...(input.autopilotId ? { autopilot_id: input.autopilotId } : {}),
    from_context: input.fromContext,
    ...(input.toOwner ? { to_owner: input.toOwner } : {}),
    original_intent: input.originalIntent,
    current_state: input.currentState,
    decisions_made: input.decisionsMade ?? [],
    critical_decisions: input.criticalDecisions ?? [],
    irreversible_risks: input.irreversibleRisks ?? [],
    changed_files: input.changedFiles ?? [],
    evidence_refs: input.evidenceRefs ?? [],
    failed_or_unverified: input.failedOrUnverified ?? [],
    open_threads: input.openThreads ?? [],
    next_first_check: input.nextFirstCheck,
    forbidden_scope_creep: input.forbiddenScopeCreep ?? [],
    artifact_available: input.artifactAvailable ?? true,
    created_at: (input.now ?? new Date()).toISOString(),
  });
}

/** The routing/archive key for a scope — its work_item_id or session_id. */
export function scopeKey(scope: HandoffScope): string {
  return scope.kind === 'work_item' ? scope.work_item_id : scope.session_id;
}

/**
 * A filesystem/git-safe author slug: lowercased, non-`[a-z0-9]` runs collapsed to a
 * single `-`, leading/trailing `-` trimmed. Derived from a git identity so two
 * concurrent authors on the SAME scope land in separate handoff entries (ac-1). Pure.
 */
export function slugifyAuthor(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The author-slug for handoff routing, derived from git identity
 * (`user.email` → `user.name`). Empty / absent identity falls back to the defined
 * non-empty slug `anon` — NEVER an empty key that would collide two authors into
 * one entry. Best-effort: a non-repo / missing git just yields the fallback.
 */
export function gitAuthorSlug(repoRoot: string): string {
  const read = (key: string): string => {
    const r = Bun.spawnSync(['git', 'config', '--get', key], {
      cwd: repoRoot,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return r.exitCode === 0 ? (r.stdout?.toString() ?? '').trim() : '';
  };
  const slug = slugifyAuthor(read('user.email') || read('user.name'));
  return slug.length > 0 ? slug : 'anon';
}

/** Render a Handoff to its human-readable markdown body (the part injected next session). */
export function renderHandoff(h: Handoff): string {
  const lines: string[] = [];
  lines.push(`# Handoff: ${scopeKey(h.scope)}`);
  if (h.autopilot_id) lines.push(`autopilot: ${h.autopilot_id}`);
  lines.push('', `from: ${h.from_context}`, '');
  lines.push('## 원래 의도');
  lines.push(h.original_intent, '');
  lines.push('## 현재 상태');
  lines.push(h.current_state, '');
  // ac-9: a fail / condition-(b) blocked handoff surfaces the decision the USER
  // must make as a distinct block — concrete options + the agent's current lean —
  // placed high so it is not mistaken for a resume pointer. Empty on a normal
  // pass/partial handoff (the section is then skipped).
  if (h.user_decision_block.length > 0) {
    lines.push('## 사용자 결정 필요 (blocked handoff)');
    for (const d of h.user_decision_block) {
      lines.push(`- 결정: ${d.decision}`);
      for (const o of d.options) lines.push(`  - 선택지: ${o}`);
      lines.push(`  - agent 현재 해석: ${d.agent_interpretation}`);
    }
    lines.push('');
  }
  if (h.decisions_made.length > 0) {
    lines.push('## 내려진 결정');
    for (const d of h.decisions_made) lines.push(`- ${d}`);
    lines.push('');
  }
  if (h.critical_decisions.length > 0) {
    lines.push('## 핵심 결정 (재호출 불가)');
    for (const d of h.critical_decisions) lines.push(`- ${d.decision} — ${d.rationale}`);
    lines.push('');
  }
  if (h.irreversible_risks.length > 0) {
    lines.push('## 비가역 위험');
    for (const r of h.irreversible_risks) lines.push(`- ${r.risk} — ${r.why_irreversible}`);
    lines.push('');
  }
  if (h.changed_files.length > 0) {
    lines.push('## 변경 파일');
    for (const f of h.changed_files) lines.push(`- ${f}`);
    lines.push('');
  }
  if (h.evidence_refs.length > 0) {
    lines.push('## 증거 (inline)');
    for (const e of h.evidence_refs) lines.push(`- ${JSON.stringify(e)}`);
    lines.push('');
  }
  if (h.failed_or_unverified.length > 0) {
    lines.push('## 실패 / 미검증');
    for (const u of h.failed_or_unverified) lines.push(`- ${u}`);
    lines.push('');
  }
  if (h.open_threads.length > 0) {
    lines.push('## 열린 스레드');
    for (const t of h.open_threads) lines.push(`- ${t}`);
    lines.push('');
  }
  lines.push('## 다음 agent 가 가장 먼저 볼 것');
  lines.push(h.next_first_check, '');
  if (h.forbidden_scope_creep.length > 0) {
    lines.push('## 금지: scope creep');
    for (const s of h.forbidden_scope_creep) lines.push(`- ${s}`);
    lines.push('');
  }
  if (!h.artifact_available) {
    lines.push('⚠ raw artifacts 가 이 클론/세션에 없다 — 인라인 요약만 신뢰할 것.', '');
  }
  return lines.join('\n').trimEnd();
}

/** Parse a serialized handoff file back into its Handoff + human body. */
export function parseHandoffFile(text: string): { handoff: Handoff; body: string } {
  if (!text.startsWith('---\n')) {
    throw new Error('handoff file: missing leading frontmatter fence');
  }
  const rest = text.slice(4);
  const end = rest.indexOf('\n---');
  if (end === -1) throw new Error('handoff file: unterminated frontmatter');
  const handoff = handoffSchema.parse(JSON.parse(rest.slice(0, end)));
  const body = rest.slice(end + 4).replace(/^\n+/, '');
  return { handoff, body };
}

/** Recursively token-scrub every string in a JSON value (defense-in-depth). */
function scrubDeep(value: unknown): unknown {
  if (typeof value === 'string') return scrubTokens(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, scrubDeep(v)]),
    );
  }
  return value;
}

/**
 * Harden a handoff body for a COMMITTED (git-object, irreversible) write:
 * token-scrub every free-text field (reuses `github-redaction`'s scrub). The routing
 * keys (`scope`), `schema_version` and `created_at` pass through verbatim. Re-parse is
 * FAIL-CLOSED: if scrubbing broke a required field (e.g. a secret-laden URL that no
 * longer validates), the write throws instead of committing an unscrubbed body. Pure.
 */
export function scrubHandoffForCommit(h: Handoff): Handoff {
  const { scope, schema_version, created_at, ...rest } = h;
  return handoffSchema.parse({
    scope,
    schema_version,
    created_at,
    ...(scrubDeep(rest) as Record<string, unknown>),
  });
}

/**
 * Persistent per-work-item handoff ROUND count — the `handoff_rounds` /
 * `post_cost` metric source (autopilot-loop `computePostCost`, intent-quality
 * doctor row).
 *
 * Reads the `refs/ditto/handoffs` HISTORY, not the pending tip: under the
 * hidden-ref handoff model consume lands an immediate deletion commit, so a
 * "currently pending" source structurally converges to 0 the moment a handoff is
 * picked up and the continuation-churn metric would silently die. A round =
 * one handoff ISSUED for this work item = a ref commit that ADDED a
 * `<wi>__<author>.md` tree entry (`--diff-filter=A`; an overwrite of a
 * still-pending same-stem handoff is a Modify and does not inflate the count,
 * matching the old single-file-overwrite semantics). LOCAL ref lookup only —
 * never fetch/push. Fail-open: unborn ref, non-repo dir or a missing git
 * binary all count 0, never throw (metrics reader, parity with the other
 * post_cost sources).
 */
export function countHandoffRounds(repoRoot: string, workItemId: string): number {
  try {
    const r = Bun.spawnSync(
      [
        'git',
        'log',
        HANDOFF_REF,
        '--format=%H',
        '--diff-filter=A',
        '--',
        `:(glob)${workItemId}__*.md`,
      ],
      { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' },
    );
    if (r.exitCode !== 0) return 0; // unborn ref / not a repo → no rounds
    return (r.stdout?.toString() ?? '').split('\n').filter((line) => line.trim().length > 0).length;
  } catch {
    return 0; // git unavailable → fail-open like every other post_cost source
  }
}
