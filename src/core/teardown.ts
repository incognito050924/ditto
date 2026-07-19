import { copyFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { refreshCharterRegion } from './charter-region';
import { atomicWriteText } from './fs';
import { fileExists } from './hosts/shared';
import { normalizedSha256 } from './instruction-bridge';
import { stripManagedBlock } from './managed-resource';
import { type RoutingScope, discoverResources, routeResource } from './resource-routing';
import { unallowlistSettingsFile } from './settings-allowlist';
import {
  CHARTER_MANIFEST_FILENAME,
  PUSH_GATE_HOOK_BACKUP_SUFFIX,
  PUSH_GATE_HOOK_MARKER,
  gitHooksDir,
  loadCharterShas,
} from './setup';

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

/** The canonical, host-agnostic RAW charter source (no persistent ditto marker). */
const CANONICAL_CHARTER_FILENAME = 'AGENTS.md';

export interface FileTeardownOutcome {
  filename: string;
  scope: RoutingScope;
  destPath: string;
  action: TeardownAction;
}

export interface TeardownResult {
  files: FileTeardownOutcome[];
  allowlistPath: string;
  /** Push-gate hook removal outcome (mirrors setup's install seam). */
  pushGateHook: UninstallPushGateHookResult;
}

/**
 * Strip the managed block from each destination setup wrote (falling back to
 * the `.ditto_bak` snapshot on corruption), then remove the `Bash(ditto:*)`
 * allow rule from the project settings. Never deletes `.ditto/`.
 */
export async function teardown(opts: TeardownOptions): Promise<TeardownResult> {
  const { resourcesDir, projectRoot, homeDir } = opts;

  const files: FileTeardownOutcome[] = [];
  // The charter manifest is recognition data, never installed into the project (setup
  // filters it from routing), so teardown must not treat it as a project file to undo.
  const resources = discoverResources(resourcesDir).filter((f) => f !== CHARTER_MANIFEST_FILENAME);
  for (const filename of resources) {
    const decision = routeResource(filename, { projectRoot, homeDir });
    // AGENTS.md is the canonical RAW charter source (no managed marker), so the generic
    // marker-strip is a no-op on it. Undo it via marker-less charter-region recognition.
    const action =
      filename === CANONICAL_CHARTER_FILENAME
        ? await teardownCharterSource(decision.destPath, resourcesDir)
        : await teardownFile(decision.destPath);
    files.push({ filename, scope: decision.scope, destPath: decision.destPath, action });
  }

  const allowlistPath = join(projectRoot, '.claude', 'settings.json');
  await unallowlistSettingsFile(allowlistPath);

  // Remove the push-gate pre-push hook (restoring any prior hook). Idempotent and
  // safe: a repo where the gate was never installed reports `left-untouched`.
  const pushGateHook = await uninstallPushGateHook({ projectRoot });

  return { files, allowlistPath, pushGateHook };
}

// ---------------------------------------------------------------- push-gate hook
// Inverse of installPushGateHook (wi_260629i9c): remove ONLY the ditto-managed
// pre-push hook (identified by its marker) and restore any prior hook we backed
// up. A non-ditto pre-push hook we never installed is left untouched.

export type PushGateHookTeardownStatus =
  | 'removed' // our hook removed; no prior backup to restore
  | 'restored-prior' // our hook removed; the backed-up prior hook restored
  | 'left-untouched'; // no hook, a non-ditto hook, or not a git repo → nothing of ours

export interface UninstallPushGateHookResult {
  status: PushGateHookTeardownStatus;
  hookPath: string;
  backupPath: string | null;
}

/**
 * Remove the ditto-managed pre-push hook from `projectRoot` (identified by its
 * marker), restoring any prior hook snapshot we backed up. A hook that isn't ours
 * — or a non-git dir — is left untouched.
 */
export async function uninstallPushGateHook(opts: {
  projectRoot: string;
}): Promise<UninstallPushGateHookResult> {
  let hooksDir: string;
  try {
    hooksDir = gitHooksDir(opts.projectRoot);
  } catch {
    return { status: 'left-untouched', hookPath: '', backupPath: null };
  }
  const hookPath = join(hooksDir, 'pre-push');
  const backupPath = `${hookPath}${PUSH_GATE_HOOK_BACKUP_SUFFIX}`;

  // Nothing to undo unless OUR hook (marker present) is the active pre-push — a
  // user's own hook (no marker) is never removed.
  if (!(await fileExists(hookPath))) {
    return { status: 'left-untouched', hookPath, backupPath: null };
  }
  const current = await readFile(hookPath, 'utf8');
  if (!current.includes(PUSH_GATE_HOOK_MARKER)) {
    return { status: 'left-untouched', hookPath, backupPath: null };
  }

  // Restore the prior hook we backed up, else just remove ours.
  if (await fileExists(backupPath)) {
    await copyFile(backupPath, hookPath);
    await rm(backupPath, { force: true });
    return { status: 'restored-prior', hookPath, backupPath };
  }
  await rm(hookPath, { force: true });
  return { status: 'removed', hookPath, backupPath: null };
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

/**
 * Undo the marker-less ditto-charter region of the canonical raw AGENTS.md. Teardown is
 * refresh-to-EMPTY: recognize the LEADING region whose normalized sha matches a known
 * charter version (current bundle OR a manifest-listed prior), then replace it with an
 * empty body so the recognized region is removed and any trailing user rules are kept
 * byte-identical. Symmetric to refresh's skip-on-doubt: an unrecognized (user-edited)
 * region — or no recognized region — is left exactly as-is (never destroyed).
 */
async function teardownCharterSource(
  destPath: string,
  resourcesDir: string,
): Promise<TeardownAction> {
  if (!(await Bun.file(destPath).exists())) return 'left-untouched';

  const current = await readFile(destPath, 'utf8');
  const bundlePath = join(resourcesDir, CANONICAL_CHARTER_FILENAME);
  const bundledCharter = (await fileExists(bundlePath)) ? await readFile(bundlePath, 'utf8') : '';
  // Recognize against every known charter version: the manifest priors plus the current
  // bundle's own sha (unioned in, mirroring setup's recognition set).
  const knownShas = [...(await loadCharterShas(resourcesDir)), normalizedSha256(bundledCharter)];

  // An empty replacement turns refresh's region-replace into a region-REMOVE: `replaced`
  // returns `'' + trailingUserRules`. `unrecognized`/`up-to-date` (nothing removable) →
  // leave the file untouched.
  const outcome = refreshCharterRegion({ current, bundledCharter: '', knownShas });
  if (outcome.kind === 'replaced') {
    await atomicWriteText(destPath, outcome.content);
    return 'stripped';
  }
  return 'left-untouched';
}
