/**
 * Heal policy — the HARD mechanical filter (wi_2607026qs ac-7, Contract 5-A).
 *
 * A Playwright test that goes red can be "healed" by an agent, but a heal must
 * never silently rewrite what a test asserts (ADR-0014 D4). The agent-facing
 * constrained healer def (resources/playwright-agents/healer.constrained.*) is
 * the SOFT layer — it can be disobeyed. This filter is the guarantee: it runs
 * over the proposed unified diff and lets ONLY selector/wait repairs through.
 *
 * Per hunk, classified from the CHANGED lines (`+`/`-`) only:
 *  - REJECT if it touches any forbidden token — an expected value
 *    (`expect(` / `toHave` / `toContain`), a skip/fixme/only, a URL literal, or
 *    seed data.
 *  - ALLOW only if it touches a selector/wait token (`getBy*` / `locator(` /
 *    `waitFor` / timeout) AND touches no forbidden token.
 *  - anything else (no recognized selector/wait change) is rejected too —
 *    fail-closed: only `allowed` may ever be applied.
 *
 * `touchedStepRegions` reports the `<journeyId>/sN` step ref of every ALLOWED
 * change (read from the `// @step` markers inside/around the hunk) so a caller
 * can force-reflag those assertion-map entries after applying a selector heal.
 */

export interface HealHunk {
  /** File the hunk applies to (from `+++ b/<file>` when present). */
  file: string;
  /** The `@@ … @@` header line of this hunk. */
  header: string;
  /** Full hunk text (header + body lines) verbatim from the input diff. */
  text: string;
  /** Why the hunk is not applyable — forbidden tokens it touched, or "no selector/wait change". */
  reasons: string[];
}

export interface HealFilterResult {
  /** Reconstructed unified diff of ONLY the allowed hunks (with file headers). '' if none. */
  allowed: string;
  /** Hunks that must NOT be auto-applied, each with its reject reason(s). */
  rejected: HealHunk[];
  /** `<journeyId>/sN` step refs whose region an allowed change touched (post-heal re-flag). */
  touchedStepRegions: string[];
}

