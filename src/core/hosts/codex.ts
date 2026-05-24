import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  asRecord,
  asStringArray,
  envKeys,
  listDirectories,
  parseToml,
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

export const codexHostAdapter: HostAdapter = {
  id: 'codex',

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
    const projectPlugins = join(repoRoot, '.codex', 'plugins');
    const userPlugins = join(homedir(), '.codex', 'plugins');
    const localSurfaces: SurfaceEntry[] = (await listDirectories(projectPlugins)).map((entry) => ({
      host: 'codex' as const,
      kind: 'plugin' as const,
      id: entry.id,
      path: entry.path,
    }));
    const homeSurfaces: SurfaceEntry[] = (await listDirectories(userPlugins)).map((entry) => ({
      host: 'codex' as const,
      kind: 'plugin' as const,
      id: entry.id,
      path: entry.path,
    }));
    return { host: 'codex', localSurfaces, homeSurfaces, unavailable: [] };
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
