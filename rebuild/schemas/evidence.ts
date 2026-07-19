import { z } from 'zod';

export const evidenceKind = z.enum([
  'command',
  'file',
  'test',
  'behavior',
  'repro',
]);

export type EvidenceKind = z.infer<typeof evidenceKind>;

export const evidence = z
  .object({
    kind: evidenceKind,
    path: z.string().optional(),
    hash: z.string().optional(),
    preview: z.string().max(2000).optional(),
    summary: z.string().min(1).max(500),
  })
  .strict()
  .refine((v) => !!(v.path || v.hash), {
    message:
      'evidence must carry a reference (path or hash), not inline content',
  });

export type Evidence = z.infer<typeof evidence>;
