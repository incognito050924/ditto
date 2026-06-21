import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCodeHostAdapter } from '~/core/hosts';
import { collectSurfaceInventory } from '~/core/surface-inventory';
import { surfaceCatalog } from '~/schemas/surface-catalog';

const REPO_ROOT = join(import.meta.dir, '..', '..');

describe('DITTO plugin surface inventory (M1.6)', () => {
  test('checked-in .ditto/local/surfaces.json exists and is non-empty (no false-green)', () => {
    const raw = JSON.parse(
      readFileSync(join(REPO_ROOT, '.ditto', 'local', 'surfaces.json'), 'utf8'),
    );
    const parsed = surfaceCatalog.parse(raw);
    expect(parsed.surfaces.length).toBe(39); // 13 skills + 20 agents (17 plugin + 3 .claude/agents variants, f95ebec) + 5 hooks + 1 plugin
  });

  test('declared catalog matches the actual plugin-root scan (no drift)', async () => {
    const report = await collectSurfaceInventory([claudeCodeHostAdapter], REPO_ROOT);
    expect(report.mismatch_count).toBe(0);
    expect(report.findings).toEqual([]);
    // hook + plugin surfaces are inventoried, not just skills/agents/commands
    const kinds = new Set(report.surfaces.map((s) => s.kind));
    expect(kinds.has('hook')).toBe(true);
    expect(kinds.has('plugin')).toBe(true);
  });
});

describe('catalog false-green guards', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-surf-'));
    await mkdir(join(repo, '.ditto', 'local'), { recursive: true });
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const writeCatalog = (text: string) =>
    writeFile(join(repo, '.ditto', 'local', 'surfaces.json'), text);

  async function caught(): Promise<Error | undefined> {
    try {
      await collectSurfaceInventory([claudeCodeHostAdapter], repo);
      return undefined;
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e));
    }
  }

  test('malformed catalog (bad JSON) throws instead of silently passing', async () => {
    await writeCatalog('{ not valid json');
    expect((await caught())?.message).toMatch(/malformed JSON/);
  });

  test('present-but-empty catalog throws', async () => {
    await writeCatalog(JSON.stringify({ schema_version: '0.1.0', surfaces: [] }));
    expect((await caught())?.message).toMatch(/declares no surfaces/);
  });

  test('schema-invalid catalog throws', async () => {
    await writeCatalog(
      JSON.stringify({
        schema_version: '0.1.0',
        surfaces: [{ host: 'claude-code', kind: 'bogus', id: 'x', path: 'y' }],
      }),
    );
    expect((await caught())?.message).toMatch(/schema validation/);
  });

  test('a declared surface absent on disk is reported as missing (drift)', async () => {
    await writeCatalog(
      JSON.stringify({
        schema_version: '0.1.0',
        surfaces: [
          { host: 'claude-code', kind: 'skill', id: 'ghost', path: 'skills/ghost/SKILL.md' },
        ],
      }),
    );
    const report = await collectSurfaceInventory([claudeCodeHostAdapter], repo);
    expect(report.mismatch_count).toBeGreaterThan(0);
    expect(report.findings[0]?.mismatch).toBe('missing_file');
  });
});
