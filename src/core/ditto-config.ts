import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type DittoConfig,
  type DittoConfigDeepInterview,
  type DittoConfigGithub,
  dittoConfig,
} from '~/schemas/ditto-config';
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

/**
 * Read the per-user `deep_interview` defaults from `.ditto/local/config.json`
 * (tier ③, gitignored, per-developer; wi_260621p6a).
 *
 * Same FAIL-OPEN contract as {@link readQuestionConfigDefaults}: a missing file,
 * invalid JSON, or schema-invalid config returns `{}` and never throws — a broken
 * config must not block `deep-interview start`. The returned shape is
 * DittoConfigDeepInterview (every field optional); the CLI fills absent flags from
 * it (`CLI flag > config > code default`) so an explicit flag still wins.
 *
 * `onMalformed` fires only when a file *exists but fails to parse* — NOT when it
 * is simply absent — so the CLI can warn that a broken config was ignored instead
 * of letting a silent fall-back to defaults look like the config "did nothing".
 */
export async function readDeepInterviewConfigDefaults(
  repoRoot: string,
  onMalformed?: () => void,
): Promise<DittoConfigDeepInterview> {
  const file = Bun.file(localDir(repoRoot, 'config.json'));
  if (!(await file.exists())) return {};
  try {
    const parsed = dittoConfig.safeParse(JSON.parse(await file.text()));
    if (!parsed.success) {
      onMalformed?.();
      return {};
    }
    return parsed.data.deep_interview ?? {};
  } catch {
    onMalformed?.();
    return {};
  }
}

/**
 * Read the `github` block from `.ditto/local/config.json` (wi_260628d79, G9/D8).
 *
 * Same FAIL-OPEN contract as the readers above: a missing file, invalid JSON, or
 * schema-invalid config returns `undefined` and never throws — a broken config
 * must not block a completion/reflection path (ADR-0018 우아한 강등). Used by the
 * later G4/G5 reflection nodes to discover the linked Project + D7 status_map.
 */
export async function readGithubConfig(
  repoRoot: string,
  onMalformed?: () => void,
): Promise<DittoConfigGithub | undefined> {
  const file = Bun.file(localDir(repoRoot, 'config.json'));
  if (!(await file.exists())) return undefined;
  try {
    const parsed = dittoConfig.safeParse(JSON.parse(await file.text()));
    if (!parsed.success) {
      onMalformed?.();
      return undefined;
    }
    return parsed.data.github;
  } catch {
    onMalformed?.();
    return undefined;
  }
}

/**
 * Write the `github` block into `.ditto/local/config.json`, PRESERVING any other
 * blocks (`tech_spec`, `deep_interview`) already present (wi_260628d79). The single
 * config store (one file, the EXISTING dittoConfig schema) is reused — no parallel
 * github-specific config file. A malformed/absent existing file is treated as `{}`
 * (fail-open) so a broken sibling block does not block writing the github block.
 * Idempotent: writing the same github value twice yields byte-identical content.
 */
export async function writeGithubConfig(
  repoRoot: string,
  github: DittoConfigGithub,
): Promise<void> {
  const path = localDir(repoRoot, 'config.json');
  let existing: DittoConfig = {};
  const file = Bun.file(path);
  if (await file.exists()) {
    try {
      const parsed = dittoConfig.safeParse(JSON.parse(await file.text()));
      if (parsed.success) existing = parsed.data;
    } catch {
      // fail-open: a malformed existing file is overwritten with just the github block.
    }
  }
  const next: DittoConfig = { ...existing, github };
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(next, null, 2)}\n`);
}
