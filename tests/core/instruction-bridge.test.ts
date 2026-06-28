import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type HostAdapter,
  codexHostAdapter,
  registerHostAdapter,
  unregisterHostAdapter,
} from '~/core/hosts';
import {
  CHARTER_IDENTITY_MARKER,
  DELEGATION_CLAUSE_ANCHOR,
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

  test('charter source fires clause_missing when the delegation anchor (§4-9) is absent', async () => {
    // A source that self-identifies as the Agent Behavior Charter but drops the
    // §4-9 delegation clause must produce a clause_missing finding — projection
    // integrity alone cannot catch deletion from both source and projection.
    await writeFile(join(dir, 'AGENTS.md'), '# Agent Behavior Charter v1\n본문\n', 'utf8');
    const report = await checkInstructionsForHosts(['codex'], dir);
    const finding = report.findings.find((f) => f.kind === 'clause_missing');
    expect(finding).toBeDefined();
    expect(finding?.host).toBe('codex');
    expect(report.results[0]?.status).toBe('drift');
  });

  test('charter source is clean when the delegation anchor (§4-9) is present', async () => {
    await writeFile(
      join(dir, 'AGENTS.md'),
      '# Agent Behavior Charter v1\n### 4-9. 위임으로 컨텍스트를 지킨다\n본문\n',
      'utf8',
    );
    const report = await checkInstructionsForHosts(['codex'], dir);
    expect(report.findings.map((f) => f.kind)).not.toContain('clause_missing');
    expect(report.results[0]?.status).toBe('ok');
  });

  test('a non-charter source is not flagged for lacking the delegation clause', async () => {
    // The default fixture AGENTS.md ("# AGENTS") is not the charter — a downstream
    // authored source must never be flagged for missing DITTO's §4-9 clause.
    const report = await checkInstructionsForHosts(['codex'], dir);
    expect(report.findings.map((f) => f.kind)).not.toContain('clause_missing');
    expect(report.results[0]?.status).toBe('ok');
  });

  test('projection-only adapters report source_missing without hard-binding codex registry', async () => {
    unregisterHostAdapter('codex');
    const projectionOnly: HostAdapter = {
      id: 'mock-projection',
      capabilities: { hooks: [], instructions: true, permissions: true, mcp: true, surface: true },
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

  // wi_260627sey: the clause-presence guard self-disables silently if the charter
  // is RENAMED — `checkRequiredClauses` returns [] when the source no longer
  // contains CHARTER_IDENTITY_MARKER (it cannot tell a renamed charter from a
  // downstream non-charter source). This pins THIS repo's canonical codex source
  // (AGENTS.md) to BOTH code constants, so renaming the charter title or moving the
  // §4-9 clause out of lockstep with the code fails loudly here instead of quietly
  // turning the guard off.
  test('the repo charter source (AGENTS.md) carries both code-coupled markers (rename → loud failure)', async () => {
    const charter = await readFile(join(process.cwd(), 'AGENTS.md'), 'utf8');
    expect(charter).toContain(CHARTER_IDENTITY_MARKER);
    expect(charter).toContain(DELEGATION_CLAUSE_ANCHOR);
  });
});
