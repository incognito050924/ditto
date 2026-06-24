import { type RetroMetricSnapshot, retroMetricSnapshot } from '~/schemas/retro-metric-snapshot';
import { localDir } from './ditto-paths';
import { atomicWriteText } from './fs';

/**
 * Append-only jsonl ledger of retro measurement snapshots (ADR-0024 Decision 4
 * trend preservation). One file for the whole repo
 * (`.ditto/local/retro-metrics.jsonl`) — crossing work item boundaries is the
 * point: the trend the ADR's retract condition needs ("does the floor reduce
 * weak-planner variance?") only exists across WIs. Mirrors `CoverageFeedbackLedger`
 * (read-existing + append-one + atomic full rewrite; concurrent writers deferred).
 *
 * ONE row per work item (first-wins idempotency), mirroring the retro memory
 * absorption's stable-key idempotency: re-driving a retro node never double-appends.
 * The row copies the `RetroMetrics` shape verbatim (anti-SLOP: an absent slot means
 * ungrounded, never a fabricated zero) — the ledger preserves, it does not invent.
 */
export class RetroMetricLedger {
  constructor(public readonly repoRoot: string) {}

  private path(): string {
    return localDir(this.repoRoot, 'retro-metrics.jsonl');
  }

  /**
   * Append one snapshot. `recorded_at` is INJECTED by the caller (never read from
   * the clock here) so the ledger stays deterministic and a sandbox that blocks
   * `new Date()` cannot break recording. Idempotent per `work_item_id`: if a row
   * for this WI already exists it is returned unchanged (no second row). The row is
   * schema-validated (retroMetricSnapshot) before it is written.
   */
  async append(
    row: Omit<RetroMetricSnapshot, 'recorded_at' | 'schema_version'>,
    recordedAt: string,
  ): Promise<RetroMetricSnapshot> {
    const existing = await this.readAll();
    const prior = existing.find((r) => r.work_item_id === row.work_item_id);
    if (prior) return prior;
    const entry = retroMetricSnapshot.parse({
      ...row,
      schema_version: '0.1.0',
      recorded_at: recordedAt,
    });
    const path = this.path();
    const file = Bun.file(path);
    const text = (await file.exists()) ? await file.text() : '';
    const trimmed = text.length === 0 || text.endsWith('\n') ? text : `${text}\n`;
    await atomicWriteText(path, `${trimmed}${JSON.stringify(entry)}\n`);
    return entry;
  }

  /**
   * Read every snapshot. A line that fails schema parse throws with file:line
   * context (fail-closed — a corrupt ledger is a real problem, not a silent skip).
   */
  async readAll(): Promise<RetroMetricSnapshot[]> {
    const path = this.path();
    const file = Bun.file(path);
    if (!(await file.exists())) return [];
    const text = await file.text();
    const lines = text.split('\n').filter((l) => l.length > 0);
    return lines.map((line, i) => {
      try {
        return retroMetricSnapshot.parse(JSON.parse(line));
      } catch (err) {
        throw new Error(
          `retro-metrics.jsonl:${i + 1} failed schema parse: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }
}
