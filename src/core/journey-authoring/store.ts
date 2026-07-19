import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type AcgJourneySpec, acgJourneySpec } from '~/schemas/acg-journey-spec';
import { type AcgStorySpec, acgStorySpec } from '~/schemas/acg-story-spec';
import { localDir } from '../ditto-paths';
import { ensureDir, readJson, writeJson } from '../fs';
import { type JourneyAuthoringState, journeyAuthoringState } from './session-state';

/**
 * JourneyAuthoringStore — ADR-0005 per-entity persistence for journeys/stories.
 *
 * Journeys are ONE-FILE-PER-JOURNEY (`.ditto/local/journeys/<jrn-id>.json`) and
 * stories ONE-FILE-PER-STORY (`.ditto/local/stories/<us-id>.json`). There is NO
 * shared catalog file that finalize read-modify-writes: a single catalog file
 * would lose updates under worktree parallelism (ADR-0005 D1). The acgJourneySpec
 * "catalog" is a READ-SIDE PROJECTION — `loadAllJourneys` reduces the per-entity
 * files — never a write target. No file locks (ADR-20260628 rejected them).
 *
 * Writes go through `writeJson` (atomic temp-file + rename, schema-validated), so
 * each per-entity file is an independent atomic upsert.
 */
export class JourneyAuthoringStore {
  constructor(public readonly repoRoot: string) {}

  private journeysDir(): string {
    return localDir(this.repoRoot, 'journeys');
  }

  private storiesDir(): string {
    return localDir(this.repoRoot, 'stories');
  }

  journeyPath(id: string): string {
    return join(this.journeysDir(), `${id}.json`);
  }

  storyPath(id: string): string {
    return join(this.storiesDir(), `${id}.json`);
  }

  async getJourney(id: string): Promise<AcgJourneySpec | null> {
    if (!(await Bun.file(this.journeyPath(id)).exists())) return null;
    return readJson(this.journeyPath(id), acgJourneySpec);
  }

  async writeJourney(spec: AcgJourneySpec): Promise<AcgJourneySpec> {
    await ensureDir(this.journeysDir());
    return writeJson(this.journeyPath(spec.id), acgJourneySpec, spec);
  }

  /** Read-side projection: the journey catalog reduced from per-entity files. */
  async loadAllJourneys(): Promise<AcgJourneySpec[]> {
    return this.loadAll(this.journeysDir(), acgJourneySpec);
  }

  async writeStory(spec: AcgStorySpec): Promise<AcgStorySpec> {
    await ensureDir(this.storiesDir());
    return writeJson(this.storyPath(spec.id), acgStorySpec, spec);
  }

  private async loadAll<T>(
    dir: string,
    schema: { parse: (v: unknown) => T } & Parameters<typeof readJson>[1],
  ): Promise<T[]> {
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith('.json')).sort();
    } catch {
      return [];
    }
    const out: T[] = [];
    for (const name of names) {
      out.push(await readJson(join(dir, name), schema));
    }
    return out;
  }

  // ── working-state (per work item) ────────────────────────────────────────
  private sessionPath(workItemId: string): string {
    return join(localDir(this.repoRoot, 'work-items', workItemId), 'journey-authoring-state.json');
  }

  async sessionExists(workItemId: string): Promise<boolean> {
    return Bun.file(this.sessionPath(workItemId)).exists();
  }

  async getSession(workItemId: string): Promise<JourneyAuthoringState> {
    return readJson(this.sessionPath(workItemId), journeyAuthoringState);
  }

  async writeSession(state: JourneyAuthoringState): Promise<JourneyAuthoringState> {
    await ensureDir(localDir(this.repoRoot, 'work-items', state.work_item_id));
    return writeJson(this.sessionPath(state.work_item_id), journeyAuthoringState, state);
  }
}
