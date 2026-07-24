import { describe, expect, test } from 'bun:test';

import type { AnalysisFinding, AnalysisRequest, AnalyzerKind } from './analyzer';
import { FakeStaticAnalysisHost } from './fake-host';
import { analysisDisposition, runAnalysis } from './provider';

const REQ: AnalysisRequest = { files: ['rebuild/analysis/provider.ts'] };

const FINDING: AnalysisFinding = {
  rule: 'js/unused-import',
  severity: 'warning',
  path: 'rebuild/analysis/provider.ts',
  line: 12,
  message: 'unused import',
};

describe('runAnalysis — ADR-0018 graceful degradation (tool ABSENT)', () => {
  test('a probe-absent tool degrades, it does not throw', async () => {
    const result = await runAnalysis('codeql', REQ, {
      probe: async () => false,
      invoke: async () => {
        throw new Error('invoke must not be called when the tool is absent');
      },
    });
    expect(result.status).toBe('degraded');
    if (result.status === 'degraded') {
      expect(result.reason).toBe('tool_absent');
      expect(result.analyzer).toBe('codeql');
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });
});

describe('runAnalysis — tool PRESENT (real result shape)', () => {
  test('a present tool returns ok with its findings', async () => {
    const result = await runAnalysis('codeql', REQ, {
      probe: async () => true,
      invoke: async () => ({ findings: [FINDING] }),
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.analyzer).toBe('codeql');
      expect(result.findings).toEqual([FINDING]);
    }
  });

  test('a present tool that finds nothing is ok+empty — genuinely CLEAN, not degraded', async () => {
    const result = await runAnalysis('codeql', REQ, {
      probe: async () => true,
      invoke: async () => ({ findings: [] }),
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.findings).toEqual([]);
  });
});

describe('runAnalysis — tool PRESENT but FAILING (ADR-0018: never propagate)', () => {
  test('invoke throwing degrades to tool_error, it does not crash the stage', async () => {
    const result = await runAnalysis('semantic', REQ, {
      probe: async () => true,
      invoke: async () => {
        throw new Error('codeql database create exited 1');
      },
    });
    expect(result.status).toBe('degraded');
    if (result.status === 'degraded') {
      expect(result.reason).toBe('tool_error');
      expect(result.detail).toContain('exited 1');
    }
  });

  test('unvalidatable tool output degrades to tool_error, not a false ok', async () => {
    const result = await runAnalysis('lsp', REQ, {
      probe: async () => true,
      invoke: async () => ({ findings: [{ rule: '', severity: 'nope' }] }),
    });
    expect(result.status).toBe('degraded');
    if (result.status === 'degraded') expect(result.reason).toBe('tool_error');
  });

  test('a THROWING probe degrades to tool_error, it does not crash the stage (ADR-0018 D1)', async () => {
    const result = await runAnalysis('codeql', REQ, {
      probe: async () => {
        throw new Error('which codeql: spawn ENOENT');
      },
      invoke: async () => ({ findings: [] }),
    });
    expect(result.status).toBe('degraded');
    if (result.status === 'degraded') {
      expect(result.reason).toBe('tool_error');
      expect(result.detail).toContain('ENOENT');
    }
  });
});

describe('analysisDisposition — the ACG-consumable (#90) three-way distinction', () => {
  test('degraded → unverified (NEVER collapses to clean — the ADR-0018 heart)', () => {
    expect(
      analysisDisposition({
        status: 'degraded',
        analyzer: 'codeql',
        reason: 'tool_absent',
        detail: 'x',
      }),
    ).toBe('unverified');
  });

  test('ok + zero findings → clean (a real scan that found nothing)', () => {
    expect(
      analysisDisposition({ status: 'ok', analyzer: 'codeql', findings: [] }),
    ).toBe('clean');
  });

  test('ok + findings → findings (governance has real violations to act on)', () => {
    expect(
      analysisDisposition({
        status: 'ok',
        analyzer: 'codeql',
        findings: [FINDING],
      }),
    ).toBe('findings');
  });

  test('tool-absent and clean are DISTINGUISHABLE dispositions', () => {
    const absent = analysisDisposition({
      status: 'degraded',
      analyzer: 'lsp',
      reason: 'tool_absent',
      detail: 'x',
    });
    const clean = analysisDisposition({
      status: 'ok',
      analyzer: 'lsp',
      findings: [],
    });
    expect(absent).not.toBe(clean);
  });
});

describe('every analyzer kind obeys the SAME invariant (via the fake host wiring)', () => {
  const kinds: AnalyzerKind[] = ['codeql', 'lsp', 'semantic'];

  test.each(kinds)('%s absent → degraded/tool_absent → unverified', async (kind) => {
    // nothing scripted present → probe absent for this kind
    const result = await runAnalysis(kind, REQ, new FakeStaticAnalysisHost());
    expect(result.status).toBe('degraded');
    expect(analysisDisposition(result)).toBe('unverified');
  });

  test.each(kinds)('%s present → ok, disposition reflects real findings', async (kind) => {
    const host = new FakeStaticAnalysisHost({
      present: { [kind]: { findings: [FINDING] } },
    });
    const result = await runAnalysis(kind, REQ, host);
    expect(result.status).toBe('ok');
    expect(analysisDisposition(result)).toBe('findings');
  });

  test('a consumer scanning several kinds gets one degraded, one clean, one findings', async () => {
    const host = new FakeStaticAnalysisHost({
      // codeql absent (omitted), lsp clean, semantic has a finding
      present: { lsp: { findings: [] }, semantic: { findings: [FINDING] } },
    });
    const [codeql, lsp, semantic] = await Promise.all([
      runAnalysis('codeql', REQ, host),
      runAnalysis('lsp', REQ, host),
      runAnalysis('semantic', REQ, host),
    ]);
    expect(analysisDisposition(codeql)).toBe('unverified');
    expect(analysisDisposition(lsp)).toBe('clean');
    expect(analysisDisposition(semantic)).toBe('findings');
  });
});
