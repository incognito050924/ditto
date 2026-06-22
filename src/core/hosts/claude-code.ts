import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  asRecord,
  asStringArray,
  envKeys,
  fileExists,
  listDirectories,
  listFiles,
  readJsonIfExists,
  readTextIfExists,
  samePath,
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

/**
 * Scan a Claude Code *plugin* root (skills/, agents/, commands/, hooks/hooks.json,
 * .claude-plugin/plugin.json) into surface entries. This is the actual side of the
 * surface-inventory drift check (M1.6); the declared side is the checked-in
 * `.ditto/local/surfaces.json` catalog.
 */
async function scanPluginRoot(repoRoot: string): Promise<SurfaceEntry[]> {
  const out: SurfaceEntry[] = [];

  for (const dir of await listDirectories(join(repoRoot, 'skills'))) {
    const skillPath = join(dir.path, 'SKILL.md');
    if (await fileExists(skillPath)) {
      out.push({ host: 'claude-code', kind: 'skill', id: dir.id, path: skillPath });
    }
  }

  for (const file of await listFiles(join(repoRoot, 'agents'))) {
    if (!file.id.endsWith('.md')) continue;
    out.push({
      host: 'claude-code',
      kind: 'agent',
      id: file.id.replace(/\.md$/, ''),
      path: file.path,
    });
  }

  for (const file of await listFiles(join(repoRoot, 'commands'))) {
    if (!file.id.endsWith('.md')) continue;
    out.push({
      host: 'claude-code',
      kind: 'command',
      id: file.id.replace(/\.md$/, ''),
      path: file.path,
    });
  }

  const hooksPath = join(repoRoot, 'hooks', 'hooks.json');
  const hooksRaw = asRecord(await readJsonIfExists(hooksPath).catch(() => null));
  const hookEvents = asRecord(hooksRaw?.hooks);
  if (hookEvents) {
    for (const event of Object.keys(hookEvents)) {
      out.push({ host: 'claude-code', kind: 'hook', id: event, path: hooksPath });
    }
  }

  const pluginPath = join(repoRoot, '.claude-plugin', 'plugin.json');
  const pluginRaw = asRecord(await readJsonIfExists(pluginPath).catch(() => null));
  if (pluginRaw && typeof pluginRaw.name === 'string') {
    out.push({ host: 'claude-code', kind: 'plugin', id: pluginRaw.name, path: pluginPath });
  }

  return out;
}

export const claudeCodeHostAdapter: HostAdapter = {
  id: 'claude-code',

  capabilities: {
    hooks: ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreCompact', 'PostToolUse', 'PreToolUse'],
    instructions: true,
    permissions: true,
    mcp: true,
    surface: true,
  },

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

  async loadPermissions(repoRoot): Promise<PermissionInventory[]> {
    const path = join(repoRoot, '.claude', 'settings.json');
    try {
      const raw = await readJsonIfExists(path);
      if (raw === null) {
        return [
          {
            host: 'claude-code',
            source_file: path,
            status: 'missing',
            raw: {},
            unavailable_reason: 'claude-code settings not found',
          },
        ];
      }
      return [
        {
          host: 'claude-code',
          source_file: path,
          status: 'ok',
          raw: asRecord(raw) ?? {},
        },
      ];
    } catch (err) {
      return [
        {
          host: 'claude-code',
          source_file: path,
          status: 'unverified',
          raw: {},
          unavailable_reason: err instanceof Error ? err.message : String(err),
        },
      ];
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
      ...(await scanPluginRoot(repoRoot)),
    ];
    return { host: 'claude-code', localSurfaces, homeSurfaces, unavailable: [] };
  },

  async spawnRun(input) {
    const { args, unverified } = buildClaudeCodeSpawnArgs(input.profile, input.args);
    return spawnProviderProcess({
      binary: 'claude',
      args,
      repoRoot: input.repoRoot,
      cwd: input.cwd,
      env: input.env,
      unverified,
    });
  },
};

const CLAUDE_CODE_PROFILE_PERMISSION: Record<HostRunInput['profile'], string> = {
  'read-only': 'plan',
  'workspace-write': 'default',
  reviewer: 'plan',
  networked: 'default',
  isolated: 'default',
};

const CLAUDE_CODE_NETWORK_NOTICE = 'claude-code network is not forced open by v0.3';

export function buildClaudeCodeSpawnArgs(
  profile: HostRunInput['profile'],
  userArgs: string[],
): { args: string[]; unverified: string[] } {
  const mode = CLAUDE_CODE_PROFILE_PERMISSION[profile];
  const unverified = [`claude-code --permission-mode ${mode} mapping is best-effort in v0.3`];
  if (profile === 'networked') {
    unverified.push(CLAUDE_CODE_NETWORK_NOTICE);
  }
  return {
    args: ['--permission-mode', mode, ...userArgs],
    unverified,
  };
}
