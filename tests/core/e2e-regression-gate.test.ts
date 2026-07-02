import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserProbe } from '~/core/e2e/browser';
import { regressionGatePath, runRegressionGate } from '~/core/e2e/regression-gate';

/**
 * wi_260610p9h ac-7 — 회귀 게이트 실행·기록. 추려진(또는 사용자 조정) 여정의
 * generated spec을 verifyGenerated로 실행하고 결과를
 * `.ditto/local/work-items/<wi>/regression-gate.json`에 남긴다. 회피 불가 보장:
 * selected 목록과 per-journey 결과가 기록에 남아 "목록에 있었는데 실행 안
 * 됨/실패"가 기계 판독 가능하다. blocked는 절대 pass로 기록되지 않는다.
 */

let repoRoot: string;
const available = async (): Promise<BrowserProbe> => ({ available: true, reason: 'cached' });
const unavailable = async (): Promise<BrowserProbe> => ({
  available: false,
  reason: 'Playwright/Chromium not available; not auto-installing',
});

beforeEach(async () => {
  // realpath: macOS tmpdir symlink — reporter rootDir vs repoRoot must agree.
  repoRoot = await realpath(await mkdtemp(join(tmpdir(), 'ditto-reggate-')));
  await mkdir(join(repoRoot, 'e2e', 'journeys'), { recursive: true });
  await mkdir(join(repoRoot, 'e2e', 'generated'), { recursive: true });
});
afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

function journeyDoc(id: string, name: string, surfaces: string[]): string {
  return [
    '---',
    'ditto_journey: v2',
    `id: ${id}`,
    `name: ${name}`,
    `description: ${name} 보호`,
    'surfaces:',
    ...surfaces.map((s) => `  - "${s}"`),
    `implementation_intent: ${name} 흐름을 검증한다`,
    '---',
    '',
    '1. [s1] 무언가 한다',
    '',
  ].join('\n');
}

async function seedJourney(slug: string, id: string, name: string, surfaces: string[]) {
  await Bun.write(
    join(repoRoot, 'e2e', 'journeys', `${slug}.journey.md`),
    journeyDoc(id, name, surfaces),
  );
  await Bun.write(
    join(repoRoot, 'e2e', 'generated', `${slug}.spec.ts`),
    `// @ditto-generated\ntest("${id} · 기본", () => {});\n`,
  );
}

async function readPersisted(wi: string) {
  return JSON.parse(await readFile(regressionGatePath(repoRoot, wi), 'utf8'));
}

