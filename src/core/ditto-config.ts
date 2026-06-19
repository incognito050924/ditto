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
 *
 * `onMalformed` (optional) fires only when a file *exists but fails to parse*
 * (invalid JSON or schema-invalid) — NOT when the file is simply absent. The
 * caller (CLI) uses it to warn the user that their config was ignored, so a
 * silent fall-back to defaults doesn't look like the config "did nothing". The
 * callback keeps the stderr side-effect at the CLI layer, not in this reader.
 */
export async function readQuestionConfigDefaults(
  repoRoot: string,
  onMalformed?: () => void,
): Promise<RawQuestionConfig> {
  const file = Bun.file(localDir(repoRoot, 'config.json'));
  if (!(await file.exists())) return {};
  try {
    const parsed = dittoConfig.safeParse(JSON.parse(await file.text()));
    if (!parsed.success) {
      onMalformed?.();
      return {};
    }
    // zod validated the bounds and stripped absent keys, so the block is a valid
    // RawQuestionConfig at runtime. The assertion only bridges the type-level
    // `T | undefined` (zod .optional()) vs. `T?` (RawQuestionConfig) nuance under
    // exactOptionalPropertyTypes — it is not loosening any validation.
    return (parsed.data.tech_spec?.question ?? {}) as RawQuestionConfig;
  } catch {
    onMalformed?.();
    return {};
  }
}
