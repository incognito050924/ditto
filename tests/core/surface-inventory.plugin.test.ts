import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeCodeHostAdapter } from '~/core/hosts';
import { collectSurfaceInventory, generateSurfaceCatalog } from '~/core/surface-inventory';

const REPO_ROOT = join(import.meta.dir, '..', '..');

describe('DITTO plugin surface inventory (M1.6)', () => {
  // Code-self-contained (wi_260715ujg): the expected side is the pure deterministic
  // code scan (generateSurfaceCatalog), asserted against a SOURCE-PINNED committed
  // count anchor — NOT the gitignored, per-developer .ditto/local/surfaces.json (which
  // can be absent on a fresh clone/worktree, and whose pre-push regen flaked concurrent
  // pushes). The hardcoded 49 is the real anchor: any genuine skill/agent/hook ADD or
  // DELETE changes the scan count and turns this RED (drift still caught, not silent).
  test('code-scanned catalog has the source-pinned surface count (no false-green)', async () => {
    const cat = await generateSurfaceCatalog([claudeCodeHostAdapter], REPO_ROOT);
    expect(cat.surfaces.length).toBe(49); // 18 skills (+coverage-taxonomy) + 24 agents (21 plugin + 3 .claude/agents variants, f95ebec) + 6 hooks + 1 plugin
  });

  test('code-scanned catalog includes hook + plugin surfaces (not just skills/agents/commands)', async () => {
    const cat = await generateSurfaceCatalog([claudeCodeHostAdapter], REPO_ROOT);
    const kinds = new Set(cat.surfaces.map((s) => s.kind));
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
