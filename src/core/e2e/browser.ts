import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type E2EJourney, e2eJourney } from '~/schemas/e2e-journey';
import { fileExists } from '../hosts/shared';
import { spawnProviderProcess } from '../hosts/spawn';

/**
 * Resolve the sibling capture runner path lazily. Computing it at module load
 * would call `fileURLToPath(import.meta.url)` eagerly, which throws under a
 * `bun build --compile` binary (where `import.meta.url` is `compiled://…`, not a
 * file URL) and would crash the whole CLI at startup. It is only needed on the
 * real-browser spawn path (inside runJourney's try → degrades to `blocked`).
 */
function runnerScriptPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'playwright-runner.mjs');
}

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
  /** Resolved playwright-core entry (for the node runner) when a real launch is possible. */
  playwrightCore?: string;
  /** Path to an already-cached Chromium executable (no download) when present. */
  executablePath?: string;
}

/**
 * Resolve the `playwright-core` module entry without adding it to package.json.
 * It lives in bun's global install cache (where `bunx playwright` resolves it);
 * createRequire cannot reach it from inside this repo (no local dep), so we glob
 * the bun cache and hand the explicit ESM entry to the node runner — which also
 * cannot resolve bun's cache on its own. Highest cached version wins.
 */
async function resolvePlaywrightCore(): Promise<string | null> {
  const bunInstall = process.env.BUN_INSTALL ?? join(homedir(), '.bun');
  const cacheDir = join(bunInstall, 'install', 'cache');
  let entries: string[];
  try {
    entries = await readdir(cacheDir);
  } catch {
    return null;
  }
  const versions = entries
    .filter((e) => /^playwright-core@\d+\.\d+\.\d+$/.test(e))
    .sort((a, b) => compareSemver(b.split('@')[1], a.split('@')[1]));
  for (const v of versions) {
    const mjs = join(cacheDir, v, 'index.mjs');
    if (await fileExists(mjs)) return mjs;
  }
  return null;
}

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}

/**
 * Find an ALREADY-CACHED Chromium executable under the Playwright browser cache.
 * We never download: if no cached full-Chromium build is present we return null
 * and the caller degrades to blocked. Headless-shell builds are skipped because
 * the cached ones use a CDP transport incompatible with the resolved playwright.
 */
async function findCachedChromium(): Promise<string | null> {
  const cacheRoot = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  let entries: string[];
  try {
    entries = await readdir(cacheRoot);
  } catch {
    return null;
  }
  // Highest build number first so we use the newest cached full-Chromium.
  const chromiumDirs = entries
    .filter((e) => /^chromium-\d+$/.test(e))
    .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  const candidates = [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  ];
  for (const dir of chromiumDirs) {
    for (const rel of candidates) {
      const abs = join(cacheRoot, dir, rel);
      if (await fileExists(abs)) return abs;
    }
  }
  return null;
}

function repoRelative(repoRoot: string, path: string): string {
  return relative(repoRoot, path).split(sep).join('/');
}

async function sha256OfFile(path: string): Promise<string> {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
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
  if (completion.exit_code !== 0) {
    return {
      available: false,
      reason: `Playwright/Chromium not available (bunx --no-install playwright --version exit=${completion.exit_code ?? 'null'}); not auto-installing per orchestrator hard constraint`,
    };
  }
  // playwright package is present; for a REAL launch we also need a resolvable
  // playwright-core module and an already-cached Chromium executable.
  const playwrightCore = await resolvePlaywrightCore();
  const executablePath = await findCachedChromium();
  if (!playwrightCore || !executablePath) {
    return {
      available: false,
      reason: `Playwright CLI present but no real-launch inputs (playwright-core=${playwrightCore ? 'ok' : 'unresolved'}, cachedChromium=${executablePath ? 'ok' : 'absent'}); not auto-installing per orchestrator hard constraint`,
    };
  }
  return {
    available: true,
    reason: 'playwright --version succeeded; cached Chromium + playwright-core resolved',
    playwrightCore,
    executablePath,
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
  if (!probe.available || !probe.playwrightCore || !probe.executablePath) {
    return { journey: blockedJourney(spec, probe.reason), run_id: runId, probe };
  }

  // Browser present: artifacts land under .ditto/runs/<id>/. We spawn the node
  // capture runner (bun cannot drive Playwright's launcher) through the host
  // primitive; it launches the cached Chromium, drives spec.steps, and writes the
  // artifacts + outcome.json. Then we collect what it produced and reference it by
  // path (+ sha256 for screenshots only — trace.zip is large/opaque, skip its hash).
  const runDir = join(repoRoot, '.ditto', 'runs', runId);
  await mkdir(runDir, { recursive: true });
  const configAbs = join(runDir, 'runner-config.json');
  await writeFile(
    configAbs,
    JSON.stringify({
      playwrightCore: probe.playwrightCore,
      executablePath: probe.executablePath,
      url: spec.url,
      steps: spec.steps,
      assertions: spec.assertions.map((a) => ({ description: a.description })),
      runDir,
    }),
  );
  let runnerExit: number | null;
  try {
    const runner = spawnProviderProcess({
      binary: 'node',
      args: [runnerScriptPath(), configAbs],
      repoRoot,
      cwd: '.',
      env: { set: {}, unset: [] },
    });
    runnerExit = (await runner.completion).exit_code;
  } catch (err) {
    return {
      journey: blockedJourney(
        spec,
        `capture runner could not spawn: ${err instanceof Error ? err.message : String(err)}`,
      ),
      run_id: runId,
      probe,
    };
  }
  if (runnerExit !== 0) {
    return {
      journey: blockedJourney(
        spec,
        `capture runner exited non-zero (exit=${runnerExit ?? 'null'}); treating as blocked rather than asserting an unobserved pass`,
      ),
      run_id: runId,
      probe,
    };
  }

  const screenshotAbs = join(runDir, 'journey.png');
  const traceAbs = join(runDir, 'trace.zip');
  const consoleAbs = join(runDir, 'console.log');
  const networkAbs = join(runDir, 'network.log');

  const screenshots: E2EJourney['artifacts']['screenshots'] = [];
  if (await fileExists(screenshotAbs)) {
    screenshots.push({
      path: repoRelative(repoRoot, screenshotAbs),
      sha256: await sha256OfFile(screenshotAbs),
    });
  }
  const trace = (await fileExists(traceAbs)) ? { path: repoRelative(repoRoot, traceAbs) } : null;
  const consoleArtifact = (await fileExists(consoleAbs))
    ? { path: repoRelative(repoRoot, consoleAbs) }
    : null;
  const network = (await fileExists(networkAbs))
    ? { path: repoRelative(repoRoot, networkAbs) }
    : null;

  // The capture script (M5 glue) records assertion outcomes; absent that, treat
  // the run as blocked rather than fabricating a pass.
  const outcomeAbs = join(runDir, 'outcome.json');
  if (!(await fileExists(outcomeAbs))) {
    return {
      journey: blockedJourney(
        spec,
        'Playwright present but no capture outcome was produced; treating as blocked rather than asserting an unobserved pass',
      ),
      run_id: runId,
      probe,
    };
  }

  let outcome: {
    result: E2EJourney['result'];
    satisfied: boolean[];
    checkable?: boolean[];
    reproduction?: string;
  };
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
    // A free-text NL assertion the runner could not mechanically evaluate is
    // checkable=false → it lands the journey on `unverified`, not a fabricated fail.
    checkable: outcome.checkable?.[i] ?? true,
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
