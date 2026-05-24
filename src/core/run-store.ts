import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { type RunManifest, runManifest } from '~/schemas/run-manifest';
import { ensureDir, readJson, writeJson } from './fs';
import { generateId } from './id';

export interface RunCreateInput {
  work_item_id: RunManifest['work_item_id'];
  provider: RunManifest['provider'];
  entrypoint: string;
  profile: RunManifest['profile'];
  cwd: string;
  model_reported: RunManifest['model_reported'];
  git_before: RunManifest['git_before'];
  prompt_path?: RunManifest['prompt_path'];
}

export class RunStore {
  constructor(public readonly repoRoot: string) {}

  private runDir(id: string): string {
    return join(this.repoRoot, '.ditto', 'runs', id);
  }

  private manifestPath(id: string): string {
    return join(this.runDir(id), 'manifest.json');
  }

  async exists(id: string): Promise<boolean> {
    try {
      await stat(this.manifestPath(id));
      return true;
    } catch {
      return false;
    }
  }

  pathFor(
    id: string,
    kind: 'prompt.md' | 'stdout.log' | 'stderr.log' | 'diff.patch' | 'result.md' | 'verify.log',
  ): string {
    return join(this.runDir(id), kind);
  }

  async create(input: RunCreateInput, now: Date = new Date()): Promise<RunManifest> {
    const id = await generateId('run', (candidate) => this.exists(candidate));
    const nowIso = now.toISOString();
    const draft = {
      schema_version: '0.1.0' as const,
      id,
      work_item_id: input.work_item_id,
      provider: input.provider,
      entrypoint: input.entrypoint,
      model_reported: input.model_reported,
      profile: input.profile,
      cwd: input.cwd,
      ...(input.prompt_path !== undefined ? { prompt_path: input.prompt_path } : {}),
      git_before: input.git_before,
      changed_files: [],
      exit_code: null,
      started_at: nowIso,
      verifications: [],
      unverified: [],
    };
    await ensureDir(this.runDir(id));
    return writeJson(this.manifestPath(id), runManifest, draft);
  }

  async get(id: string): Promise<RunManifest> {
    return readJson(this.manifestPath(id), runManifest);
  }

  async update(id: string, mutator: (current: RunManifest) => RunManifest): Promise<RunManifest> {
    const current = await this.get(id);
    const next = mutator(current);
    if (next.id !== current.id) {
      throw new Error(`update mutator changed run id from ${current.id} to ${next.id}`);
    }
    return writeJson(this.manifestPath(id), runManifest, next);
  }
}
