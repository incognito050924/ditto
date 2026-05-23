import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');
const cli = join(repoRoot, 'src', 'cli', 'index.ts');
let dir: string;
let home: string;

function run(args: string[]) {
  return Bun.spawnSync(['bun', 'run', cli, ...args], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, HOME: home },
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-doctor-mcp-'));
  home = await mkdtemp(join(tmpdir(), 'ditto-home-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

describe('doctor mcp', () => {
  test('collects project and user MCP servers', async () => {
    await cp(join(repoRoot, 'tests', 'fixtures', 'doctor', 'claude-code', 'mcp-config-only'), dir, {
      recursive: true,
    });
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(
      join(home, '.codex', 'config.toml'),
      '[mcp_servers.codex-server]\ncommand = "node"\nargs = ["codex.js"]\n',
      'utf8',
    );
    const proc = run(['doctor', 'mcp', '--output', 'json']);
    expect(proc.exitCode).toBe(0);
    const json = JSON.parse(proc.stdout.toString());
    expect(json.servers.length).toBeGreaterThanOrEqual(2);
  });

  test('reports unverified when no MCP sources are readable', () => {
    const proc = run(['doctor', 'mcp', '--output', 'json']);
    expect(proc.exitCode).toBe(0);
    const json = JSON.parse(proc.stdout.toString());
    expect(json.status).toBe('unverified');
    expect(json.unavailable_reason.length).toBeGreaterThan(0);
  });

  test('reports unverified .claude/settings.json MCP server names', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(
      join(dir, '.claude', 'settings.json'),
      JSON.stringify({ mcpServers: { legacy: { command: 'node' } } }),
      'utf8',
    );
    const proc = run(['doctor', 'mcp', '--host', 'claude-code', '--output', 'json']);
    expect(proc.exitCode).toBe(0);
    const json = JSON.parse(proc.stdout.toString());
    expect(
      json.unavailable.some((item: { reason: string }) => item.reason.includes('legacy')),
    ).toBe(true);
  });

  test('extracts inline table env keys from codex user config', async () => {
    await mkdir(join(home, '.codex'), { recursive: true });
    await cp(
      join(repoRoot, 'tests', 'fixtures', 'doctor', 'codex', 'mcp-inline-table', 'config.toml'),
      join(home, '.codex', 'config.toml'),
    );
    const proc = run(['doctor', 'mcp', '--host', 'codex', '--output', 'json']);
    expect(proc.exitCode).toBe(0);
    const json = JSON.parse(proc.stdout.toString());
    const fetch = json.servers.find((server: { name: string }) => server.name === 'fetch');
    expect(fetch).toBeDefined();
    expect(fetch.env_keys).toEqual(['REGION', 'TOKEN']);
    expect(fetch.args).toEqual(['mcp-fetch']);
  });
});
