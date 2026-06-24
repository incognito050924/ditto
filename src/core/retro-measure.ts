/**
 * Retro measurement + narrative projection + memory absorption (ADR-0024 결정4).
 *
 * The retrospective node PRESENTS what these deterministic pieces assemble; it
 * never invents the metrics or the narrative. Two distinct responsibilities:
 *
 *   ac-4 — `assembleRetroMetrics`: TWO metrics KEPT SEPARATE (never merged into
 *     one number): ① 산출물 floor (completion-coverage ratio + unit-only-closure
 *     aggregate + escape-ledger recurrence) and ② 과정 건강도 (intent-quality
 *     post_cost). Anti-SLOP: a slot is emitted ONLY when its grounding is present
 *     (re-evaluable); an ungrounded slot is OMITTED — a placeholder zero would be
 *     an inducement bias (the slot's mere presence reads as signal). But a retro
 *     with ZERO grounded slots renders an EXPLICIT "no measurable signal" marker,
 *     not a silent omit-all (a silently-empty retro is indistinguishable from a
 *     missing one — the discovered-category gap the far-field sweep flagged).
 *
 *   ac-5 — `projectRetroNarrative` + `absorbRetroMemory`: the narrative is a pure
 *     PROJECTION of records the run already wrote (unverified/residual verdicts,
 *     close_reason, intent-drift, evidence refs) — no free-form generation. Its
 *     DURABLE part is absorbed into cross-WI memory via the existing append path,
 *     idempotently (a stable per-WI event id) and FILTERED (process-health noise
 *     never enters the durable warm-start prior).
 */

import type { MemoryEvent } from '~/schemas/memory-event';
import type { MemoryEventStore } from './memory-store';
import { sha256Hex } from './memory-store';

// ── ac-4: two SEPARATED metrics ──────────────────────────────────────────────

/**
 * Grounding inputs for the retro metrics, each pre-collected by the caller. A
 * value present (incl. a real `0`) means the signal was re-evaluated and is
 * grounded; `undefined`/`null` means the data was absent/unreadable → the slot is
 * OMITTED (never zeroed). Keeping the two groups' inputs flat here lets the
 * assembler decide present-or-omit independently per slot.
 */
export interface RetroMetricInputs {
  // ① 산출물 floor
  /** completion-coverage ratio (closed-by-evidence / total acceptance). */
  coverage?: number | null;
  /** count of unit-only (falsely-green) closures across the work item. */
  unit_only_closures?: number | null;
  /** escape-ledger recurrence count for this work item's categories. */
  escape_recurrence?: number | null;
  // ② 과정 건강도
  /** intent-quality post-intent cost (drift + rework + retries + handoffs). */
  post_cost?: number | null;
}

/** ① 산출물 floor — each sub-slot present only when its input was grounded. */
export interface RetroOutcomeFloor {
  coverage?: number;
  unit_only_closures?: number;
  escape_recurrence?: number;
}

/** ② 과정 건강도 — present only when post_cost was grounded. */
export interface RetroProcessHealth {
  post_cost: number;
}

/**
 * The two metrics, KEPT SEPARATE. Each group is omitted entirely when none of its
 * sub-slots are grounded. When BOTH groups are omitted, `no_measurable_signal` is
 * set so the retro renders an explicit marker instead of a silent empty.
 */
export interface RetroMetrics {
  outcome_floor?: RetroOutcomeFloor;
  process_health?: RetroProcessHealth;
  /** Set true iff zero slots were grounded — explicit "no measurable signal". */
  no_measurable_signal?: true;
}

