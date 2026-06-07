import { readFileSync } from 'node:fs';
import { computeScanFingerprint, workItemBaseCandidates } from '~/acg/semantic/scan-observation';
import { localDir } from '~/core/ditto-paths';
import { diffVsRef, gitRevParse, listChangedFilesVsRef } from '~/core/git';
import { pickBaseRef } from '~/core/work-item-handoff';
import { acgSemanticScanObservation } from '~/schemas/acg-semantic-scan-observation';
import type { WorkItem } from '~/schemas/work-item';

/**
 * S1+S3 (wi_260605aw1) — Stop-time semantic-scan AX nudge.
 *
 * The autowiring dialectic (reviews/dialectic-1) ruled the heavy CodeQL scan out
 * of the Stop hook (ADR-0001 perf contract). What belongs here is the cheap ACG
 * direction-keeping signal that reflects the observe flow:
 *   - source changed, no fresh observation → "run `ditto semantic observe`".
 *   - fresh observation WITH changes, not yet promoted to a blocking verdict →
 *     "promote the breaking ones (`ditto semantic detect`/`verdict`)".
 *   - fresh observation with zero changes, or a blocking artifact already present
 *     → silent.
 * "Fresh" = the observation's fingerprint matches the current tree (so it
 * describes exactly this state). No CodeQL here — only git diff + a file read.
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
  /** A blocking semantic-compatibility.json already exists. */
  semanticPresent: boolean;
  /** Resolved base ref, or null when none resolves. */
  base: string | null;
  /** Changed source files vs base (already filtered). */
  changedSourceFiles: string[];
  /** Change count from a FRESH observation (fingerprint matches now), or null. */
  observationChangeCount: number | null;
}

/** The advisory message, or null when no nudge is warranted. Pure. */
export function semanticScanNudge(input: SemanticNudgeInput): string | null {
  if (!input.isNonTerminal) return null;
  if (input.semanticPresent) return null;
  if (input.base === null) return null;
  if (input.changedSourceFiles.length === 0) return null;

  if (input.observationChangeCount === null) {
    return `DITTO semantic check: ${input.changedSourceFiles.length} changed source file(s) vs ${input.base} but no current semantic-scan-observation.json. Run \`ditto semantic observe --work-item ${input.workItemId} --base ${input.base}\` to check exported-signature changes.\n`;
  }
  if (input.observationChangeCount === 0) return null;
  return `DITTO semantic check: ${input.observationChangeCount} observed exported-signature change(s) (semantic-scan-observation.json) not yet resolved. Promote any meaning-breaking change with \`ditto semantic detect\` + \`ditto semantic verdict\`, or declare it intended.\n`;
}

/**
 * Resolve the nudge for a work item that is otherwise allowed to stop. Impure
 * (git + a file read — cheap, no CodeQL). Returns the message or null.
 */
export function computeSemanticNudge(
  repoRoot: string,
  workItem: WorkItem,
  opts: { semanticPresent: boolean; isNonTerminal: boolean },
): string | null {
  const base = pickBaseRef(repoRoot, workItemBaseCandidates(workItem));
  const changedSourceFiles = base ? filterSourceFiles(listChangedFilesVsRef(repoRoot, base)) : [];
  return semanticScanNudge({
    workItemId: workItem.id,
    isNonTerminal: opts.isNonTerminal,
    semanticPresent: opts.semanticPresent,
    base,
    changedSourceFiles,
    observationChangeCount: base ? freshObservationChangeCount(repoRoot, workItem.id, base) : null,
  });
}

/**
 * Change count from the work item's observation IF it describes the current tree
 * (fingerprint match); otherwise null (stale or absent → treat as no observation).
 */
function freshObservationChangeCount(
  repoRoot: string,
  workItemId: string,
  base: string,
): number | null {
  try {
    const path = localDir(repoRoot, 'work-items', workItemId, 'semantic-scan-observation.json');
    const parsed = acgSemanticScanObservation.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    if (!parsed.success) return null;
    const fingerprintNow = computeScanFingerprint(
      gitRevParse(repoRoot, base),
      diffVsRef(repoRoot, base),
    );
    return parsed.data.fingerprint === fingerprintNow ? parsed.data.change_count : null;
  } catch {
    return null;
  }
}
