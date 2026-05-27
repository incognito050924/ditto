import { join } from 'node:path';
import { z } from 'zod';
import { workItemId } from '~/schemas/common';
import { ensureDir, readJson, writeJson } from './fs';

/**
 * Single-active invariant (plan §3 F3): one `session_id → work_item_id` pointer
 * is the single source for "the active work item this session". UserPromptSubmit
 * and Stop read the SAME pointer so they always agree on which work item is live.
 * Stored at `.ditto/sessions/<session_id>.json`.
 */
const sessionPointer = z.object({
  schema_version: z.literal('0.1.0'),
  session_id: z.string().min(1),
  work_item_id: workItemId,
  updated_at: z.string().min(1),
});

/** Filesystem-safe session id (Claude Code session ids are uuids; be defensive). */
function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export class SessionPointerStore {
  constructor(public readonly repoRoot: string) {}

  private path(sessionId: string): string {
    return join(this.repoRoot, '.ditto', 'sessions', `${safeSessionId(sessionId)}.json`);
  }

  /** The work item id this session points at, or null when unset/unreadable. */
  async get(sessionId: string): Promise<string | null> {
    try {
      const parsed = await readJson(this.path(sessionId), sessionPointer);
      return parsed.work_item_id;
    } catch {
      return null;
    }
  }

  async set(sessionId: string, id: string, now: Date = new Date()): Promise<void> {
    await ensureDir(join(this.repoRoot, '.ditto', 'sessions'));
    await writeJson(this.path(sessionId), sessionPointer, {
      schema_version: '0.1.0',
      session_id: sessionId,
      work_item_id: id,
      updated_at: now.toISOString(),
    });
  }
}
