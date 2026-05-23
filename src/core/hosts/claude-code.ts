import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  asRecord,
  asStringArray,
  envKeys,
  listDirectories,
  listFiles,
  readJsonIfExists,
  readTextIfExists,
  samePath,
} from './shared';
import type {
  HostAdapter,
  McpInventory,
  McpServerEntry,
  PermissionInventory,
  SurfaceEntry,
  SurfaceInventory,
} from './types';

function serversFromObject(
  host: 'claude-code',
  scope: McpServerEntry['scope'],
  sourceFile: string,
  value: unknown,
): McpServerEntry[] {
  const record = asRecord(value);
  if (!record) return [];
  return Object.entries(record).map((entry) => {
    const [name, raw] = entry;
    const server = asRecord(raw) ?? {};
    const result: McpServerEntry = {
      host,
      scope,
      name,
      source_file: sourceFile,
      side_effect_label: typeof server.command === 'string' ? 'external_process' : 'unknown',
    };
    if (typeof server.command === 'string') result.command = server.command;
    const args = asStringArray(server.args);
    if (args) result.args = args;
    const keys = envKeys(server.env);
    if (keys) result.env_keys = keys;
    return result;
  });
}

function projectMcpFromClaudeJson(
  repoRoot: string,
  raw: unknown,
  sourceFile: string,
): McpServerEntry[] {
  const root = asRecord(raw);
  if (!root) return [];
  const servers: McpServerEntry[] = [];
  const projects = asRecord(root.projects);
  if (projects) {
    for (const [projectPath, projectRaw] of Object.entries(projects)) {
      if (!samePath(projectPath, repoRoot)) continue;
      const project = asRecord(projectRaw);
      servers.push(...serversFromObject('claude-code', 'local', sourceFile, project?.mcpServers));
    }
  }
  servers.push(...serversFromObject('claude-code', 'user', sourceFile, root.mcpServers));
  return servers;
}

export const claudeCodeHostAdapter: HostAdapter = {
  id: 'claude-code',

  async loadInstructions(repoRoot) {
    const path = join(repoRoot, 'CLAUDE.md');
    const content = await readTextIfExists(path);
    return {
      role: 'projection',
      host: 'claude-code',
      source: 'AGENTS.md',
      path,
      exists: content !== null,
      ...(content !== null ? { content } : {}),
    };
  },

  async loadPermissions(repoRoot): Promise<PermissionInventory> {
    const path = join(repoRoot, '.claude', 'settings.json');
    try {
      const raw = await readJsonIfExists(path);
      if (raw === null) {
        return {
          host: 'claude-code',
          source_file: path,
          status: 'missing',
          raw: {},
          unavailable_reason: 'claude-code settings not found',
        };
      }
      return {
        host: 'claude-code',
        source_file: path,
        status: 'ok',
        raw: asRecord(raw) ?? {},
      };
    } catch (err) {
      return {
        host: 'claude-code',
        source_file: path,
        status: 'unverified',
        raw: {},
        unavailable_reason: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async loadMcpServers(repoRoot): Promise<McpInventory> {
    const unavailable: McpInventory['unavailable'] = [];
    const servers: McpServerEntry[] = [];
    const projectPath = join(repoRoot, '.mcp.json');
    try {
      const raw = await readJsonIfExists(projectPath);
      if (raw === null) {
        unavailable.push({
          scope: 'project',
          source_file: projectPath,
          reason: 'project .mcp.json not found',
        });
      } else {
        const root = asRecord(raw);
        servers.push(...serversFromObject('claude-code', 'project', projectPath, root?.mcpServers));
      }
    } catch (err) {
      unavailable.push({
        scope: 'project',
        source_file: projectPath,
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    const userPath = join(homedir(), '.claude.json');
    try {
      const raw = await readJsonIfExists(userPath);
      if (raw === null) {
        unavailable.push({
          scope: 'user',
          source_file: userPath,
          reason: 'claude-code user config not found',
        });
      } else {
        servers.push(...projectMcpFromClaudeJson(repoRoot, raw, userPath));
      }
    } catch (err) {
      unavailable.push({
        scope: 'user',
        source_file: userPath,
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    const settingsPath = join(repoRoot, '.claude', 'settings.json');
    try {
      const settings = asRecord(await readJsonIfExists(settingsPath));
      const settingsServers = asRecord(settings?.mcpServers);
      if (settingsServers) {
        const names = Object.keys(settingsServers).sort();
        unavailable.push({
          scope: 'unverified',
          source_file: settingsPath,
          reason: `.claude/settings.json mcpServers is not a v0.2 verified MCP source: ${names.join(', ')}`,
        });
      }
    } catch {
      // permissions inventory reports settings parse failures; keep MCP output focused.
    }
    return { host: 'claude-code', servers, unavailable };
  },

  async loadSurfaceInventory(repoRoot): Promise<SurfaceInventory> {
    const homeSurfaces: SurfaceEntry[] = (
      await listDirectories(join(homedir(), '.claude', 'skills'))
    ).map((entry) => ({
      host: 'claude-code' as const,
      kind: 'skill' as const,
      id: entry.id,
      path: entry.path,
    }));
    const localSurfaces: SurfaceEntry[] = [
      ...(await listDirectories(join(repoRoot, '.claude', 'agents'))).map((entry) => ({
        host: 'claude-code' as const,
        kind: 'agent' as const,
        id: entry.id,
        path: entry.path,
      })),
      ...(await listFiles(join(repoRoot, '.claude', 'agents')))
        .filter((entry) => entry.id.endsWith('.md'))
        .map((entry) => ({
          host: 'claude-code' as const,
          kind: 'agent' as const,
          id: entry.id.replace(/\.md$/, ''),
          path: entry.path,
        })),
      ...(await listFiles(join(repoRoot, '.claude', 'commands')))
        .filter((entry) => entry.id.endsWith('.md'))
        .map((entry) => ({
          host: 'claude-code' as const,
          kind: 'command' as const,
          id: entry.id.replace(/\.md$/, ''),
          path: entry.path,
        })),
    ];
    return { host: 'claude-code', localSurfaces, homeSurfaces, unavailable: [] };
  },
};
