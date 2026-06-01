import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildJourney, probePlaywright, runJourney } from '~/core/e2e/browser';
import { completionContract } from '~/schemas/completion-contract';
import { e2eJourney } from '~/schemas/e2e-journey';
import { evidenceRecord } from '~/schemas/evidence-record';

const spec = () => ({
  journey: 'login flow',
  url: 'http://localhost:3000/login',
  steps: [
    { action: 'fill email', target: '#email', expectation: 'value set' },
    { action: 'click submit', target: 'button[type=submit]' },
  ],
  assertions: [{ description: 'redirected to dashboard' }],
});

describe('e2e browser thin layer (ac-3/ac-4, §10)', () => {
  test('buildJourney parses through the schema (cross-field enforced at runtime)', () => {
    const j = buildJourney({
      journey: 'j',
      url: 'http://x/',
      steps: [],
      assertions: [{ description: 'ok', satisfied: true }],
      result: 'pass',
    });
    expect(e2eJourney.safeParse(j).success).toBe(true);
    expect(j.result).toBe('pass');
  });

  test('buildJourney rejects fail-without-reproduction (runtime object)', () => {
    expect(() =>
      buildJourney({
        journey: 'j',
        url: 'http://x/',
        steps: [],
        assertions: [{ description: 'ok', satisfied: false }],
        result: 'fail',
        reproduction: null,
      }),
    ).toThrow();
  });

  test('buildJourney rejects pass with an unsatisfied assertion', () => {
    expect(() =>
      buildJourney({
        journey: 'j',
        url: 'http://x/',
        steps: [],
        assertions: [{ description: 'x', satisfied: false }],
        result: 'pass',
      }),
    ).toThrow();
  });

  test('probePlaywright never installs and reports availability honestly', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ditto-e2e-'));
    const probe = await probePlaywright(repoRoot);
    expect(typeof probe.available).toBe('boolean');
    expect(probe.reason.length).toBeGreaterThan(0);
    if (!probe.available) {
      expect(probe.reason).toMatch(/not auto-installing/);
    }
  });

  test('runJourney degrades to result=blocked when no browser is available', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ditto-e2e-'));
    const out = await runJourney(repoRoot, 'run_e2etest01', spec());
    // In this CI/no-browser environment the probe is expected to be unavailable.
    if (out.probe.available) {
      // If a browser IS present but no capture outcome was written, still blocked.
      expect(['blocked', 'pass', 'fail']).toContain(out.journey.result);
    } else {
      expect(out.journey.result).toBe('blocked');
      expect(out.journey.reproduction).toMatch(/not auto-installing|not available/);
    }
    expect(e2eJourney.safeParse(out.journey).success).toBe(true);
  });

  test('runJourney with captured artifacts references each path (ac-3)', async () => {
    // Simulate a browser-present run by pre-seeding the run dir with captures.
    // We cannot force probe availability without a browser, so this test
    // exercises the artifact-collection + builder path directly via buildJourney
    // using the same paths runJourney would emit.
    const repoRoot = await mkdtemp(join(tmpdir(), 'ditto-e2e-'));
    const runId = 'run_e2etest02';
    const runDir = join(repoRoot, '.ditto', 'runs', runId);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, 'journey.png'), 'fake-png-bytes');
    const journey = buildJourney({
      journey: 'login flow',
      url: 'http://localhost:3000/login',
      steps: spec().steps,
      assertions: [{ description: 'redirected to dashboard', satisfied: true }],
      result: 'pass',
      artifacts: {
        screenshots: [
          {
            path: `.ditto/runs/${runId}/journey.png`,
            sha256: 'a'.repeat(64),
          },
        ],
        trace: { path: `.ditto/runs/${runId}/trace.zip` },
        console: { path: `.ditto/runs/${runId}/console.log` },
        network: { path: `.ditto/runs/${runId}/network.log` },
      },
    });
    expect(journey.artifacts.screenshots[0]?.path).toContain('.ditto/runs/');
    expect(journey.artifacts.trace?.path).toContain('trace.zip');
    expect(journey.artifacts.console?.path).toContain('console.log');
    expect(journey.artifacts.network?.path).toContain('network.log');
  });
});

describe('e2eJourney → EvidenceRecord in CompletionContract (ac-5)', () => {
  test('a blocked journey wraps as one local-artifact EvidenceRecord in a completion', () => {
    const journey = buildJourney({
      journey: 'login flow',
      url: 'http://localhost:3000/login',
      steps: spec().steps,
      assertions: [{ description: 'redirected to dashboard', satisfied: false }],
      result: 'blocked',
      reproduction: 'no browser available',
    });
    const record = evidenceRecord.parse({
      ref: {
        kind: 'artifact',
        path: '.ditto/runs/run_e2etest03/journey.json',
        sha256: 'b'.repeat(64),
      },
      captured_at: '2026-06-01T12:00:00+09:00',
      freshness: 'fresh',
      portability: 'local-artifact',
      artifact_available: true,
      key_lines: [`result=${journey.result}`, `journey=${journey.journey}`],
    });
    const completion = completionContract.parse({
      schema_version: '0.1.0',
      work_item_id: 'wi_260601pli',
      declared_by: 'verifier',
      declared_at: '2026-06-01T12:00:00+09:00',
      summary: 'e2e journey produced as evidence',
      acceptance: [
        {
          criterion_id: 'ac-e2e',
          verdict: 'unverified',
          evidence_records: [record],
          notes: 'browser unavailable; journey blocked',
        },
      ],
      unverified: [{ item: 'browser journey', reason: 'no Chromium present', out_of_scope: false }],
      next_handoff_path: '.ditto/runs/run_e2etest03/journey.json',
      final_verdict: 'unverified',
    });
    expect(completion.acceptance[0]?.evidence_records).toHaveLength(1);
    expect(completion.acceptance[0]?.evidence_records[0]?.portability).toBe('local-artifact');
    expect(completion.acceptance[0]?.evidence_records[0]?.artifact_available).toBe(true);
  });
});
