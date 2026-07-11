import { z } from 'zod';
import {
  evidenceRef,
  evidenceRequiredKind,
  isoDateTime,
  profileName,
  relativePath,
  runId,
  schemaVersion,
  verdict,
  workItemId,
  workItemStatus,
} from './common';
import { oracleMode } from './coverage';

const gitSha40 = z
  .string()
  .regex(/^[a-f0-9]{40}$/, 'git sha must be 40 lowercase hex characters')
  .describe('Full 40-char git commit sha');

// ADR-0024 §3.1: re-evaluability class of an AC oracle. NEW axis (re-evaluability
// strength), distinct from intent.ts evidenceRequiredKind (= *kind of evidence*:
// test|diff|browser|doc|log). dynamic_test = hard·dynamic (executed), static_scan =
// hard·static (re-scanned), soft_judgment = soft (review / user-decision).
export const verificationMethod = z
  .enum(['dynamic_test', 'static_scan', 'soft_judgment'])
  .describe(
    'Re-evaluability class of the oracle (ADR-0024 §3.1: hard·dynamic / hard·static / soft·judgment). Distinct from evidenceRequiredKind (intent.ts), which is the kind of evidence, not its re-evaluability.',
  );

// ADR-0024 §3.0/§3 raise≠resolution: a code-pointer maps_to (file:line or
// path:symbol) names a frozen current-code position that drifts as code changes.
// Valid for a `backward` oracle (a current-code finding); rejected for a `forward`
// oracle (evaluated on the post-change final state — must stay re-evaluable).
// Exported (wi_260706n4w): the presence-mode oracle reuses THIS grammar as its
// citation shape — no new citation syntax is introduced.
export const codePointerMapsTo = /^[^\s]+\.[A-Za-z0-9]+:[^\s]+$/;

export const acOracle = z
  .object({
    // §3.1 — re-evaluability class; references evidenceRequiredKind to keep the
    // relationship explicit (this is a different axis, not a duplicate).
    verification_method: verificationMethod,
    // §3 — anchor target. Same vocabulary as dialectic.ts opponentObjection.maps_to
    // ("AC, file:line, intent, or doc"); do not reinvent.
    maps_to: z
      .string()
      .min(1)
      .describe(
        'AC, file:line, intent, or doc the oracle anchors to (same vocabulary as dialectic maps_to)',
      ),
    // §3.0 — forward = evaluated on the post-change final state; backward =
    // current-code finding.
    direction: z
      .enum(['forward', 'backward'])
      .describe(
        'forward = post-change final state; backward = current-code finding (ADR-0024 §3.0)',
      ),
    // wi_260706n4w ac-1: 2-mode oracle claim — EXACTLY two additive fields
    // (pattern + mode), both OPTIONAL: a legacy oracle omits them and parses
    // unchanged (no schema_version bump). mode='absence' ⇒ the claim is
    // "`pattern` does not occur under maps_to (= repo-relative scope_path)" with
    // verification_method='static_scan' + direction='backward' (a current-code
    // finding); mode='presence' reuses the file:line maps_to citation
    // (codePointerMapsTo) — no new citation grammar. Decidability (single
    // non-whitespace token + length cap + scope containment) is gated by core
    // validateAcOracle / the executor shape gate, NOT at parse time — a
    // non-decidable claim routes to advisory (coverage.ts isDecidableOraclePattern).
    pattern: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Fixed-string token claimed ABSENT under maps_to (mode=absence). Decidable iff single non-whitespace token within the length cap (coverage.ts ORACLE_PATTERN_TOKEN_RE / ORACLE_PATTERN_MAX_LENGTH)',
      ),
    mode: oracleMode
      .optional()
      .describe(
        'presence = cited file:line anchor exists; absence = pattern does not occur under maps_to (wi_260706n4w)',
      ),
  })
  .superRefine((value, ctx) => {
    if (value.direction === 'forward' && codePointerMapsTo.test(value.maps_to)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'forward oracle must be re-evaluable: a code-pointer maps_to (file:line / symbol) drifts on change — use direction=backward for a current-code finding (ADR-0024 §3.0)',
        path: ['maps_to'],
      });
    }
  })
  .describe('Per-AC oracle: re-evaluable verification method + anchor target (ADR-0024 §3)');

