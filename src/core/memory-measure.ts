/**
 * Hallucination-reduction measurement (memory-librarian §8 inc.5, ac-5).
 *
 * Two metrics gate whether the curator actually reduces hallucination:
 *  - **재제안율 (re-proposal rate)** = re-proposals detected / rejected
 *    alternatives catalogued. A re-proposal = a candidate plan/decision text
 *    echoes an alternative a governing ADR already rejected.
 *  - **불변식 위반율 (invariant violation rate)** — denominator = invariants
 *    stated in ADRs. NOTE: invariants are prose-scattered (no dedicated
 *    section), so they are extracted by low-precision keyword scan only; the
 *    violation numerator is NOT computed deterministically here. This gap is the
 *    measure-before-expand signal (ADR-0013 D4): re-proposal rate is feasible
 *    (rejected alternatives live in a dedicated `## 대안` section, ~90% ADR
 *    coverage); invariant rate is not yet.
 *
 * Matching is deterministic and intentionally crude (no embeddings, ADR-0013
 * D1): a rejected alternative is matched against a candidate only via a
 * distinctive token (latin word ≥4 chars, or a parenthesized term) drawn from
 * its bold lead. Pure-Korean alternatives with no distinctive token may be
 * missed — recall is bounded, which the baseline run surfaces.
 */

const REJECTED_HEADING = /^##\s*대안/;
const HEADING = /^##\s/;
const BULLET = /^\s*[-*]\s+/;
const INVARIANT_KEYWORD = /불변식|invariant/i;
const RELATED_LINE = /^[-*\s]*관련\s*:/;

/**
 * Parse the rejected-alternative bullet items from an ADR body. Captures bullets
 * under the first `## 대안…` heading (covers the `대안 (기각)`, `대안과 폐기 사유`,
 * `대안 (기각/보류)` variants) until the next `## ` heading. Continuation lines of
 * a bullet are appended to that item.
 */
export function extractRejectedAlternatives(adrBody: string): string[] {
  const items: string[] = [];
  let capturing = false;
  for (const raw of adrBody.split('\n')) {
    if (HEADING.test(raw)) {
      capturing = REJECTED_HEADING.test(raw);
      continue;
    }
    if (!capturing) continue;
    if (BULLET.test(raw)) {
      items.push(raw.replace(BULLET, '').trim());
    } else if (raw.trim().length > 0 && items.length > 0) {
      // continuation of the current bullet
      items[items.length - 1] = `${items[items.length - 1]} ${raw.trim()}`;
    }
  }
  return items.filter((i) => i.length > 0);
}

/**
 * Low-precision invariant scan: lines mentioning 불변식/invariant, excluding
 * headings and the `관련:` reference line. Precision is deliberately weak — this
 * is a feasibility probe, not a parser (see module doc).
 */
export function extractInvariants(adrBody: string): string[] {
  return adrBody
    .split('\n')
    .map((l) => l.trim())
    .filter(
      (l) =>
        l.length > 0 && !l.startsWith('#') && !RELATED_LINE.test(l) && INVARIANT_KEYWORD.test(l),
    );
}

/** Distinctive tokens from a rejected-alternative item used for crude matching. */
function salientTokens(item: string): string[] {
  const bold = item.match(/\*\*(.+?)\*\*/);
  const lead = bold?.[1] ?? item;
  const tokens = new Set<string>();
  for (const m of lead.matchAll(/\(([^)]+)\)/g)) {
    for (const t of (m[1] ?? '').split(/[\s,/]+/)) {
      if (t.length >= 3) tokens.add(t.toLowerCase());
    }
  }
  for (const m of lead.matchAll(/[A-Za-z][A-Za-z0-9]{3,}/g)) {
    tokens.add(m[0].toLowerCase());
  }
  return [...tokens];
}

export interface ReproposalHit {
  adr_id: string;
  item: string;
  matched_token: string;
  candidate_index: number;
}

export interface MeasurementReport {
  adrs_total: number;
  adrs_with_rejected_section: number;
  adrs_without_rejected_section: string[];
  rejected_alternatives_total: number;
  invariants_total: number;
  candidates_total: number;
  reproposals_detected: number;
  /** reproposals_detected / rejected_alternatives_total (0 when denominator 0). */
  reproposal_rate: number;
  reproposal_hits: ReproposalHit[];
  /** invariant violation numerator is not computed deterministically (see doc). */
  invariant_violations_computed: false;
}

/**
 * Build the baseline measurement over a set of ADR bodies and (optionally)
 * candidate plan/decision texts to check for re-proposals. With no candidates
 * this is the inventory baseline (denominator + coverage); with candidates it
 * also computes the re-proposal numerator and rate.
 */
export function measureHallucination(
  adrs: Array<{ id: string; body: string }>,
  candidates: string[],
): MeasurementReport {
  const without: string[] = [];
  let rejectedTotal = 0;
  let invariantsTotal = 0;
  let withSection = 0;
  const lowerCandidates = candidates.map((c) => c.toLowerCase());
  const hits: ReproposalHit[] = [];

  for (const adr of adrs) {
    const rejected = extractRejectedAlternatives(adr.body);
    invariantsTotal += extractInvariants(adr.body).length;
    if (rejected.length === 0) {
      without.push(adr.id);
    } else {
      withSection += 1;
      rejectedTotal += rejected.length;
      for (const item of rejected) {
        const tokens = salientTokens(item);
        for (let ci = 0; ci < lowerCandidates.length; ci += 1) {
          const matched = tokens.find((t) => lowerCandidates[ci]?.includes(t));
          if (matched) {
            hits.push({ adr_id: adr.id, item, matched_token: matched, candidate_index: ci });
            break; // one hit per item is enough for the rate
          }
        }
      }
    }
  }

  const detected = hits.length;
  return {
    adrs_total: adrs.length,
    adrs_with_rejected_section: withSection,
    adrs_without_rejected_section: without,
    rejected_alternatives_total: rejectedTotal,
    invariants_total: invariantsTotal,
    candidates_total: candidates.length,
    reproposals_detected: detected,
    reproposal_rate: rejectedTotal === 0 ? 0 : detected / rejectedTotal,
    reproposal_hits: hits,
    invariant_violations_computed: false,
  };
}
