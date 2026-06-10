import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserProbe } from '~/core/e2e/browser';
import { verifyGenerated } from '~/core/e2e/generated-verify';

/**
 * ac-2 + ac-9 wiring: one pre-commit run of the generated specs through the
 * target repo's standard Playwright runner, recorded as pass/fail under
 * `.ditto/local/runs/<runId>/generated-verify.json`. No browser → blocked
 * record, runner never invoked, never an install attempt.
 */

let repoRoot: string;
const available = async (): Promise<BrowserProbe> => ({ available: true, reason: 'cached' });
const unavailable = async (): Promise<BrowserProbe> => ({
  available: false,
  reason: 'Playwright/Chromium not available; not auto-installing per orchestrator hard constraint',
});

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'ditto-genverify-'));
});
afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

async function readRecord(runId: string) {
  return JSON.parse(
    await readFile(
      join(repoRoot, '.ditto', 'local', 'runs', runId, 'generated-verify.json'),
      'utf8',
    ),
  );
}

describe('verifyGenerated (ac-2: one pre-commit run, recorded)', () => {
  test('runner exit 0 → result=pass, record persisted with files + exit code', async () => {
    const invoked: string[][] = [];
    const record = await verifyGenerated(repoRoot, 'r-gv-01', ['e2e/generated/login.spec.ts'], {
      probe: available,
      runner: async (_root, files) => {
        invoked.push([...files]);
        return { exit_code: 0, output: 'Running 1 test\n  1 passed (1.2s)\n' };
      },
    });
    expect(record.result).toBe('pass');
    expect(record.exit_code).toBe(0);
    expect(invoked).toEqual([['e2e/generated/login.spec.ts']]);
    const persisted = await readRecord('r-gv-01');
    expect(persisted.result).toBe('pass');
    expect(persisted.files).toEqual(['e2e/generated/login.spec.ts']);
    expect(persisted.run_id).toBe('r-gv-01');
  });

  test('runner non-zero exit → result=fail, output summary captured in the record', async () => {
    const record = await verifyGenerated(repoRoot, 'r-gv-02', ['e2e/generated/login.spec.ts'], {
      probe: available,
      runner: async () => ({ exit_code: 1, output: 'Running 1 test\n  1 failed\n    expect(x)\n' }),
    });
    expect(record.result).toBe('fail');
    expect(record.exit_code).toBe(1);
    expect(record.output_tail.join('\n')).toContain('1 failed');
    const persisted = await readRecord('r-gv-02');
    expect(persisted.result).toBe('fail');
  });

  test('runner receives the JSON-reporter output path under the run dir (failure-report input)', async () => {
    let seenPath: string | undefined;
    await verifyGenerated(repoRoot, 'r-gv-04', ['e2e/generated/login.spec.ts'], {
      probe: available,
      runner: async (_root, _files, jsonReportPath) => {
        seenPath = jsonReportPath;
        return { exit_code: 0, output: 'ok\n' };
      },
    });
    expect(seenPath).toBe(
      join(repoRoot, '.ditto', 'local', 'runs', 'r-gv-04', 'playwright-report.json'),
    );
  });

  test('no browser → result=blocked, runner NEVER invoked, record still persisted (ac-9)', async () => {
    let runnerCalls = 0;
    const record = await verifyGenerated(repoRoot, 'r-gv-03', ['e2e/generated/login.spec.ts'], {
      probe: unavailable,
      runner: async () => {
        runnerCalls += 1;
        return { exit_code: 0, output: '' };
      },
    });
    expect(record.result).toBe('blocked');
    expect(record.reason).toMatch(/not auto-installing/);
    expect(record.exit_code).toBeNull();
    expect(runnerCalls).toBe(0);
    const persisted = await readRecord('r-gv-03');
    expect(persisted.result).toBe('blocked');
  });
});