export const acceptanceCriterion = z
  .object({
    id: z.string().min(1).describe('Stable id within the work item (e.g., ac-1)'),
    statement: z.string().min(1).describe('Single observable behavior in user-facing terms'),
    verdict: verdict.default('unverified'),
    evidence: z.array(evidenceRef).default([]),
    // Additive + OPTIONAL (ADR-0024 §3): legacy ACs omit it and parse unchanged;
    // no schema_version bump (same idiom as autopilot_exempt / sourceDigest).
    oracle: acOracle.optional(),
    // Provenance of graded criteria replaced via `work set-criteria --supersede`
    // (prior statement + reason). Lock-with-provenance so a verified criterion is
    // not silently overwritten (goalpost-moving, charter §4-6). Additive + OPTIONAL:
    // legacy ACs omit it and parse unchanged; no schema_version bump.
    superseded: z
      .array(
        z.object({
          statement: z.string().min(1).describe('The prior (graded) statement that was replaced'),
          reason: z.string().min(1).describe('Why the prior criterion was superseded'),
        }),
      )
      .optional(),
    // wi_2607069bk §1.2 Finding E: the *kind of evidence* required per AC, lifted
    // from the intent sidecar (Run) onto the base AC (record.json / Record) so that
    // deleting intent.json loses no durable "required evidence kinds" info. Additive
    // + OPTIONAL (same idiom as oracle / superseded): a legacy work-item.json AC
    // omits it and parses unchanged — no schema_version bump. intentAcceptanceCriterion
    // now inherits this instead of re-declaring it (membership SoT = Record).
    evidence_required: z.array(evidenceRequiredKind).optional(),
  })
  .describe('One acceptance criterion with its verification verdict');

// wi_260625k0w ac-1: a git worktree+branch DITTO created for a work item. For a
// multi-repo workspace there is one entry per owning repo (`.` = the workspace
// repo, else the sub-repo's path relative to the workspace root). Additive +
// OPTIONAL on workItem (default []): legacy work-item.json omits it and parses
// unchanged — same idiom as changed_files, so no schema_version bump.
export const workItemWorktree = z
  .object({
    owning_repo: z
      .string()
      .min(1)
      .describe(
        "'.' for the workspace repo, else the sub-repo path relative to the workspace root",
      ),
    worktree_path: relativePath.describe(
      'Worktree checkout path, relative to the workspace repo root',
    ),
    branch: z.string().min(1).describe('Branch checked out in this worktree'),
  })
  .describe('One git worktree+branch DITTO created for a work item (one per owning repo)');

// Shared severity scale. riskNote applies a `.default('low')`; ac-4 follow_ups
// reference the SAME levels (info|low|medium|high|critical) without reinventing.
export const severityLevel = z.enum(['info', 'low', 'medium', 'high', 'critical']);

export const riskNote = z
  .object({
    description: z.string().min(1),
    severity: severityLevel.default('low'),
    mitigation: z.string().optional(),
  })
  .describe('Outstanding risk that did not block completion but remains relevant');

// ac-4 (wi_260626wnv): a discovered follow-up captured on the work item itself, so
// a lightweight WI (no intent.json) has a structured slot instead of prose-dumping
// on the user. kind=bug is materialized into a tracked, back-linked WI (its id is
// stamped on materialized_wi); kind=idea is recorded as a candidate only. A
// self-caused high/critical bug that is not resolved blocks the source WI's `done`.
export const followUp = z
  .object({
    kind: z
      .enum(['bug', 'idea'])
      .describe('bug = a defect materialized into a tracked WI; idea = a candidate only'),
    note: z.string().min(1).describe('What was discovered'),
    severity: severityLevel.optional(),
    self_caused: z
      .boolean()
      .optional()
      .describe('True if this regression was introduced by the source work item itself'),
    materialized_wi: workItemId
      .optional()
      .describe('The tracked work item this bug was materialized into (kind=bug only)'),
    resolved: z.boolean().optional().describe('True once the follow-up has been addressed'),
    // ac-2 (wi_260710tjd): OPTIONAL, ADVISORY display-ordering rank. 1 = surfaced
    // first (most urgent) … 5 = last; mirrors the 5-level severityLevel discipline.
    // It ONLY orders the follow_ups_to_pick_up surfacing — it drives NOTHING
    // (no-auto-pick preserved, ADR-20260627); no node-selection or drive path reads it.
    priority: z
      .number()
      .int()
      .min(1)
      .max(5)
      .optional()
      .describe('Advisory pick-up ordering rank (1=first…5=last); display-only, drives nothing'),
  })
  .describe('A discovered follow-up (bug/idea) captured on the work item');

