import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type HostAdapter,
  codexHostAdapter,
  registerHostAdapter,
  unregisterHostAdapter,
} from '~/core/hosts';
import {
  checkInstructionsForAdapters,
  checkInstructionsForHosts,
  loadProjection,
  normalizedSha256,
} from '~/core/instruction-bridge';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-instructions-'));
  await cp(join(import.meta.dir, '..', 'fixtures', 'doctor', 'codex', 'instructions-ok'), dir, {
    recursive: true,
  });
  await cp(
    join(import.meta.dir, '..', 'fixtures', 'doctor', 'claude-code', 'instructions-ok'),
    dir,
    {
      recursive: true,
    },
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('instruction bridge', () => {
  test('normalizes line endings and trailing whitespace for sha256', () => {
    expect(normalizedSha256('a  \r\nb\t')).toBe(normalizedSha256('a\nb'));
  });

  test('loads a managed projection block', async () => {
    const projection = await loadProjection(dir);
    expect(projection.kind).toBe('ok');
    if (projection.kind === 'ok') {
      expect(projection.markerSource).toBe('AGENTS.md');
      expect(projection.managedBlock).toContain('원본 줄');
    }
  });

  test('reports content mismatch when projection body changes', async () => {
    await writeFile(
      join(dir, 'CLAUDE.md'),
      '<!-- ditto:managed:start source=AGENTS.md sha256=a38d48e293e579a63234dc67dff1b6bcc44fb17acd78f6996fe1cc22bb4444a1 -->\nchanged\n<!-- ditto:managed:end -->\n',
      'utf8',
    );
    const report = await checkInstructionsForHosts(['claude-code'], dir);
    expect(report.findings.map((finding) => finding.kind)).toContain('content_mismatch');
    expect(report.results[0]?.host).toBe('claude-code');
    expect(report.results[0]?.status).toBe('drift');
    expect(report.results[0]?.markerSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.results[0]?.actualSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  test('reports multiple_markers finding when CLAUDE.md has more than one block', async () => {
    await writeFile(
      join(dir, 'CLAUDE.md'),
      [
        '<!-- ditto:managed:start source=AGENTS.md sha256=0000000000000000000000000000000000000000000000000000000000000000 -->',
        'one',
        '<!-- ditto:managed:end -->',
        '',
        '<!-- ditto:managed:start source=AGENTS.md sha256=1111111111111111111111111111111111111111111111111111111111111111 -->',
        'two',
        '<!-- ditto:managed:end -->',
      ].join('\n'),
      'utf8',
    );
    const report = await checkInstructionsForHosts(['claude-code'], dir);
    const finding = report.findings.find((f) => f.kind === 'multiple_markers');
    expect(finding).toBeDefined();
    expect(finding?.message).toContain('2');
    expect(report.results[0]?.status).toBe('drift');
  });

  test('projection-only adapters report source_missing without hard-binding codex registry', async () => {
    unregisterHostAdapter('codex');
    const projectionOnly: HostAdapter = {
      id: 'mock-projection',
      async loadInstructions() {
        return {
          role: 'projection',
          host: 'mock-projection',
          source: 'AGENTS.md',
          path: join(dir, 'MOCK.md'),
          exists: false,
        };
      },
      async loadPermissions() {
        return [{ host: 'mock-projection', source_file: 'mock', status: 'missing', raw: {} }];
      },
      async loadMcpServers() {
        return { host: 'mock-projection', servers: [], unavailable: [] };
      },
      async loadSurfaceInventory() {
        return { host: 'mock-projection', localSurfaces: [], homeSurfaces: [], unavailable: [] };
      },
    };
    try {
      const report = await checkInstructionsForAdapters([projectionOnly], dir);
      expect(report.findings).toEqual([]);
      expect(report.results).toEqual([]);
      expect(report.sourceSha256).toBe(null);
    } finally {
      registerHostAdapter(codexHostAdapter);
    }
  });
});
