import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { localDir } from '../ditto-paths';
import { atomicWriteText } from '../fs';
import { spawnProviderProcess } from '../hosts/spawn';
import { type BrowserGuardOptions, withBrowserGuard } from './authoring-guard';
import { isFallbackUnverified } from './generator-fallback';

/**
 * Pre-commit verification of generated specs (wi_260610p9h ac-2, ac-9 wiring).
 *
 * Runs the target repo's STANDARD Playwright runner (`npx playwright test
 * <files>` — no runner reinvention) once over the generated spec files and
 * records the observed pass/fail under
 * `.ditto/local/runs/<runId>/generated-verify.json`. The run goes through
 * `withBrowserGuard`: when Playwright/Chromium is absent the runner is never
 * invoked (no install attempt) and a `blocked` record is persisted instead.
 */

export interface PlaywrightRunOutcome {
  exit_code: number | null;
  output: string;
}

export type PlaywrightRunner = (
  repoRoot: string,
  files: string[],
  /** When set, the JSON reporter output is preserved here (failure-report input). */
  jsonReportPath?: string,
) => Promise<PlaywrightRunOutcome>;

/** Default runner: the target repo's standard `npx playwright test <files>`. */
export async function runPlaywrightTests(
  repoRoot: string,
  files: string[],
  jsonReportPath?: string,
): Promise<PlaywrightRunOutcome> {
  const proc = spawnProviderProcess({
    binary: 'npx',
    args: [
      'playwright',
      'test',
      ...files,
      // Keep the human `line` reporter AND persist machine-readable JSON for
      // `ditto e2e failure-report` (DSL-vocabulary failure mapping, ac-11).
      ...(jsonReportPath !== undefined ? ['--reporter=line,json'] : []),
    ],
    repoRoot,
    cwd: '.',
    env: {
      set: jsonReportPath !== undefined ? { PLAYWRIGHT_JSON_OUTPUT_NAME: jsonReportPath } : {},
      unset: [],
    },
  });
  const [stdoutText, stderrText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const completion = await proc.completion;
  return { exit_code: completion.exit_code, output: `${stdoutText}${stderrText}` };
}

export interface GeneratedVerifyRecord {
  run_id: string;
  /** Repo-relative spec paths that were (or would have been) executed. */
  files: string[];
  result: 'pass' | 'fail' | 'blocked';
  reason: string;
  exit_code: number | null;
  /** Last lines of the runner output — the human-readable run summary. */
  output_tail: string[];
  verified_at: string;
}

export interface VerifyGeneratedOptions extends BrowserGuardOptions {
  /** Injectable runner (tests); defaults to `npx playwright test <files>`. */
  runner?: PlaywrightRunner;
}

const OUTPUT_TAIL_LINES = 40;

function outputTail(output: string): string[] {
  const lines = output.split('\n').filter((l) => l.trim() !== '');
  return lines.slice(-OUTPUT_TAIL_LINES);
}

/**
 * Tests the runner exited 0 report as PASS. Playwright's line reporter prints a
 * `N passed` summary only when at least one test actually ran to a pass; an
 * all-skipped run (e.g. every case is `test.fixme`) prints `N skipped` with no
 * `passed` line. Parsing the passed count is how we tell "verified" from "the
 * runner exited clean but exercised nothing".
 */
function passedCount(output: string): number {
  const m = output.match(/(\d+)\s+passed/);
  return m ? Number(m[1]) : 0;
}

/**
 * A spec branded `@ditto-unverified fallback:e2e-scripter` is a degraded
 * scaffold produced without a live browser — inherently unverified. Reading the
 * files is best-effort: an unreadable path (never authored / mocked in tests)
 * cannot be branded a fallback, so it falls through to the count-based check.
 */
async function anyFallbackUnverified(repoRoot: string, files: string[]): Promise<boolean> {
  for (const file of files) {
    try {
      if (isFallbackUnverified(await readFile(join(repoRoot, file), 'utf8'))) return true;
    } catch {
      // Unreadable spec — not brandable as a fallback; leave the decision to counts.
    }
  }
  return false;
}

export async function verifyGenerated(
  repoRoot: string,
  runId: string,
  files: string[],
  options: VerifyGeneratedOptions = {},
): Promise<GeneratedVerifyRecord> {
  const runner = options.runner ?? runPlaywrightTests;
  const runDir = localDir(repoRoot, 'runs', runId);
  await mkdir(runDir, { recursive: true });
  const outcome = await withBrowserGuard(
    repoRoot,
    () => runner(repoRoot, files, join(runDir, 'playwright-report.json')),
    options.probe ? { probe: options.probe } : {},
  );
  const verified_at = new Date().toISOString();
  let record: GeneratedVerifyRecord;
  if (outcome.result === 'blocked') {
    record = {
      run_id: runId,
      files,
      result: 'blocked',
      reason: outcome.reason,
      exit_code: null,
      output_tail: [],
      verified_at,
    };
  } else {
    const exitCode = outcome.value.exit_code;
    const output = outcome.value.output;
    // Gate-honesty (ac-5/ac-8): exit 0 alone is not a pass. A degraded
    // @ditto-unverified fallback (never live-run) and an all-skipped run
    // (0 tests exercised — e.g. every case is `test.fixme`) both exit 0 yet
    // verify no behavior; recording 'pass' would let a completion gate mistake
    // them for a real pass. Both map to 'blocked' (the schema's "did not run").
    let result: GeneratedVerifyRecord['result'];
    let reason: string;
    if (exitCode !== 0) {
      result = 'fail';
      reason = `npx playwright test exited ${exitCode ?? 'null'}`;
    } else if (await anyFallbackUnverified(repoRoot, files)) {
      result = 'blocked';
      reason =
        'spec is an @ditto-unverified fallback (scaffolded without a live browser) — inherently unverified, not a pass';
    } else if (passedCount(output) === 0) {
      result = 'blocked';
      reason = `runner exited 0 but all tests skipped — no behavior verified (${outputTail(output).slice(-1)[0] ?? 'no summary'})`;
    } else {
      result = 'pass';
      reason = `npx playwright test exited ${exitCode ?? 'null'}`;
    }
    record = {
      run_id: runId,
      files,
      result,
      reason,
      exit_code: exitCode,
      output_tail: outputTail(output),
      verified_at,
    };
  }
  await atomicWriteText(
    join(runDir, 'generated-verify.json'),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return record;
}
