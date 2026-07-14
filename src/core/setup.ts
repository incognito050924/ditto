import { execFileSync } from 'node:child_process';
import { chmod, cp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { RecipePushGate } from '~/schemas/recipe';
import { refreshCharterRegion } from './charter-region';
import { atomicWriteText, ensureDir } from './fs';
import { codexHostAdapter } from './hosts/codex';
import { fileExists, listDirectories, listFiles, readJsonIfExists } from './hosts/shared';
import { type InitScaffoldResult, initScaffold } from './init-scaffold';
import { applyManagedFile, unwrapManagedBlock, writeBackupOnce } from './managed-resource';
import { type RoutingScope, discoverResources, routeResource } from './resource-routing';
import { allowlistSettingsFile } from './settings-allowlist';
import { generateSurfaceCatalog } from './surface-inventory';

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
  /**
   * Codex config root for global resource install (the codex global AGENTS.md).
   * Defaults to `<homeDir>/.codex`; the CLI passes `$CODEX_HOME` here so a dogfood
   * codex session (isolated CODEX_HOME) never writes the user's real ~/.codex.
   */
  codexHome?: string;
  now: Date;
  host?: SetupHost;
  pluginRoot?: string;
  /**
   * When the resolved recipe declares a `push_gate` (ac-5), install the portable
   * pre-push gate hook into `projectRoot`. Absent → the hook stage is skipped, so
   * a recipe without a push_gate (or the interactive wizard, which only runs when
   * no recipe is present) leaves git hooks untouched.
   */
  pushGate?: RecipePushGate;
  /** Override the bundled hook template; defaults to `<resourcesDir>/../hooks/pre-push`. */
  hookTemplatePath?: string;
}

export type SetupHost = 'claude-code' | 'codex' | 'both';

/**
 * Bundled recognition data for the marker-less AGENTS.md charter refresh: the set
 * of normalized shas of every shipped charter version. Lives inside
 * `resources/managed/` as a committed asset but is EXCLUDED from install routing
 * (it is recognition data, not an instruction resource).
 */
export const CHARTER_MANIFEST_FILENAME = 'charter-manifest.json';

/** Outcome of installing one bundled resource. */
export interface ResourceOutcome {
  host: 'claude-code' | 'codex';
  filename: string;
  scope: RoutingScope;
  destPath: string;
  /**
   * `refreshed`/`up-to-date`/`unrecognized` are the AGENTS.md charter-refresh
   * outcomes: an existing charter region was replaced with the newer bundle,
   * already matched the current bundle (silent no-op), or was user-edited and left
   * untouched (surfaces a "couldn't refresh" notice).
   */
  status: 'written' | 'kept' | 'corrupted' | 'refreshed' | 'up-to-date' | 'unrecognized';
  backupPath: string | null;
}

export interface SetupResult {
  resources: ResourceOutcome[];
  scaffold: InitScaffoldResult;
  allowlistPath: string;
  allowlistApplied: boolean;
  codex: CodexSetupResult | null;
  /**
   * Push-gate hook stage outcome; null when the recipe declared no push_gate.
   * Optional (additive field) so pre-existing `SetupResult` literals stay valid.
   */
  pushGateHook?: PushGateHookResult | null;
}

export interface CodexSetupResult {
  pluginRoot: string;
  installedPluginDir: string;
  marketplacePath: string;
  surfaceCatalogPath: string;
  statusPath: string;
  pluginLoadStatus: 'needs_user_action';
  enableCommands: string[];
  agentsDir: string;
  agentsInstalled: number;
}

interface ResourceInstallDecision {
  host: 'claude-code' | 'codex';
  filename: string;
  scope: RoutingScope;
  destPath: string;
}