// ac-3 (wi_260626wnv): a work item's own declared risk axis. Same vocabulary as
// gates.ts RiskAxes / the deep-interview risk axis (non_local/irreversible/
// unaudited) — do NOT invent new names. Drives the risk-driven heavy nudge
// (user-prompt-submit) and the lightweight-close override gate (work done) when
// no intent.json was ever produced. Each flag is optional so a partial
// declaration (`--risk irreversible`) records only what was asserted.
export const declaredRisk = z
  .object({
    non_local: z.boolean().optional(),
    irreversible: z.boolean().optional(),
    unaudited: z.boolean().optional(),
  })
  .describe('Work-item-declared risk flags (gates.ts RiskAxes vocabulary)');

// M1 (wi_260628d79): singular link from a work item to ONE GitHub issue (1 WI ↔ 1
// issue, v1 — not an array). `posted_decision_ids` tracks G8 direct-post idempotency
// (a later node marks ids it has already posted; here we only declare the field).
export const githubIssueLink = z
  .object({
    repo: z.string().min(1).describe('owner/name of the repo that owns the issue'),
    number: z.number().int().describe('Issue number within the repo'),
    node_id: z.string().optional().describe('GraphQL node id of the issue'),
    project_item_id: z
      .string()
      .optional()
      .describe('Projects v2 item id once the issue is added to a board'),
    posted_decision_ids: z
      .array(z.string())
      .optional()
      .describe('Decision-log ids already posted to this issue (G8 post idempotency)'),
    // wi_2606287v9 (#5) ac-1: branch/session-grain CLAIM occupancy markers. These
    // record whether THIS session/branch claimed the issue (so the same @me on a
    // different branch is distinguishable). NOT a cache of the GitHub assignee —
    // read-back stays SoT (ADR-20260628-github-backlog-sot); store only what
    // idempotency + branch-grain needs. Additive + OPTIONAL; no schema_version bump.
    claimed_branch: z
      .string()
      .min(1)
      .optional()
      .describe('Branch name THIS session claimed the issue on (branch-grain occupancy)'),
    posted_claim_markers: z
      .array(z.string())
      .optional()
      .describe('Claim markers already posted to this issue (claim-post idempotency)'),
  })
  .describe('Singular GitHub issue this work item is linked to (1 WI ↔ 1 issue, v1)');

export const reEntry = z
  .object({
    command: z.string().optional().describe('Concrete next command to resume work'),
    fresh_evidence_needed: z
      .array(z.string())
      .default([])
      .describe('What new evidence must be gathered before the next attempt'),
    owner: z.string().optional().describe('Profile or human handle expected to resume'),
  })
  .describe('Instructions for resuming a partial/unverified/blocked work item');

