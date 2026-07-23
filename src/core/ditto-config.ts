import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  type DittoConfigDeepInterview,
  type DittoConfigGithub,
  dittoConfig,
} from '~/schemas/ditto-config';
import { localDir } from './ditto-paths';

/**
 * Handoff write-push consent (`handoff_push_consent` block; wi_2607239vu, ac-3).
 *
 * This records a per-developer, per-project standing grant that lets `ditto
 * handoff write` auto-push a NEW handoff body to a PUBLIC/unknown-visibility
 * remote without repeating the interactive `--push-public` confirmation. It is
 * deliberately WRITE-SCOPED: a consume's pure deletion needs no consent at all
 * (the sync core auto-exempts it, identity-masked), and a purge force-push stays
 * behind the explicit `--push-public` opt-in. The block name is the scope — a
 * broader grant would carry a different key.
 *
 * ORIGIN-BOUND: the consent is pinned to the exact `origin_url` it was granted for.
 * Keying by repo path alone would carry the grant over when origin is re-pointed,
 * transferred, or forked, silently consenting a DIFFERENT remote. The reader only
 * honours it when the current origin URL matches.
 *
 * VISIBILITY STAMP: `visibility_at_grant` records the remote's visibility at grant
 * time so the reader's caller can detect a later private→public flip (compare with
 * the live visibility) and re-confirm.
 *
 * This block is defined HERE (in core) rather than in the shared `dittoConfig`
 * schema on purpose: to `dittoConfig` (a non-strict z.object) the key is UNKNOWN, so
 * a whole-config `safeParse` STRIPS it instead of failing — a malformed consent value
 * therefore never poisons the sibling github/deep_interview blocks (per-key gentle
 * parsing, C5; the whole-config-drop lesson of ditto-config schema:62-72). The reader
 * below validates the block on its own, independently of whole-config validity.
 */
export const dittoConfigHandoffPushConsent = z
  .object({
    origin_url: z.string().min(1),
    visibility_at_grant: z.enum(['public', 'private', 'internal']),
    granted_at: z.string().min(1),
  })
  .describe('Handoff write-push consent — origin-bound + visibility-stamped');

export type DittoConfigHandoffPushConsent = z.infer<typeof dittoConfigHandoffPushConsent>;

/**
 * Read the handoff write-push consent for the CURRENT origin.
 *
 * FAIL-CLOSED: a missing file, invalid JSON, a malformed/mis-typed consent value
 * (a string, number, or partial object — including a truthy-looking `'false'`), or
 * an origin-URL MISMATCH all resolve to `undefined` ("no consent"). Only a fully
 * schema-valid block whose `origin_url` EXACTLY equals `currentOriginUrl` is
 * honoured; the returned object exposes `visibility_at_grant` so the caller can
 * compare it against the live remote visibility and re-confirm on a private→public
 * flip. Parsing is independent of whole-config validity (per-key gentle, C5).
 */
export async function readHandoffPushConsent(
  repoRoot: string,
  currentOriginUrl: string,
): Promise<DittoConfigHandoffPushConsent | undefined> {
  const file = Bun.file(localDir(repoRoot, 'config.json'));
  if (!(await file.exists())) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    return undefined; // fail-closed: malformed file → no consent
  }
  if (raw === null || typeof raw !== 'object') return undefined;
  const block = (raw as Record<string, unknown>).handoff_push_consent;
  const parsed = dittoConfigHandoffPushConsent.safeParse(block);
  if (!parsed.success) return undefined; // fail-closed: absent/malformed/truthy-string
  // Origin binding: honour the grant ONLY for the exact origin it was pinned to.
  if (parsed.data.origin_url !== currentOriginUrl) return undefined;
  return parsed.data;
}

/**
 * Record the handoff write-push consent into `.ditto/local/config.json`.
 *
 * ATOMIC WRITE (C5): the config is written to a temp sibling then `rename`d over the
 * target, so a crash mid-write can never leave a truncated config that would drop
 * every block. Existing sibling blocks (`prism`, `deep_interview`, `github`) are
 * preserved by spreading the RAW object of a schema-VALID existing file (not the
 * schema-stripped `parsed.data`), so a block this schema version no longer declares
 * survives the write (wi_260707oi1 무성삭제 방지; mirrors writeGithubConfig). A
 * malformed/absent existing file is treated as `{}` (fail-open) so a broken sibling
 * does not block recording consent. The caller supplies `granted_at` and
 * `visibility_at_grant` (captured at grant time).
 */
export async function writeHandoffPushConsent(
  repoRoot: string,
  consent: DittoConfigHandoffPushConsent,
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
      // fail-open: a malformed existing file is overwritten with just the consent block.
    }
  }
  const next: Record<string, unknown> = { ...existing, handoff_push_consent: consent };
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`);
  await rename(tmp, path); // atomic replace on same filesystem
}

/**
 * Read the per-user `deep_interview` defaults from `.ditto/local/config.json`
 * (tier ③, gitignored, per-developer; wi_260621p6a).
 *
 * FAIL-OPEN: a missing file, invalid JSON, or schema-invalid config returns `{}`
 * and never throws — a broken config must not block `deep-interview start`. The
 * returned shape is DittoConfigDeepInterview (every field optional); the CLI fills
 * absent flags from
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
