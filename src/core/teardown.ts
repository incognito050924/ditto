import { copyFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWriteText } from './fs';
import { stripManagedBlock } from './managed-resource';
import { type RoutingScope, discoverResources, routeResource } from './resource-routing';
import { unallowlistSettingsFile } from './settings-allowlist';

/**
 * Pure `ditto teardown` core: the inverse of `ditto setup`. Targets the SAME
 * destinations setup computed (via discover + route) and undoes each install
 * using teardown semantics A — strip ONLY the ditto:managed block, preserving
 * all user content (original plus increments added after setup).
 *
 * Corruption fallback: if a file's markers are unbalanced/unsafe to strip,
 * never destroy content — restore from `<dest>.ditto_bak` if present, otherwise
 * leave the file untouched and report it.
 *
 * `.ditto/` is intentionally NOT removed (it is the user's work-item history,
 * mirroring install-plugin.mjs preserving `.ditto/` on uninstall). The
 * `.ditto_bak` snapshots are also left in place after a normal strip (cheap
 * safety; the user can remove them).
 */
export interface TeardownOptions {
  resourcesDir: string;
  projectRoot: string;
  homeDir: string;
}

/** What teardown did to one managed destination. */
export type TeardownAction = 'stripped' | 'restored-from-backup' | 'left-untouched';

const BACKUP_SUFFIX = '.ditto_bak';

export interface FileTeardownOutcome {
  filename: string;
  scope: RoutingScope;
  destPath: string;
  action: TeardownAction;
}

export interface TeardownResult {
  files: FileTeardownOutcome[];
  allowlistPath: string;
}

/**
 * Strip the managed block from each destination setup wrote (falling back to
 * the `.ditto_bak` snapshot on corruption), then remove the `Bash(ditto:*)`
 * allow rule from the project settings. Never deletes `.ditto/`.
 */
export async function teardown(opts: TeardownOptions): Promise<TeardownResult> {
  const { resourcesDir, projectRoot, homeDir } = opts;

  const files: FileTeardownOutcome[] = [];
  for (const filename of discoverResources(resourcesDir)) {
    const decision = routeResource(filename, { projectRoot, homeDir });
    const action = await teardownFile(decision.destPath);
    files.push({ filename, scope: decision.scope, destPath: decision.destPath, action });
  }

  const allowlistPath = join(projectRoot, '.claude', 'settings.json');
  await unallowlistSettingsFile(allowlistPath);

  return { files, allowlistPath };
}

/**
 * Undo one managed file. Missing destination → `left-untouched`. Normal markers
 * → strip and write back. Corrupted markers → restore from `.ditto_bak` if it
 * exists, else leave untouched.
 */
async function teardownFile(destPath: string): Promise<TeardownAction> {
  if (!(await Bun.file(destPath).exists())) return 'left-untouched';

  const current = await readFile(destPath, 'utf8');
  const stripped = stripManagedBlock(current);
  if (stripped.kind === 'ok') {
    await atomicWriteText(destPath, stripped.content);
    return 'stripped';
  }

  // Corrupted markers: never strip-destroy. Restore the original snapshot if we
  // have one; otherwise leave the file exactly as-is.
  const bakPath = `${destPath}${BACKUP_SUFFIX}`;
  if (await Bun.file(bakPath).exists()) {
    await copyFile(bakPath, destPath);
    return 'restored-from-backup';
  }
  return 'left-untouched';
}
