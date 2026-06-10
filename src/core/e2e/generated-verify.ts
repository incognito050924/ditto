import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { localDir } from '../ditto-paths';
import { atomicWriteText } from '../fs';
import { spawnProviderProcess } from '../hosts/spawn';
import { type BrowserGuardOptions, withBrowserGuard } from './authoring-guard';

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
    const pass = outcome.value.exit_code === 0;
    record = {
      run_id: runId,
      files,
      result: pass ? 'pass' : 'fail',
      reason: `npx playwright test exited ${outcome.value.exit_code ?? 'null'}`,
      exit_code: outcome.value.exit_code,
      output_tail: outputTail(outcome.value.output),
      verified_at,
    };
  }
  await atomicWriteText(
    join(runDir, 'generated-verify.json'),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  return record;
}
