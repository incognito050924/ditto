import { describe, expect, test } from 'bun:test';
import { e2eJourney } from '~/schemas/e2e-journey';

const passing = () => ({
  schema_version: '0.1.0',
  journey: 'login flow',
  url: 'http://localhost:3000/login',
  steps: [
    { action: 'fill email', target: '#email', expectation: 'value set' },
    { action: 'click submit', target: 'button[type=submit]' },
  ],
  assertions: [{ description: 'redirected to dashboard', satisfied: true }],
  result: 'pass' as const,
});

describe('e2eJourney schema (설계서 §10)', () => {
  test('passing journey parses; artifacts default empty', () => {
    const j = e2eJourney.parse(passing());
    expect(j.result).toBe('pass');
    expect(j.artifacts.screenshots).toEqual([]);
    expect(j.artifacts.trace).toBe(null);
    expect(j.reproduction).toBe(null);
  });

  test('result=fail requires reproduction steps', () => {
    const failNoRepro = { ...passing(), result: 'fail' as const };
    expect(e2eJourney.safeParse(failNoRepro).success).toBe(false);

    const failOk = {
      ...passing(),
      result: 'fail' as const,
      assertions: [{ description: 'redirected', satisfied: false }],
      reproduction: '1) login with empty pw 2) observe 500',
    };
    expect(e2eJourney.safeParse(failOk).success).toBe(true);
  });

  test('result=pass with an unsatisfied assertion is rejected', () => {
    const inconsistent = {
      ...passing(),
      assertions: [{ description: 'x', satisfied: false }],
    };
    expect(e2eJourney.safeParse(inconsistent).success).toBe(false);
  });

  test('artifacts reference path (+ optional sha256), raw stays under .ditto/runs', () => {
    const j = e2eJourney.parse({
      ...passing(),
      artifacts: {
        screenshots: [{ path: '.ditto/runs/run_e2e0001/login.png', sha256: 'a'.repeat(64) }],
        trace: { path: '.ditto/runs/run_e2e0001/trace.zip' },
      },
    });
    expect(j.artifacts.screenshots[0]?.path).toContain('.ditto/runs/');
    expect(j.artifacts.trace?.path).toContain('trace.zip');
  });

  test('blocked journey (could not run) parses without reproduction', () => {
    const blocked = { ...passing(), result: 'blocked' as const, assertions: [] };
    expect(e2eJourney.safeParse(blocked).success).toBe(true);
  });
});
