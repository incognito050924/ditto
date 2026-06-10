import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Autopilot } from '~/schemas/autopilot';
import type { IntentContract } from '~/schemas/intent';
import { userConfirmation } from '~/schemas/interview-state';
import {
  type SpecSectionId as SchemaSectionId,
  type TechSpecState,
  specGroundingEvidence,
  specReviewState,
  specSectionId,
} from '~/schemas/tech-spec-state';
import { bootstrapAutopilot } from './autopilot-bootstrap';
import { type GateResult, type RiskAxes, interviewReadinessGate } from './gates';
import { IntentStore } from './intent-store';
import { InterviewStore } from './interview-store';
import { TechSpecStore } from './tech-spec-store';
import { WorkItemStore } from './work-item-store';

/**
 * tech-spec driver — the hard half of the `ditto:tech-spec` surface
 * (design: reports/design/tech-spec-surface-design.md §8).
 *
 * The spec document is the single source; `intent.json` is compiled from it at
 * finalize, one-way (no sync back). This module owns:
 *  - the section model shared by the template, the compiler, and the digest
 *  - `compileSpecDoc` — fail-closed markdown → intent-fields compile
 *  - `computeSpecDigest` — sha256 over the compile-input sections only
 *    (요약·목표·비목표·완료 조건·위험 — decided 2026-06-10: protect exactly what
 *    intent derives from; 배경/계획/마일스톤/인터뷰 기록 edits never force re-finalize)
 */

export const SPEC_SECTIONS: readonly { id: SchemaSectionId; title: string }[] = [
  { id: 'feature', title: '기능' },
  { id: 'summary', title: '요약' },
  { id: 'background', title: '배경' },
  { id: 'goals', title: '목표' },
  { id: 'non-goals', title: '비목표' },
  { id: 'acceptance-criteria', title: '완료 조건' },
  { id: 'risks', title: '위험' },
  { id: 'plan', title: '계획' },
  { id: 'impact', title: '영향도' },
  { id: 'rejected-alternatives', title: '기각된 대안' },
  { id: 'milestones', title: '마일스톤' },
  { id: 'interview-log', title: '인터뷰 기록' },
  { id: 'post-build', title: '빌드 후 처리' },
];

export type SpecSectionId = SchemaSectionId;

/** Sections whose text compiles into intent.json — the digest hash range. */
export const COMPILE_INPUT_SECTIONS: readonly SpecSectionId[] = [
  'summary',
  'goals',
  'non-goals',
  'acceptance-criteria',
  'risks',
];

/** Sections stating codebase/project facts — grounding evidence required (ac-9). */
export const FACTUAL_SECTIONS: readonly SpecSectionId[] = ['background', 'impact'];

const EVIDENCE_KINDS = new Set(['test', 'diff', 'doc', 'browser', 'log']);

/** `## 5. 비목표 (변경 경계) [장]` → `비목표 (변경 경계) [장]` */
function headingText(line: string): string {
  return line
    .replace(/^##\s+/, '')
    .replace(/^\d+\.\s*/, '')
    .trim();
}

function sectionIdFor(heading: string): SpecSectionId | null {
  for (const s of SPEC_SECTIONS) {
    if (heading.startsWith(s.title)) return s.id;
  }
  return null;
}

/** Normalize a section body so whitespace/EOL churn never moves the digest. */
function normalizeBody(body: string): string {
  return body
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.trimEnd())
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');
}

/** Split the doc into `## `-level sections keyed by the section model. */
export function parseSpecSections(markdown: string): {
  sections: Map<SpecSectionId, string>;
  duplicates: SpecSectionId[];
} {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const sections = new Map<SpecSectionId, string>();
  const duplicates: SpecSectionId[] = [];
  let current: SpecSectionId | null = null;
  let buf: string[] = [];
  const flush = () => {
    if (current === null) return;
    const body = normalizeBody(buf.join('\n'));
    if (sections.has(current)) duplicates.push(current);
    else sections.set(current, body);
  };
  for (const line of lines) {
    if (line.startsWith('## ')) {
      flush();
      current = sectionIdFor(headingText(line));
      buf = [];
    } else if (current !== null) {
      buf.push(line);
    }
  }
  flush();
  return { sections, duplicates };
}

/** sha256 over the compile-input sections only (the digest hash range). */
export function computeSpecDigest(markdown: string): string {
  const { sections } = parseSpecSections(markdown);
  const hash = createHash('sha256');
  for (const id of COMPILE_INPUT_SECTIONS) {
    hash.update(`${id}\n${sections.get(id) ?? ''}\0`);
  }
  return hash.digest('hex');
}