export const workItem = z
  .object({
    schema_version: schemaVersion,
    id: workItemId,
    title: z.string().min(1).max(200),
    source_request: z
      .string()
      .min(1)
      .describe('Verbatim or close-paraphrase of the original user request'),
    goal: z
      .string()
      .min(1)
      .describe('Observable outcome stated in project terms; not a list of steps'),
    acceptance_criteria: z.array(acceptanceCriterion).min(1),
    status: workItemStatus.default('draft'),
    owner_profile: profileName.default('workspace-write'),
    parent_id: workItemId.optional().describe('Parent work item if this is a child task'),
    child_ids: z.array(workItemId).default([]),
    changed_files: z.array(relativePath).default([]),
    // wi_260625k0w ac-1: git worktree(s)+branch(es) DITTO created for this work
    // item, recorded so cleanup/teardown knows what to tear down. Additive +
    // OPTIONAL (default []), no schema_version bump (same idiom as changed_files).
    worktrees: z.array(workItemWorktree).default([]),
    // (B) plan→autopilot transition escape hatch (wi_260615xby). When true, the
    // Stop gate lets this work item close on a completion.json ALONE without ever
    // bootstrapping autopilot — the explicit "this work did not need the
    // finalize→bootstrap→drive path" marker. Optional + additive: a legacy
    // work-item.json omits it and parses + behaves exactly as before.
    autopilot_exempt: z
      .boolean()
      .optional()
      .describe('Allow closing on completion.json alone without going through autopilot'),
    // ac-3 (wi_260626wnv): the work item's own declared risk axis. Additive +
    // OPTIONAL: a legacy work-item.json omits it and parses unchanged; no
    // schema_version bump (same idiom as autopilot_exempt).
    declared_risk: declaredRisk.optional(),
    // ac-3 (wi_260626wnv): set by `work promote` to mark a lightweight WI for the
    // heavy (deep-interview) path in place — no abandon+recreate. Keeps the
    // risk-driven heavy nudge firing after the placeholder was replaced by real
    // criteria. Additive + OPTIONAL; no schema_version bump.
    promoted_to_heavy: z
      .boolean()
      .optional()
      .describe('Marked for the heavy (deep-interview) path via `work promote`'),
    // ac-4 (wi_260626wnv): discovered follow-ups captured on the WI itself.
    // Additive + OPTIONAL: a legacy work-item.json omits it and parses unchanged;
    // no schema_version bump (same idiom as declared_risk / autopilot_exempt).
    follow_ups: z.array(followUp).optional(),
    // ac-4 (wi_260626wnv): provenance link — the WI whose `follow-up --kind bug`
    // materialized THIS work item. Distinct from parent_id (task hierarchy); kept
    // separate on purpose. Additive + OPTIONAL; no schema_version bump.
    discovered_by: workItemId
      .optional()
      .describe('Work item whose discovered bug materialized this one (provenance, not hierarchy)'),
    // ac-5 (wi_260626wnv): chain lineage edge — "this WI continues from the named
    // predecessor". Models a sequential lineage (vjo→227h→258zu→…), which the
    // parent_id tree / dead child_ids could not. Drives the derived `work stem`
    // view + bulk close. Additive + OPTIONAL: a legacy work-item.json omits it and
    // parses unchanged; no schema_version bump (same idiom as discovered_by).
    follows: workItemId
      .optional()
      .describe(
        'Predecessor work item this one continues from (chain lineage, not the parent_id tree)',
      ),
    // M1 (wi_260628d79) ac-8: singular link to a GitHub issue. Additive + OPTIONAL:
    // a legacy work-item.json omits it and parses + behaves unchanged; no
    // schema_version bump (same idiom as declared_risk / autopilot_exempt).
    github_issue: githubIssueLink.optional(),
    risks: z.array(riskNote).default([]),
    re_entry: reEntry.optional(),
    runs: z.array(runId).default([]),
    handoff_path: relativePath.optional(),
    language_overrides: relativePath
      .optional()
      .describe('Path to language.md if this work item modifies the glossary'),
    started_at_sha: gitSha40
      .optional()
      .describe(
        'Git HEAD sha at the time this work item transitioned draft → in_progress; used as default base for handoff diff collection',
      ),
    // wi_260710s4j: untracked (`??`) paths already present in the working tree at the
    // draft → in_progress edge — a one-shot baseline of FOREIGN dirt that predated the
    // run, so autopilot's later `changed_files` accounting can exclude it. Captured EDGE-
    // only (no lazy backfill, unlike started_at_sha) and omitted when git is unavailable.
    // Additive + OPTIONAL: a legacy work-item.json omits it and parses unchanged; no
    // schema_version bump (same idiom as changed_files / started_at_sha).
    started_untracked_baseline: z.array(relativePath).optional(),
    created_at: isoDateTime,
    updated_at: isoDateTime,
    closed_at: isoDateTime.optional(),
  })
  .superRefine((value, ctx) => {
    const needsReEntry = (['partial', 'unverified', 'blocked'] as const).includes(
      value.status as 'partial' | 'unverified' | 'blocked',
    );
    if (!needsReEntry) return;
    if (!value.re_entry) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `status=${value.status} requires re_entry with command or fresh_evidence_needed`,
        path: ['re_entry'],
      });
      return;
    }
    const hasCommand =
      typeof value.re_entry.command === 'string' && value.re_entry.command.length > 0;
    const hasEvidence = value.re_entry.fresh_evidence_needed.length > 0;
    if (!hasCommand && !hasEvidence) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `status=${value.status} requires re_entry.command or non-empty re_entry.fresh_evidence_needed`,
        path: ['re_entry'],
      });
    }
  })
  .describe('Authoritative state for a single DITTO work item');

