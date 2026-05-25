import { z } from 'zod';
import { relativePath, schemaVersion } from './common';

export const surfaceCatalogEntry = z.object({
  host: z.enum(['codex', 'claude-code']),
  kind: z.enum(['skill', 'agent', 'command', 'plugin']),
  id: z.string().min(1),
  path: relativePath,
});

export const surfaceCatalog = z.object({
  schema_version: schemaVersion,
  surfaces: z.array(surfaceCatalogEntry),
});

export type SurfaceCatalog = z.output<typeof surfaceCatalog>;
