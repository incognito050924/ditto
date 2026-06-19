import { dittoConfig } from '~/schemas/ditto-config';
import { localDir } from './ditto-paths';
import type { RawQuestionConfig } from './tech-spec-options';

/**
 * Read the per-user `tech_spec.question` defaults from
 * `.ditto/local/config.json` (tier ③, gitignored, per-developer; wi_260619jmu).
 *
 * FAIL-OPEN: a missing file, invalid JSON, or schema-invalid config returns `{}`
 * and never throws — a broken config must not block `tech-spec start`. The
 * returned shape is RawQuestionConfig (every field optional), fed to
 * `resolveQuestionConfig(cliRaw, configRaw)` where explicit CLI flags still win.
 */
export async function readQuestionConfigDefaults(repoRoot: string): Promise<RawQuestionConfig> {
  const file = Bun.file(localDir(repoRoot, 'config.json'));
  if (!(await file.exists())) return {};
  try {
    const parsed = dittoConfig.safeParse(JSON.parse(await file.text()));
    if (!parsed.success) return {};
    // zod validated the bounds and stripped absent keys, so the block is a valid
    // RawQuestionConfig at runtime. The assertion only bridges the type-level
    // `T | undefined` (zod .optional()) vs. `T?` (RawQuestionConfig) nuance under
    // exactOptionalPropertyTypes — it is not loosening any validation.
    return (parsed.data.tech_spec?.question ?? {}) as RawQuestionConfig;
  } catch {
    return {};
  }
}