// wi_2607069bk §1.1/§2.1 — one entry of the committed per-event immutable log
// (`.ditto/work-items/<id>/events/<seq>.<actor>.<eid>.json`, one event per file,
// `open(wx)`). get() = record.json + fold over these events. Ordering is by
// (seq, actor), NEVER by ts (clock-skew safe); event_id is the content-hash dedupe
// key that makes re-append idempotent. This node adds the SCHEMA only — the
// reducer / store / consumer wiring lands in later nodes.
//
// B1 boundary (§4 B1): the spec-freshness stamp `source_digest` deliberately stays
// on intent.json (Run, intent.ts sourceDigest); neither the work-item Record
// (record.json) nor this event log models it — durable decisions (AC, scope,
// evidence_required) live in the Record, the digest is Run-tier and droppable.
const workItemEventBase = {
  schema_version: schemaVersion,
  work_item_id: workItemId,
  // REQUIRED, per-writer monotonic (Lamport-like); with `actor` it is the ordering
  // key. NOT nullable/defaulted — a missing seq is an invalid event.
  seq: z.number().int().nonnegative().describe('Per-writer monotonic sequence; (seq,actor) orders'),
  // REQUIRED, writer identity (profile/session). Tiebreaks equal seq across writers.
  actor: z
    .string()
    .min(1)
    .describe('Writer identity (profile/session); (seq,actor) order tiebreak'),
  // REQUIRED, content-hash over {kind, payload core}; the dedupe / idempotency key.
  event_id: z.string().min(1).describe('Content-hash dedupe key (idempotent re-append)'),
  // Informational ONLY — never used for ordering (clock-skew safe).
  ts: isoDateTime.describe('When the event was written; informational only, not an ordering key'),
};

// status transition: to + derived closed_at (nullable so reopen DROPS the timestamp).
const workItemStatusEventPayload = z
  .object({
    to: workItemStatus,
    closed_at: isoDateTime.nullable().optional().describe('Set on terminal; null clears on reopen'),
  })
  .describe('status event payload (§1.1)');

// AC verdict: criterion_id + verdict + evidence pointers (evidenceRef, digest-safe).
const workItemVerdictEventPayload = z
  .object({
    criterion_id: z.string().min(1).describe('The AC id this verdict is for'),
    verdict,
    evidence: z.array(evidenceRef).default([]),
  })
  .describe('AC verdict event payload (§1.1)');

// github idempotency markers (posted decision / claim). union-folded; a
// claim_release invalidates the matching marker.
const workItemGithubPostEventPayload = z
  .object({
    posted_decision_id: z.string().optional().describe('Decision-log id posted to the issue'),
    posted_claim_marker: z.string().optional().describe('Claim marker posted to the issue'),
    claimed_branch: z.string().optional().describe('Branch this post claimed the issue on'),
  })
  .describe('github_post idempotency event payload (§1.1 / C5)');

const workItemClaimEventPayload = z
  .object({
    claimed_branch: z.string().optional().describe('Branch claiming/releasing the issue'),
    posted_claim_marker: z.string().optional().describe('Claim marker this event claims/releases'),
  })
  .describe('claim / claim_release event payload (§1.1 / C5)');

export const workItemEvent = z
  .discriminatedUnion('kind', [
    z.object({
      ...workItemEventBase,
      kind: z.literal('status'),
      payload: workItemStatusEventPayload,
    }),
    z.object({
      ...workItemEventBase,
      kind: z.literal('verdict'),
      payload: workItemVerdictEventPayload,
    }),
    z.object({
      ...workItemEventBase,
      kind: z.literal('github_post'),
      payload: workItemGithubPostEventPayload,
    }),
    z.object({
      ...workItemEventBase,
      kind: z.literal('claim'),
      payload: workItemClaimEventPayload,
    }),
    z.object({
      ...workItemEventBase,
      kind: z.literal('claim_release'),
      payload: workItemClaimEventPayload,
    }),
  ])
  .describe('One entry of the committed per-event immutable work-item log (wi_2607069bk §2.1)');

export type WorkItemEvent = z.infer<typeof workItemEvent>;

export type WorkItem = z.infer<typeof workItem>;
export type WorkItemWorktree = z.infer<typeof workItemWorktree>;
export type FollowUp = z.infer<typeof followUp>;
export type DeclaredRisk = z.infer<typeof declaredRisk>;
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterion>;
export type AcOracle = z.infer<typeof acOracle>;
export type ReEntry = z.infer<typeof reEntry>;
export type GithubIssueLink = z.infer<typeof githubIssueLink>;