/** A grounded numeric input is a finite number (a real `0` counts; null/undefined do not). */
function grounded(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * Assemble the two SEPARATED retro metrics from grounding inputs (ac-4). Pure.
 * Each slot is present iff its input was grounded; the two groups never merge into
 * one scalar; zero grounded slots ⇒ explicit `no_measurable_signal`.
 */
export function assembleRetroMetrics(inputs: RetroMetricInputs): RetroMetrics {
  const outcome: RetroOutcomeFloor = {};
  if (grounded(inputs.coverage)) outcome.coverage = inputs.coverage;
  if (grounded(inputs.unit_only_closures)) outcome.unit_only_closures = inputs.unit_only_closures;
  if (grounded(inputs.escape_recurrence)) outcome.escape_recurrence = inputs.escape_recurrence;

  const metrics: RetroMetrics = {};
  if (Object.keys(outcome).length > 0) metrics.outcome_floor = outcome;
  if (grounded(inputs.post_cost)) metrics.process_health = { post_cost: inputs.post_cost };

  // Whole-empty → explicit marker, never a silent omit-all (an empty retro must be
  // distinguishable from a missing one).
  if (!metrics.outcome_floor && !metrics.process_health) {
    return { no_measurable_signal: true };
  }
  return metrics;
}

// ── ac-5: projection-only narrative ──────────────────────────────────────────

/**
 * The run's existing records the narrative projects from. Each field is content
 * the run ALREADY wrote; the projector copies, never generates. `process_health_note`
 * is process-health context that may sit next to the narrative but is FILTERED OUT
 * of durable cross-WI absorption (it would pollute the warm-start prior).
 */
export interface RetroNarrativeRecords {
  work_item_id: string;
  /** completion `unverified[].item` strings (what was not verified). */
  unverified: string[];
  /** completion `remaining_risks` / residual-risk ledger rows. */
  residual_risks: string[];
  /** coverage `close_reason` justifications for skipped/deferred categories. */
  close_reasons: string[];
  /** persisted intent-drift event descriptions. */
  intent_drift: string[];
  /** evidence ref pointers (decision id / commit / file:line). */
  evidence_refs: string[];
  /** process-health context (e.g. post_cost churn) — NOT memory-eligible. */
  process_health_note?: string;
}

/** One projected narrative line: the kind it came from + the verbatim record text. */
export interface RetroNarrativeItem {
  kind: 'unverified' | 'residual' | 'close_reason' | 'intent_drift' | 'evidence';
  /** Whether this line is durable cross-WI learning (absorbed) vs process noise. */
  memory_eligible: boolean;
  text: string;
}

export interface RetroNarrative {
  work_item_id: string;
  items: RetroNarrativeItem[];
}

/**
 * Project the retro narrative strictly from existing records (ac-5). PURE and
 * copy-only: every item's `text` is verbatim from a passed record — nothing is
 * generated, so a fact not in `records` can never appear. The memory-eligibility
 * flag marks which kinds are durable cross-WI learning (absorbed) vs process noise
 * (`process_health_note`, kept for the live retro view but never absorbed).
 */
export function projectRetroNarrative(records: RetroNarrativeRecords): RetroNarrative {
  const items: RetroNarrativeItem[] = [];
  for (const text of records.unverified)
    items.push({ kind: 'unverified', memory_eligible: true, text });
  for (const text of records.residual_risks)
    items.push({ kind: 'residual', memory_eligible: true, text });
  for (const text of records.close_reasons)
    items.push({ kind: 'close_reason', memory_eligible: true, text });
  for (const text of records.intent_drift)
    items.push({ kind: 'intent_drift', memory_eligible: true, text });
  for (const text of records.evidence_refs)
    items.push({ kind: 'evidence', memory_eligible: true, text });
  // Process-health note is carried for the live retro but flagged non-eligible so
  // the absorption filter drops it (no post_cost noise in durable priors).
  if (records.process_health_note) {
    items.push({ kind: 'evidence', memory_eligible: false, text: records.process_health_note });
  }
  return { work_item_id: records.work_item_id, items };
}

// ── ac-5: cross-WI memory absorption (idempotent + filtered) ──────────────────

/**
 * Stable memory-event id for a work item's retro absorption (idempotency key).
 * Derived deterministically from the work item id so re-driving the retro
 * (re-entering the node) targets the SAME event id; the immutable `append` ('wx')
 * then fails-loud on the duplicate, which `absorbRetroMemory` catches → one event.
 * sha256 keeps it within the `memevt_[a-z0-9_-]{4,}` event-id regex.
 */
export function retroMemoryEventId(workItemId: string): string {
  return `memevt_retro_${sha256Hex(workItemId).slice(0, 16)}`;
}

export interface AbsorbOptions {
  /** RFC3339 timestamp, injected for determinism (never read from the clock here). */
  createdAt: string;
  /** Agent role recorded as the event author. */
  actorRole: string;
}

export interface AbsorbResult {
  /** true when a new durable event was written; false when nothing eligible or already absorbed. */
  appended: boolean;
  event?: MemoryEvent;
}

/**
 * The `memoryEvent.text` zod ceiling (`.max(4000)` in src/schemas/memory-event.ts).
 * A large but legitimate retro can assemble more eligible-item text than this; the
 * absorb must NOT throw the ZodError (the loop swallows it → a real retro lost with
 * NO log — charter: no silent failure). Truncation over silent-drop: the projection
 * is bounded record content, so a truncated record still carries the durable signal.
 */
const MEMORY_EVENT_TEXT_MAX = 4000;
const TRUNCATION_MARKER = '\n…[truncated]';

/**
 * Cap the assembled narrative text to the memory-event schema ceiling, with a clear
 * truncation marker, so an oversized retro absorbs (truncated) instead of throwing.
 * Returns the text unchanged when it already fits.
 */
function capToMemoryEventLimit(text: string): string {
  if (text.length <= MEMORY_EVENT_TEXT_MAX) return text;
  const head = text.slice(0, MEMORY_EVENT_TEXT_MAX - TRUNCATION_MARKER.length);
  return head + TRUNCATION_MARKER;
}

/**
 * Absorb the retro narrative's DURABLE part into cross-WI memory (ac-5).
 *
 * Filter: only `memory_eligible` items are absorbed — process-health noise is
 * dropped so it never pollutes warm-start priors. A projection with no eligible
 * items absorbs nothing (no empty durable event).
 *
 * Bounded: the assembled text is capped to the memory-event schema ceiling (with a
 * truncation marker) so a large retro absorbs (truncated) rather than throwing a
 * swallowed ZodError (no silent failure).
 *
 * Idempotent: the event id is `retroMemoryEventId(work_item_id)` (a stable key), so
 * re-driving the retro re-targets the same id; the immutable append fails on the
 * duplicate and this returns `appended:false` instead of double-writing.
 */
export async function absorbRetroMemory(
  store: MemoryEventStore,
  narrative: RetroNarrative,
  opts: AbsorbOptions,
): Promise<AbsorbResult> {
  const eligible = narrative.items.filter((i) => i.memory_eligible);
  if (eligible.length === 0) return { appended: false };

  const text = capToMemoryEventLimit(eligible.map((i) => `[${i.kind}] ${i.text}`).join('\n'));
  const eventId = retroMemoryEventId(narrative.work_item_id);
  try {
    const event = await store.append({
      schema_version: '0.1.0',
      event_id: eventId,
      event_type: 'analysis',
      actor: { kind: 'agent', role: opts.actorRole },
      text,
      created_at: opts.createdAt,
      status: 'pending',
      sources: [],
      confidence_kind: 'EXTRACTED',
      sensitivity: 'internal',
      governs: [],
    });
    return { appended: true, event };
  } catch (err) {
    // Already absorbed (immutable append rejected the duplicate id) → idempotent
    // no-op. The MemoryEventExistsError name is matched structurally to avoid an
    // import cycle and to keep any other write error fail-loud.
    if (err instanceof Error && err.name === 'MemoryEventExistsError') {
      return { appended: false };
    }
    throw err;
  }
}
