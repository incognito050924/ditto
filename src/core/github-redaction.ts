import { relative } from 'node:path';

/**
 * GitHub external-write redaction (wi_260628d79, M9 — impl-redaction node, ac-15).
 *
 * The SINGLE shaping layer EVERY external write routes through (issue comments that
 * land on a public / cross-repo issue): the completion-result comment
 * (github-reflection.ts) and the decisive direct-post + sync rollup
 * (github-progress.ts).
 *
 * Built as POSITIVE / ALLOW-LIST shaping per the pii-leak + secret-exposure
 * pre-mortem branches: the public-safe body is CONSTRUCTED from only the enumerated
 * safe fields (commit SHA, per-AC verdict, a 1-line summary) — NEVER a
 * strip-known-bad blacklist, which would leak any un-enumerated field onto a public
 * issue. The free-text fragments that DO ride along (the 1-line summary, a decision
 * reason) are additionally hardened by `sanitizeFragment`: internal absolute paths
 * are relativized to the repo root, a multi-line raw-log tail is dropped (only the
 * first line survives), internal `wi_…` identifiers are removed, and a final
 * credential / token regex scrub runs (defense-in-depth).
 */

/** Credential / token shapes scrubbed from any free-text fragment (defense-in-depth). */
const TOKEN_PATTERNS: RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub PAT / OAuth / user-to-server / refresh / server token
  /github_pat_[A-Za-z0-9_]{20,}/g, // fine-grained PAT
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access-key id
  /\b[A-Za-z0-9_-]*(?:secret|token|api[_-]?key|password)[A-Za-z0-9_-]*\s*[:=]\s*\S+/gi,
];

/** Internal work-item identifiers — not emitted on a public issue body. */
const WI_ID = /\bwi_[a-z0-9]+\b/g;

/** A POSIX absolute path token, not preceded by `:` or a word char (so `https://…`
 *  and `pkg/sub` are left alone — only true absolute paths match). */
const ABS_PATH = /(?<![:\w])(?:\/[A-Za-z0-9._@-]+)+/g;

/** Relativize internal absolute paths: a path under `repoRoot` becomes repo-relative;
 *  any other absolute path is reduced to its basename so the internal directory
 *  structure never leaks. */
function relativizePaths(text: string, repoRoot: string): string {
  return text.replace(ABS_PATH, (match) => {
    if (repoRoot && (match === repoRoot || match.startsWith(`${repoRoot}/`))) {
      return relative(repoRoot, match) || '.';
    }
    const base = match.slice(match.lastIndexOf('/') + 1);
    return base || match;
  });
}

/**
 * Harden one free-text fragment for a public body: keep ONLY the first line (drop a
 * raw multi-line log tail), relativize internal absolute paths, strip internal
 * `wi_…` ids, and scrub credential / token patterns. Pure.
 */
export function sanitizeFragment(text: string, repoRoot: string = process.cwd()): string {
  const firstLine = text.split('\n')[0] ?? '';
  let out = relativizePaths(firstLine, repoRoot);
  for (const re of TOKEN_PATTERNS) out = out.replace(re, '[redacted]');
  out = out.replace(WI_ID, '');
  return out.replace(/\s{2,}/g, ' ').trim();
}

/** The allow-listed public-safe completion summary fields (github-reflection). */
export interface CompletionSummaryFields {
  /** 1-line summary (the work-item title) — sanitized, never raw. */
  summaryLine: string;
  /** Commit SHA — included verbatim when present (allow-listed, public-safe). */
  sha?: string;
  /** Aggregate completion verdict — a bare verdict label, public-safe. */
  finalVerdict?: string;
  /** Per-AC verdict: ONLY id + verdict (the statement is free text and is omitted). */
  acVerdicts: { id: string; verdict: string }[];
  /** Repo root for path relativization; defaults to the process cwd. */
  repoRoot?: string;
}

/**
 * CONSTRUCT the public-safe completion comment from ONLY the allow-listed fields
 * (SHA, per-AC verdict, 1-line summary). Nothing un-enumerated — no wi id, no AC
 * statement text, no raw logs — can reach the body, because the body is built field
 * by field rather than filtered from a blob.
 */
export function buildPublicSafeSummary(fields: CompletionSummaryFields): string {
  const root = fields.repoRoot ?? process.cwd();
  const lines: string[] = [
    '## ditto: work item result',
    '',
    sanitizeFragment(fields.summaryLine, root),
  ];
  if (fields.sha) lines.push('', `commit: \`${fields.sha}\``);
  if (fields.finalVerdict) lines.push('', `final_verdict: \`${fields.finalVerdict}\``);
  if (fields.acVerdicts.length > 0) {
    lines.push('', 'Acceptance criteria:');
    for (const ac of fields.acVerdicts) lines.push(`- ${ac.id} [${ac.verdict}]`);
  }
  return lines.join('\n');
}