function listItems(body: string): string[] {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^([-*]|\d+\.)\s+/.test(l))
    .map((l) => l.replace(/^([-*]|\d+\.)\s+/, '').trim());
}

/** Markdown table body rows as trimmed cell arrays (header + divider skipped). */
function tableRows(body: string): string[][] {
  const rows = body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'))
    .map((l) =>
      l
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((c) => c.trim()),
    );
  // drop the header row and the |---|---| divider
  return rows.filter((cells, i) => i > 0 && !cells.every((c) => /^:?-+:?$/.test(c) || c === ''));
}

type CompiledFields = Pick<
  IntentContract,
  'goal' | 'in_scope' | 'out_of_scope' | 'acceptance_criteria' | 'unknowns'
>;

export type CompileResult =
  | { status: 'compiled'; fields: CompiledFields; digest: string }
  | { status: 'rejected'; reasons: string[] };

/**
 * Compile the spec document into intent fields (one-way, fail-closed).
 * Mapping is the template's contract: 요약→goal, 목표→in_scope, 비목표→out_of_scope,
 * 완료 조건 표→acceptance_criteria, 위험 표의 unknown 행→unknowns. Risk axes are NOT
 * derived from prose — the finalize payload carries them (agent judgment).
 */
export function compileSpecDoc(markdown: string): CompileResult {
  const { sections, duplicates } = parseSpecSections(markdown);
  const reasons: string[] = [];

  for (const dup of duplicates) {
    if (COMPILE_INPUT_SECTIONS.includes(dup)) {
      const title = SPEC_SECTIONS.find((s) => s.id === dup)?.title ?? dup;
      reasons.push(`섹션 "${title}"이 중복 정의됨 — 컴파일 원본이 모호함`);
    }
  }
  for (const id of COMPILE_INPUT_SECTIONS) {
    const title = SPEC_SECTIONS.find((s) => s.id === id)?.title ?? id;
    const body = sections.get(id);
    if (body === undefined) reasons.push(`필수 섹션 누락: "${title}"`);
    else if (body === '') reasons.push(`필수 섹션이 비어 있음: "${title}"`);
  }
  if (reasons.length > 0) return { status: 'rejected', reasons };

  const summary = sections.get('summary') as string;
  const goalsBody = sections.get('goals') as string;
  const nonGoalsBody = sections.get('non-goals') as string;
  const acBody = sections.get('acceptance-criteria') as string;
  const risksBody = sections.get('risks') as string;

  // AC table — the keystone. Reject duplicates / unknown evidence kinds / no rows.
  const acceptance_criteria: CompiledFields['acceptance_criteria'] = [];
  const seenIds = new Set<string>();
  for (const cells of tableRows(acBody)) {
    const [id, statement, evidenceCell] = [cells[0] ?? '', cells[1] ?? '', cells[2] ?? ''];
    if (!id || !statement) {
      reasons.push(`완료 조건 표의 행이 불완전함: "${cells.join(' | ')}"`);
      continue;
    }
    if (seenIds.has(id)) {
      reasons.push(`완료 조건 id 중복: ${id}`);
      continue;
    }
    seenIds.add(id);
    const kinds = evidenceCell.split(/[^a-z]+/i).filter((t) => t.length > 0);
    const invalid = kinds.filter((k) => !EVIDENCE_KINDS.has(k.toLowerCase()));
    if (kinds.length === 0 || invalid.length > 0) {
      reasons.push(
        `완료 조건 ${id}의 evidence 종류가 enum(test|diff|doc|browser|log) 밖: "${evidenceCell}"`,
      );
      continue;
    }
    acceptance_criteria.push({
      id,
      statement,
      verdict: 'unverified',
      evidence: [],
      evidence_required: kinds.map((k) => k.toLowerCase()) as never,
    });
  }
  if (acceptance_criteria.length === 0 && reasons.length === 0) {
    reasons.push('완료 조건 표에 행이 없음 — AC가 이 문서의 키스톤이다');
  }
  if (reasons.length > 0) return { status: 'rejected', reasons };

  // 위험 표에서 처리(2열)에 unknown이 표시된 행 → unknowns
  const unknowns = tableRows(risksBody)
    .filter((cells) => /unknown/i.test(cells[1] ?? ''))
    .map((cells) => cells[0] ?? '')
    .filter((s) => s.length > 0);

  return {
    status: 'compiled',
    fields: {
      goal: summary.trim(),
      in_scope: listItems(goalsBody).length > 0 ? listItems(goalsBody) : [goalsBody],
      out_of_scope: listItems(nonGoalsBody).length > 0 ? listItems(nonGoalsBody) : [nonGoalsBody],
      acceptance_criteria,
      unknowns,
    },
    digest: computeSpecDigest(markdown),
  };
}

