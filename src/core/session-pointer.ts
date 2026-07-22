import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { workItemId } from '~/schemas/common';
import { localDir } from './ditto-paths';
import { ensureDir, readJson, writeJson } from './fs';

/**
 * Single-active invariant: one `session_id → work_item_id` pointer
 * is the single source for "the active work item this session". UserPromptSubmit
 * and Stop read the SAME pointer so they always agree on which work item is live.
 * Stored at `.ditto/local/sessions/<session_id>.json`.
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

/**
 * Session pointers older than this (by filesystem mtime) are swept
 * (WS-HND-T3, wi_260706kdx): a pointer a reused session never overwrote would
 * otherwise re-bind that session to a long-dead work item forever. (The 7-day
 * figure originally mirrored the retired file-based handoff store's
 * active-sweep retention; it now stands on its own.)
 */
const STALE_SESSION_RETENTION_DAYS = 7;
const STALE_SESSION_RETENTION_MS = STALE_SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;

export class SessionPointerStore {
  constructor(public readonly repoRoot: string) {}

  private dir(): string {
    return localDir(this.repoRoot, 'sessions');
  }

  private path(sessionId: string): string {
    return join(this.dir(), `${safeSessionId(sessionId)}.json`);
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
    await ensureDir(localDir(this.repoRoot, 'sessions'));
    await writeJson(this.path(sessionId), sessionPointer, {
      schema_version: '0.1.0',
      session_id: sessionId,
      work_item_id: id,
      updated_at: now.toISOString(),
    });
  }

  /**
   * Retire this session's pointer (delete the file). Fail-open: a missing pointer
   * is a no-op, never throws. After clear, `get` returns null.
   */
  async clear(sessionId: string): Promise<void> {
    try {
      await unlink(this.path(sessionId));
    } catch {
      // missing / already-gone → nothing to retire (fail-open)
    }
  }

  /**
   * GC stale session pointers (WS-HND-T3, wi_260706kdx) — the once-per-prompt tick
   * that stops a reused session id from re-binding to a long-dead work item.
   * CONTENT-BLIND: staleness is decided by the filesystem mtime, NOT the parsed
   * `updated_at`, so a malformed pointer file still retires by age. Best-effort /
   * fail-open: a failed stat/unlink just leaves the file for a later turn and never
   * throws. DELETES (pointers are cheap, single-source state — nothing to preserve).
   * Returns the swept paths.
   */
  async sweepStale(now: Date = new Date()): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir());
    } catch {
      return []; // no sessions dir yet
    }
    const swept: string[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const path = join(this.dir(), name);
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(path)).mtimeMs;
      } catch {
        continue; // can't stat → skip (fail-open)
      }
      if (now.getTime() - mtimeMs <= STALE_SESSION_RETENTION_MS) continue; // within limit → stays
      try {
        await unlink(path);
        swept.push(path);
      } catch {
        // best-effort: a failed unlink just leaves it for a later turn
      }
    }
    return swept;
  }
}
