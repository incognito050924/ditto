import { ADR_ID_EXTRACT_RE } from '../schemas/adr-id';

/** Parsed `- 상태:` / `- status:` list line of an ADR body. */
export interface AdrStatusLine {
  /** Full status value text after the label (trimmed), e.g. `superseded by ADR-…`. */
  status: string;
  /** Successor ADR id when the value reads `superseded by <id>`. */
  supersededBy?: string;
}

// LINE-anchored status-line matchers (the `- 상태:` / `- status:` list line; the
// list dash is optional but the label must open its own line). Deliberately NOT a
// whole-body substring match: accepted ADR bodies legitimately contain the word
// 'superseded' (and even '상태:') in prose, and a substring match would let prose
// fake a supersede verdict. `상태:` wins; `status:` is the case-insensitive fallback.
const ADR_STATUS_LINE_KO_RE = /^\s*(?:[-*]\s+)?상태:\s*(.+)$/m;
const ADR_STATUS_LINE_EN_RE = /^\s*(?:[-*]\s+)?status:\s*(.+)$/im;

/**
 * Parse an ADR body's status LINE — the single shared parser for the knowledge
 * projection (headline status) and decision-conflict verification, so
 * projection and gate can never disagree about what an ADR's status is.
 * Returns the full status value plus the successor id extracted from a
 * `superseded by <id>` value (prefix extraction, so a trailing annotation
 * after the id is tolerated). null = no parseable status line.
 */
export function parseAdrStatusLine(body: string): AdrStatusLine | null {
  const value = body.match(ADR_STATUS_LINE_KO_RE)?.[1] ?? body.match(ADR_STATUS_LINE_EN_RE)?.[1];
  if (value === undefined) return null;
  const status = value.trim();
  if (status.length === 0) return null;
  const after = status.match(/superseded by\s+(.+)$/i)?.[1];
  const supersededBy = after?.match(ADR_ID_EXTRACT_RE)?.[0];
  return { status, ...(supersededBy !== undefined ? { supersededBy } : {}) };
}
