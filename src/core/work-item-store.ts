import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { languageLedger } from '~/schemas/language-ledger';
import { type WorkItem, workItem } from '~/schemas/work-item';
import { atomicWriteText, ensureDir, readJson, writeJson } from './fs';
import { generateId } from './id';

/**
 * Best-effort read of the current git HEAD sha for `repoRoot`.
 * Returns null if `repoRoot` is not a git work tree, git is missing,
 * or the rev-parse output is not a 40-char hex sha.
 */
function tryGitHeadSha(repoRoot: string): string | null {
  const proc = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {
    cwd: repoRoot,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (proc.exitCode !== 0) return null;
  const sha = (proc.stdout?.toString() ?? '').trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) return null;
  return sha;
}

export interface WorkItemCreateInput {
  title: string;
  source_request: string;
  goal: string;
  acceptance_criteria: WorkItem['acceptance_criteria'];
  owner_profile?: WorkItem['owner_profile'];
  parent_id?: WorkItem['parent_id'];
}

export interface WorkItemSummary {
  id: string;
  title: string;
  status: WorkItem['status'];
  updated_at: string;
}

export class WorkItemStore {
  constructor(public readonly repoRoot: string) {}

  private workItemDir(id: string): string {
    return join(this.repoRoot, '.ditto', 'work-items', id);
  }

  private workItemPath(id: string): string {
    return join(this.workItemDir(id), 'work-item.json');
  }

  private languageLedgerPath(id: string): string {
    return join(this.workItemDir(id), 'language-ledger.json');
  }

  async exists(id: string): Promise<boolean> {
    try {
      await stat(this.workItemPath(id));
      return true;
    } catch {
      return false;
    }
  }

  async create(input: WorkItemCreateInput, now: Date = new Date()): Promise<WorkItem> {
    const id = await generateId('wi', (candidate) => this.exists(candidate));
    const nowIso = now.toISOString();
    const draft = {
      schema_version: '0.1.0' as const,
      id,
      title: input.title,
      source_request: input.source_request,
      goal: input.goal,
      acceptance_criteria: input.acceptance_criteria,
      status: 'draft' as const,
      owner_profile: input.owner_profile ?? ('workspace-write' as const),
      ...(input.parent_id !== undefined ? { parent_id: input.parent_id } : {}),
      child_ids: [],
      changed_files: [],
      risks: [],
      runs: [],
      created_at: nowIso,
      updated_at: nowIso,
    };
    await ensureDir(join(this.workItemDir(id), 'evidence'));
    const written = await writeJson(this.workItemPath(id), workItem, draft);
    await writeJson(this.languageLedgerPath(id), languageLedger, {
      schema_version: '0.1.0',
      work_item_id: id,
      created_at: nowIso,
      updated_at: nowIso,
      changes: [],
    });
    return written;
  }

  async get(id: string): Promise<WorkItem> {
    return readJson(this.workItemPath(id), workItem);
  }

  /**
   * Read, transform, validate, and atomically replace a work item.
   * The mutator must not produce a different `id`; that would be a different
   * work item entirely.
   */
  async update(id: string, mutator: (current: WorkItem) => WorkItem): Promise<WorkItem> {
    const current = await this.get(id);
    const next = mutator(current);
    if (next.id !== current.id) {
      throw new Error(`update mutator changed work item id from ${current.id} to ${next.id}`);
    }
    // draft → in_progress 전환 시점에 한 번만 git HEAD sha를 박는다.
    // 이미 박혀 있으면 손대지 않음(idempotent). git 실패 시 omit.
    let withSha: WorkItem = next;
    if (
      current.status === 'draft' &&
      next.status === 'in_progress' &&
      next.started_at_sha === undefined
    ) {
      const sha = tryGitHeadSha(this.repoRoot);
      if (sha !== null) {
        withSha = { ...next, started_at_sha: sha };
      }
    }
    const withTouched = { ...withSha, updated_at: new Date().toISOString() };
    return writeJson(this.workItemPath(id), workItem, withTouched);
  }

  async list(): Promise<WorkItemSummary[]> {
    const base = join(this.repoRoot, '.ditto', 'work-items');
    let entries: string[];
    try {
      entries = await readdir(base);
    } catch {
      return [];
    }
    const summaries: WorkItemSummary[] = [];
    for (const name of entries) {
      const dir = join(base, name);
      let s: Awaited<ReturnType<typeof stat>>;
      try {
        s = await stat(dir);
      } catch {
        continue;
      }
      if (!s.isDirectory()) continue;
      try {
        const item = await readJson(join(dir, 'work-item.json'), workItem);
        summaries.push({
          id: item.id,
          title: item.title,
          status: item.status,
          updated_at: item.updated_at,
        });
      } catch {
        // skip malformed work items in list; they will fail
        // on explicit get() with a clear schema error.
      }
    }
    summaries.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
    return summaries;
  }

  async appendCommandLogLine(workItemId: string, jsonLine: string): Promise<void> {
    const dir = join(this.workItemDir(workItemId), 'evidence');
    await ensureDir(dir);
    const path = join(dir, 'commands.jsonl');
    const file = Bun.file(path);
    const existing = (await file.exists()) ? await file.text() : '';
    const trimmedExisting =
      existing.endsWith('\n') || existing.length === 0 ? existing : `${existing}\n`;
    await atomicWriteText(path, `${trimmedExisting}${jsonLine}\n`);
  }
}

// Re-export the input shape for type imports
export type { WorkItem };

// Helper for callers that want to validate ad-hoc work item objects
export const workItemSchema = workItem;
export const partialWorkItemSchema = workItem;
export const acceptanceCriterionInputSchema = z
  .object({
    id: z.string().min(1),
    statement: z.string().min(1),
  })
  .passthrough();