interface Marketplace {
  name?: string;
  plugins?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

const CODEX_MARKETPLACE_NAME = 'ditto-local';
const CODEX_PLUGIN_NAME = 'ditto';
const CODEX_PLUGIN_DEST_REL = join('.agents', 'plugins', CODEX_PLUGIN_NAME);
// Cross-platform bundle name: `bin/ditto` is portable JS run by `bun` (Windows
// uses the sibling `ditto.cmd` launcher) — there is no per-OS `ditto.exe`.
const CODEX_BIN_NAME = 'ditto';

/**
 * Load the normalized charter shas from the bundled `charter-manifest.json`. Missing
 * or malformed manifest → `[]` (no recognized priors), so a fresh install and any
 * target lacking the manifest degrade gracefully to create-if-missing behavior.
 */
async function loadCharterShas(resourcesDir: string): Promise<string[]> {
  const raw = await readJsonIfExists(join(resourcesDir, CHARTER_MANIFEST_FILENAME));
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const shas = (raw as { shas?: unknown }).shas;
  if (!Array.isArray(shas)) return [];
  return shas.filter((s): s is string => typeof s === 'string');
}

function setupHosts(host: SetupHost | undefined): Set<'claude-code' | 'codex'> {
  if (host === 'codex') return new Set(['codex']);
  if (host === 'both') return new Set(['claude-code', 'codex']);
  return new Set(['claude-code']);
}

function resourceDecisions(
  resourcesDir: string,
  projectRoot: string,
  homeDir: string,
  codexHome: string,
  hosts: Set<'claude-code' | 'codex'>,
): ResourceInstallDecision[] {
  const out: ResourceInstallDecision[] = [];
  // The charter manifest is recognition data, not an installable resource — keep it
  // out of routing so it is never written into the target project.
  const files = discoverResources(resourcesDir).filter((f) => f !== CHARTER_MANIFEST_FILENAME);

  if (hosts.has('claude-code')) {
    for (const filename of files) {
      const decision = routeResource(filename, { projectRoot, homeDir });
      out.push({ host: 'claude-code', filename, ...decision });
    }
  }

  if (hosts.has('codex')) {
    for (const filename of files) {
      if (filename === 'AGENTS.md') {
        out.push({
          host: 'codex',
          filename,
          scope: 'project',
          destPath: join(projectRoot, 'AGENTS.md'),
        });
      } else if (filename === 'GLOBAL_AGENTS.md') {
        out.push({
          host: 'codex',
          filename,
          scope: 'global',
          destPath: join(codexHome, 'AGENTS.md'),
        });
      }
    }
  }

  const seen = new Set<string>();
  return out.filter((d) => {
    const key = d.destPath;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function codexMarketplaceEntry(): Record<string, unknown> {
  return {
    name: CODEX_PLUGIN_NAME,
    source: {
      source: 'local',
      path: `./${CODEX_PLUGIN_DEST_REL.replaceAll('\\', '/')}`,
    },
    policy: {
      installation: 'AVAILABLE',
      authentication: 'ON_INSTALL',
    },
    category: 'Productivity',
    interface: {
      displayName: 'DITTO',
    },
  };
}

async function readMarketplace(path: string): Promise<Marketplace> {
  const raw = await readJsonIfExists(path);
  if (raw === null) return { name: CODEX_MARKETPLACE_NAME, plugins: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${path} is not a JSON object`);
  }
  return raw as Marketplace;
}

async function writeCodexMarketplace(path: string): Promise<void> {
  const marketplace = await readMarketplace(path);
  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const nextEntry = codexMarketplaceEntry();
  const nextPlugins = plugins.filter((p) => p?.name !== CODEX_PLUGIN_NAME);
  nextPlugins.push(nextEntry);
  nextPlugins.sort((a, b) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
  await atomicWriteText(
    path,
    `${JSON.stringify(
      {
        name: typeof marketplace.name === 'string' ? marketplace.name : CODEX_MARKETPLACE_NAME,
        ...marketplace,
        plugins: nextPlugins,
      },
      null,
      2,
    )}\n`,
  );
}

async function installCodexAgents(pluginRoot: string, projectRoot: string): Promise<number> {
  const srcDir = join(pluginRoot, '.codex', 'agents');
  if (!(await fileExists(srcDir))) {
    throw new Error(`codex custom agents not found at ${srcDir}; run build:codex-plugin first`);
  }
  const destDir = join(projectRoot, '.codex', 'agents');
  await ensureDir(destDir);
  let count = 0;
  for (const file of await listFiles(srcDir)) {
    if (!file.id.endsWith('.toml')) continue;
    await cp(file.path, join(destDir, file.id));
    count += 1;
  }
  return count;
}

function codexDittoCommand(installedPluginDir: string): string {
  return `"${join(installedPluginDir, 'bin', CODEX_BIN_NAME).replaceAll('\\', '/')}"`;
}

function rewriteCodexDittoReferences(text: string, dittoCommand: string): string {
  return text
    .replace(/"\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/ditto(?:\.exe)?"/g, dittoCommand)
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/ditto(?:\.exe)?/g, dittoCommand)
    .replace(/`ditto(?=\s)/g, `\`${dittoCommand}`);
}

async function rewriteCodexTextFile(path: string, dittoCommand: string): Promise<void> {
  const before = await readFile(path, 'utf8');
  const after = rewriteCodexDittoReferences(before, dittoCommand);
  if (after !== before) await writeFile(path, after);
}

function rewriteCodexAgentTomlReferences(text: string, dittoCommand: string): string {
  return text.replace(
    /(\bdeveloper_instructions\s*=\s*""")([\s\S]*?)("""\s*)/,
    (_match, open: string, body: string, close: string) =>
      `${open}${rewriteCodexDittoReferences(body, dittoCommand)}${close}`,
  );
}

async function rewriteCodexAgentTomlFile(path: string, dittoCommand: string): Promise<void> {
  const before = await readFile(path, 'utf8');
  const after = rewriteCodexAgentTomlReferences(before, dittoCommand);
  if (after !== before) await writeFile(path, after);
}

async function rewriteCodexInstalledReferences(installedPluginDir: string): Promise<void> {
  const dittoCommand = codexDittoCommand(installedPluginDir);
  for (const dir of await listDirectories(join(installedPluginDir, 'skills'))) {
    const skillPath = join(dir.path, 'SKILL.md');
    if (await fileExists(skillPath)) await rewriteCodexTextFile(skillPath, dittoCommand);
  }
  for (const file of await listFiles(join(installedPluginDir, '.codex', 'agents'))) {
    if (file.id.endsWith('.toml')) await rewriteCodexAgentTomlFile(file.path, dittoCommand);
  }
}

async function writeCodexSurfaceCatalog(projectRoot: string): Promise<string> {
  const surfaceCatalogPath = join(projectRoot, '.ditto', 'local', 'surfaces.codex.json');
  await ensureDir(join(projectRoot, '.ditto', 'local'));
  const catalog = await generateSurfaceCatalog(
    [codexHostAdapter],
    projectRoot,
    'surfaces.codex.json',
  );
  await atomicWriteText(surfaceCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  return surfaceCatalogPath;
}

async function writeCodexPluginStatus(projectRoot: string): Promise<{
  statusPath: string;
  enableCommands: string[];
}> {
  const statusPath = join(projectRoot, '.ditto', 'local', 'codex-plugin-status.json');
  const enableCommands = [
    `codex plugin marketplace add ${JSON.stringify(projectRoot)}`,
    `codex plugin add ${CODEX_PLUGIN_NAME}@${CODEX_MARKETPLACE_NAME}`,
  ];
  await atomicWriteText(
    statusPath,
    `${JSON.stringify(
      {
        schema_version: '0.1.0',
        plugin: CODEX_PLUGIN_NAME,
        marketplace: CODEX_MARKETPLACE_NAME,
        status: 'needs_user_action',
        reason:
          'setup prepared the target-local Codex marketplace, but Codex has not been asked to install this plugin in CODEX_HOME',
        commands: enableCommands,
      },
      null,
      2,
    )}\n`,
  );
  return { statusPath, enableCommands };
}

async function installCodexSurface(opts: {
  pluginRoot: string;
  projectRoot: string;
}): Promise<CodexSetupResult> {
  const { pluginRoot, projectRoot } = opts;
  const manifestPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
  if (!(await fileExists(manifestPath))) {
    throw new Error(
      `codex plugin manifest not found at ${manifestPath}; run build:codex-plugin first`,
    );
  }

  const installedPluginDir = join(projectRoot, CODEX_PLUGIN_DEST_REL);
  if (resolve(pluginRoot) === resolve(installedPluginDir)) {
    throw new Error(
      `codex plugin source is already the installed plugin directory: ${installedPluginDir}`,
    );
  }
  await rm(installedPluginDir, { recursive: true, force: true });
  await ensureDir(join(projectRoot, '.agents', 'plugins'));
  await cp(pluginRoot, installedPluginDir, { recursive: true });
  await rewriteCodexInstalledReferences(installedPluginDir);

  const marketplacePath = join(projectRoot, '.agents', 'plugins', 'marketplace.json');
  await writeCodexMarketplace(marketplacePath);

  const agentsInstalled = await installCodexAgents(installedPluginDir, projectRoot);
  const surfaceCatalogPath = await writeCodexSurfaceCatalog(projectRoot);
  const { statusPath, enableCommands } = await writeCodexPluginStatus(projectRoot);
  return {
    pluginRoot,
    installedPluginDir,
    marketplacePath,
    surfaceCatalogPath,
    statusPath,
    pluginLoadStatus: 'needs_user_action',
    enableCommands,
    agentsDir: join(projectRoot, '.codex', 'agents'),
    agentsInstalled,
  };
}

/**
 * Install one bundled instruction resource by the role of its destination:
 *
 *  - `AGENTS.md` is the canonical, host-agnostic SOURCE. It is written raw (no
 *    managed block) and create-if-missing, so an authored charter is never
 *    clobbered by the bundled snapshot nor duplicated by appending a block after
 *    pre-existing raw content.
 *  - `CLAUDE.md` is a PROJECTION of the sibling AGENTS.md: a single managed block
 *    `source=AGENTS.md` whose body mirrors the on-disk AGENTS.md verbatim. This is
 *    exactly what `ditto doctor instructions` requires (markerSource=AGENTS.md and
 *    body sha == AGENTS.md sha), so it must read the installed source, not the
 *    bundled CLAUDE.md copy.
 *  - anything else keeps the generic managed-block install.
 */
async function installResource(
  decision: ResourceInstallDecision,
  resourcesDir: string,
  charterShas: string[],
): Promise<ResourceOutcome> {
  const common = {
    host: decision.host,
    filename: decision.filename,
    scope: decision.scope,
    destPath: decision.destPath,
  };
  const name = basename(decision.destPath);

  if (name === 'AGENTS.md') {
    const bundledCharter = await readFile(join(resourcesDir, decision.filename), 'utf8');
    const existed = await fileExists(decision.destPath);
    if (!existed) {
      await atomicWriteText(decision.destPath, bundledCharter);
      return { ...common, status: 'written', backupPath: null };
    }
    // AGENTS.md is the canonical RAW source. An older version wrapped it in a
    // ditto-managed block, which then made the sibling CLAUDE.md projection
    // double-wrap (nested markers). Heal by stripping ditto markers back to raw,
    // preserving any other content; a file without markers is left untouched.
    const current = await readFile(decision.destPath, 'utf8');
    const unwrapped = unwrapManagedBlock(current);
    if (unwrapped !== current) {
      const backupPath = await writeBackupOnce(decision.destPath);
      await atomicWriteText(decision.destPath, unwrapped);
      return { ...common, status: 'written', backupPath };
    }
    // Marker-less charter refresh — canonical project source only. GLOBAL_AGENTS.md
    // is a separate charter the manifest does not track, so it keeps create-if-
    // missing / kept semantics (never a false "couldn't refresh" notice).
    if (decision.filename === 'AGENTS.md') {
      const refresh = refreshCharterRegion({ current, bundledCharter, knownShas: charterShas });
      if (refresh.kind === 'replaced') {
        const backupPath = await writeBackupOnce(decision.destPath);
        await atomicWriteText(decision.destPath, refresh.content);
        return { ...common, status: 'refreshed', backupPath };
      }
      // up-to-date → silent no-op; unrecognized → skip (a user-edited region), the
      // CLI surfaces the "couldn't refresh" notice from this status.
      return { ...common, status: refresh.kind, backupPath: null };
    }
    return { ...common, status: 'kept', backupPath: null };
  }

  if (name === 'CLAUDE.md') {
    const sourcePath = join(dirname(decision.destPath), 'AGENTS.md');
    const projectionBody = (await fileExists(sourcePath))
      ? await readFile(sourcePath, 'utf8')
      : await readFile(join(resourcesDir, decision.filename), 'utf8');
    const applied = await applyManagedFile(decision.destPath, projectionBody, 'AGENTS.md');
    return {
      ...common,
      status: applied.kind === 'ok' ? 'written' : 'corrupted',
      backupPath: applied.kind === 'ok' ? applied.backupPath : null,
    };
  }

  const body = await readFile(join(resourcesDir, decision.filename), 'utf8');
  const applied = await applyManagedFile(decision.destPath, body, decision.filename);
  return {
    ...common,
    status: applied.kind === 'ok' ? 'written' : 'corrupted',
    backupPath: applied.kind === 'ok' ? applied.backupPath : null,
  };
}

// ---------------------------------------------------------------- push-gate hook
// Install seam for the recipe-driven git pre-push gate (wi_260629i9c, ac-5). When
// the resolved recipe declares a `push_gate`, setup drops a portable pre-push hook
// into the target repo that invokes `ditto push-gate`. The seam is NON-DESTRUCTIVE
// (an existing non-ditto hook is backed up, never clobbered), IDEMPOTENT (our own
// hook is recognised by its marker and refreshed, not re-backed-up), and FAILS
// SAFE on the `core.hooksPath` indirection (a husky/lefthook repo is refused with
// guidance rather than installing an inert `.git/hooks` hook or silently disabling
// the user's hooks).

/** Marker line in the installed hook that proves the hook is ditto-managed. */
export const PUSH_GATE_HOOK_MARKER = 'ditto:managed:pre-push';

/** Suffix for the snapshot of a prior, non-ditto pre-push hook. */
export const PUSH_GATE_HOOK_BACKUP_SUFFIX = '.ditto-backup';

export type PushGateHookStatus =
  | 'installed' // no prior hook → wrote ours
  | 'refreshed' // our hook already there → rewrote in place (idempotent re-run)
  | 'backed-up' // a non-ditto hook existed → moved to `.ditto-backup`, wrote ours
  | 'refused-existing' // non-ditto hook AND a backup already present → refused (no clobber)
  | 'refused-hookspath' // custom non-ditto core.hooksPath → refused with guidance
  | 'no-git-repo'; // target is not a git repo → cannot install a git hook

export interface PushGateHookResult {
  status: PushGateHookStatus;
  /** The `.git/hooks/pre-push` path we targeted (best-effort; empty when no git repo). */
  hookPath: string;
  /** The `.ditto-backup` snapshot path when we backed one up, else null. */
  backupPath: string | null;
  /** Actionable guidance, set on the refuse / no-git outcomes. */
  message: string | null;
}

export interface InstallPushGateHookOptions {
  /** Target git repo root. */
  projectRoot: string;
  /** Path to the bundled `resources/hooks/pre-push` template. */
  hookTemplatePath: string;
  /**
   * Absolute path of the TRUSTED workspace root, for a CLONED SUB-REPO install
   * (wi_2606299kn ac-4). When set, the substitutable `WS_ROOT=""` line in the hook
   * template is rewritten to `WS_ROOT="<workspaceRoot>"` so the installed hook
   * resolves the ROOT recipe (ROOT-ONLY trust), not the cloned sub-repo's own.
   * Omit for a normal/root install (the template's empty WS_ROOT is left as-is).
   */
  workspaceRoot?: string;
}

/** Derive the bundled hook template path from the `resources/managed` dir. */
export function defaultHookTemplatePath(resourcesDir: string): string {
  return join(dirname(resourcesDir), 'hooks', 'pre-push');
}

/** `git config --get core.hooksPath` for `cwd`, or null when unset/not-a-repo. */
function customHooksPath(cwd: string): string | null {
  try {
    const v = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return v.length > 0 ? v : null;
  } catch {
    return null; // unset → git exits non-zero
  }
}

/**
 * Resolve the repo's hooks directory via `git rev-parse --git-path hooks` (correct
 * for linked worktrees/submodules, where `.git` is a file). Throws when `cwd` is
 * not a git repo. NOTE: this honours `core.hooksPath`, so callers MUST screen out a
 * custom hooksPath first (we install only into the real `.git/hooks`).
 */
export function gitHooksDir(cwd: string): string {
  const p = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  return isAbsolute(p) ? p : join(cwd, p);
}

/**
 * Install the pre-push gate hook into `projectRoot`. See the section comment for
 * the non-destructive / idempotent / fail-safe contract.
 */
export async function installPushGateHook(
  opts: InstallPushGateHookOptions,
): Promise<PushGateHookResult> {
  const { projectRoot, hookTemplatePath } = opts;

  // core.hooksPath indirection (COVERAGE-CRITICAL): a custom hooksPath means git
  // honours that dir over `.git/hooks`. Writing `.git/hooks/pre-push` would be
  // silently ignored, and repointing hooksPath would silently disable the user's
  // husky/lefthook hooks — either is a silent failure on a SAFETY gate. Refuse.
  const hooksPath = customHooksPath(projectRoot);
  if (hooksPath !== null) {
    return {
      status: 'refused-hookspath',
      hookPath: '',
      backupPath: null,
      message: `core.hooksPath is set to "${hooksPath}" (custom hooks dir, e.g. husky/lefthook). ditto will not write .git/hooks/pre-push (git would ignore it) nor repoint core.hooksPath (that would disable your hooks). Add the ditto pre-push call to "${hooksPath}/pre-push" manually: it should pipe stdin into \`ditto push-gate\`.`,
    };
  }

  let hooksDir: string;
  try {
    hooksDir = gitHooksDir(projectRoot);
  } catch {
    return {
      status: 'no-git-repo',
      hookPath: '',
      backupPath: null,
      message: `${projectRoot} is not a git repository — a pre-push hook cannot be installed. Run \`git init\` (or \`ditto setup\` from inside the repo), then re-run setup.`,
    };
  }

  const hookPath = join(hooksDir, 'pre-push');
  const backupPath = `${hookPath}${PUSH_GATE_HOOK_BACKUP_SUFFIX}`;
  // For a CLONED SUB-REPO install (workspaceRoot set), bake the trusted workspace
  // root into the template's substitutable WS_ROOT line BEFORE writing. The bake
  // runs against the on-disk template every time, so both the install and refresh
  // write paths stay idempotent (a re-run re-derives WS_ROOT from the clean template).
  const template = bakeWorkspaceRoot(await readFile(hookTemplatePath, 'utf8'), opts.workspaceRoot);

  await ensureDir(hooksDir);

  if (!(await fileExists(hookPath))) {
    await writeHookFile(hookPath, template);
    return { status: 'installed', hookPath, backupPath: null, message: null };
  }

  // A hook already exists. If it is OURS (marker present), refresh in place — a
  // re-run must not double-install nor back up our own hook.
  const existing = await readFile(hookPath, 'utf8');
  if (existing.includes(PUSH_GATE_HOOK_MARKER)) {
    await writeHookFile(hookPath, template);
    return { status: 'refreshed', hookPath, backupPath: null, message: null };
  }

  // A non-ditto hook. NEVER clobber it. Back it up ONCE; if a backup already
  // exists we refuse rather than overwrite either the user's hook or its backup.
  if (await fileExists(backupPath)) {
    return {
      status: 'refused-existing',
      hookPath,
      backupPath,
      message: `${hookPath} is a non-ditto pre-push hook and ${backupPath} already exists — refusing to overwrite either. Remove/merge them manually, or pipe stdin into \`ditto push-gate\` from your existing hook.`,
    };
  }
  await rename(hookPath, backupPath);
  await writeHookFile(hookPath, template);
  return { status: 'backed-up', hookPath, backupPath, message: null };
}

/**
 * Rewrite the template's substitutable `WS_ROOT=""` line to `WS_ROOT="<workspaceRoot>"`
 * for a cloned sub-repo install (wi_2606299kn ac-4), so the installed hook resolves the
 * ROOT recipe (ROOT-ONLY trust). A normal/root install (`workspaceRoot` absent) leaves
 * the template untouched. Throws if the template lost the substitutable line — a baked
 * sub-repo hook with an empty WS_ROOT would silently resolve the CLONE's own recipe.
 */
function bakeWorkspaceRoot(template: string, workspaceRoot?: string): string {
  if (workspaceRoot === undefined || workspaceRoot === '') return template;
  const baked = template.replace(
    /^WS_ROOT=""$/m,
    `WS_ROOT=${JSON.stringify(resolve(workspaceRoot))}`,
  );
  if (baked === template) {
    throw new Error(
      'pre-push template is missing the substitutable `WS_ROOT=""` line — cannot pin the workspace root for a sub-repo install',
    );
  }
  return baked;
}

/** Write the hook body and set the POSIX exec bit (no-op effect on Windows). */
async function writeHookFile(hookPath: string, body: string): Promise<void> {
  await writeFile(hookPath, body);
  await chmod(hookPath, 0o755);
}

/**
 * Discover bundled resources, route + merge each into its destination as a
 * managed block, scaffold `.ditto/` under the project, and allowlist the
 * project settings file.
 */
export async function setup(opts: SetupOptions): Promise<SetupResult> {
  const { resourcesDir, projectRoot, homeDir, now } = opts;
  const codexHome = opts.codexHome ?? join(homeDir, '.codex');
  const hosts = setupHosts(opts.host);

  const decisions = resourceDecisions(resourcesDir, projectRoot, homeDir, codexHome, hosts);
  // Install canonical sources (AGENTS.md) and generic resources first so each
  // CLAUDE.md projection can mirror its sibling on-disk AGENTS.md.
  const ordered = [
    ...decisions.filter((d) => basename(d.destPath) !== 'CLAUDE.md'),
    ...decisions.filter((d) => basename(d.destPath) === 'CLAUDE.md'),
  ];

  const charterShas = await loadCharterShas(resourcesDir);
  const resources: ResourceOutcome[] = [];
  for (const decision of ordered) {
    resources.push(await installResource(decision, resourcesDir, charterShas));
  }

  const scaffold = await initScaffold(projectRoot, now);

  const allowlistPath = join(projectRoot, '.claude', 'settings.json');
  const allowlistApplied = hosts.has('claude-code');
  if (allowlistApplied) await allowlistSettingsFile(allowlistPath);

  const codex = hosts.has('codex')
    ? await installCodexSurface({
        pluginRoot: opts.pluginRoot ?? resolve(resourcesDir, '..', '..'),
        projectRoot,
      })
    : null;

  // Push-gate hook stage (ac-5): install only when the recipe declared a push_gate.
  const pushGateHook = opts.pushGate
    ? await installPushGateHook({
        projectRoot,
        hookTemplatePath: opts.hookTemplatePath ?? defaultHookTemplatePath(resourcesDir),
      })
    : null;

  return { resources, scaffold, allowlistPath, allowlistApplied, codex, pushGateHook };
}
