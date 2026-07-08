import { createHash } from 'node:crypto';
import type { IntentContract } from '~/schemas/intent';

/**
 * spec-doc — the neutral spec-document compiler (extracted from the retired
 * tech-spec surface, wi_260707oi1). The spec document is the single source;
 * intent fields are compiled from it, one-way (no sync back). This module owns:
 *  - the section model shared by any template, the compiler, and the digest
 *  - `compileSpecDoc` — fail-closed markdown → intent-fields compile
 *  - `computeSpecDigest` — sha256 over the compile-input sections only
 *    (요약·목표·비목표·완료 조건·위험 — decided 2026-06-10: protect exactly what
 *    intent derives from; 배경/계획/마일스톤/인터뷰 기록 edits never force re-finalize)
 *
 * Surface-agnostic: no store, no CLI, no work-item wiring — just the pure
 * document → fields transform its consumers (the digest freshness gate, and the
 * intent-compiling authoring surface) reuse.
 */

/** Template section ids (13 sections). */
export type SpecSectionId =
  | 'feature'
  | 'summary'
  | 'background'
  | 'goals'
  | 'non-goals'
  | 'acceptance-criteria'
  | 'risks'
  | 'plan'
  | 'impact'
  | 'rejected-alternatives'
  | 'milestones'
  | 'interview-log'
  | 'post-build';

export const SPEC_SECTIONS: readonly { id: SpecSectionId; title: string }[] = [
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
  let inFence = false;
  // A ```/~~~ fenced block: a `## ` inside it is prose, NOT a section boundary — else a
  // quoted/code-block heading hijacks the section split (and the digest range). Reuses the
  // fence-detection of question-context.ts `stripCode`.
  const fenceLine = /^\s*(```+|~~~+)/;
  const flush = () => {
    if (current === null) return;
    const body = normalizeBody(buf.join('\n'));
    if (sections.has(current)) duplicates.push(current);
    else sections.set(current, body);
  };
  for (const line of lines) {
    if (fenceLine.test(line)) inFence = !inFence;
    if (!inFence && line.startsWith('## ')) {
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
