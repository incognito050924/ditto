/**
 * Auto-detect ditto status keys from a Project v2 board's Status options
 * (wi_2606289h9 — claim_status_map auto-detect/backfill).
 *
 * The board move on claim (github-claim.ts) is silently skipped when
 * `claim_status_map.in_progress` is unset (old / un-mapped config). `ditto github
 * setup` backfills it by reading the board's Status options and matching them to
 * ditto's keys here. Matching is EXACT-SET over a normalization that absorbs ONLY
 * case / whitespace / `_` / `-` (사용자 결정 C1: no fuzzy, no synonym, no
 * localization) — so "In progress", "In Progress", "in_progress", "in-progress"
 * all map to `in_progress`, but "Doing" never does. A normalization collision that
 * yields MORE than one matching option for a key is AMBIGUOUS (never guessed —
 * left unset + warned).
 *
 * This module takes the StatusOption[] already extracted by `extractStatusOptions`
 * (the shared field-selection rule, github-reflection.ts `selectStatusField`) — it
 * NEVER re-parses a raw field-list, so the option ids it yields are exactly the ids
 * valid at apply/claim time.
 */

/** A Project v2 single-select Status option (structurally `StatusOption`). */
export interface StatusOptionLike {
  id: string;
  name: string;
}

/**
 * EXACT-SET normalization: lowercase (locale-independent) then drop every run of
 * whitespace / `_` / `-`. Absorbs surface formatting ONLY — no fuzzy, no synonyms.
 */
export function normalizeStatusName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, '');
}

/**
 * Canonical ditto-key → accepted normalized board-name forms. EXACT-SET: a board
 * option matches a key iff its normalized name is in the key's set. These are the
 * board columns ditto auto-detects — the non-terminal claim column (`in_progress`)
 * and, when present, the terminal `done` column.
 */
export const CLAIM_AUTODETECT_TABLE: Record<string, string[]> = {
  in_progress: ['inprogress'],
};
export const STATUS_AUTODETECT_TABLE: Record<string, string[]> = {
  done: ['done'],
};

export interface StatusMatchResult {
  /** key → matched option id (EXACTLY one option matched). */
  matched: Record<string, string>;
  /** key → colliding option names (filter.length > 1) — ambiguous, left UNSET. */
  ambiguous: Record<string, string[]>;
}

/**
 * Match a board's Status options against an auto-detect table. For each key:
 * exactly-one match → `matched`; more-than-one (normalization collision) →
 * `ambiguous` (never guessed); zero → omitted.
 */
export function matchStatusOptions(
  options: StatusOptionLike[],
  table: Record<string, string[]>,
): StatusMatchResult {
  const matched: Record<string, string> = {};
  const ambiguous: Record<string, string[]> = {};
  for (const [key, aliases] of Object.entries(table)) {
    const aliasSet = new Set(aliases);
    const hits = options.filter((o) => aliasSet.has(normalizeStatusName(o.name)));
    if (hits.length === 1) {
      const hit = hits[0];
      if (hit) matched[key] = hit.id;
    } else if (hits.length > 1) {
      ambiguous[key] = hits.map((o) => o.name);
    }
  }
  return { matched, ambiguous };
}

export interface AutodetectResult {
  /** Detected terminal status_map entries (subset of done — exactly-one match). */
  statusMap: Record<string, string>;
  /** Detected non-terminal claim_status_map entries (subset of in_progress). */
  claimStatusMap: Record<string, string>;
  /** Human-readable ambiguity warnings for keys left unset on a collision (C4). */
  warnings: string[];
}

/**
 * Auto-detect both maps from a board's Status options. Pure: the caller owns the
 * fill-vs-overwrite merge into the persisted config.
 */
export function autodetectStatusMaps(options: StatusOptionLike[]): AutodetectResult {
  const claim = matchStatusOptions(options, CLAIM_AUTODETECT_TABLE);
  const status = matchStatusOptions(options, STATUS_AUTODETECT_TABLE);
  const warnings: string[] = [];
  for (const [key, names] of Object.entries({ ...claim.ambiguous, ...status.ambiguous })) {
    warnings.push(
      `Auto-detect ambiguous for '${key}': multiple board options normalize alike (${names.join(', ')}) — left unset, map it explicitly with \`ditto github setup --claim-status-map\`/\`--status-map\`.`,
    );
  }
  return { statusMap: status.matched, claimStatusMap: claim.matched, warnings };
}
