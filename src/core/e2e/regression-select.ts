import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { parseYaml } from '../hosts/shared';
import { parseJourneyDoc, splitFrontMatter } from './journey-dsl';

/**
 * 회귀 게이트 영향 추림 (wi_260610p9h ac-7).
 *
 * Crosses the journey front-matter `surfaces` with a change diff: ONLY
 * `component:<repo path|glob>` surfaces are machine-matchable; `page:`/`api:`
 * surfaces are metadata for human/agent judgment and never matched here.
 * Layout convention (same as the rest of the pipeline): journeys live at
 * `<repo>/e2e/journeys`, derived specs at `<repo>/e2e/generated/<slug>.spec.ts`;
 * returned paths are repo-relative POSIX. A selected journey whose generated
 * spec is absent is flagged `missing_generated` — broken derivatives must not
 * disappear silently.
 */

const COMPONENT_PREFIX = 'component:';

/**
 * Minimal glob matcher. package.json carries no glob dependency (checked:
 * citty/smol-toml/yaml/zod only), so instead of adding one this supports ONLY:
 *  - `*`  — any characters within ONE path segment (never `/`)
 *  - `**` — any characters across segments (a `**` segment also matches zero segments)
 *  - no glob chars — exact path OR directory containment (`src/auth` matches
 *    `src/auth/login.ts`)
 * NOT supported: `?`, `[...]`, `{a,b}`, `!` negation.
 */
export function matchesComponentPattern(pattern: string, path: string): boolean {
  if (!pattern.includes('*')) {
    return path === pattern || path.startsWith(pattern.endsWith('/') ? pattern : `${pattern}/`);
  }
  return globToRegExp(pattern).test(path);
}

function globToRegExp(pattern: string): RegExp {
  let out = '^';
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 3;
      continue;
    }
    if (pattern.startsWith('**', i)) {
      out += '.*';
      i += 2;
      continue;
    }
    const ch = pattern[i] as string;
    out += ch === '*' ? '[^/]*' : ch.replace(/[.+?^${}()|[\]\\]/, '\\$&');
    i += 1;
  }
  return new RegExp(`${out}$`);
}

export interface JourneyEntry {
  id: string;
  name: string;
  description: string;
  surfaces: string[];
  uses_blocks: string[];
  /** Repo-relative POSIX path of the .journey.md source. */
  journey_file: string;
  /** Repo-relative POSIX path of the conventional e2e/generated/<slug>.spec.ts. */
  generated_spec: string;
  /** True when the conventional generated spec does not exist on disk. */
  missing_generated: boolean;
}

export interface ImpactedJourney extends JourneyEntry {
  /** The component: surfaces that intersected the changed paths ([] when user-added). */
  matched_surfaces: string[];
}

export interface InvalidJourney {
  file: string;
  error: string;
}

export interface JourneyInventory {
  entries: JourneyEntry[];
  /** Journeys that could not be parsed — surfaced, never silently dropped. */
  invalid: InvalidJourney[];
}

const toPosix = (p: string): string => p.split(sep).join('/');

const V1_VERSION_MISMATCH_REASON =
  'DSL v1 no longer supported — re-author as v2 (clean break, no auto-migration)';

/**
 * Turn a journey parse failure into an author-actionable reason. A file that
 * declares a non-`v2` `ditto_journey` version (i.e. a v1 journey after the clean
 * break) gets the explicit version-mismatch guidance instead of the raw zod
 * literal blob, so the regression gate names WHY it refused. Any other failure
 * (malformed YAML, missing front-matter, unknown v2 field) keeps its specific
 * parser message so it can be fixed. Never silently drops the file.
 */
function invalidJourneyReason(text: string, parseError: string): string {
  const split = splitFrontMatter(text);
  if (split) {
    try {
      const raw = parseYaml(split.frontMatter);
      if (
        raw !== null &&
        typeof raw === 'object' &&
        'ditto_journey' in raw &&
        (raw as { ditto_journey?: unknown }).ditto_journey !== 'v2'
      ) {
        return V1_VERSION_MISMATCH_REASON;
      }
    } catch {
      // Malformed YAML has its own parser message — fall through.
    }
  }
  return parseError;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Load every `<slug>.journey.md` under `journeysDir` (convention: <repo>/e2e/journeys). */
export async function loadJourneyEntries(journeysDir: string): Promise<JourneyInventory> {
  const journeysAbs = resolve(journeysDir);
  // Layout convention <repo>/e2e/journeys → repo root is two levels up.
  const repoRoot = resolve(journeysAbs, '..', '..');
  const generatedDir = resolve(journeysAbs, '..', 'generated');
  let names: string[];
  try {
    names = (await readdir(journeysAbs)).filter((n) => n.endsWith('.journey.md')).sort();
  } catch {
    return { entries: [], invalid: [] };
  }
  const entries: JourneyEntry[] = [];
  const invalid: InvalidJourney[] = [];
  for (const name of names) {
    const fileAbs = join(journeysAbs, name);
    const fileRel = toPosix(relative(repoRoot, fileAbs));
    const text = await readFile(fileAbs, 'utf8');
    const parsed = parseJourneyDoc(text);
    if (!parsed.ok) {
      invalid.push({ file: fileRel, error: invalidJourneyReason(text, parsed.error) });
      continue;
    }
    const slug = name.slice(0, -'.journey.md'.length);
    const specAbs = join(generatedDir, `${slug}.spec.ts`);
    entries.push({
      id: parsed.frontMatter.id,
      name: parsed.frontMatter.name,
      description: parsed.frontMatter.description,
      surfaces: parsed.frontMatter.surfaces,
      uses_blocks: parsed.frontMatter.uses_blocks,
      journey_file: fileRel,
      generated_spec: toPosix(relative(repoRoot, specAbs)),
      missing_generated: !(await fileExists(specAbs)),
    });
  }
  return { entries, invalid };
}

export interface RegressionSelection {
  journeys: ImpactedJourney[];
  /** Changed paths no journey's component: surfaces matched. */
  unmatched_changed_paths: string[];
  invalid_journeys: InvalidJourney[];
}

const normalizePath = (p: string): string => toPosix(p).replace(/^\.\//, '');

/** ac-7: impacted journeys = journeys with ≥1 component: surface matching ≥1 changed path. */
export async function selectImpactedJourneys(
  journeysDir: string,
  changedPaths: string[],
): Promise<RegressionSelection> {
  const { entries, invalid } = await loadJourneyEntries(journeysDir);
  const normalized = changedPaths.map(normalizePath);
  const matchedPaths = new Set<string>();
  const journeys: ImpactedJourney[] = [];
  for (const entry of entries) {
    const matched: string[] = [];
    for (const surface of entry.surfaces) {
      if (!surface.startsWith(COMPONENT_PREFIX)) continue; // page:/api: → human judgment only
      const pattern = normalizePath(surface.slice(COMPONENT_PREFIX.length));
      const hits = normalized.filter((p) => matchesComponentPattern(pattern, p));
      if (hits.length === 0) continue;
      matched.push(surface);
      for (const hit of hits) matchedPaths.add(hit);
    }
    if (matched.length > 0) journeys.push({ ...entry, matched_surfaces: matched });
  }
  return {
    journeys,
    unmatched_changed_paths: normalized.filter((p) => !matchedPaths.has(p)),
    invalid_journeys: invalid,
  };
}
