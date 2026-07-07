import { containScopePath } from '~/core/coverage-oracle';
import { scrubTokens } from '~/core/github-redaction';
import { SPEC_SECTIONS, type SpecSectionId, computeSpecDigest } from '~/core/spec-doc';

/** A codebase/project fact stated in a factual section — summary + grounding pointer. */
export interface FactualClaim {
  /** The claim, stated as a SUMMARY (never a raw transcription of code/config/interview). */
  claim: string;
  /** A grounding reference: file:line, a markdown link, an ADR id, or a memory pointer. */
  grounding?: string;
}

export interface DesignDocAc {
  id: string;
  statement: string;
  evidence: string;
}

export interface DesignDocRisk {
  risk: string;
  handling: string;
  flag?: string;
}

/** Structured input for the prism design document (the refined intent sections). */
export interface DesignDocInput {
  feature: string;
  summary: string;
  goals: string[];
  nonGoals: string[];
  acceptanceCriteria: DesignDocAc[];
  risks: DesignDocRisk[];
  background?: FactualClaim[];
  impact?: FactualClaim[];
  interviewSummary?: string;
}

export interface EmitOptions {
  /** Repo-relative target path under `.ditto/specs`. */
  targetPath: string;
  repoRoot: string;
  /** Explicit user decision: emit even with ungrounded factual claims (marks them unresolved). */
  allowUngrounded?: boolean;
}

export type EmitResult =
  | { status: 'emitted'; markdown: string; digest: string; abs: string; unresolved: string[] }
  | { status: 'rejected'; reasons: string[] };

function title(id: SpecSectionId): string {
  return SPEC_SECTIONS.find((s) => s.id === id)?.title ?? id;
}

/** A ```/~~~ fenced block = a raw transcription of code/config/interview text. */
const FENCE = /(^|\n)\s*(```+|~~~+)/;

/**
 * Is `s` a real grounding reference? file:line, a markdown link, an ADR id, or a memory
 * pointer count; a bare assertion does not (ac-5 is fail-closed — an ungrounded string is
 * treated as no grounding at all).
 */
function isGroundingRef(s: string | undefined): boolean {
  if (!s || s.trim().length === 0) return false;
  return (
    /\S+\.\w+:\d+/.test(s) || // file:line
    /\[.+\]\(.+\)/.test(s) || // markdown link
    /\bADR-/.test(s) || // ADR id
    /\b(?:proj_|memevt_|src_)/.test(s) // memory projection pointer
  );
}

/** Render a factual section's claims as summary lines with an inline grounding pointer. */
function renderFactual(claims: FactualClaim[] | undefined): string {
  if (!claims || claims.length === 0) return '없음';
  return claims
    .map((c) =>
      c.grounding ? `- ${c.claim} (근거: ${c.grounding})` : `- ${c.claim} (근거 없음 — 미해결)`,
    )
    .join('\n');
}

/**
 * Render the human-readable design document. Section HEADINGS are pulled from
 * SPEC_SECTIONS so the doc stays isomorphic to the spec template (drift-proof), and
 * the compile-input sections (요약·목표·비목표·완료 조건·위험) are laid out so the
 * preserved `computeSpecDigest` binds them.
 */
export function renderDesignDoc(input: DesignDocInput): string {
  const acRows = input.acceptanceCriteria
    .map((a) => `| ${a.id} | ${a.statement} | ${a.evidence} |`)
    .join('\n');
  const riskRows = input.risks
    .map((r) => `| ${r.risk} | ${r.handling} | ${r.flag ?? '—'} |`)
    .join('\n');

  const parts = [
    `# ${input.feature} — 설계 문서`,
    '',
    '> 소비자: DITTO(design → implement → verify) + 사람. 원문 전사 금지 — 요약+링크.',
    '',
    `## 1. ${title('feature')}`,
    '',
    `- 이름: ${input.feature}`,
    '',
    `## 2. ${title('summary')}`,
    '',
    input.summary,
    '',
    `## 3. ${title('background')}`,
    '',
    renderFactual(input.background),
    '',
    `## 4. ${title('goals')}`,
    '',
    input.goals.map((g) => `- ${g}`).join('\n'),
    '',
    `## 5. ${title('non-goals')}`,
    '',
    input.nonGoals.map((g) => `- ${g}`).join('\n'),
    '',
    `## 6. ${title('acceptance-criteria')}`,
    '',
    '| id | 완료 조건 | evidence |',
    '|---|---|---|',
    acRows,
    '',
    `## 7. ${title('risks')}`,
    '',
    '| 위험 | 처리 | 플래그 |',
    '|---|---|---|',
    riskRows,
    '',
    `## 8. ${title('impact')}`,
    '',
    renderFactual(input.impact),
    '',
    `## 9. ${title('interview-log')}`,
    '',
    input.interviewSummary ?? '없음',
    '',
  ];
  return parts.join('\n');
}

