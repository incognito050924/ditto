import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { collectCapabilityInventory } from '~/core/capability-inventory';
import { claudeCodeHostAdapter, codexHostAdapter } from '~/core/hosts';
import type { HostAdapter, HostCapabilities, SurfaceEntry } from '~/core/hosts';

const repoRoot = join(import.meta.dir, '..', '..');

function stubAdapter(capabilities: HostCapabilities, hookSurfaces: string[] = []): HostAdapter {
  return {
    id: 'stub',
    capabilities,
    async loadInstructions() {
      return { role: 'source', host: 'stub', path: 'AGENTS.md', exists: false };
    },
    async loadPermissions() {
      return [{ host: 'stub', source_file: 'stub', status: 'missing', raw: {} }];
    },
    async loadMcpServers() {
      return { host: 'stub', servers: [], unavailable: [] };
    },
    async loadSurfaceInventory() {
      const localSurfaces: SurfaceEntry[] = hookSurfaces.map((id) => ({
        host: 'stub',
        kind: 'hook',
        id,
        path: 'hooks/hooks.json',
      }));
      return { host: 'stub', localSurfaces, homeSurfaces: [], unavailable: [] };
    },
  };
}

describe('collectCapabilityInventory', () => {
  test('ac-3 fail-closed: a false required capability produces a finding', async () => {
    const adapter = stubAdapter({
      hooks: [],
      instructions: true,
      permissions: false,
      mcp: true,
      surface: true,
    });
    const report = await collectCapabilityInventory([adapter], repoRoot);
    expect(report.finding_count).toBeGreaterThan(0);
    const finding = report.findings.find((f) => f.kind === 'missing_required');
    expect(finding?.capability).toBe('permissions');
  });

  test('ac-3 pass-side: real adapters satisfy required capabilities', async () => {
    const report = await collectCapabilityInventory(
      [claudeCodeHostAdapter, codexHostAdapter],
      repoRoot,
    );
    expect(report.findings.filter((f) => f.kind === 'missing_required')).toEqual([]);
  });

  test('ac-4 drift: declared hook not registered is a finding', async () => {
    const adapter = stubAdapter(
      {
        hooks: ['Stop'],
        instructions: true,
        permissions: true,
        mcp: true,
        surface: true,
      },
      [], // registers nothing
    );
    const report = await collectCapabilityInventory([adapter], repoRoot);
    expect(report.findings.some((f) => f.kind === 'declared_hook_not_registered')).toBe(true);
  });

  test('ac-4 drift: registered hook not declared is a finding', async () => {
    const adapter = stubAdapter(
      {
        hooks: [],
        instructions: true,
        permissions: true,
        mcp: true,
        surface: true,
      },
      ['Stop'], // registers Stop but declares none
    );
    const report = await collectCapabilityInventory([adapter], repoRoot);
    expect(report.findings.some((f) => f.kind === 'registered_hook_not_declared')).toBe(true);
  });

  test('ac-4 honest pass: real claude-code declared hooks == registered (0 drift)', async () => {
    const report = await collectCapabilityInventory([claudeCodeHostAdapter], repoRoot);
    expect(report.findings.filter((f) => f.kind.includes('hook'))).toEqual([]);
    const cc = report.hosts.find((h) => h.host === 'claude-code');
    expect(cc).toBeDefined();
    expect([...(cc?.hook_events ?? [])].sort()).toEqual([...(cc?.capabilities.hooks ?? [])].sort());
    expect(cc?.hook_events.length).toBe(5);
  });

  test('codex honestly declares no hooks and registers none (0 drift)', async () => {
    const report = await collectCapabilityInventory([codexHostAdapter], repoRoot);
    const codex = report.hosts.find((h) => h.host === 'codex');
    expect(codex?.capabilities.hooks).toEqual([]);
    expect(codex?.hook_events).toEqual([]);
    expect(report.finding_count).toBe(0);
  });
});