// ── state machine drivers (start / record-section) ──────────────────────────

/**
 * record-section payload — the ac-9 hard gate lives HERE, in the schema:
 * factual sections (배경·영향도) require ≥1 grounding-query evidence
 * (memory projection_id or ACG artifact path); calls without it are rejected
 * at parse time, before any state is written (fail-closed pull gate, design §8).
 */
export const recordSectionPayload = z
  .object({
    section: z.object({
      id: specSectionId,
      review: specReviewState.default('pending'),
      evidence: z.array(specGroundingEvidence).default([]),
    }),
  })
  .superRefine((val, ctx) => {
    if (FACTUAL_SECTIONS.includes(val.section.id) && val.section.evidence.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['section', 'evidence'],
        message: `사실 섹션 "${val.section.id}"은 근거 조회 증거(memory projection_id 또는 ACG 산출물 경로)가 스키마 필수다 — 증거 없이 기록할 수 없음 (ac-9)`,
      });
    }
  });

export type RecordSectionPayload = z.infer<typeof recordSectionPayload>;

export interface StartTechSpecInput {
  workItemId: string;
  docPath: string;
  mode?: 'stepwise' | 'oneshot';
  now?: Date;
}

/** Initialize tech-spec-state.json. Mode defaults to stepwise (design §5). */
export async function startTechSpec(
  repoRoot: string,
  input: StartTechSpecInput,
): Promise<TechSpecState> {
  const nowIso = (input.now ?? new Date()).toISOString();
  return new TechSpecStore(repoRoot).write({
    schema_version: '0.1.0',
    work_item_id: input.workItemId,
    doc_path: input.docPath,
    mode: input.mode ?? 'stepwise',
    sections: [],
    finalized: null,
    updated_at: nowIso,
  });
}

export interface RecordSectionInput {
  workItemId: string;
  payload: RecordSectionPayload;
  now?: Date;
}

/** Upsert one section record (same id updates in place). Requires start first. */
export async function recordSection(
  repoRoot: string,
  input: RecordSectionInput,
): Promise<TechSpecState> {
  const store = new TechSpecStore(repoRoot);
  const state = await store.get(input.workItemId);
  const nowIso = (input.now ?? new Date()).toISOString();
  const record = {
    id: input.payload.section.id,
    review: input.payload.section.review,
    evidence: input.payload.section.evidence,
    recorded_at: nowIso,
  };
  const idx = state.sections.findIndex((s) => s.id === record.id);
  const sections =
    idx === -1
      ? [...state.sections, record]
      : state.sections.map((s, i) => (i === idx ? record : s));
  return store.write({ ...state, sections, updated_at: nowIso });
}

// ── finalize (tech-spec 전용 — deep-interview finalize 재사용 불가, design §8) ──

/**
 * Unlike deep-interview's finalizePayload, content fields (goal/AC/…) are NOT in
 * the payload — the document is the source and the compiler derives them. The
 * payload carries only what the doc cannot: risk-axes judgment, the optional
 * pre-approval source, and the user confirmation (2차 게이트, mode-invariant).
 */
export const finalizeTechSpecPayload = z.object({
  risk: z
    .object({
      non_local: z.boolean().default(false),
      irreversible: z.boolean().default(false),
      unaudited: z.boolean().default(false),
    })
    .default({ non_local: false, irreversible: false, unaudited: false }),
  approved_source: z.enum(['approved_spec', 'issue', 'prd', 'user']).optional(),
  user_confirmation: userConfirmation,
});

export type FinalizeTechSpecPayload = z.infer<typeof finalizeTechSpecPayload>;

export type FinalizeTechSpecResult =
  | { status: 'finalized'; intent: IntentContract; autopilot: Autopilot; state: TechSpecState }
  | { status: 'not_started' }
  | { status: 'doc_missing'; doc_path: string }
  | { status: 'compile_rejected'; reasons: string[] }
  // An interview happened during co-authoring and its readiness gate is still
  // blocked — finalize never bypasses it (ac-10). No interview at all is fine.
  | { status: 'interview_not_ready'; gate: GateResult }
  | { status: 'not_confirmed' };

export interface FinalizeTechSpecInput {
  workItemId: string;
  payload: FinalizeTechSpecPayload;
  now?: Date;
}

