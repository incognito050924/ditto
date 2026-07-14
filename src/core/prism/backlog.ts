import { z } from 'zod';
import { PLACEHOLDER_AC_STATEMENT } from '~/core/charter';
import type { WorkItemStore } from '~/core/work-item-store';
import { isoDateTime, schemaVersion, workItemId } from '~/schemas/common';
import { verificationMethod } from '~/schemas/work-item';
import type { DesignDocInput } from './designdoc';
import type { PrismStore } from './store';

/**
 * prism backlog-split mechanism (wi_260707oi1, ac-8).
 *
 * Confirmed design doc → multi-WI split proposal → user-approval primitive →
 * per-item WI-draft materialization. The four load-bearing guarantees:
 *   - approval primitive: the evidence is the user's OWN words (a bare CLI call is
 *     NOT approval), reusing the deep-interview `userConfirmation` evidence-bearing
 *     pattern + who/when attribution;
 *   - AUTH-2 no-auto-drive: materialize produces WI DRAFTS only — NO intent.json is
 *     written (the per-item intent compile is deferred to pickup), so the bootstrap
 *     empty-set defense stays intact and nothing is auto-started;
 *   - idempotent per-item back-link: each materialized item is back-linked to the
 *     parent immediately, so a partial-failure re-run never duplicates;
 *   - 0·1 boundaries + per-item AC + verification method (no placeholder leak).
 *
 * The schema is defined here (co-located in the prism core module) rather than in
 * `src/schemas/prism.ts`: this node's mutating lease does not cover that file, so
 * the zod SoT for the split shape lives beside its only consumer.
 */

// One acceptance criterion of a split item: a real statement + its verification
// method (ADR-0024 re-evaluability class). No vague placeholder is admissible.
export const prismSplitItemAc = z
  .object({
    statement: z
      .string()
      .min(1)
      .describe('Observable criterion in user-facing terms (not a placeholder)'),
    verification_method: verificationMethod,
  })
  .describe('One split-item acceptance criterion: statement + verification method');

export type PrismSplitItemAc = z.infer<typeof prismSplitItemAc>;

// One proposed split item = a future work item (title + goal + its OWN AC set).
export const prismSplitItem = z
  .object({
    title: z.string().min(1),
    goal: z.string().min(1),
    acceptance_criteria: z.array(prismSplitItemAc).min(1),
  })
  .describe('One proposed backlog-split item (materializes into one WI draft)');

export type PrismSplitItem = z.infer<typeof prismSplitItem>;

// Approval primitive — reuse the deep-interview userConfirmation evidence-bearing
// pattern (evidence = the user's own words, NOT a bare boolean) + who/when
// attribution. `confirmed=true` requires a non-empty statement (same superRefine as
// interview-state.ts userConfirmation), so a bare CLI invocation cannot approve.
export const prismSplitApproval = z
  .object({
    confirmed: z.boolean().describe('The user approved the backlog-split proposal'),
    statement: z
      .string()
      .default('')
      .describe("The user's own words approving; required (non-empty) when confirmed=true"),
    approved_by: z.string().min(1).describe('Who approved (attribution)'),
    approved_at: isoDateTime.describe('When the approval was captured'),
  })
  .superRefine((value, ctx) => {
    if (value.confirmed && value.statement.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'confirmed=true requires the user statement (evidence, not a bare boolean)',
        path: ['statement'],
      });
    }
  })
  .describe('Evidence-bearing user approval of the split (user words + who/when)');

export type PrismSplitApproval = z.infer<typeof prismSplitApproval>;

// The durable (Record-tier) split record: the proposal items, the one-time approval
// (present once approved), and the per-item back-links (the idempotency ledger).
export const prismBacklogSplit = z
  .object({
    schema_version: schemaVersion,
    work_item_id: workItemId,
    items: z.array(prismSplitItem).default([]),
    approval: prismSplitApproval.optional(),
    materialized: z
      .array(z.object({ item_key: z.string().min(1), wi_id: workItemId }))
      .default([])
      .describe(
        'Per-item back-link ledger (item_key → materialized WI id) — the idempotency record',
      ),
  })
  .describe('Prism backlog-split record: proposal + approval + per-item materialization ledger');

