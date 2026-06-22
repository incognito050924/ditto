// Codex host surface: surface inventory + doctor drift (N7-codex-surface-inventory,
// wi_260613f9d, dual-host plan M3).
//
// Asserts the codex adapter scans its plugin root into host=codex surfaces
// (.codex-plugin/plugin.json -> plugin, skills/<id>/SKILL.md -> skill,
// hooks/hooks.json -> hook) and that the codex catalog (surfaces.codex.json)
// matches the actual scan with no drift. Agent surfaces (.codex/agents/*.toml)
// are produced by agent projection (M4 / N8); this slice wires the scanner
// capability but does not assert any agent surface is discovered.
import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectCapabilityInventory } from '~/core/capability-inventory';
import { codexHostAdapter } from '~/core/hosts';
import { collectSurfaceInventory } from '~/core/surface-inventory';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');

describe('Codex host surface inventory (M3)', () => {
  test('scans plugin / skill / hook surfaces as host=codex', async () => {
    const inv = await codexHostAdapter.loadSurfaceInventory(REPO_ROOT);
    const local = inv.localSurfaces;

    // every surface this scanner emits is host=codex
    expect(local.every((s) => s.host === 'codex')).toBe(true);

    const kinds = new Set(local.map((s) => s.kind));
    expect(kinds.has('plugin')).toBe(true);
    expect(kinds.has('skill')).toBe(true);
    expect(kinds.has('hook')).toBe(true);

    // plugin manifest .codex-plugin/plugin.json -> name "ditto"
    expect(local.some((s) => s.kind === 'plugin' && s.id === 'ditto')).toBe(true);

    // hooks/hooks.json registers exactly the declared lifecycle events
    const hookIds = local
      .filter((s) => s.kind === 'hook')
      .map((s) => s.id)
      .sort();
    expect(hookIds).toEqual(
      [
        'PostToolUse',
        'PreCompact',
        'PreToolUse',
        'SessionStart',
        'Stop',
        'UserPromptSubmit',
      ].sort(),
    );

    // skills shared with the claude build are surfaced under host=codex
    expect(local.some((s) => s.kind === 'skill' && s.id === 'autopilot')).toBe(true);
  });

  test('does NOT inventory the non-official .codex/plugins path (OBJ-5)', async () => {
    // Official Codex discovery is .agents/plugins/marketplace.json (+ legacy
    // .claude-plugin/marketplace.json), NOT a .codex/plugins directory. Scanning
    // .codex/plugins emitted false plugin-surface evidence (dialectic-1 OBJ-5).
    const dir = await mkdtemp(join(tmpdir(), 'ditto-codex-obj5-'));
    try {
      await mkdir(join(dir, '.codex', 'plugins', 'bogus'), { recursive: true });
      const inv = await codexHostAdapter.loadSurfaceInventory(dir);
      const all = [...inv.localSurfaces, ...inv.homeSurfaces];
      expect(all.some((s) => s.id === 'bogus')).toBe(false);
      expect(all.some((s) => s.path.includes(join('.codex', 'plugins')))).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('codex catalog matches the actual codex scan (no drift)', async () => {
    const report = await collectSurfaceInventory([codexHostAdapter], REPO_ROOT);
    expect(report.mismatch_count).toBe(0);
    expect(report.findings).toEqual([]);
  });

  test('codex declared hooks == registered hooks (capability drift = 0)', async () => {
    const report = await collectCapabilityInventory([codexHostAdapter], REPO_ROOT);
    const codex = report.hosts.find((h) => h.host === 'codex');
    const declared = [...(codex?.capabilities.hooks ?? [])].map(String).sort();
    const registered = [...(codex?.hook_events ?? [])].sort();
    expect(declared).toEqual(registered);
    expect(report.findings.filter((f) => f.kind.includes('hook'))).toEqual([]);
  });
});
