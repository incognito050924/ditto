import { readFile } from 'node:fs/promises';
import { atomicWriteText } from './fs';
import { fileExists } from './hosts/shared';

/**
 * The permission rule that lets Claude Code invoke the `ditto` binary without a
 * prompt. Lives in a project `settings.json` under `permissions.allow`.
 *
 * This is the canonical, importable copy used by `ditto setup`/`teardown`.
 * `scripts/install-plugin.mjs` keeps its own literal copy because it runs as a
 * plain Node `.mjs` script and cannot import this TS module.
 */
export const ALLOW_RULE = 'Bash(ditto:*)';

/**
 * Minimal shape of a Claude Code project `settings.json` that this module
 * touches. Unknown keys are preserved verbatim.
 */
export interface ClaudeSettings {
  permissions?: { allow?: string[]; [key: string]: unknown };
  [key: string]: unknown;
}

/**
 * Idempotently ensure `permissions.allow` contains {@link ALLOW_RULE}. Pure:
 * returns a new object and never mutates the input.
 */
export function addAllowRule(settings: ClaudeSettings): ClaudeSettings {
  const perms = settings.permissions ?? {};
  const allow = Array.isArray(perms.allow) ? perms.allow : [];
  const nextAllow = allow.includes(ALLOW_RULE) ? allow : [...allow, ALLOW_RULE];
  return { ...settings, permissions: { ...perms, allow: nextAllow } };
}

/**
 * Remove {@link ALLOW_RULE} from `permissions.allow`, leaving other rules and
 * settings keys intact. Tolerates an absent rule or absent permissions. Pure.
 */
export function removeAllowRule(settings: ClaudeSettings): ClaudeSettings {
  const perms = settings.permissions;
  if (!perms || !Array.isArray(perms.allow)) return settings;
  return {
    ...settings,
    permissions: { ...perms, allow: perms.allow.filter((r) => r !== ALLOW_RULE) },
  };
}

async function readSettings(settingsPath: string): Promise<ClaudeSettings> {
  if (!(await fileExists(settingsPath))) return {};
  const text = (await readFile(settingsPath, 'utf8')).trim();
  return text ? (JSON.parse(text) as ClaudeSettings) : {};
}

async function writeSettings(settingsPath: string, settings: ClaudeSettings): Promise<void> {
  await atomicWriteText(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * Read the settings file (or `{}` if missing), add {@link ALLOW_RULE}, and write
 * it back. Creates the parent `.claude/` dir as needed and preserves other keys.
 */
export async function allowlistSettingsFile(settingsPath: string): Promise<void> {
  const settings = await readSettings(settingsPath);
  await writeSettings(settingsPath, addAllowRule(settings));
}

/**
 * Read the settings file, remove {@link ALLOW_RULE}, and write it back. No-op
 * when the file is missing.
 */
export async function unallowlistSettingsFile(settingsPath: string): Promise<void> {
  if (!(await fileExists(settingsPath))) return;
  const settings = await readSettings(settingsPath);
  await writeSettings(settingsPath, removeAllowRule(settings));
}
