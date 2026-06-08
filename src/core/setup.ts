import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type InitScaffoldResult, initScaffold } from './init-scaffold';
import { applyManagedFile } from './managed-resource';
import { type RoutingScope, discoverResources, routeResource } from './resource-routing';
import { allowlistSettingsFile } from './settings-allowlist';

/**
 * Pure `ditto setup` core: composes the already-built routing, managed-merge,
 * scaffold, and allowlist pieces. Performs fs writes but takes every install
 * path via `opts` so the CLI (not this module) owns environment resolution.
 *
 * Idempotent: `applyManagedFile` keeps the first `.ditto_bak`, `initScaffold`
 * never clobbers, and `allowlistSettingsFile` de-dups the allow rule.
 */
export interface SetupOptions {
  resourcesDir: string;
  projectRoot: string;
  homeDir: string;
  now: Date;
}

/** Outcome of installing one bundled resource. */
export interface ResourceOutcome {
  filename: string;
  scope: RoutingScope;
  destPath: string;
  status: 'written' | 'corrupted';
  backupPath: string | null;
}

export interface SetupResult {
  resources: ResourceOutcome[];
  scaffold: InitScaffoldResult;
  allowlistPath: string;
}

/**
 * Discover bundled resources, route + merge each into its destination as a
 * managed block, scaffold `.ditto/` under the project, and allowlist the
 * project settings file.
 */
export async function setup(opts: SetupOptions): Promise<SetupResult> {
  const { resourcesDir, projectRoot, homeDir, now } = opts;

  const resources: ResourceOutcome[] = [];
  for (const filename of discoverResources(resourcesDir)) {
    const decision = routeResource(filename, { projectRoot, homeDir });
    const body = await readFile(join(resourcesDir, filename), 'utf8');
    const applied = await applyManagedFile(decision.destPath, body, filename);
    resources.push({
      filename,
      scope: decision.scope,
      destPath: decision.destPath,
      status: applied.kind === 'ok' ? 'written' : 'corrupted',
      backupPath: applied.kind === 'ok' ? applied.backupPath : null,
    });
  }

  const scaffold = await initScaffold(projectRoot, now);

  const allowlistPath = join(projectRoot, '.claude', 'settings.json');
  await allowlistSettingsFile(allowlistPath);

  return { resources, scaffold, allowlistPath };
}