// Expected-value / skip / navigation / seed edits — forbidden in an auto-applied heal.
const FORBIDDEN: Array<{ label: string; re: RegExp }> = [
  { label: 'expect(', re: /\bexpect\s*\(/ },
  { label: 'toHave', re: /toHave/ },
  { label: 'toContain', re: /toContain/ },
  { label: '.fixme(', re: /\.fixme\s*\(/ },
  { label: '.skip(', re: /\.skip\s*\(/ },
  { label: '.only(', re: /\.only\s*\(/ },
  // URL literal / navigation target: https?:// literal or any *.goto(...) call.
  { label: 'URL literal', re: /https?:\/\/|\.goto\s*\(/ },
  // seed data reference: seedData / seed.spec / seed_x / seed( — heuristic (see report).
  { label: 'seed data', re: /\bseed[\w.(]/i },
];

// Selector / wait repairs — the only edits a heal may carry.
const ALLOWED_TOKENS: Array<{ label: string; re: RegExp }> = [
  { label: 'getBy*', re: /\bgetBy[A-Za-z]/ },
  { label: 'locator(', re: /locator\s*\(/ },
  { label: 'waitFor', re: /waitFor/ },
  { label: 'timeout', re: /timeout/i },
];

const STEP_MARKER_RE = /@step\s+(\S+\/[sb]\d+)/g;

interface RawHunk {
  header: string;
  bodyLines: string[];
}

interface DiffFile {
  /** Preamble lines (diff --git, index, ---, +++) emitted before any hunk. */
  headerLines: string[];
  file: string;
  hunks: RawHunk[];
}

function parseFileName(line: string): string | undefined {
  const name = line.replace(/^(\+\+\+|---)\s+/, '').split('\t')[0];
  if (!name || name === '/dev/null') return undefined;
  return name.replace(/^[ab]\//, '');
}

/**
 * Parse a unified diff into per-file hunks. Structural markers (`diff --git`,
 * `@@`) are always honored; `---`/`+++` are treated as file headers ONLY when
 * not inside a hunk, so a removed/added content line that happens to start with
 * `---`/`+++` is not misread as a header.
 */
function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let curHunk: RawHunk | null = null;

  const flushHunk = () => {
    if (cur && curHunk) cur.hunks.push(curHunk);
    curHunk = null;
  };
  const flushFile = () => {
    flushHunk();
    if (cur) files.push(cur);
    cur = null;
  };

  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      flushHunk();
      if (!cur) cur = { headerLines: [], file: '', hunks: [] };
      curHunk = { header: line, bodyLines: [] };
    } else if (line.startsWith('diff --git ')) {
      flushFile();
      cur = { headerLines: [line], file: '', hunks: [] };
    } else if (!curHunk && line.startsWith('--- ')) {
      // A `---` header outside a hunk starts a new file block when the current
      // one already has content (handles diffs with no `diff --git` preamble).
      if (!cur || cur.hunks.length > 0) {
        flushFile();
        cur = { headerLines: [line], file: '', hunks: [] };
      } else {
        cur.headerLines.push(line);
        cur.file = parseFileName(line) ?? cur.file;
      }
    } else if (!curHunk && line.startsWith('+++ ')) {
      if (!cur) cur = { headerLines: [], file: '', hunks: [] };
      cur.headerLines.push(line);
      cur.file = parseFileName(line) ?? cur.file;
    } else if (curHunk) {
      curHunk.bodyLines.push(line);
    } else if (cur) {
      cur.headerLines.push(line);
    }
    // else: stray line before any file marker — ignore.
  }
  flushFile();
  return files;
}

function hunkText(h: RawHunk): string {
  return [h.header, ...h.bodyLines].join('\n');
}

/** Content of the changed (`+`/`-`) lines, prefix stripped, joined. */
function changedContent(h: RawHunk): string {
  return h.bodyLines
    .filter((l) => l.startsWith('+') || l.startsWith('-'))
    .map((l) => l.slice(1))
    .join('\n');
}

/** `<journeyId>/sN` refs from any @step marker in the whole hunk (header + body). */
function stepRefs(h: RawHunk): string[] {
  const text = [h.header, ...h.bodyLines].join('\n');
  const re = new RegExp(STEP_MARKER_RE.source, 'g');
  const refs: string[] = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const ref = m[1];
    if (ref !== undefined) refs.push(ref);
  }
  return refs;
}

function classify(h: RawHunk): { allowed: boolean; reasons: string[] } {
  const changed = changedContent(h);
  const reasons = FORBIDDEN.filter((f) => f.re.test(changed)).map((f) => f.label);
  if (reasons.length > 0) return { allowed: false, reasons };
  const hasAllowToken = ALLOWED_TOKENS.some((a) => a.re.test(changed));
  if (hasAllowToken) return { allowed: true, reasons: [] };
  return { allowed: false, reasons: ['no selector/wait change (not an allowed heal target)'] };
}

export function filterHealPatch(diff: string): HealFilterResult {
  const files = parseDiff(diff);
  const allowedParts: string[] = [];
  const rejected: HealHunk[] = [];
  const touched = new Set<string>();

  for (const file of files) {
    const allowedHunks: RawHunk[] = [];
    for (const h of file.hunks) {
      const { allowed, reasons } = classify(h);
      if (allowed) {
        allowedHunks.push(h);
        for (const ref of stepRefs(h)) touched.add(ref);
      } else {
        rejected.push({ file: file.file, header: h.header, text: hunkText(h), reasons });
      }
    }
    if (allowedHunks.length > 0) {
      allowedParts.push([...file.headerLines, ...allowedHunks.map(hunkText)].join('\n'));
    }
  }

  return {
    allowed: allowedParts.join('\n'),
    rejected,
    touchedStepRegions: [...touched],
  };
}
