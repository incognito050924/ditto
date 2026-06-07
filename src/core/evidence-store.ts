import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { z } from 'zod';
import { type CommandLogEntry, commandLogEntry } from '~/schemas/evidence-log';
import { type EvidenceIndex, evidenceIndex, evidenceRecord } from '~/schemas/evidence-record';
import { localDir } from './ditto-paths';
import { atomicWriteText, ensureDir, readJson, writeJson } from './fs';

export class EvidenceStore {
  constructor(public readonly repoRoot: string) {}

  private workItemDir(workItemId: string): string {
    return localDir(this.repoRoot, 'work-items', workItemId);
  }

  private evidenceDir(workItemId: string): string {
    return join(this.workItemDir(workItemId), 'evidence');
  }

  private commandsPath(workItemId: string): string {
    return join(this.evidenceDir(workItemId), 'commands.jsonl');
  }

  // evidence-index.json은 work-item 루트에 둔다(evidence/ 하위 아님) — gitignore 대상인
  // raw evidence/ 와 달리 커밋 가능한 ledger다(설계서 §8 layout).
  private evidenceIndexPath(workItemId: string): string {
    return join(this.workItemDir(workItemId), 'evidence-index.json');
  }

  /**
   * Append one command log entry to the work item's commands.jsonl.
   * Entry is validated against commandLogEntry schema; invalid input throws.
   *
   * The file is rewritten atomically (read existing + new line, then
   * atomic write of the full content). For v0.1 this is acceptable;
   * concurrent writers and growth limits are deferred to a later phase.
   */
  async appendCommand(workItemId: string, entry: CommandLogEntry): Promise<CommandLogEntry> {
    const parsed = commandLogEntry.parse(entry);
    await ensureDir(this.evidenceDir(workItemId));
    const path = this.commandsPath(workItemId);
    const file = Bun.file(path);
    const existing = (await file.exists()) ? await file.text() : '';
    const trimmed = existing.length === 0 || existing.endsWith('\n') ? existing : `${existing}\n`;
    const line = JSON.stringify(parsed);
    await atomicWriteText(path, `${trimmed}${line}\n`);
    return parsed;
  }

  /**
   * Read all entries; lines that fail schema parse throw with file:line context.
   * Use sparingly — for large logs, callers should stream.
   */
  async readAll(workItemId: string): Promise<CommandLogEntry[]> {
    const path = this.commandsPath(workItemId);
    const file = Bun.file(path);
    if (!(await file.exists())) return [];
    const text = await file.text();
    const lines = text.split('\n').filter((l) => l.length > 0);
    return lines.map((line, idx) => {
      try {
        return commandLogEntry.parse(JSON.parse(line));
      } catch (err) {
        throw new Error(`commands.jsonl ${path}:${idx + 1} invalid: ${String(err)}`);
      }
    });
  }

  /**
   * Read the committable evidence-index.json ledger. Returns an empty index
   * (no records) when the file does not exist yet. A schema-invalid file
   * throws (fail-closed; the ledger is a completion input, not a crash).
   */
  async readIndex(workItemId: string): Promise<EvidenceIndex> {
    const path = this.evidenceIndexPath(workItemId);
    if (!(await Bun.file(path).exists())) {
      return { schema_version: '0.1.0', work_item_id: workItemId, records: [] };
    }
    return readJson(path, evidenceIndex);
  }

  /**
   * Append one EvidenceRecord to the work item's evidence-index.json ledger.
   * Append-only: existing records are preserved and the new one is added at the
   * end. The whole index is validated against the schema (each record's
   * cross-field rules included) and written atomically. Returns the new ledger.
   */
  async appendRecord(
    workItemId: string,
    record: z.input<typeof evidenceRecord>,
  ): Promise<EvidenceIndex> {
    const current = await this.readIndex(workItemId);
    const next: z.input<typeof evidenceIndex> = {
      schema_version: '0.1.0',
      work_item_id: workItemId,
      records: [...current.records, evidenceRecord.parse(record)],
    };
    await ensureDir(this.workItemDir(workItemId));
    return writeJson(this.evidenceIndexPath(workItemId), evidenceIndex, next);
  }
}

/**
 * Compute a sha256 over arbitrary content. Used by callers when storing
 * stdout/stderr separately and only carrying a hash inline.
 */
export function sha256Hex(content: string | Uint8Array): string {
  const hash = createHash('sha256');
  hash.update(content);
  return hash.digest('hex');
}
