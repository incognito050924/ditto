import { readFile } from 'node:fs/promises';
import type { ZodTypeAny, z } from 'zod';

import { localDir } from './paths';

/**
 * Generic FAIL-OPEN reader for the per-developer config store
 * `.ditto/local/config.json` (tier ③, gitignored).
 *
 * FAIL-OPEN: a missing file, invalid JSON, or schema-invalid content returns
 * the caller-provided `defaults` and never throws — a broken config must not
 * block the surface reading it. Callers pass the zod schema for the shape they
 * need; this reader is not coupled to any specific config block.
 *
 * `onMalformed` fires only when the file *exists but fails to parse or
 * validate* — NOT when it is simply absent — so the caller can warn that a
 * broken config was ignored instead of letting a silent fall-back to defaults
 * look like the config "did nothing".
 */
export async function readLocalConfig<S extends ZodTypeAny>(
  repoRoot: string,
  schema: S,
  defaults: z.output<S>,
  onMalformed?: () => void,
): Promise<z.output<S>> {
  let text: string;
  try {
    text = await readFile(localDir(repoRoot, 'config.json'), 'utf8');
  } catch {
    // Absent (or unreadable) file → defaults, no malformed signal.
    return defaults;
  }
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      onMalformed?.();
      return defaults;
    }
    return parsed.data;
  } catch {
    onMalformed?.();
    return defaults;
  }
}
