import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type DittoConfigDeepInterview,
  type DittoConfigGithub,
  type DittoConfigQuestion,
  dittoConfig,
} from '~/schemas/ditto-config';
import { localDir } from './ditto-paths';

/**
 * Read the per-user `prism.question` defaults from `.ditto/local/config.json`
 * (tier ③, gitignored, per-developer; wi_260619jmu).
 *
 * FAIL-OPEN: a missing file, invalid JSON, or schema-invalid config returns `{}`
 * and never throws — a broken config must not block the authoring surface. The
 * returned shape is DittoConfigQuestion (every field optional), fed to the
 * question-config resolver where explicit CLI flags still win.
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
): Promise<DittoConfigQuestion> {
  const file = Bun.file(localDir(repoRoot, 'config.json'));
  if (!(await file.exists())) return {};
  try {
    const parsed = dittoConfig.safeParse(JSON.parse(await file.text()));
    if (!parsed.success) {
      onMalformed?.();
      return {};
    }
    return parsed.data.prism?.question ?? {};
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
 * blocks (`prism`, `deep_interview`) already present (wi_260628d79). The single
 * config store (one file) is reused — no parallel github-specific config file. A
 * malformed/absent existing file is treated as `{}` (fail-open) so a broken sibling
 * block does not block writing the github block.
 * Idempotent: writing the same github value twice yields byte-identical content.
 *
 * Only a schema-VALID existing file is trusted, but its RAW object is spread (not
 * the schema-stripped `parsed.data`), so a sibling block this schema version no
 * longer declares — e.g. a legacy config block left by a retired surface — is
 * preserved rather than silently stripped (wi_260707oi1, DI-2 무성삭제 방지).
 */
export async function writeGithubConfig(
  repoRoot: string,
  github: DittoConfigGithub,
): Promise<void> {
  const path = localDir(repoRoot, 'config.json');
  let existing: Record<string, unknown> = {};
  const file = Bun.file(path);
  if (await file.exists()) {
    try {
      const raw = JSON.parse(await file.text()) as unknown;
      // Trust only a schema-valid file, but keep its RAW keys so unknown sibling
      // blocks survive the write instead of being dropped by the schema strip.
      if (dittoConfig.safeParse(raw).success && raw !== null && typeof raw === 'object') {
        existing = raw as Record<string, unknown>;
      }
    } catch {
      // fail-open: a malformed existing file is overwritten with just the github block.
    }
  }
  const next: Record<string, unknown> = { ...existing, github };
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(next, null, 2)}\n`);
}

/**
 * Bootstrap-once seed of the `github` block into `.ditto/local/config.json` from a
 * TEAM-shared source (recipe.backlog), used by `ditto setup` (wi_260629vnt). 개인 우선:
 * a per-developer github config already present is NEVER overwritten — the seed only
 * fills the block when it is *provably* absent.
 *
 * THREE-STATE predicate (raw file read, NOT `readGithubConfig()===undefined`, which
 * conflates absent and malformed and would let a seed write CLOBBER sibling blocks):
 *   (a) config.json file absent                                  → seed (reason 'absent')
 *   (b) file present + parses + schema-valid + no `github` field → seed (reason 'absent')
 *   (c) file present + `github` field present                    → keep (reason 'existing')
 *   (d) file present + malformed JSON / schema-invalid           → NO seed, fail-closed
 *                                                                  (reason 'malformed', warn)
 * Fail-closed on (d) protects siblings: seeding a malformed file would route through
 * writeGithubConfig's catch (existing→{}) and ERASE prism/deep_interview. Only a
 * provably-valid existing file is ever written through.
 *
 * `onMalformed` fires only in case (d) — so the CLI can warn the user their config was
 * ignored rather than silently skipping the seed.
 */
export async function seedGithubConfigIfAbsent(
  repoRoot: string,
  github: DittoConfigGithub,
  onMalformed?: () => void,
): Promise<{ seeded: boolean; reason: 'absent' | 'existing' | 'malformed' }> {
  const file = Bun.file(localDir(repoRoot, 'config.json'));

  // (a) file absent → seed.
  if (!(await file.exists())) {
    await writeGithubConfig(repoRoot, github);
    return { seeded: true, reason: 'absent' };
  }

  // File present — parse ONCE to distinguish provable-absence (b) from malformed (d).
  let parsed: ReturnType<typeof dittoConfig.safeParse>;
  try {
    parsed = dittoConfig.safeParse(JSON.parse(await file.text()));
  } catch {
    // (d) invalid JSON → fail-closed, never seed (would clobber siblings).
    onMalformed?.();
    return { seeded: false, reason: 'malformed' };
  }
  if (!parsed.success) {
    // (d) schema-invalid → fail-closed.
    onMalformed?.();
    return { seeded: false, reason: 'malformed' };
  }
  if (parsed.data.github !== undefined) {
    // (c) personal github config present → 개인 우선, never overwrite.
    return { seeded: false, reason: 'existing' };
  }
  // (b) parse-valid file, github provably absent → seed (writeGithubConfig preserves siblings).
  await writeGithubConfig(repoRoot, github);
  return { seeded: true, reason: 'absent' };
}
