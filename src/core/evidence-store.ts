import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { type CommandLogEntry, commandLogEntry } from '~/schemas/evidence-log';
import { atomicWriteText, ensureDir } from './fs';

export class EvidenceStore {
  constructor(public readonly repoRoot: string) {}

  private evidenceDir(workItemId: string): string {
    return join(this.repoRoot, '.ditto', 'work-items', workItemId, 'evidence');
  }

  private commandsPath(workItemId: string): string {
    return join(this.evidenceDir(workItemId), 'commands.jsonl');
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