/**
 * Emit the design document through the fail-closed gate:
 *  - V-1 containment: reject a target path outside repoRoot (reuses `containScopePath`).
 *  - DI-1: every compile-input section (요약·목표·비목표·완료 조건·위험) must be non-empty,
 *    so the preserved `computeSpecDigest` binds real content — never the empty-body hash.
 *  - scrub policy: raw transcription (code fences) in a factual claim or the interview
 *    summary is REJECTED — summary + grounding link only.
 *  - ac-5 grounding: a factual-section claim (배경·영향도) without a real grounding reference
 *    blocks the emit, UNLESS `allowUngrounded` is set (explicit user decision), in which case
 *    the ungrounded claims ship marked as unresolved.
 *  - Before returning, `scrubTokens` redacts any token-shaped secret that slipped through.
 */
export function emitDesignDoc(input: DesignDocInput, opts: EmitOptions): EmitResult {
  const reasons: string[] = [];

  // V-1 — containment over the untrusted target path.
  const contained = containScopePath(opts.targetPath, opts.repoRoot);
  if (!contained.ok) reasons.push(`문서 경로가 repo 밖입니다: ${contained.detail}`);

  // DI-1 — compile-input sections must carry real content (digest anti-collapse).
  if (input.summary.trim().length === 0) reasons.push('필수 절이 비어 있음: 요약');
  if (input.goals.filter((g) => g.trim().length > 0).length === 0)
    reasons.push('필수 절이 비어 있음: 목표');
  if (input.nonGoals.filter((g) => g.trim().length > 0).length === 0)
    reasons.push('필수 절이 비어 있음: 비목표');
  if (input.acceptanceCriteria.length === 0) reasons.push('필수 절이 비어 있음: 완료 조건');
  if (input.risks.length === 0) reasons.push('필수 절이 비어 있음: 위험');

  const factual = [
    ...(input.background ?? []).map((c) => ({ section: '배경', claim: c })),
    ...(input.impact ?? []).map((c) => ({ section: '영향도', claim: c })),
  ];

  // scrub policy — no raw transcription; summary + link only.
  for (const { section, claim } of factual) {
    if (FENCE.test(claim.claim))
      reasons.push(`${section} 절에 원문 전사(코드블록)가 있습니다 — 요약+링크만 허용`);
  }
  if (input.interviewSummary && FENCE.test(input.interviewSummary))
    reasons.push('인터뷰 절에 원문 전사(코드블록)가 있습니다 — 요약+링크만 허용');

  // ac-5 — grounding fail-closed over factual claims.
  const ungrounded = factual.filter(({ claim }) => !isGroundingRef(claim.grounding));
  const unresolved = ungrounded.map(({ section, claim }) => `${section}: ${claim.claim}`);
  if (ungrounded.length > 0 && !opts.allowUngrounded) {
    for (const { section, claim } of ungrounded)
      reasons.push(`${section} 절의 사실 주장에 근거가 없습니다: "${claim.claim}"`);
  }

  if (reasons.length > 0) return { status: 'rejected', reasons };

  const markdown = scrubTokens(renderDesignDoc(input));
  return {
    status: 'emitted',
    markdown,
    digest: computeSpecDigest(markdown),
    abs: contained.ok ? contained.abs : opts.targetPath,
    unresolved,
  };
}
