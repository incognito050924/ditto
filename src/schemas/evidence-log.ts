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
  .describe('One line of .ditto/local/work-items/<id>/evidence/commands.jsonl');

export type CommandLogEntry = z.infer<typeof commandLogEntry>;

export const editLogEntry = z
  .object({
    ts: isoDateTime,
    kind: z.literal('edit').describe('Discriminator for file-mutation tool entries'),
    tool: z
      .enum(['Edit', 'Write', 'MultiEdit'])
      .describe('The file-mutation tool that produced this change'),
    file_path: z
      .string()
      .min(1)
      .describe('Path of the edited/written file as the tool received it'),
    work_item_id: z
      .string()
      .regex(/^wi_[a-z0-9]{8,}$/)
      .optional()
      .describe('Work item that owns this log entry; redundant with file location'),
  })
  .describe(
    'One line of .ditto/local/work-items/<id>/evidence/edits.jsonl. Records Edit/Write/MultiEdit ' +
      'tool use so evidence collection is not command-only (V6); audit of what files a node touched.',
  );

export type EditLogEntry = z.infer<typeof editLogEntry>;
