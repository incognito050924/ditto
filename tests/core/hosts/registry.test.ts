import { describe, expect, test } from 'bun:test';
import {
  type HostAdapter,
  listHostAdapters,
  registerHostAdapter,
  unregisterHostAdapter,
} from '~/core/hosts';
import { collectPermissionFindings } from '~/core/permission-inventory';

describe('host adapter registry', () => {
  test('registers codex and claude-code by default', () => {
    const ids = listHostAdapters().map((adapter) => adapter.id);
    expect(ids).toContain('codex');
    expect(ids).toContain('claude-code');
  });

  test('can register another adapter through the shared interface shape', async () => {
    let permissionCalled = false;
    const mock: HostAdapter = {
      id: 'mock',
      capabilities: { hooks: [], instructions: true, permissions: true, mcp: true, surface: true },
      async loadInstructions() {
        return { role: 'source', host: 'codex', path: 'AGENTS.md', exists: false };
      },
      async loadPermissions() {
        permissionCalled = true;
        return [{ host: 'codex', source_file: '.codex/config.toml', status: 'missing', raw: {} }];
      },
      async loadMcpServers() {
        return { host: 'codex', servers: [], unavailable: [] };
      },
      async loadSurfaceInventory() {
        return { host: 'codex', localSurfaces: [], homeSurfaces: [], unavailable: [] };
      },
    };
    registerHostAdapter(mock);
    expect(listHostAdapters().find((adapter) => adapter.id === 'mock')).toBe(mock);
    const findings = await collectPermissionFindings([mock], '/tmp/ditto-mock');
    expect(permissionCalled).toBe(true);
    expect(findings[0]?.label).toBe('missing');
    unregisterHostAdapter('mock');
  });
});
