import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  asRecord,
  asStringArray,
  envKeys,
  fileExists,
  listDirectories,
  listFiles,
  parseToml,
  readJsonIfExists,
  readTextIfExists,
} from './shared';
import { spawnProviderProcess } from './spawn';
import type {
  HostAdapter,
  HostRunInput,
  McpInventory,
  McpServerEntry,
  PermissionInventory,
  SurfaceEntry,
  SurfaceInventory,
} from './types';

function mcpServersFromToml(text: string, sourceFile: string): McpServerEntry[] {
  const parsed = parseToml(text);
  const mcpServers = asRecord(parsed.mcp_servers);
  if (!mcpServers) return [];
  const servers: McpServerEntry[] = [];
  for (const [name, raw] of Object.entries(mcpServers)) {
    const values = asRecord(raw) ?? {};
    const server: McpServerEntry = {
      host: 'codex',
      scope: 'user',
      name,
      source_file: sourceFile,
      side_effect_label: values.command === 'stdio' ? 'stdio' : 'external_process',
    };
    if (typeof values.command === 'string') server.command = values.command;
    const args = asStringArray(values.args);
    if (args) server.args = args;
    const keys = envKeys(values.env);
    if (keys) server.env_keys = keys;
    servers.push(server);
  }
  return servers;
}

/**
 * Scan one Codex plugin root into surface entries: ".codex-plugin/plugin.json"
 * -> plugin, "skills/<id>/SKILL.md" -> skill, "hooks/hooks.json" event keys ->
 * hook. Project custom agents are scanned separately from "$REPO/.codex/agents";
 * plugin-bundled ".codex/agents" is only a setup source artifact. This is the
 * actual side of the codex surface drift check; the declared side is
 * ".ditto/local/surfaces.codex.json".
 * The skills/ and hooks/ roots are shared with the claude build (same source).
 */
async function scanCodexPluginRoot(pluginRoot: string): Promise<SurfaceEntry[]> {
  const out: SurfaceEntry[] = [];

  const pluginPath = join(pluginRoot, '.codex-plugin', 'plugin.json');
  const pluginRaw = asRecord(await readJsonIfExists(pluginPath).catch(() => null));
  if (pluginRaw && typeof pluginRaw.name === 'string') {
    out.push({ host: 'codex', kind: 'plugin', id: pluginRaw.name, path: pluginPath });
  }

  for (const dir of await listDirectories(join(pluginRoot, 'skills'))) {
    const skillPath = join(dir.path, 'SKILL.md');
    if (await fileExists(skillPath)) {
      out.push({ host: 'codex', kind: 'skill', id: dir.id, path: skillPath });
    }
  }

  const hooksPath = join(pluginRoot, 'hooks', 'hooks.json');
  const hookEvents = asRecord(asRecord(await readJsonIfExists(hooksPath).catch(() => null))?.hooks);
  if (hookEvents) {
    for (const event of Object.keys(hookEvents)) {
      out.push({ host: 'codex', kind: 'hook', id: event, path: hooksPath });
    }
  }

  return out;
}

async function codexPluginRoots(repoRoot: string): Promise<string[]> {
  const roots: string[] = [];
  const installed = join(repoRoot, '.agents', 'plugins', 'ditto');
  if (await fileExists(join(installed, '.codex-plugin', 'plugin.json'))) roots.push(installed);
  if (await fileExists(join(repoRoot, '.codex-plugin', 'plugin.json'))) roots.push(repoRoot);
  return [...new Set(roots)];
}

async function scanProjectCodexAgents(repoRoot: string): Promise<SurfaceEntry[]> {
  const out: SurfaceEntry[] = [];
  for (const file of await listFiles(join(repoRoot, '.codex', 'agents'))) {
    if (!file.id.endsWith('.toml')) continue;
    out.push({ host: 'codex', kind: 'agent', id: file.id.replace(/\.toml$/, ''), path: file.path });
  }
  return out;
}

