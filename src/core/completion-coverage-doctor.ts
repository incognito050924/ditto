import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CompletionContract } from '~/schemas/completion-contract';
import { completionContract } from '~/schemas/completion-contract';
import { workItem } from '~/schemas/work-item';
import { CompletionStore } from './completion-store';
import { localDir } from './ditto-paths';
import { readJson } from './fs';
import { WorkItemStore, type WorkItemSummary } from './work-item-store';

/**
 * completion-coverage doctor (measurement-infra) — aggregates the ground-truth
 * metric ⑦ "completion-evidence coverage = evidence-closed acceptance / total
 * acceptance" across work items, from data that is ALREADY persisted. No new
 * instrumentation: each work item's `completion.json` (work-item dir + archive)
 * already records per-AC `verdict`/`evidence`; this only counts across them.
 *
 * The closure rule encodes claim ≠ proof: an AC counts as "closed" only when its
 * verdict is `pass` AND it carries at least one evidence ref (bare `evidence` or
 * sidecar `evidence_records`). A `pass` with no evidence is a claim, not proof,
 * and is NOT counted — mirroring the completion gate's evidence requirement.
 */

/** Whether an acceptance verdict is closed by evidence (claim ≠ proof). */
function isClosed(ac: CompletionContract['acceptance'][number]): boolean {
  const hasEvidence = (ac.evidence?.length ?? 0) > 0 || (ac.evidence_records?.length ?? 0) > 0;
  return ac.verdict === 'pass' && hasEvidence;
}

/**
 * Auxiliary probe (advisory, NON-gating) for the wi_260614ojc recurrence class:
 * a `pass` AC whose ONLY evidence is `kind:"command"` (a unit/CLI test) with NO
 * `kind:"file"`/`kind:"artifact"` evidence pointing at a runtime/artifact path.
 * Such a closure proves a function runs in a test, not that the feature is wired
 * into the runtime path or that its §9 artifact was produced. This does NOT change
 * `isClosed` or any verdict — it only surfaces "closed on unit evidence alone" so
 * the real guardrail (AC-authoring discipline, §11) has a visible signal. A
 * non-pass AC is never flagged: only closures can be falsely-green.
 */
export function isUnitOnlyClosure(ac: CompletionContract['acceptance'][number]): boolean {
  if (ac.verdict !== 'pass') return false;
  const refs = [...(ac.evidence ?? []), ...(ac.evidence_records ?? [])];
  if (refs.length === 0) return false;
  const hasCommand = refs.some((e) => e.kind === 'command');
  const hasRuntimeOrArtifact = refs.some((e) => e.kind === 'file' || e.kind === 'artifact');
  return hasCommand && !hasRuntimeOrArtifact;
}

/**
 * Aggregate the `isUnitOnlyClosure` probe over a completion's acceptance set
 * (ADR-0024 결정4 ① 산출물 floor). The per-AC probe above is the unit; the retro
 * needs the COUNT of unit-only (falsely-green) closures across the work item.
 * Pure over the completion; absent acceptance ⇒ 0.
 */
export function countUnitOnlyClosures(completion: CompletionContract | null): number {
  return (completion?.acceptance ?? []).filter(isUnitOnlyClosure).length;
}

export interface CompletionCoverageRow {
  work_item_id: string;
  title: string;
  status: WorkItemSummary['status'];
  /** Whether a completion.json was present for this work item. */
  has_completion: boolean;
  total_acceptance: number;
  /** ACs closed by evidence (verdict=pass AND at least one evidence ref). */
  closed_acceptance: number;
  /** closed / total; 0 when there are no acceptance criteria. */
  coverage: number;
}

export interface CompletionCoverageTotals {
  work_items: number;
  with_completion: number;
  total_acceptance: number;
  closed_acceptance: number;
  /** total_closed / total_acceptance; 0 when there are none. */
  coverage: number;
}

export interface CompletionCoverageReport {
  rows: CompletionCoverageRow[];
  totals: CompletionCoverageTotals;
}

