import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PLAYWRIGHT_TEST_MCP_KEY,
  buildE2eAgentsRecord,
  detectVersionSkew,
  gatePlaywrightVersion,
  mergeMcpServers,
  parsePlaywrightVersion,
  readE2eAgentsRecord,
  resolveLoop,
  scaffoldIfAbsent,
  writeE2eAgentsRecord,
  writeMergedMcpJson,
} from '~/core/e2e/init-agents';

/**
 * wi_2607026qs ac-9 (Contract 8) — dual-host E2E test-agent install.
 * Optional-tool code (ADR-0018): NEVER auto-install Playwright, NEVER crash
 * when it is absent. Filesystem effects sit behind an injectable seam so these
 * unit tests need neither a real Playwright install nor a real host config.
 */

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'ditto-initagents-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('resolveLoop — host/loop mapping (reject wrong pairing)', () => {
  test('host derives its loop; explicit matching loop is accepted', () => {
    expect(resolveLoop('claude')).toBe('claude');
    expect(resolveLoop('codex')).toBe('codex');
    expect(resolveLoop('claude', 'claude')).toBe('claude');
  });
  test('a mismatched explicit loop is rejected', () => {
    expect(() => resolveLoop('claude', 'codex')).toThrow();
    expect(() => resolveLoop('codex', 'claude')).toThrow();
  });
});

describe('Playwright version gate (>=1.61.0)', () => {
  test('parses a `playwright --version` line', () => {
    expect(parsePlaywrightVersion('Version 1.61.1')).toMatchObject({
      major: 1,
      minor: 61,
      patch: 1,
    });
    expect(parsePlaywrightVersion('1.60.0')).toMatchObject({ major: 1, minor: 60, patch: 0 });
    expect(parsePlaywrightVersion('garbage')).toBeNull();
  });

  test('codex REFUSES <1.61 and ALLOWS >=1.61', () => {
    const low = gatePlaywrightVersion('codex', 'Version 1.60.0');
    expect(low.decision).toBe('refuse');
    expect(low.message).toBeTruthy();

    const ok = gatePlaywrightVersion('codex', 'Version 1.61.1');
    expect(ok.decision).toBe('install');
  });

  test('claude installs but WARNS below 1.61; installs clean at/above', () => {
    const low = gatePlaywrightVersion('claude', '1.60.0');
    expect(low.decision).toBe('install');
    expect(low.warn).toBeTruthy();

    const ok = gatePlaywrightVersion('claude', '1.61.0');
    expect(ok.decision).toBe('install');
    expect(ok.warn).toBeNull();
  });

  test('absent Playwright routes to degrade (never install, never crash)', () => {
    const gate = gatePlaywrightVersion('codex', null);
    expect(gate.decision).toBe('degrade');
    expect(() => gatePlaywrightVersion('claude', undefined)).not.toThrow();
  });
});

describe('.mcp.json backup + merge (claude loop clobbers with a fresh file)', () => {
  test('merge preserves a pre-existing user MCP server AND adds playwright-test', () => {
    const existing = JSON.stringify({
      mcpServers: { 'user-db': { command: 'my-db-mcp', args: ['--port', '5432'] } },
    });
    const merged = mergeMcpServers(existing);
    expect(merged.mcpServers['user-db']).toEqual({
      command: 'my-db-mcp',
      args: ['--port', '5432'],
    });
    expect(merged.mcpServers[PLAYWRIGHT_TEST_MCP_KEY]).toBeDefined();
  });

  test('absent/empty existing content yields a fresh config with playwright-test only', () => {
    const merged = mergeMcpServers(null);
    expect(Object.keys(merged.mcpServers)).toEqual([PLAYWRIGHT_TEST_MCP_KEY]);
  });

  test('writeMergedMcpJson backs the original up ONCE and writes the merged file', async () => {
    await withTmp(async (dir) => {
      const mcpPath = join(dir, '.mcp.json');
      await Bun.write(
        mcpPath,
        JSON.stringify({ mcpServers: { 'user-db': { command: 'my-db-mcp' } } }, null, 2),
      );

      const res = await writeMergedMcpJson(mcpPath);
      expect(res.backupPath).toBe(`${mcpPath}.ditto_bak`);
      expect(res.servers).toContain('user-db');
      expect(res.servers).toContain(PLAYWRIGHT_TEST_MCP_KEY);

      // backup keeps the ORIGINAL, target holds the merged result
      const bak = JSON.parse(await readFile(`${mcpPath}.ditto_bak`, 'utf8'));
      expect(Object.keys(bak.mcpServers)).toEqual(['user-db']);
      const written = JSON.parse(await readFile(mcpPath, 'utf8'));
      expect(written.mcpServers['user-db']).toBeDefined();
      expect(written.mcpServers[PLAYWRIGHT_TEST_MCP_KEY]).toBeDefined();
    });
  });
});

describe('scaffold create-if-absent (never overwrite a user config)', () => {
  test('creates the file when absent, then refuses to overwrite it', async () => {
    await withTmp(async (dir) => {
      const cfg = join(dir, 'playwright.config.ts');
      const first = await scaffoldIfAbsent(cfg, 'export default { testDir: "e2e/generated" };\n');
      expect(first).toBe('created');
      expect(await Bun.file(cfg).exists()).toBe(true);

      const userEdited = 'export default { testDir: "custom" };\n';
      await Bun.write(cfg, userEdited);
      const second = await scaffoldIfAbsent(cfg, 'export default { testDir: "e2e/generated" };\n');
      expect(second).toBe('skipped-exists');
      // the user's config is preserved verbatim
      expect(await readFile(cfg, 'utf8')).toBe(userEdited);
    });
  });
});

describe('version-skew record', () => {
  test('buildE2eAgentsRecord stamps plan_format v1 + constrained healer', () => {
    const rec = buildE2eAgentsRecord({ playwrightVersion: '1.61.1', loop: 'claude' });
    expect(rec.plan_format_version).toBe('v1');
    expect(rec.healer).toBe('constrained');
    expect(rec.loop).toBe('claude');
    expect(rec.playwright_version).toBe('1.61.1');
    expect(typeof rec.installed_at).toBe('string');
  });

  test('detectVersionSkew flags a plan_format mismatch → loud warn + degrade', () => {
    const stale = buildE2eAgentsRecord({ playwrightVersion: '1.61.1', loop: 'claude' });
    const skewed = { ...stale, plan_format_version: 'v2' };
    const res = detectVersionSkew(skewed);
    expect(res.skew).toBe(true);
    expect(res.action).toBe('degrade');
    expect(res.warn).toBeTruthy();

    const match = detectVersionSkew(stale);
    expect(match.skew).toBe(false);
    expect(match.action).toBe('ok');
    expect(match.warn).toBeNull();
  });

  test('write then read round-trips the record; absent path reads null', async () => {
    await withTmp(async (dir) => {
      const path = join(dir, '.ditto', 'local', 'e2e-agents.json');
      expect(await readE2eAgentsRecord(path)).toBeNull();

      const rec = buildE2eAgentsRecord({ playwrightVersion: '1.61.1', loop: 'codex' });
      await writeE2eAgentsRecord(path, rec);
      const back = await readE2eAgentsRecord(path);
      expect(back).toEqual(rec);
    });
  });
});
