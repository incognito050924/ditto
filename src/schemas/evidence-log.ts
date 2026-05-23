import { z } from 'zod';
import { isoDateTime, relativePath, sha256 } from './common';

export const commandLogEntry = z
  .object({
    ts: isoDateTime,
    kind: z
      .literal('command')
      .describe('Discriminator; only command entries are currently defined'),
    command: z.string().min(1).describe('Exact command line as executed'),
    exit_code: z.number().int(),
    duration_ms: z.number().int().nonnegative().optional(),
    sha256: sha256.optional().describe('Hash of captured output when stored as artifact'),
    output_path: relativePath
      .optional()
      .describe('Repo-relative path to the captured stdout/stderr file if stored separately'),
    work_item_id: z
      .string()
      .regex(/^wi_[a-z0-9]{8,}$/)
      .optional()
      .describe(
        'Work item that owns this log entry; redundant with file location but kept for self-contained replay',
      ),
    criterion_id: z
      .string()
      .optional()
      .describe('Acceptance criterion this command was meant to verify, if any'),
  })
  .describe('One line of .ditto/work-items/<id>/evidence/commands.jsonl');

export type CommandLogEntry = z.infer<typeof commandLogEntry>;