/**
 * Compile the spec document into intent.json (+source_digest), mirror the AC
 * into the work item, record per-section review coverage, and bootstrap
 * autopilot. Fail-closed at every gate; nothing is written before all gates
 * pass. Reuses IntentStore/bootstrapAutopilot so intent writer singularity
 * holds at the module level (design §10 — 순차 파이프라인 기각의 귀결).
 */
export async function finalizeTechSpec(
  repoRoot: string,
  input: FinalizeTechSpecInput,
): Promise<FinalizeTechSpecResult> {
  const specStore = new TechSpecStore(repoRoot);
  if (!(await specStore.exists(input.workItemId))) return { status: 'not_started' };
  const state = await specStore.get(input.workItemId);

  let markdown: string;
  try {
    markdown = await readFile(join(repoRoot, state.doc_path), 'utf8');
  } catch {
    return { status: 'doc_missing', doc_path: state.doc_path };
  }

  const compiled = compileSpecDoc(markdown);
  if (compiled.status === 'rejected') {
    return { status: 'compile_rejected', reasons: compiled.reasons };
  }

  // 인터뷰가 발생했으면 그 readiness 게이트 통과가 선행 조건 (우회 없음, ac-10).
  // 미발생이면 게이트 자체가 없다 — 강제 진입 없음. Interview state is read-only
  // here: tech-spec never mutates deep-interview's machine (zero diff, §5).
  const interviews = new InterviewStore(repoRoot);
  if (await interviews.exists(input.workItemId)) {
    const gate = interviewReadinessGate(await interviews.get(input.workItemId));
    if (!gate.pass) return { status: 'interview_not_ready', gate };
  }

  if (!input.payload.user_confirmation.confirmed) return { status: 'not_confirmed' };

  const items = new WorkItemStore(repoRoot);
  const workItem = await items.get(input.workItemId);
  const intent: IntentContract = {
    schema_version: '0.1.0',
    work_item_id: input.workItemId,
    source_request: workItem.source_request,
    goal: compiled.fields.goal,
    in_scope: compiled.fields.in_scope,
    out_of_scope: compiled.fields.out_of_scope,
    acceptance_criteria: compiled.fields.acceptance_criteria,
    unknowns: compiled.fields.unknowns,
    follow_up_candidates: [],
    question_policy: 'ask_only_if_user_only_can_answer',
    source_digest: { doc_path: state.doc_path, sha256: compiled.digest },
  };
  const writtenIntent = await new IntentStore(repoRoot).write(intent);

  // Mirror AC into the work item so completionGate cross-checks align (same
  // contract as interview finalize).
  await items.update(input.workItemId, (current) => ({
    ...current,
    acceptance_criteria: compiled.fields.acceptance_criteria.map((ac) => ({
      id: ac.id,
      statement: ac.statement,
      verdict: ac.verdict,
      evidence: ac.evidence,
    })),
    goal: compiled.fields.goal,
  }));

  // 리뷰 커버리지 기록 (design §8): 모든 템플릿 섹션에 대해 reviewed/skipped/pending을
  // 스탬프 — '합의된 원본' 주장은 reviewed 섹션에 한해 성립하며, 생략은 생략으로 남는다.
  const nowIso = (input.now ?? new Date()).toISOString();
  const recorded = new Map(state.sections.map((s) => [s.id, s.review]));
  const finalizedState = await specStore.write({
    ...state,
    finalized: {
      at: nowIso,
      digest: compiled.digest,
      review_coverage: SPEC_SECTIONS.map((s) => ({
        id: s.id,
        review: recorded.get(s.id) ?? 'pending',
      })),
    },
    updated_at: nowIso,
  });

  const refreshedItem = await items.get(input.workItemId);
  const risk: RiskAxes = input.payload.risk;
  const boot = await bootstrapAutopilot(repoRoot, {
    workItem: refreshedItem,
    intent: writtenIntent,
    risk,
    ...(input.payload.approved_source ? { approvedSource: input.payload.approved_source } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  if (boot.status !== 'created') {
    // Same contract as interview finalize: intent is persisted, so the caller can
    // fix the doc (e.g. untestable AC) and retry bootstrap without re-compiling.
    throw new Error(
      `spec compiled but bootstrapAutopilot failed (${boot.status}): ${boot.reasons.join('; ')}`,
    );
  }
  return {
    status: 'finalized',
    intent: writtenIntent,
    autopilot: boot.graph,
    state: finalizedState,
  };
}
