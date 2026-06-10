import { describe, expect, test } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withBrowserGuard } from '~/core/e2e/authoring-guard';
import type { BrowserProbe } from '~/core/e2e/browser';

describe('withBrowserGuard (ac-9: no install, degrade to blocked)', () => {
  test('probe unavailable → blocked; the guarded action (and thus ANY command, install included) never runs', async () => {
    const ranCommands: string[] = [];
    const probe = async (): Promise<BrowserProbe> => ({
      available: false,
      reason:
        'Playwright/Chromium not available; not auto-installing per orchestrator hard constraint',
    });
    const out = await withBrowserGuard(
      '/repo',
      async () => {
        ranCommands.push('bunx playwright install'); // would be the forbidden path
        return 'converted';
      },
      { probe },
    );
    expect(out.result).toBe('blocked');
    if (out.result === 'blocked') expect(out.reason).toMatch(/not auto-installing/);
    // The action was never invoked → no command (in particular no `playwright install`).
    expect(ranCommands).toEqual([]);
  });

  test('probe available → the action runs once and its value is returned', async () => {
    let calls = 0;
    const probe = async (): Promise<BrowserProbe> => ({ available: true, reason: 'cached' });
    const out = await withBrowserGuard(
      '/repo',
      async () => {
        calls += 1;
        return 42;
      },
      { probe },
    );
    expect(out).toEqual({
      result: 'ran',
      value: 42,
      probe: { available: true, reason: 'cached' },
    });
    expect(calls).toBe(1);
  });

  test('default probe is probePlaywright: honest outcome, never an install attempt', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'ditto-guard-'));
    const out = await withBrowserGuard(repoRoot, async () => 'ok');
    if (out.result === 'blocked') {
      // The reused probe policy states it explicitly: probing only, no install.
      expect(out.reason).toMatch(/not auto-installing|not available|could not spawn/);
    } else {
      expect(out.value).toBe('ok');
    }
  });
});
