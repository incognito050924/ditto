import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
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
}

export type SetupHost = 'claude-code' | 'codex' | 'both';

/** Outcome of installing one bundled resource. */
export interface ResourceOutcome {
  host: 'claude-code' | 'codex';
  filename: string;
  scope: RoutingScope;
  destPath: string;
  status: 'written' | 'kept' | 'corrupted';
  backupPath: string | null;
}

export interface SetupResult {
  resources: ResourceOutcome[];
  scaffold: InitScaffoldResult;
  allowlistPath: string;
  allowlistApplied: boolean;
  codex: CodexSetupResult | null;
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
  const files = discoverResources(resourcesDir);

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
): Promise<ResourceOutcome> {
  const common = {
    host: decision.host,
    filename: decision.filename,
    scope: decision.scope,
    destPath: decision.destPath,
  };
  const name = basename(decision.destPath);

  if (name === 'AGENTS.md') {
    const existed = await fileExists(decision.destPath);
    if (!existed) {
      const body = await readFile(join(resourcesDir, decision.filename), 'utf8');
      await atomicWriteText(decision.destPath, body);
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

  const resources: ResourceOutcome[] = [];
  for (const decision of ordered) {
    resources.push(await installResource(decision, resourcesDir));
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

  return { resources, scaffold, allowlistPath, allowlistApplied, codex };
}
