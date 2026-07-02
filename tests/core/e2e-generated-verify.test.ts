import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserProbe } from '~/core/e2e/browser';
import { verifyGenerated } from '~/core/e2e/generated-verify';
import { FALLBACK_UNVERIFIED_MARKER } from '~/core/e2e/generator-fallback';

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

describe('verifyGenerated (ac-5/ac-8: exit 0 ≠ pass when nothing was exercised)', () => {
  test('all tests skipped (0 ran, e.g. all test.fixme) → NOT pass (blocked) with reason', async () => {
    const record = await verifyGenerated(repoRoot, 'r-gv-skip', ['e2e/generated/login.spec.ts'], {
      probe: available,
      runner: async () => ({
        exit_code: 0,
        output: 'Running 1 test using 1 worker\n\n  1 skipped\n',
      }),
    });
    expect(record.result).not.toBe('pass');
    expect(record.result).toBe('blocked');
    expect(record.reason).toMatch(/skip|no behavior verified/i);
    const persisted = await readRecord('r-gv-skip');
    expect(persisted.result).toBe('blocked');
  });

  test('spec carrying @ditto-unverified fallback marker → never pass even if runner exits 0 with a "pass"', async () => {
    const specRel = 'e2e/generated/fallback.spec.ts';
    await mkdir(join(repoRoot, 'e2e', 'generated'), { recursive: true });
    await writeFile(
      join(repoRoot, specRel),
      `// ${FALLBACK_UNVERIFIED_MARKER}\ntest.fixme('scaffold', async () => {});\n`,
    );
    const record = await verifyGenerated(repoRoot, 'r-gv-fb', [specRel], {
      probe: available,
      runner: async () => ({ exit_code: 0, output: '  1 passed (0.1s)\n' }),
    });
    expect(record.result).not.toBe('pass');
    expect(record.result).toBe('blocked');
    expect(record.reason).toMatch(/fallback|unverified/i);
    const persisted = await readRecord('r-gv-fb');
    expect(persisted.result).toBe('blocked');
  });

  test('spec with a real passing test (on disk, no marker) → pass (unchanged)', async () => {
    const specRel = 'e2e/generated/login.spec.ts';
    await mkdir(join(repoRoot, 'e2e', 'generated'), { recursive: true });
    await writeFile(
      join(repoRoot, specRel),
      "import { test, expect } from '@playwright/test';\ntest('login', async () => { expect(1).toBe(1); });\n",
    );
    const record = await verifyGenerated(repoRoot, 'r-gv-real', [specRel], {
      probe: available,
      runner: async () => ({ exit_code: 0, output: 'Running 1 test\n  1 passed (1.2s)\n' }),
    });
    expect(record.result).toBe('pass');
  });
});
