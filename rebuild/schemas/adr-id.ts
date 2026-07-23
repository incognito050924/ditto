/**
 * ADR-id grammar primitives — defined ONCE here so knowledge authoring
 * (adr-new), consistency checking (adr-check), and the CLAUDE.md projection all
 * share a single source for the id shape instead of re-spelling the regex.
 *
 * Two id FORMS exist (the immutable-filename identifier policy):
 *   - legacy `ADR-NNNN` (4-digit number; grandfathered, rename forbidden), and
 *   - new `ADR-YYYYMMDD-<slug>` (8-digit date + slug; the whole filename stem is
 *     the immutable id — no separate number/uid, no renumbering ever).
 *
 * The anchored full-id matcher and the unanchored extraction matcher order their
 * alternatives DIFFERENTLY and that difference is load-bearing:
 *   - ANCHORED (`^...$`): validates a complete id. Order is irrelevant because
 *     the whole string must match.
 *   - UNANCHORED (prefix extraction): the 8-digit(+slug) branch MUST come first.
 *     `\d{4}` is a prefix of `\d{8}`, so a `\d{4}`-first alternation would
 *     truncate `ADR-20260624-x` to `ADR-2026`.
 * Do not "normalize" the two orderings into one — they encode different concerns.
 */

/** Slug charset: lowercase alphanumeric words joined by single hyphens. */
const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';
/** Legacy 4-digit ADR number. */
const DIGITS4 = '\\d{4}';
/** New ADR date (YYYYMMDD). */
const DIGITS8 = '\\d{8}';

/**
 * ANCHORED full-id validator: a complete id is legacy `ADR-NNNN` or new
 * `ADR-YYYYMMDD-<slug>`.
 */
export const ADR_ID_FULL_RE = new RegExp(`^ADR-(?:${DIGITS4}|${DIGITS8}-${SLUG})$`);

/**
 * UNANCHORED prefix extractor: pull the id out of a filename/stem. 8-digit
 * branch FIRST so a new-form date is not truncated to its first 4 digits. For
 * legacy `ADR-NNNN-<slug>.md` this yields `ADR-NNNN`; for
 * `ADR-YYYYMMDD-<slug>.md` the full `ADR-YYYYMMDD-<slug>`.
 */
export const ADR_ID_EXTRACT_RE = new RegExp(`^ADR-(?:${DIGITS8}-${SLUG}|${DIGITS4})`);

/** Same prefix as the extractor, plus the `: ` separator — strips the id prefix off an ADR title line. */
export const ADR_TITLE_PREFIX_RE = new RegExp(`^ADR-(?:${DIGITS8}-${SLUG}|${DIGITS4}):\\s*`);

/**
 * Match a *whole* well-formed ADR filename: `ADR-NNNN-<slug>.md` or
 * `ADR-YYYYMMDD-<slug>.md`. The slug is required after the number; bare
 * `ADR-NNNN.md` / `ADR-YYYYMMDD.md` and `ADR-xyz.md` are malformed.
 */
export const ADR_FILENAME_RE = new RegExp(`^ADR-(?:${DIGITS8}|${DIGITS4})-${SLUG}\\.md$`);

/**
 * Slug-only validator (anchored). Rejects uppercase, underscores,
 * leading/trailing/double hyphens, and empties — the slug becomes part of the
 * ADR's immutable filename id, so it stays strict.
 */
export const ADR_SLUG_RE = new RegExp(`^${SLUG}$`);

/**
 * Extract an ADR's identifier from a filename, or null when the name is
 * malformed. Shared drop-in for the projection's headline builder and
 * adr-check: both gate on a whole well-formed filename, then take the id
 * prefix.
 */
export function adrIdFromFilename(filename: string): string | null {
  if (!ADR_FILENAME_RE.test(filename)) return null;
  return filename.match(ADR_ID_EXTRACT_RE)?.[0] ?? null;
}
