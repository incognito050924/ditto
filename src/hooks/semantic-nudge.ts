import { listChangedFilesVsRef } from '~/core/git';
import { pickBaseRef } from '~/core/work-item-handoff';
import type { WorkItem } from '~/schemas/work-item';

/**
 * S1 (wi_260605aw1) — Stop-time semantic-scan AX nudge.
 *
 * The autowiring dialectic (reviews/dialectic-1) ruled the heavy CodeQL scan out
 * of the Stop hook (ADR-0001 perf contract). What belongs here is the cheap ACG
 * direction-keeping signal: when an in-progress work item is *allowed to stop*
 * but it touched source files and produced no semantic artifact, remind (without
 * blocking) to run `ditto semantic scan`. No CodeQL, no DB — only a git diff name
 * list. The user delegated implementation to the autonomous agent; this nudge is
 * how the loop is told "you may be declaring done without a meaning check".
 */

/** Source extensions ACG can analyze (CodeQL bindings). */
const SEMANTIC_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.java', '.kt', '.py'] as const;

export function filterSourceFiles(files: string[]): string[] {
  return files.filter(
    (f) => !f.endsWith('.d.ts') && SEMANTIC_SOURCE_EXTENSIONS.some((ext) => f.endsWith(ext)),
  );
}

export interface SemanticNudgeInput {
  workItemId: string;
  /** Work item is non-terminal (still in progress) — terminal items are not nudged. */
  isNonTerminal: boolean;
  /** A semantic-compatibility.json already exists (already checked/seeded). */
  semanticPresent: boolean;
  /** Resolved base ref, or null when none resolves. */
  base: string | null;
  /** Changed source files vs base (already filtered). */
  changedSourceFiles: string[];
}

/** The advisory message, or null when no nudge is warranted. Pure. */
export function semanticScanNudge(input: SemanticNudgeInput): string | null {
  if (!input.isNonTerminal) return null;
  if (input.semanticPresent) return null;
  if (input.base === null) return null;
  if (input.changedSourceFiles.length === 0) return null;
  return `DITTO semantic check: ${input.changedSourceFiles.length} changed source file(s) vs ${input.base} but no semantic-compatibility.json. Run \`ditto semantic scan --work-item ${input.workItemId} --base ${input.base}\` to check exported-signature/meaning compatibility (or \`ditto semantic detect\` to seed manually).\n`;
}

/** Base ref candidates: work item start sha, then the usual remote/local mains. */
function baseCandidates(workItem: WorkItem): string[] {
  const candidates: string[] = [];
  if (workItem.started_at_sha) candidates.push(workItem.started_at_sha);
  candidates.push('origin/main', 'origin/master', 'main', 'master');
  return candidates;
}

/**
 * Resolve the nudge for a work item that is otherwise allowed to stop. Impure
 * (git only — cheap). Returns the message or null.
 */
export function computeSemanticNudge(
  repoRoot: string,
  workItem: WorkItem,
  opts: { semanticPresent: boolean; isNonTerminal: boolean },
): string | null {
  const base = pickBaseRef(repoRoot, baseCandidates(workItem));
  const changedSourceFiles = base ? filterSourceFiles(listChangedFilesVsRef(repoRoot, base)) : [];
  return semanticScanNudge({
    workItemId: workItem.id,
    isNonTerminal: opts.isNonTerminal,
    semanticPresent: opts.semanticPresent,
    base,
    changedSourceFiles,
  });
}
