import type { RunManifest } from '~/schemas/run-manifest';

export type BuiltinHostId = 'codex' | 'claude-code';
export type HostId = BuiltinHostId | (string & {});

export type InstructionSurface =
  | {
      role: 'source';
      host: HostId;
      path: string;
      exists: boolean;
      content?: string;
    }
  | {
      role: 'projection';
      host: HostId;
      source: 'AGENTS.md';
      path: string;
      exists: boolean;
      content?: string;
    };

export type PermissionRiskLabel =
  | 'dangerous_mode'
  | 'network_on'
  | 'secrets_read'
  | 'write_outside_workspace'
  | 'approval_bypass';

export interface PermissionInventory {
  host: HostId;
  source_file: string;
  status: 'ok' | 'missing' | 'unverified';
  raw: Record<string, unknown>;
  unavailable_reason?: string;
}

export type McpScope = 'project' | 'local' | 'user' | 'unverified';

export interface McpServerEntry {
  host: HostId;
  scope: McpScope;
  name: string;
  source_file: string;
  command?: string;
  args?: string[];
  env_keys?: string[];
  side_effect_label: string;
}

export interface McpInventory {
  host: HostId;
  servers: McpServerEntry[];
  unavailable: Array<{ scope: McpScope; source_file: string; reason: string }>;
}

export type SurfaceKind = 'skill' | 'agent' | 'command' | 'plugin' | 'hook';
export type SurfaceMismatch = 'missing_file' | 'extra_file' | 'renamed';

export interface SurfaceEntry {
  host: HostId;
  kind: SurfaceKind;
  id: string;
  path: string;
  mismatch?: SurfaceMismatch;
}

export interface SurfaceInventory {
  host: HostId;
  localSurfaces: SurfaceEntry[];
  homeSurfaces: SurfaceEntry[];
  unavailable: Array<{ path: string; reason: string }>;
}

export interface HostRunEnv {
  set: Record<string, string>;
  unset: string[];
}

export interface HostRunInput {
  repoRoot: string;
  cwd: string;
  profile: RunManifest['profile'];
  args: string[];
  env: HostRunEnv;
}

export interface HostRunCompletion {
  exit_code: number | null;
  model_reported: string | null;
  signal?: string;
  error?: string;
  unverified?: string[];
}

export interface HostRunProcess {
  entrypoint: string;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  completion: Promise<HostRunCompletion>;
}

export type HookEventId = 'UserPromptSubmit' | 'Stop' | 'PreCompact' | 'PostToolUse' | 'PreToolUse';

export const HOOK_EVENT_IDS: readonly HookEventId[] = [
  'UserPromptSubmit',
  'Stop',
  'PreCompact',
  'PostToolUse',
  'PreToolUse',
];

export interface HostCapabilities {
  /** Hook events this host can actually run; [] = hooks unsupported. */
  hooks: HookEventId[];
  /** loadInstructions is a real loader. */
  instructions: boolean;
  /** loadPermissions is a real loader. */
  permissions: boolean;
  /** loadMcpServers is a real loader. */
  mcp: boolean;
  /** loadSurfaceInventory is a real loader. */
  surface: boolean;
}

export interface HostAdapter {
  id: HostId;
  capabilities: HostCapabilities;
  loadInstructions(repoRoot: string): Promise<InstructionSurface>;
  loadPermissions(repoRoot: string): Promise<PermissionInventory[]>;
  loadMcpServers(repoRoot: string): Promise<McpInventory>;
  loadSurfaceInventory(repoRoot: string): Promise<SurfaceInventory>;
  spawnRun?(input: HostRunInput): Promise<HostRunProcess>;
}

const registry = new Map<HostId, HostAdapter>();

export function registerHostAdapter(adapter: HostAdapter): void {
  registry.set(adapter.id, adapter);
}

export function getHostAdapter(id: HostId): HostAdapter {
  const adapter = registry.get(id);
  if (!adapter) throw new Error(`unknown host adapter: ${id}`);
  return adapter;
}

export function listHostAdapters(): HostAdapter[] {
  return [...registry.values()];
}

export function unregisterHostAdapter(id: HostId): void {
  registry.delete(id);
}

export class InvalidHostError extends Error {
  constructor(public readonly value: string) {
    super(`invalid --host value "${value}"; expected one of: codex, claude-code`);
    this.name = 'InvalidHostError';
  }
}

export function parseHostId(value: string | undefined): BuiltinHostId | undefined {
  if (value === undefined) return undefined;
  if (value === 'codex' || value === 'claude-code') return value;
  throw new InvalidHostError(value);
}