export type PrismBacklogSplit = z.infer<typeof prismBacklogSplit>;

// ── shared item validation (no placeholder leak) ───────────────────────────────

/**
 * A vague/placeholder AC statement — the exact placeholder constant or a bare "TBD"
 * lead — must NOT leak through as a materialized criterion (decision 5). The schema
 * already rejects an empty statement (min(1)); this catches the placeholder shapes.
 */
function isPlaceholderStatement(statement: string): boolean {
  const s = statement.trim();
  return s === PLACEHOLDER_AC_STATEMENT || /^TBD\b/i.test(s);
}

function zodReasons(prefix: string, err: z.ZodError): string {
  return `${prefix}: ${err.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`;
}

/**
 * Validate + parse the proposed split items. Each item must be schema-valid AND
 * carry a non-placeholder AC statement. Shared by propose (proposal time) and
 * materialize (defense-in-depth, so a placeholder cannot leak even if the persisted
 * record was tampered with). A 0-item list is valid (the empty boundary).
 */
function validateSplitItems(
  items: readonly unknown[],
): { ok: true; items: PrismSplitItem[] } | { ok: false; reasons: string[] } {
  const reasons: string[] = [];
  const parsed: PrismSplitItem[] = [];
  items.forEach((raw, i) => {
    const p = prismSplitItem.safeParse(raw);
    if (!p.success) {
      reasons.push(zodReasons(`분할 항목 ${i + 1} 형식 오류`, p.error));
      return;
    }
    for (const ac of p.data.acceptance_criteria) {
      if (isPlaceholderStatement(ac.statement)) {
        reasons.push(
          `분할 항목 ${i + 1}의 완료 조건이 아직 내용 없는 임시 문구예요: "${ac.statement}" — 눈으로 확인할 수 있는 실제 기준으로 바꿔 주세요`,
        );
      }
    }
    parsed.push(p.data);
  });
  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, items: parsed };
}

// ── propose ──────────────────────────────────────────────────────────────────

export type ProposeSplitResult =
  | { status: 'proposed'; items: PrismSplitItem[] }
  | { status: 'rejected'; reasons: string[] };

/**
 * Produce a split proposal from a CONFIRMED design doc + the proposed items. A
 * design doc counts as confirmed only when it carries real content (feature +
 * summary + ≥1 acceptance criterion) — an empty/unconfirmed doc cannot seed a
 * split. Each proposed item's AC must be non-empty and NOT the placeholder — no
 * vague criterion leaks through. A 0-item proposal is VALID (the empty boundary):
 * it proposes nothing to materialize.
 */
export function proposeBacklogSplit(
  doc: DesignDocInput,
  items: readonly unknown[],
): ProposeSplitResult {
  const reasons: string[] = [];
  if (doc.feature.trim().length === 0)
    reasons.push('설계 문서가 아직 확정되지 않았어요: 기능 이름이 비어 있어요');
  if (doc.summary.trim().length === 0)
    reasons.push('설계 문서가 아직 확정되지 않았어요: 요약이 비어 있어요');
  if (doc.acceptanceCriteria.length === 0)
    reasons.push('설계 문서가 아직 확정되지 않았어요: 완료 조건이 없어요 — 내용이 빈 상태로는 나눌 수 없어요');

  const itemCheck = validateSplitItems(items);
  if (!itemCheck.ok) reasons.push(...itemCheck.reasons);

  if (reasons.length > 0) return { status: 'rejected', reasons };
  return { status: 'proposed', items: itemCheck.ok ? itemCheck.items : [] };
}

// ── materialize ────────────────────────────────────────────────────────────────