describe('runRegressionGate (ac-7 실행·기록)', () => {
  test('추려진 spec 통과 → result=pass, per-journey pass 기록', async () => {
    await seedJourney('login', 'jrn-login', '로그인 여정', ['component:src/auth/**']);
    const invoked: string[][] = [];
    const { record } = await runRegressionGate(
      repoRoot,
      { workItemId: 'wi_r1', runId: 'rg-01', changedPaths: ['src/auth/x.ts'] },
      {
        probe: available,
        runner: async (_root, files) => {
          invoked.push([...files]);
          return { exit_code: 0, output: '1 passed\n' };
        },
      },
    );
    expect(record.result).toBe('pass');
    expect(invoked).toEqual([['e2e/generated/login.spec.ts']]);
    expect(record.selected).toHaveLength(1);
    expect(record.selected[0]?.name).toBe('로그인 여정');
    expect(record.journey_results).toEqual([{ journey_id: 'jrn-login', result: 'pass' }]);
    const persisted = await readPersisted('wi_r1');
    expect(persisted.result).toBe('pass');
    expect(persisted.run_id).toBe('rg-01');
  });

  test('실패 주입 → result=fail + failures에 journey·case 명시 (회피 불가)', async () => {
    await seedJourney('login', 'jrn-login', '로그인 여정', ['component:src/auth/**']);
    const { record } = await runRegressionGate(
      repoRoot,
      { workItemId: 'wi_r2', runId: 'rg-02', changedPaths: ['src/auth/x.ts'] },
      {
        probe: available,
        runner: async (_root, _files, jsonReportPath) => {
          if (jsonReportPath !== undefined) {
            await Bun.write(
              jsonReportPath,
              JSON.stringify({
                config: { rootDir: join(repoRoot, 'e2e', 'generated') },
                suites: [
                  {
                    title: 'login.spec.ts',
                    file: 'login.spec.ts',
                    specs: [
                      {
                        title: 'jrn-login · 기본',
                        file: 'login.spec.ts',
                        tests: [{ results: [{ status: 'failed', error: { message: 'boom' } }] }],
                      },
                    ],
                  },
                ],
              }),
            );
          }
          return { exit_code: 1, output: '1 failed\n' };
        },
      },
    );
    expect(record.result).toBe('fail');
    expect(record.failures).toEqual([{ journey_id: 'jrn-login', case: '기본' }]);
    expect(record.journey_results).toEqual([{ journey_id: 'jrn-login', result: 'fail' }]);
    const persisted = await readPersisted('wi_r2');
    expect(persisted.result).toBe('fail');
    expect(persisted.failures).toHaveLength(1);
  });

  test('제목 규약이 깨진 실패도 spec 파일 경로로 journey에 매핑된다 (O-7)', async () => {
    await seedJourney('login', 'jrn-login', '로그인 여정', ['component:src/auth/**']);
    await seedJourney('pay', 'jrn-pay', '결제 여정', ['component:src/auth/**']);
    const { record } = await runRegressionGate(
      repoRoot,
      { workItemId: 'wi_r8', runId: 'rg-09', changedPaths: ['src/auth/x.ts'] },
      {
        probe: available,
        runner: async (_root, _files, jsonReportPath) => {
          if (jsonReportPath !== undefined) {
            await Bun.write(
              jsonReportPath,
              JSON.stringify({
                config: { rootDir: join(repoRoot, 'e2e', 'generated') },
                suites: [
                  {
                    title: 'login.spec.ts',
                    file: 'login.spec.ts',
                    specs: [
                      {
                        // 규약(<journey-id> · <case>) 위반 제목 — 파일 기준 매핑이 받쳐야 한다
                        title: 'free-form title',
                        file: 'login.spec.ts',
                        tests: [{ results: [{ status: 'failed', error: { message: 'boom' } }] }],
                      },
                    ],
                  },
                ],
              }),
            );
          }
          return { exit_code: 1, output: '1 failed\n' };
        },
      },
    );
    expect(record.result).toBe('fail');
    expect(record.failures).toEqual([{ journey_id: 'jrn-login', case: 'free-form title' }]);
    // 파일 매핑 덕에 실패는 jrn-login에 국소화되고, jrn-pay는 정당하게 pass.
    expect(record.journey_results).toContainEqual({ journey_id: 'jrn-login', result: 'fail' });
    expect(record.journey_results).toContainEqual({ journey_id: 'jrn-pay', result: 'pass' });
  });

  test('어느 여정에도 매핑 못 한 실패가 있으면 모든 실행 여정이 보수적 fail (O-7)', async () => {
    await seedJourney('login', 'jrn-login', '로그인 여정', ['component:src/auth/**']);
    await seedJourney('pay', 'jrn-pay', '결제 여정', ['component:src/auth/**']);
    const { record } = await runRegressionGate(
      repoRoot,
      { workItemId: 'wi_r9', runId: 'rg-10', changedPaths: ['src/auth/x.ts'] },
      {
        probe: available,
        runner: async (_root, _files, jsonReportPath) => {
          if (jsonReportPath !== undefined) {
            await Bun.write(
              jsonReportPath,
              JSON.stringify({
                config: { rootDir: join(repoRoot, 'e2e', 'generated') },
                suites: [
                  {
                    title: 'mystery.spec.ts',
                    file: 'mystery.spec.ts', // 추려진 어떤 spec과도 다름
                    specs: [
                      {
                        title: 'free-form title',
                        file: 'mystery.spec.ts',
                        tests: [{ results: [{ status: 'failed', error: { message: 'boom' } }] }],
                      },
                    ],
                  },
                ],
              }),
            );
          }
          return { exit_code: 1, output: '1 failed\n' };
        },
      },
    );
    expect(record.result).toBe('fail');
    // 실패를 국소화할 수 없으면 어떤 여정도 pass로 기록될 수 없다 (pass 증명 불가).
    expect(record.journey_results).toContainEqual({ journey_id: 'jrn-login', result: 'fail' });
    expect(record.journey_results).toContainEqual({ journey_id: 'jrn-pay', result: 'fail' });
  });

  test('blocked(브라우저 부재) → result=blocked, 절대 pass 아님, runner 미호출', async () => {
    await seedJourney('login', 'jrn-login', '로그인 여정', ['component:src/auth/**']);
    let calls = 0;
    const { record } = await runRegressionGate(
      repoRoot,
      { workItemId: 'wi_r3', runId: 'rg-03', changedPaths: ['src/auth/x.ts'] },
      {
        probe: unavailable,
        runner: async () => {
          calls += 1;
          return { exit_code: 0, output: '' };
        },
      },
    );
    expect(record.result).toBe('blocked');
    expect(calls).toBe(0);
    expect(record.journey_results).toEqual([{ journey_id: 'jrn-login', result: 'blocked' }]);
    const persisted = await readPersisted('wi_r3');
    expect(persisted.result).toBe('blocked');
  });

  test('generated spec 부재 여정 → not_run, 실행분이 통과해도 게이트는 fail', async () => {
    await seedJourney('login', 'jrn-login', '로그인 여정', ['component:src/**']);
    await Bun.write(
      join(repoRoot, 'e2e', 'journeys', 'orphan.journey.md'),
      journeyDoc('jrn-orphan', '고아 여정', ['component:src/**']),
    );
    const { record } = await runRegressionGate(
      repoRoot,
      { workItemId: 'wi_r4', runId: 'rg-04', changedPaths: ['src/x.ts'] },
      { probe: available, runner: async () => ({ exit_code: 0, output: '1 passed\n' }) },
    );
    expect(record.result).toBe('fail');
    expect(record.journey_results).toContainEqual({ journey_id: 'jrn-orphan', result: 'not_run' });
    expect(record.journey_results).toContainEqual({ journey_id: 'jrn-login', result: 'pass' });
  });

  test('영향 여정 없음 → result=pass (전체 실행 강제 아님)', async () => {
    await seedJourney('login', 'jrn-login', '로그인 여정', ['component:src/auth/**']);
    let calls = 0;
    const { record } = await runRegressionGate(
      repoRoot,
      { workItemId: 'wi_r5', runId: 'rg-05', changedPaths: ['docs/readme.md'] },
      {
        probe: available,
        runner: async () => {
          calls += 1;
          return { exit_code: 0, output: '' };
        },
      },
    );
    expect(record.result).toBe('pass');
    expect(record.selected).toHaveLength(0);
    expect(calls).toBe(0);
  });

  test('파싱 불가 journey → record에 invalid_journeys 영속 + 게이트 non-pass(fail)', async () => {
    await seedJourney('login', 'jrn-login', '로그인 여정', ['component:src/auth/**']);
    await Bun.write(join(repoRoot, 'e2e', 'journeys', 'broken.journey.md'), 'no front matter\n');
    const { record } = await runRegressionGate(
      repoRoot,
      { workItemId: 'wi_r7', runId: 'rg-08', changedPaths: ['src/auth/x.ts'] },
      { probe: available, runner: async () => ({ exit_code: 0, output: '1 passed\n' }) },
    );
    expect(record.invalid_journeys).toHaveLength(1);
    expect(record.invalid_journeys[0]?.file).toBe('e2e/journeys/broken.journey.md');
    // 실행분이 전부 통과해도 파싱 불가 여정이 있으면 pass로 닫히지 않는다
    expect(record.result).toBe('fail');
    const persisted = await readPersisted('wi_r7');
    expect(persisted.invalid_journeys).toHaveLength(1);
    expect(persisted.result).toBe('fail');
  });

  test('--journeys 조정 목록은 자동 추림을 대체하고, 미지의 id는 거부', async () => {
    await seedJourney('login', 'jrn-login', '로그인 여정', ['component:src/auth/**']);
    await seedJourney('billing', 'jrn-billing', '결제 여정', ['component:src/billing/**']);
    const { record } = await runRegressionGate(
      repoRoot,
      {
        workItemId: 'wi_r6',
        runId: 'rg-06',
        changedPaths: ['src/auth/x.ts'],
        journeyIds: ['jrn-billing'],
      },
      { probe: available, runner: async () => ({ exit_code: 0, output: '1 passed\n' }) },
    );
    expect(record.selected.map((s) => s.id)).toEqual(['jrn-billing']);
    expect(record.selected[0]?.matched_surfaces).toEqual([]);
    // 자동 추림 결과가 auto_selected로 병기되어 사용자 조정과의 차이가 기계 판독 가능하다
    expect(record.auto_selected).toEqual(['jrn-login']);

    expect(
      runRegressionGate(
        repoRoot,
        { workItemId: 'wi_r6', runId: 'rg-07', changedPaths: [], journeyIds: ['jrn-nope'] },
        { probe: available, runner: async () => ({ exit_code: 0, output: '' }) },
      ),
    ).rejects.toThrow('jrn-nope');
  });
});
