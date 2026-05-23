import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repoRoot = join(import.meta.dir, '..', '..');
const cli = join(repoRoot, 'src', 'cli', 'index.ts');
let dir: string;

function run(args: string[], cwd = dir) {
  return Bun.spawnSync(['bun', 'run', cli, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, HOME: join(dir, 'home') },
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-doctor-instructions-'));
  await cp(join(repoRoot, 'tests', 'fixtures', 'doctor', 'codex', 'instructions-ok'), dir, {
    recursive: true,
  });
  await cp(join(repoRoot, 'tests', 'fixtures', 'doctor', 'claude-code', 'instructions-ok'), dir, {
    recursive: true,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('doctor instructions', () => {
  test('returns ok for matching codex and claude-code instructions', () => {
    const proc = run(['doctor', 'instructions', '--output', 'json']);
    expect(proc.exitCode).toBe(0);
    const json = JSON.parse(proc.stdout.toString());
    expect(json.findings).toHaveLength(0);
    expect(json.results).toHaveLength(2);
    const codex = json.results.find((result: { host: string }) => result.host === 'codex');
    const claude = json.results.find((result: { host: string }) => result.host === 'claude-code');
    expect(codex.status).toBe('ok');
    expect(codex.path).toEndWith('AGENTS.md');
    expect(codex.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(claude.status).toBe('ok');
    expect(claude.path).toEndWith('CLAUDE.md');
    expect(claude.markerSource).toBe('AGENTS.md');
    expect(claude.markerSha256).toBe(codex.sourceSha256);
    expect(claude.actualSha256).toBe(codex.sourceSha256);
    expect(claude.sourceSha256).toBe(codex.sourceSha256);
    expect(claude.findings).toHaveLength(0);
  });

  test('returns drift exit code and finding when projection is missing', async () => {
    await rm(join(dir, 'CLAUDE.md'));
    const proc = run(['doctor', 'instructions', '--host', 'claude-code', '--output', 'json']);
    expect(proc.exitCode).toBe(1);
    const json = JSON.parse(proc.stdout.toString());
    expect(
      json.findings.some((finding: { kind: string }) => finding.kind === 'projection_missing'),
    ).toBe(true);
    expect(json.results[0].status).toBe('drift');
    expect(json.results[0].findings[0].kind).toBe('projection_missing');
  });

  test('detects content mismatch when managed block body changes', async () => {
    await writeFile(
      join(dir, 'CLAUDE.md'),
      '<!-- ditto:managed:start source=AGENTS.md sha256=a38d48e293e579a63234dc67dff1b6bcc44fb17acd78f6996fe1cc22bb4444a1 -->\n변조된 줄\n<!-- ditto:managed:end -->\n',
    );
    const proc = run(['doctor', 'instructions', '--host', 'claude-code', '--output', 'json']);
    expect(proc.exitCode).toBe(1);
    const json = JSON.parse(proc.stdout.toString());
    expect(
      json.findings.some((finding: { kind: string }) => finding.kind === 'content_mismatch'),
    ).toBe(true);
    const claude = json.results.find((result: { host: string }) => result.host === 'claude-code');
    expect(
      claude.findings.some((finding: { kind: string }) => finding.kind === 'content_mismatch'),
    ).toBe(true);
  });

  test('detects sha256 mismatch when AGENTS.md changes', async () => {
    await writeFile(join(dir, 'AGENTS.md'), '# AGENTS\n원본 줄\nnew line\n');
    const proc = run(['doctor', 'instructions', '--host', 'claude-code', '--output', 'json']);
    expect(proc.exitCode).toBe(1);
    const json = JSON.parse(proc.stdout.toString());
    expect(
      json.findings.some((finding: { kind: string }) => finding.kind === 'sha256_mismatch'),
    ).toBe(true);
  });

  test('detects missing managed block marker', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), 'no marker\n');
    const proc = run(['doctor', 'instructions', '--host', 'claude-code', '--output', 'json']);
    expect(proc.exitCode).toBe(1);
    const json = JSON.parse(proc.stdout.toString());
    expect(
      json.findings.some((finding: { kind: string }) => finding.kind === 'marker_missing'),
    ).toBe(true);
  });

  test('detects missing AGENTS.md for codex', async () => {
    await rm(join(dir, 'AGENTS.md'));
    const proc = run(['doctor', 'instructions', '--host', 'codex', '--output', 'json']);
    expect(proc.exitCode).toBe(1);
    const json = JSON.parse(proc.stdout.toString());
    expect(json.findings[0].kind).toBe('source_missing');
  });

  test('advisory keeps drift exit code at zero', async () => {
    await writeFile(
      join(dir, 'AGENTS.md'),
      '<!-- ditto:managed:start source=AGENTS.md sha256=a38d48e293e579a63234dc67dff1b6bcc44fb17acd78f6996fe1cc22bb4444a1 -->\noops\n<!-- ditto:managed:end -->\n',
    );
    const proc = run([
      'doctor',
      'instructions',
      '--host',
      'codex',
      '--output',
      'json',
      '--advisory',
    ]);
    expect(proc.exitCode).toBe(0);
    const json = JSON.parse(proc.stdout.toString());
    expect(json.findings[0].kind).toBe('marker_in_source');
  });

  test('rejects invalid host as usage error', () => {
    const proc = run(['doctor', 'instructions', '--host', 'unknown', '--output', 'json']);
    expect(proc.exitCode).toBe(65);
    expect(proc.stderr.toString()).toContain('invalid --host value');
  });

  test('detects multiple managed markers in CLAUDE.md', async () => {
    await writeFile(
      join(dir, 'CLAUDE.md'),
      [
        '<!-- ditto:managed:start source=AGENTS.md sha256=a38d48e293e579a63234dc67dff1b6bcc44fb17acd78f6996fe1cc22bb4444a1 -->',
        'block 1',
        '<!-- ditto:managed:end -->',
        '',
        'free area',
        '',
        '<!-- ditto:managed:start source=AGENTS.md sha256=1111111111111111111111111111111111111111111111111111111111111111 -->',
        'block 2',
        '<!-- ditto:managed:end -->',
        '',
      ].join('\n'),
    );
    const proc = run(['doctor', 'instructions', '--host', 'claude-code', '--output', 'json']);
    expect(proc.exitCode).toBe(1);
    const json = JSON.parse(proc.stdout.toString());
    const finding = json.findings.find((f: { kind: string }) => f.kind === 'multiple_markers');
    expect(finding).toBeDefined();
    expect(finding.message).toContain('2');
  });
});
