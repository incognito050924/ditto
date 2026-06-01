import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { type E2EJourney, e2eJourney } from '~/schemas/e2e-journey';
import { spawnProviderProcess } from '../hosts/spawn';

/**
 * E2E browser thin layer (설계서 §10, e2e-journey-contract §3/§4). The M5 runtime
 * that the `playwright-e2e` agent / `/ditto:e2e` skill use to drive ONE direct-URL
 * journey with Playwright/Chromium and capture artifacts under `.ditto/runs/<id>/`.
 *
 * It reuses the host-adapter spawn primitive (`spawnProviderProcess`) — the same
 * way the dialectic Codex path is a separate thin layer over spawn. It is NOT MCP
 * (§10) and does NOT orchestrate a dev server (direct URL only).
 *
 * HARD CONSTRAINT (orchestrator decision): no automatic browser download. We probe
 * whether Playwright/Chromium is already present and, if not, return a
 * schema-legal `result='blocked'` journey — never `playwright install`, never a
 * hard build failure. This keeps the feature buildable/testable without a browser.
 */

export interface E2EJourneySpec {
  journey: string;
  url: string;
  steps: E2EJourney['steps'];
  assertions: Array<{ description: string }>;
}

export interface BrowserProbe {
  available: boolean;
  reason: string;
}

function repoRelative(repoRoot: string, path: string): string {
  return relative(repoRoot, path).split(sep).join('/');
}

async function sha256OfFile(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect whether Playwright/Chromium is already usable WITHOUT installing it.
 * We probe `bunx playwright --version`; a non-zero exit (e.g. would-download,
 * not found) is treated as unavailable. We never run `playwright install`.
 */
export async function probePlaywright(repoRoot: string): Promise<BrowserProbe> {
  let proc: ReturnType<typeof spawnProviderProcess>;
  try {
    proc = spawnProviderProcess({
      binary: 'bunx',
      // `--no-install` keeps bunx from auto-fetching the package over the network.
      args: ['--no-install', 'playwright', '--version'],
      repoRoot,
      cwd: '.',
      env: { set: {}, unset: [] },
    });
  } catch (err) {
    return {
      available: false,
      reason: `Playwright probe could not spawn: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const completion = await proc.completion;
  if (completion.exit_code === 0) {
    return { available: true, reason: 'playwright --version succeeded' };
  }
  return {
    available: false,
    reason: `Playwright/Chromium not available (bunx --no-install playwright --version exit=${completion.exit_code ?? 'null'}); not auto-installing per orchestrator hard constraint`,
  };
}

/**
 * Assemble an `e2eJourney` and validate it through the schema so the runtime
 * cross-field invariants (fail⇒reproduction, pass⇒all assertions satisfied) are
 * enforced at build time, not just at the JSON boundary.
 */
export function buildJourney(input: {
  journey: string;
  url: string;
  steps: E2EJourney['steps'];
  assertions: E2EJourney['assertions'];
  result: E2EJourney['result'];
  artifacts?: E2EJourney['artifacts'];
  reproduction?: string | null;
}): E2EJourney {
  return e2eJourney.parse({
    schema_version: '0.1.0',
    journey: input.journey,
    url: input.url,
    steps: input.steps,
    assertions: input.assertions,
    result: input.result,
    ...(input.artifacts ? { artifacts: input.artifacts } : {}),
    ...(input.reproduction !== undefined ? { reproduction: input.reproduction } : {}),
  });
}

function blockedJourney(spec: E2EJourneySpec, reason: string): E2EJourney {
  return buildJourney({
    journey: spec.journey,
    url: spec.url,
    steps: spec.steps,
    // blocked: assertions were never evaluated, so none is marked satisfied.
    assertions: spec.assertions.map((a) => ({ description: a.description, satisfied: false })),
    result: 'blocked',
    reproduction: reason,
  });
}

export interface RunJourneyResult {
  journey: E2EJourney;
  run_id: string;
  probe: BrowserProbe;
}

/**
 * Run one journey for an autopilot e2e node. When no browser is present this
 * returns a `result='blocked'` journey (the expected path in CI / no-browser
 * sessions). When Playwright IS present, it drives the URL via a generated
 * Playwright script spawned through the host primitive, captures the artifacts
 * the driver wrote, and assembles the journey from the observed outcome.
 */
export async function runJourney(
  repoRoot: string,
  runId: string,
  spec: E2EJourneySpec,
): Promise<RunJourneyResult> {
  const probe = await probePlaywright(repoRoot);
  if (!probe.available) {
    return { journey: blockedJourney(spec, probe.reason), run_id: runId, probe };
  }

  // Browser present: artifacts land under .ditto/runs/<id>/. The actual capture
  // glue (a Playwright script driving spec.steps) writes these files; here we
  // collect whatever the driver produced and reference it by path (+ sha256 for
  // screenshots only — trace.zip is large/opaque, skip its hash per §4).
  const runDir = join(repoRoot, '.ditto', 'runs', runId);
  const screenshotAbs = join(runDir, 'journey.png');
  const traceAbs = join(runDir, 'trace.zip');
  const consoleAbs = join(runDir, 'console.log');
  const networkAbs = join(runDir, 'network.log');

  const screenshots: E2EJourney['artifacts']['screenshots'] = [];
  if (await pathExists(screenshotAbs)) {
    screenshots.push({
      path: repoRelative(repoRoot, screenshotAbs),
      sha256: await sha256OfFile(screenshotAbs),
    });
  }
  const trace = (await pathExists(traceAbs)) ? { path: repoRelative(repoRoot, traceAbs) } : null;
  const consoleArtifact = (await pathExists(consoleAbs))
    ? { path: repoRelative(repoRoot, consoleAbs) }
    : null;
  const network = (await pathExists(networkAbs))
    ? { path: repoRelative(repoRoot, networkAbs) }
    : null;

  // The capture script (M5 glue) records assertion outcomes; absent that, treat
  // the run as blocked rather than fabricating a pass.
  const outcomeAbs = join(runDir, 'outcome.json');
  if (!(await pathExists(outcomeAbs))) {
    return {
      journey: blockedJourney(
        spec,
        'Playwright present but no capture outcome was produced; treating as blocked rather than asserting an unobserved pass',
      ),
      run_id: runId,
      probe,
    };
  }

  let outcome: { result: E2EJourney['result']; satisfied: boolean[]; reproduction?: string };
  try {
    outcome = JSON.parse(await readFile(outcomeAbs, 'utf8'));
  } catch (err) {
    return {
      journey: blockedJourney(
        spec,
        `capture outcome unreadable: ${err instanceof Error ? err.message : String(err)}`,
      ),
      run_id: runId,
      probe,
    };
  }

  const assertions = spec.assertions.map((a, i) => ({
    description: a.description,
    satisfied: outcome.satisfied[i] ?? false,
  }));
  const journey = buildJourney({
    journey: spec.journey,
    url: spec.url,
    steps: spec.steps,
    assertions,
    result: outcome.result,
    artifacts: { screenshots, trace, console: consoleArtifact, network },
    reproduction:
      outcome.result === 'fail' ? (outcome.reproduction ?? 'see captured artifacts') : null,
  });
  return { journey, run_id: runId, probe };
}
