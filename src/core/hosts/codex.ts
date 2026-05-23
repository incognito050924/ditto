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
import type {
  HostAdapter,
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
    const path = join(repoRoot, '.codex', 'config.toml');
    const text = await readTextIfExists(path);
    if (text === null) {
      return [
        {
          host: 'codex',
          source_file: path,
          status: 'missing',
          raw: {},
          unavailable_reason: 'codex repo config not found',
        },
      ];
    }
    return [{ host: 'codex', source_file: path, status: 'ok', raw: parseToml(text) }];
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
};
