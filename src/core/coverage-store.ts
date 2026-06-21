import { join, relative } from 'node:path';
import { type CoverageMap, coverageMap } from '~/schemas/coverage';
import { localDir } from './ditto-paths';
import { atomicWriteText, ensureDir, readJson, writeJson } from './fs';

/**
 * CoverageStore — the ONLY path that mutates the §9 plan-stage runtime artifacts.
 * Mirrors AutopilotStore: callers never write `coverage.json` / `plan-dialog.md`
 * directly; they go through `writeMap` / `writePlanDialog` so every coverage-map
 * mutation is schema-validated (coverageMap zod) and atomic. The two artifacts
 * live under `.ditto/local/runs/<wi>/` (per-developer runtime tier, §9).
 */
export class CoverageStore {
  constructor(public readonly repoRoot: string) {}

  private dir(workItemId: string): string {
    return localDir(this.repoRoot, 'runs', workItemId);
  }

  private mapPath(workItemId: string): string {
    return join(this.dir(workItemId), 'coverage.json');
  }

  private dialogPath(workItemId: string): string {
    return join(this.dir(workItemId), 'plan-dialog.md');
  }

  private intentDialogPath(workItemId: string): string {
    return join(this.dir(workItemId), 'intent-dialog.md');
  }

  /** True once a coverage sweep has produced coverage.json for this work item. */
  async exists(workItemId: string): Promise<boolean> {
    return Bun.file(this.mapPath(workItemId)).exists();
  }

  /**
   * Repo-relative path of coverage.json (for evidenceRef projection). Returns the
   * path even if the file is absent — callers gate on `exists` first.
   */
  relMapPath(workItemId: string): string {
    return relative(this.repoRoot, this.mapPath(workItemId));
  }

  async getMap(workItemId: string): Promise<CoverageMap> {
    return readJson(this.mapPath(workItemId), coverageMap);
  }

  /** Initial create / full replace of the coverage map. Validated + atomic. */
  async writeMap(workItemId: string, map: CoverageMap): Promise<CoverageMap> {
    await ensureDir(this.dir(workItemId));
    return writeJson(this.mapPath(workItemId), coverageMap, map);
  }

  /** Render plan-dialog.md (markdown produced by serializePlanDialog). Atomic. */
  async writePlanDialog(workItemId: string, markdown: string): Promise<void> {
    await ensureDir(this.dir(workItemId));
    await atomicWriteText(this.dialogPath(workItemId), markdown);
  }

  /**
   * Render intent-dialog.md (§9) — the intent-stage sibling of plan-dialog.md.
   * Same markdown shape (serializePlanDialog with stage='intent'); the engine is
   * reused, only the destination file differs. Atomic.
   */
  async writeIntentDialog(workItemId: string, markdown: string): Promise<void> {
    await ensureDir(this.dir(workItemId));
    await atomicWriteText(this.intentDialogPath(workItemId), markdown);
  }
}
