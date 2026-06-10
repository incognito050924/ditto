import { describe, expect, test } from 'bun:test';
import { buildFailureReport, renderFailureLines } from '~/core/e2e/failure-report';

/**
 * wi_260610p9h ac-11 — e2e failures are reported in DSL step vocabulary
 * ("which journey, which step, expected vs got") with replay means (headed
 * re-run command + trace viewer). Mapping keys: test title `<journey-id> ·
 * <case>` (g4 scripter contract) and the nearest preceding `// @step` marker
 * above the failing line in the generated spec.
 */

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

function reporter(overrides: { errorLine?: number; attachments?: unknown[] } = {}) {
  return {
    config: { rootDir: '/repo/e2e/generated' },
    suites: [
      {
        title: 'login.spec.ts',
        file: 'login.spec.ts',
        suites: [],
        specs: [
          {
            title: 'jrn-login · 정상 로그인',
            file: 'login.spec.ts',
            line: 3,
            tests: [
              {
                status: 'unexpected',
                results: [
                  {
                    status: 'failed',
                    error: {
                      message:
                        'Error: expect(locator).toBeVisible() failed\n\nExpected: visible\nReceived: hidden\n',
                      stack: `Error: ...\n    at /repo/e2e/generated/login.spec.ts:${overrides.errorLine ?? 7}:46`,
                    },
                    attachments: overrides.attachments ?? [
                      { name: 'trace', path: '/repo/test-results/t1/trace.zip' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

const readSpec = async (file: string) =>
  file === 'e2e/generated/login.spec.ts' ? SPEC_TEXT : null;

describe('buildFailureReport (ac-11: DSL vocabulary + replay)', () => {
  test('maps title → journey/case, failing line → preceding @step marker + DSL 원문', async () => {
    const failures = await buildFailureReport(reporter(), { repoRoot: '/repo', readSpec });
    expect(failures).toHaveLength(1);
    const f = failures[0];
    expect(f?.journey_id).toBe('jrn-login');
    expect(f?.case_name).toBe('정상 로그인');
    expect(f?.spec_file).toBe('e2e/generated/login.spec.ts');
    expect(f?.step_id).toBe('s2');
    expect(f?.step_dsl_line).toBe('화면에 "환영합니다" 문구가 보인다');
    expect(f?.expected).toBe('visible');
    expect(f?.actual).toBe('hidden');
  });

  test('replay: headed re-run command filtered to the failing test + trace viewer command', async () => {
    const failures = await buildFailureReport(reporter(), { repoRoot: '/repo', readSpec });
    const f = failures[0];
    expect(f?.replay.headed_command).toBe(
      'npx playwright test e2e/generated/login.spec.ts -g "jrn-login · 정상 로그인" --headed',
    );
    expect(f?.replay.trace_command).toBe(
      'npx playwright show-trace /repo/test-results/t1/trace.zip',
    );
  });

  test('no trace attachment → trace_command absent (renderer gives guidance instead)', async () => {
    const failures = await buildFailureReport(reporter({ attachments: [] }), {
      repoRoot: '/repo',
      readSpec,
    });
    expect(failures[0]?.replay.trace_command).toBeUndefined();
    const lines = renderFailureLines(failures[0] as never).join('\n');
    expect(lines).toContain('--trace on');
  });

  test('failure before any @step marker → no step info, message still reported', async () => {
    const failures = await buildFailureReport(reporter({ errorLine: 1 }), {
      repoRoot: '/repo',
      readSpec,
    });
    expect(failures[0]?.step_id).toBeUndefined();
    expect(failures[0]?.message).toContain('toBeVisible');
  });

  test('passing runs produce no failures', async () => {
    const rep = reporter();
    const result = rep.suites[0]?.specs[0]?.tests[0]?.results[0] as { status: string };
    result.status = 'passed';
    const failures = await buildFailureReport(rep, { repoRoot: '/repo', readSpec });
    expect(failures).toHaveLength(0);
  });
});

describe('renderFailureLines (사람용 한국어 렌더링)', () => {
  test('one sentence in DSL vocabulary: 여정/단계/DSL 원문/기대/실제 + replay lines', async () => {
    const failures = await buildFailureReport(reporter(), { repoRoot: '/repo', readSpec });
    const lines = renderFailureLines(failures[0] as never, '로그인 여정');
    expect(lines[0]).toBe(
      '여정 로그인 여정의 단계 [s2] 화면에 "환영합니다" 문구가 보인다에서 visible를 기대했지만 hidden가 나왔다',
    );
    const all = lines.join('\n');
    expect(all).toContain('--headed');
    expect(all).toContain('npx playwright show-trace');
  });
});