export interface CompletionCoverageDeps {
  listWorkItems(): Promise<WorkItemSummary[]>;
  /** Read completion.json for a work item, or null when absent/unreadable. */
  readCompletion(workItemId: string): Promise<CompletionContract | null>;
}

/** Read every archived completion.json from `.ditto/local/archive/<label>/<wi>/`. */
async function listArchived(repoRoot: string): Promise<WorkItemSummary[]> {
  const base = localDir(repoRoot, 'archive');
  let labels: string[];
  try {
    labels = await readdir(base);
  } catch {
    return [];
  }
  const out: WorkItemSummary[] = [];
  for (const label of labels) {
    let ids: string[];
    try {
      ids = await readdir(join(base, label));
    } catch {
      continue;
    }
    for (const id of ids) {
      try {
        const item = await readJson(join(base, label, id, 'work-item.json'), workItem);
        out.push({ id, title: item.title, status: item.status, updated_at: item.updated_at });
      } catch {
        // skip non-work-item dirs / malformed items
      }
    }
  }
  return out;
}

/** Read a completion.json at an explicit archive path, or null when absent. */
async function readArchivedCompletion(
  repoRoot: string,
  label: string,
  id: string,
): Promise<CompletionContract | null> {
  const path = localDir(repoRoot, 'archive', label, id, 'completion.json');
  if (!(await Bun.file(path).exists())) return null;
  try {
    return await readJson(path, completionContract);
  } catch {
    return null;
  }
}

/** Wire the real stores. Each reader is fail-open: a missing sidecar is null. */
export function defaultCompletionCoverageDeps(repoRoot: string): CompletionCoverageDeps {
  const workItems = new WorkItemStore(repoRoot);
  const completions = new CompletionStore(repoRoot);
  // Map archived id → label so readCompletion can locate the archived file.
  const archiveLabelOf = new Map<string, string>();
  return {
    listWorkItems: async () => {
      const active = await workItems.list();
      const base = localDir(repoRoot, 'archive');
      let labels: string[] = [];
      try {
        labels = await readdir(base);
      } catch {
        labels = [];
      }
      for (const label of labels) {
        try {
          for (const id of await readdir(join(base, label))) archiveLabelOf.set(id, label);
        } catch {
          // skip unreadable label dir
        }
      }
      const archived = await listArchived(repoRoot);
      return [...active, ...archived];
    },
    readCompletion: async (id) => {
      const label = archiveLabelOf.get(id);
      if (label) return readArchivedCompletion(repoRoot, label, id);
      return (await completions.exists(id)) ? completions.get(id) : null;
    },
  };
}

function buildRow(
  summary: WorkItemSummary,
  completion: CompletionContract | null,
): CompletionCoverageRow {
  const acceptance = completion?.acceptance ?? [];
  const total = acceptance.length;
  const closed = acceptance.filter(isClosed).length;
  return {
    work_item_id: summary.id,
    title: summary.title,
    status: summary.status,
    has_completion: completion !== null,
    total_acceptance: total,
    closed_acceptance: closed,
    coverage: total === 0 ? 0 : closed / total,
  };
}

function totalsOf(rows: CompletionCoverageRow[]): CompletionCoverageTotals {
  const totalAcceptance = rows.reduce((s, r) => s + r.total_acceptance, 0);
  const closedAcceptance = rows.reduce((s, r) => s + r.closed_acceptance, 0);
  return {
    work_items: rows.length,
    with_completion: rows.filter((r) => r.has_completion).length,
    total_acceptance: totalAcceptance,
    closed_acceptance: closedAcceptance,
    coverage: totalAcceptance === 0 ? 0 : closedAcceptance / totalAcceptance,
  };
}

export async function collectCompletionCoverageReport(
  deps: CompletionCoverageDeps,
): Promise<CompletionCoverageReport> {
  const summaries = await deps.listWorkItems();
  const rows: CompletionCoverageRow[] = [];
  for (const summary of summaries) {
    const completion = await deps.readCompletion(summary.id);
    rows.push(buildRow(summary, completion));
  }
  return { rows, totals: totalsOf(rows) };
}