export interface MaterializeDeps {
  workItems: WorkItemStore;
  prism: PrismStore;
  parentId: string;
  approval: PrismSplitApproval;
}

export type MaterializeSplitResult =
  | { status: 'materialized'; materialized_wis: string[] }
  | { status: 'rejected'; reasons: string[] };

/** Stable per-item ledger key (index within a persisted, immutable proposal). */
function itemKey(index: number): string {
  return `item-${index}`;
}

/**
 * Materialize the persisted split proposal into per-item WI DRAFTS — ONLY when the
 * approval primitive carries the user's own words. See the module header for the
 * four guarantees. Idempotent per item via the persisted back-link ledger: each
 * created WI's ledger entry is written IMMEDIATELY, so a partial-failure re-run
 * skips what already landed and never duplicates.
 */
export async function materializeBacklogSplit(
  deps: MaterializeDeps,
): Promise<MaterializeSplitResult> {
  const { workItems, prism, parentId, approval } = deps;

  // Approval-primitive gate (AUTH). A bare invocation (confirmed=false or an empty
  // statement) is NOT approval — the evidence must be the user's own words.
  const parsedApproval = prismSplitApproval.safeParse(approval);
  if (
    !parsedApproval.success ||
    !parsedApproval.data.confirmed ||
    parsedApproval.data.statement.trim().length === 0
  ) {
    return {
      status: 'rejected',
      reasons: [
        '승인이 없어요: 물화(승인된 제안을 실제 작업 항목으로 만드는 것)하려면 사용자가 직접 쓴 승인 문장이 필요해요 — 명령만 실행하는 것으로는 승인으로 인정되지 않아요',
      ],
    };
  }

  const split = await prism.readBacklogSplit(parentId);
  if (split === null) {
    return {
      status: 'rejected',
      reasons: [`나눌 제안이 아직 없어요: ${parentId}에 대한 분할 제안을 먼저 만들어 주세요`],
    };
  }

  // Defense-in-depth: re-validate the persisted items (no placeholder leak).
  const itemCheck = validateSplitItems(split.items);
  if (!itemCheck.ok) return { status: 'rejected', reasons: itemCheck.reasons };

  const ledger = new Map(split.materialized.map((m) => [m.item_key, m.wi_id]));
  const materialized_wis: string[] = [];
  let current: PrismBacklogSplit = split;

  for (const [i, item] of itemCheck.items.entries()) {
    const key = itemKey(i);
    const already = ledger.get(key);
    if (already !== undefined) {
      // Idempotent: this item already materialized (a prior run) — reuse, no dup.
      materialized_wis.push(already);
      continue;
    }
    // Materialize ONE WI DRAFT: its OWN AC (statement + verification method on the
    // oracle), back-linked to the parent via discovered_by. store.create writes NO
    // intent.json (no-auto-drive) and leaves status='draft' (not auto-started).
    const created = await workItems.create({
      title: item.title.slice(0, 200),
      source_request: `Backlog split of ${parentId}: ${item.goal}`,
      goal: item.goal,
      acceptance_criteria: item.acceptance_criteria.map((ac, j) => ({
        id: `ac-${j + 1}`,
        statement: ac.statement,
        verdict: 'unverified' as const,
        evidence: [],
        oracle: {
          verification_method: ac.verification_method,
          maps_to: 'intent',
          direction: 'forward' as const,
        },
      })),
      discovered_by: parentId,
    });
    materialized_wis.push(created.id);
    // Persist the back-link IMMEDIATELY (per-item idempotency ledger).
    current = await prism.writeBacklogSplit({
      ...current,
      materialized: [...current.materialized, { item_key: key, wi_id: created.id }],
    });
    ledger.set(key, created.id);
  }

  // Record the one-time approval (durable, auditable): the user's own words + who/when.
  await prism.writeBacklogSplit({ ...current, approval: parsedApproval.data });

  return { status: 'materialized', materialized_wis };
}
