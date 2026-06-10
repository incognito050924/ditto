import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { featureFixAllowed } from '~/core/e2e/failure-verdict';
import { parseJourneyDoc } from '~/core/e2e/journey-dsl';

/**
 * wi_260610p9h CLI surface for the failure flow:
 * - `ditto e2e failure-report --runId <id>` — DSL-vocabulary failure report +
 *   replay commands (ac-11), fed by the persisted playwright-report.json.
 * - `ditto e2e failure-verdict …` — appends the USER verdict to
 *   e2e-verdicts.jsonl (ac-12); flaky verdicts also land in the journey
 *   front-matter flaky_history without touching the body.
 */

const cli = join(process.cwd(), 'src/cli/index.ts');
let dir: string;

function run(args: string[]) {
  const proc = Bun.spawnSync(['bun', cli, ...args], { cwd: dir, env: { ...process.env } });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

beforeEach(async () => {
  // realpath: macOS tmpdir is a symlink (/var → /private/var); reporter rootDir
  // and the CLI-resolved repo root must agree for repo-relative spec paths.
  dir = await realpath(await mkdtemp(join(tmpdir(), 'ditto-e2e-failure-cli-')));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SPEC_TEXT = [
  'import { test, expect } from "@playwright/test";',
  '',
  'test("jrn-login · 정상 로그인", async ({ page }) => {',
  '  // @step jrn-login/s1 사용자가 /login에 간다',
  '  await page.goto("/login");',
  '  // @step jrn-login/s2 화면에 "환영합니다" 문구가 보인다',
  '  await expect(page.getByText("환영합니다")).toBeVisible();',
  '});',
].join('\n');

const JOURNEY = `---
ditto_journey: v1
id: jrn-login
name: 로그인 여정
description: 로그인 흐름 보호
surfaces:
  - "page:/login"
---

1. [s1] 사용자가 /login에 간다
2. [s2] 화면에 "환영합니다" 문구가 보인다
`;

async function seedRun(runId: string) {
  const runDir = join(dir, '.ditto', 'local', 'runs', runId);
  await mkdir(runDir, { recursive: true });
  await mkdir(join(dir, 'e2e', 'generated'), { recursive: true });
  await mkdir(join(dir, 'e2e', 'journeys'), { recursive: true });
  await Bun.write(join(dir, 'e2e', 'generated', 'login.spec.ts'), SPEC_TEXT);
  await Bun.write(join(dir, 'e2e', 'journeys', 'login.journey.md'), JOURNEY);
  const reporter = {
    config: { rootDir: join(dir, 'e2e', 'generated') },
    suites: [
      {
        title: 'login.spec.ts',
        file: 'login.spec.ts',
        specs: [
          {
            title: 'jrn-login · 정상 로그인',
            file: 'login.spec.ts',
            line: 3,
            tests: [
              {
                results: [
                  {
                    status: 'failed',
                    error: {
                      message: 'Error: toBeVisible failed\n\nExpected: visible\nReceived: hidden\n',
                      stack: `    at ${join(dir, 'e2e', 'generated', 'login.spec.ts')}:7:46`,
                    },
                    attachments: [{ name: 'trace', path: join(dir, 'tr', 'trace.zip') }],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  await Bun.write(join(runDir, 'playwright-report.json'), JSON.stringify(reporter));
  await Bun.write(
    join(runDir, 'generated-verify.json'),
    JSON.stringify({
      run_id: runId,
      files: ['e2e/generated/login.spec.ts'],
      result: 'fail',
      reason: 'npx playwright test exited 1',
      exit_code: 1,
      output_tail: [],
      verified_at: new Date().toISOString(),
    }),
  );
}

describe('ditto e2e failure-report CLI (ac-11)', () => {
  test('renders DSL-vocabulary failure + replay commands (human)', async () => {
    await seedRun('r-fr-01');
    const res = run(['e2e', 'failure-report', '--runId', 'r-fr-01']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('여정 로그인 여정의 단계 [s2] 화면에 "환영합니다" 문구가 보인다');
    expect(res.stdout).toContain('visible를 기대했지만 hidden');
    expect(res.stdout).toContain(
      'npx playwright test e2e/generated/login.spec.ts -g "jrn-login · 정상 로그인" --headed',
    );
    expect(res.stdout).toContain('npx playwright show-trace');
  });

  test('json output exposes the structured failures', async () => {
    await seedRun('r-fr-02');
    const res = run(['e2e', 'failure-report', '--runId', 'r-fr-02', '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.failures).toHaveLength(1);
    expect(payload.failures[0].journey_id).toBe('jrn-login');
    expect(payload.failures[0].step_id).toBe('s2');
    expect(payload.failures[0].replay.headed_command).toContain('--headed');
  });

  test('missing report → runtime error with guidance', async () => {
    const res = run(['e2e', 'failure-report', '--runId', 'r-none']);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('verify-generated');
  });
});

describe('ditto e2e failure-verdict CLI (ac-12)', () => {
  test('records the user verdict; 기능 opens featureFixAllowed', async () => {
    const res = run([
      'e2e',
      'failure-verdict',
      '--work-item',
      'wi_x',
      '--journey',
      'jrn-login',
      '--case',
      '정상 로그인',
      '--classification',
      '기능',
      '--basis',
      '응답에 환영 문구 누락 확인',
    ]);
    expect(res.exitCode).toBe(0);
    const raw = await readFile(
      join(dir, '.ditto', 'local', 'work-items', 'wi_x', 'e2e-verdicts.jsonl'),
      'utf8',
    );
    const line = JSON.parse(raw.trim());
    expect(line.classification).toBe('기능');
    expect(line.confirmed_by_user).toBe(true);
    const gate = await featureFixAllowed(dir, 'wi_x', 'jrn-login', '정상 로그인');
    expect(gate.allowed).toBe(true);
  });

  test('invalid classification → usage error', async () => {
    const res = run([
      'e2e',
      'failure-verdict',
      '--work-item',
      'wi_x',
      '--journey',
      'jrn-login',
      '--case',
      'c',
      '--classification',
      'unknown',
      '--basis',
      'b',
    ]);
    expect(res.exitCode).toBe(65);
  });

  test('flaky requires --journey-file', async () => {
    const res = run([
      'e2e',
      'failure-verdict',
      '--work-item',
      'wi_x',
      '--journey',
      'jrn-login',
      '--case',
      'c',
      '--classification',
      'flaky',
      '--basis',
      'b',
    ]);
    expect(res.exitCode).toBe(65);
    expect(res.stderr).toContain('--journey-file');
  });

  test('flaky verdict appends flaky_history and preserves the journey body', async () => {
    await mkdir(join(dir, 'e2e', 'journeys'), { recursive: true });
    const journeyPath = join(dir, 'e2e', 'journeys', 'login.journey.md');
    await Bun.write(journeyPath, JOURNEY);
    const res = run([
      'e2e',
      'failure-verdict',
      '--work-item',
      'wi_x',
      '--journey',
      'jrn-login',
      '--case',
      '정상 로그인',
      '--classification',
      'flaky',
      '--basis',
      '재실행 1회 통과, 타이밍 의심',
      '--journey-file',
      'e2e/journeys/login.journey.md',
    ]);
    expect(res.exitCode).toBe(0);
    const next = await readFile(journeyPath, 'utf8');
    const parsed = parseJourneyDoc(next);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.frontMatter.flaky_history).toHaveLength(1);
    expect(parsed.frontMatter.flaky_history[0]?.case).toBe('정상 로그인');
    expect(parsed.stepIds).toEqual(['s1', 's2']);
    // gate stays closed: flaky is not a feature defect
    const gate = await featureFixAllowed(dir, 'wi_x', 'jrn-login', '정상 로그인');
    expect(gate.allowed).toBe(false);
  });
});