export const codexHostAdapter: HostAdapter = {
  id: 'codex',

  capabilities: {
    // The lifecycle events mirror Claude's names because Codex adopted the same
    // hook protocol (reports/design/dual-host-codex-fact-verification.md F2/F3);
    // the codex scanner registers exactly these from the shared hooks/hooks.json,
    // so declared == registered (capability-inventory hook drift = 0). The first 5
    // were smoke-verified at M2. [VERIFY] SessionStart inherits the adopted protocol
    // but its codex firing is not yet smoke-verified — declared here for dual-host
    // parity (the banner it backs is claude-centric and degrades to silent on codex).
    hooks: ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreCompact', 'PostToolUse', 'PreToolUse'],
    instructions: true,
    permissions: true,
    mcp: true,
    surface: true,
  },

  async loadInstructions(repoRoot) {
    const path = join(repoRoot, 'AGENTS.md');
    const content = await readTextIfExists(path);
    return {
      role: 'source',
      host: 'codex',
      path,
      exists: content !== null,
      ...(content !== null ? { content } : {}),
    };
  },

  async loadPermissions(repoRoot): Promise<PermissionInventory[]> {
    const repoPath = join(repoRoot, '.codex', 'config.toml');
    const repoText = await readTextIfExists(repoPath);
    const inventories: PermissionInventory[] = [
      repoText === null
        ? {
            host: 'codex',
            source_file: repoPath,
            status: 'missing',
            raw: {},
            unavailable_reason: 'codex repo config not found',
          }
        : { host: 'codex', source_file: repoPath, status: 'ok', raw: parseToml(repoText) },
    ];
    const userPath = join(homedir(), '.codex', 'config.toml');
    const userText = await readTextIfExists(userPath);
    inventories.push(
      userText === null
        ? {
            host: 'codex',
            source_file: userPath,
            status: 'missing',
            raw: {},
            unavailable_reason: 'codex user config not found',
          }
        : { host: 'codex', source_file: userPath, status: 'ok', raw: parseToml(userText) },
    );
    return inventories;
  },

  async loadMcpServers(repoRoot): Promise<McpInventory> {
    const userPath = join(homedir(), '.codex', 'config.toml');
    const text = await readTextIfExists(userPath);
    const unavailable: McpInventory['unavailable'] = [];
    const servers = text === null ? [] : mcpServersFromToml(text, userPath);
    if (text === null) {
      unavailable.push({
        scope: 'user',
        source_file: userPath,
        reason: 'codex user config not found',
      });
    }
    const projectPath = join(repoRoot, '.codex', 'config.toml');
    if (await Bun.file(projectPath).exists()) {
      unavailable.push({
        scope: 'unverified',
        source_file: projectPath,
        reason: 'repo-local codex MCP config is outside v0.2 verified scope',
      });
    }
    return { host: 'codex', servers, unavailable };
  },

  async loadSurfaceInventory(repoRoot): Promise<SurfaceInventory> {
    // Official Codex plugin discovery is `$REPO/.agents/plugins/marketplace.json`
    // (+ personal `~/.agents/plugins/marketplace.json` + legacy
    // `$REPO/.claude-plugin/marketplace.json`), NOT a `.codex/plugins` directory.
    // Scanning `.codex/plugins`/`~/.codex/plugins` fabricated plugin-surface
    // evidence from a path Codex never loads (dialectic-1 OBJ-5). We inventory the
    // real plugin-root surfaces (manifest/skill/hook) plus project custom agents.
    const localSurfaces: SurfaceEntry[] = [];
    for (const root of await codexPluginRoots(repoRoot)) {
      localSurfaces.push(...(await scanCodexPluginRoot(root)));
    }
    localSurfaces.push(...(await scanProjectCodexAgents(repoRoot)));
    return { host: 'codex', localSurfaces, homeSurfaces: [], unavailable: [] };
  },

  async spawnRun(input) {
    const { args, unverified } = buildCodexSpawnArgs(input.profile, input.args);
    return spawnProviderProcess({
      binary: 'codex',
      args,
      repoRoot: input.repoRoot,
      cwd: input.cwd,
      env: input.env,
      unverified,
    });
  },
};

const CODEX_PROFILE_SANDBOX_FLAGS: Record<HostRunInput['profile'], string[]> = {
  'read-only': ['--sandbox', 'read-only'],
  'workspace-write': ['--sandbox', 'workspace-write'],
  reviewer: ['--sandbox', 'read-only'],
  networked: ['--sandbox', 'workspace-write'],
  isolated: ['--sandbox', 'workspace-write'],
};

const CODEX_PROFILE_UNVERIFIED: Record<HostRunInput['profile'], string[]> = {
  'read-only': [],
  'workspace-write': [],
  reviewer: [],
  networked: ['codex network is not forced open by v0.3; sandbox restricts outbound'],
  isolated: [],
};

export function buildCodexSpawnArgs(
  profile: HostRunInput['profile'],
  userArgs: string[],
): { args: string[]; unverified: string[] } {
  return {
    args: [...CODEX_PROFILE_SANDBOX_FLAGS[profile], ...userArgs],
    unverified: [...CODEX_PROFILE_UNVERIFIED[profile]],
  };
}
