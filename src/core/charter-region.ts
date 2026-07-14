import { normalizedSha256 } from './instruction-bridge';

/**
 * Marker-less ditto-charter recognition/replace primitive for `ditto setup`.
 *
 * The canonical source AGENTS.md carries NO persistent ditto marker (raw-AGENTS
 * invariant), so the charter region's boundary is inferred, not read from a marker.
 * Rule: the ditto-charter region is the LEADING span of the file whose normalized
 * sha matches a known bundled charter version; any user-authored rules follow it.
 * The common case is region == whole file.
 *
 * Recognition is NORMALIZED exact-match — CRLF and per-line trailing whitespace are
 * folded away by `normalizedSha256` (the same normalization the instruction bridge
 * uses), so a CRLF/trailing-space variant of a shipped charter still matches, while
 * ANY non-whitespace divergence stays unrecognized. This is exact-match, not fuzzy.
 */

export interface RefreshCharterRegionParams {
  /** The on-disk AGENTS.md content. */
  current: string;
  /** The current canonical (bundled) charter body. */
  bundledCharter: string;
  /**
   * Normalized shas of every bundled charter version (from charter-manifest.json).
   * Includes prior versions so an N→N+1 upgrade recognizes the prior charter; the
   * current bundle's own sha is unioned in regardless.
   */
  knownShas: readonly string[];
}

export type RefreshCharterRegionResult =
  | { kind: 'up-to-date'; content: string }
  | { kind: 'replaced'; content: string }
  | { kind: 'unrecognized'; content: string };

/**
 * Enumerate the byte offsets at which a leading line-prefix of `content` ends: just
 * after every '\n', plus the full length. Charter bodies end on a newline, so the
 * true region boundary is always one of these offsets.
 */
function leadingPrefixOffsets(content: string): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') offsets.push(i + 1);
  }
  if (offsets[offsets.length - 1] !== content.length) offsets.push(content.length);
  return offsets;
}

/**
 * Decide whether the ditto-charter region of `current` is up to date, replaceable
 * with `bundledCharter`, or unrecognized. The matched region is the LONGEST leading
 * line-prefix whose normalized sha is a known charter sha; user rules after it are
 * preserved byte-identical on replace.
 */
export function refreshCharterRegion(
  params: RefreshCharterRegionParams,
): RefreshCharterRegionResult {
  const { current, bundledCharter } = params;
  const currentSha = normalizedSha256(bundledCharter);
  const known = new Set<string>([...params.knownShas, currentSha]);

  // Longest recognized leading prefix wins: a full charter has a specific length, so
  // the largest matching boundary is the real region end (a shorter partial prefix
  // is never a full-charter sha, hence never a false match).
  const offsets = leadingPrefixOffsets(current);
  for (let i = offsets.length - 1; i >= 0; i--) {
    const boundary = offsets[i] as number;
    const sha = normalizedSha256(current.slice(0, boundary));
    if (!known.has(sha)) continue;
    if (sha === currentSha) return { kind: 'up-to-date', content: current };
    // A known PRIOR charter — replace the region, keep the trailing user rules verbatim.
    return { kind: 'replaced', content: bundledCharter + current.slice(boundary) };
  }
  return { kind: 'unrecognized', content: current };
}
