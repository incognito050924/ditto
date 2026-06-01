// @ts-nocheck
/**
 * E2E capture runner (M5 glue). Runs under **node** (not bun): bun's pipe transport
 * cannot drive Playwright's CDP launcher, but node + the cached `playwright-core`
 * module driving an ALREADY-CACHED Chromium executable works. This script is NOT a
 * library import — `runJourney` (../browser.ts) spawns it through the host
 * `spawnProviderProcess` primitive, exactly like the dialectic Codex thin layer.
 *
 * It never downloads a browser: it imports playwright-core from an explicit path and
 * launches a pre-existing Chromium binary via `executablePath`. Both paths are
 * resolved by the caller and passed in `argv[2]` (a JSON config file).
 *
 * Config JSON shape (written by browser.ts):
 *   { playwrightCore, executablePath, url, steps:[{action,target,expectation}],
 *     assertions:[{description}], runDir }
 *
 * Outputs into runDir: journey.png, trace.zip, console.log, network.log, outcome.json.
 * Exit 0 = capture completed (outcome.json written, with result pass|fail).
 * Non-zero = capture itself failed (no outcome.json); caller degrades to blocked.
 */
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const configPath = process.argv[2];
if (!configPath) {
  console.error('runner: missing config path argv[2]');
  process.exit(2);
}
const cfg = JSON.parse(readFileSync(configPath, 'utf8'));

const { chromium } = await import(cfg.playwrightCore);

let browser;
try {
  browser = await chromium.launch({ executablePath: cfg.executablePath, headless: true });
} catch (err) {
  console.error(`runner: launch failed: ${err?.message ?? err}`);
  process.exit(3);
}

const consoleLines = [];
const networkLines = [];
const satisfied = [];
let result = 'pass';
let reproduction = null;

try {
  const context = await browser.newContext();
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
  page.on('request', (r) => networkLines.push(`> ${r.method()} ${r.url()}`));
  page.on('response', (r) => networkLines.push(`< ${r.status()} ${r.url()}`));

  await page.goto(cfg.url, { waitUntil: 'load' });

  // Drive steps. We support a tiny, honest action vocabulary; unknown actions are
  // recorded but do not fail the run (the journey description carries intent).
  for (const step of cfg.steps ?? []) {
    if (step.action === 'click' && step.target) {
      await page.click(step.target);
    } else if (step.action === 'fill' && step.target) {
      await page.fill(step.target, step.expectation ?? '');
    }
    // other actions: no-op drive; goto already loaded the page
  }

  // Evaluate assertions. Convention: description "<selector> contains <text>" or
  // "<selector> visible"; otherwise we assert the selector (if it looks like one)
  // is present. A heading-text assertion is enough for ac-3.
  for (const a of cfg.assertions ?? []) {
    let ok = false;
    const containsMatch = a.description.match(/^(.+?) contains (.+)$/);
    const visibleMatch = a.description.match(/^(.+?) visible$/);
    try {
      if (containsMatch) {
        const text = await page.textContent(containsMatch[1].trim());
        ok = (text ?? '').includes(containsMatch[2].trim());
      } else if (visibleMatch) {
        ok = await page.isVisible(visibleMatch[1].trim());
      } else {
        // Fallback: treat the whole description as a selector to locate.
        ok = (await page.locator(a.description).count()) > 0;
      }
    } catch {
      ok = false;
    }
    satisfied.push(ok);
  }
  if (satisfied.some((s) => !s)) {
    result = 'fail';
    reproduction = `1) open ${cfg.url} 2) run the journey steps 3) one or more assertions did not hold (see console.log/network.log/trace.zip)`;
  }

  await page.screenshot({ path: join(cfg.runDir, 'journey.png') });
  await context.tracing.stop({ path: join(cfg.runDir, 'trace.zip') });
} catch (err) {
  console.error(`runner: drive failed: ${err?.message ?? err}`);
  await browser.close();
  process.exit(4);
} finally {
  await browser.close().catch(() => {});
}

await writeFile(join(cfg.runDir, 'console.log'), `${consoleLines.join('\n')}\n`);
await writeFile(join(cfg.runDir, 'network.log'), `${networkLines.join('\n')}\n`);
await writeFile(
  join(cfg.runDir, 'outcome.json'),
  JSON.stringify({ result, satisfied, ...(reproduction ? { reproduction } : {}) }),
);
console.error(`runner: outcome result=${result} assertions=${satisfied.length}`);
process.exit(0);
