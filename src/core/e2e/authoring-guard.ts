import { type BrowserProbe, probePlaywright } from './browser';

/**
 * Authoring-side browser guard (wi_260610p9h ac-9). DSL conversion/verification
 * runs that need Playwright/Chromium go through this gate. It REUSES the
 * existing probe policy (`probePlaywright` — `bunx --no-install`, never
 * `playwright install`): when the probe says unavailable, the guarded action is
 * never invoked and the caller gets a `blocked` outcome instead of an install
 * attempt or a hard failure.
 */

export type GuardedOutcome<T> =
  | { result: 'ran'; value: T; probe: BrowserProbe }
  | { result: 'blocked'; reason: string; probe: BrowserProbe };

export interface BrowserGuardOptions {
  /** Injectable probe (tests); defaults to the shared no-install probePlaywright. */
  probe?: (repoRoot: string) => Promise<BrowserProbe>;
}

export async function withBrowserGuard<T>(
  repoRoot: string,
  action: (probe: BrowserProbe) => Promise<T>,
  options: BrowserGuardOptions = {},
): Promise<GuardedOutcome<T>> {
  const probe = await (options.probe ?? probePlaywright)(repoRoot);
  if (!probe.available) {
    return { result: 'blocked', reason: probe.reason, probe };
  }
  return { result: 'ran', value: await action(probe), probe };
}
