import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * wi_260610p9h CLI 표면:
 * - `ditto e2e regression` — 영향 추림 → 실행 → regression-gate.json 기록 (ac-7).
 *   실행 경로(pass/fail/blocked)는 core 테스트(e2e-regression-gate.test.ts)가
 *   runner/probe 주입으로 검증한다 — 여기서는 usage + 결정론 경로(빈 선택,
 *   missing_generated → fail)만 본다 (기존 verify-generated CLI 테스트 패턴).
 * - `ditto e2e lifecycle` — 사용자 확인 게이트 + 파생물 가드 (ac-8).
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
  dir = await realpath(await mkdtemp(join(tmpdir(), 'ditto-reglc-cli-')));
  await mkdir(join(dir, 'e2e', 'journeys'), { recursive: true });
  await mkdir(join(dir, 'e2e', 'generated', 'support'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
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

const GENERATED =
  '/**\n * @ditto-generated\n * @ditto-source e2e/journeys/login.journey.md\n * @ditto-journey jrn-login\n */\n';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('ditto e2e regression CLI (ac-7)', () => {
  test('--changed-files 비면 usage error', () => {
    const res = run(['e2e', 'regression', '--work-item', 'wi_x', '--changed-files', ' , ']);
    expect(res.exitCode).toBe(65);
    expect(res.stderr).toContain('--changed-files');
  });

  test('영향 여정 없음 → exit 0, 기록 result=pass', async () => {
    await Bun.write(
      join(dir, 'e2e', 'journeys', 'login.journey.md'),
      journeyDoc('jrn-login', '로그인 여정', ['component:src/auth/**']),
    );
    const res = run([
      'e2e',
      'regression',
      '--work-item',
      'wi_x',
      '--changed-files',
      'docs/readme.md',
    ]);
    expect(res.exitCode).toBe(0);
    const record = JSON.parse(
      await readFile(
        join(dir, '.ditto', 'local', 'work-items', 'wi_x', 'regression-gate.json'),
        'utf8',
      ),
    );
    expect(record.result).toBe('pass');
    expect(record.selected).toHaveLength(0);
  });

  test('추려진 여정의 generated spec 부재 → exit 비-0, 기록에 not_run (회피 불가)', async () => {
    await Bun.write(
      join(dir, 'e2e', 'journeys', 'login.journey.md'),
      journeyDoc('jrn-login', '로그인 여정', ['component:src/auth/**']),
    );
    const res = run([
      'e2e',
      'regression',
      '--work-item',
      'wi_x',
      '--changed-files',
      'src/auth/session.ts',
    ]);
    expect(res.exitCode).not.toBe(0);
    // 추림 목록은 name·description으로 사용자에게 제시된다
    expect(res.stdout).toContain('로그인 여정');
    expect(res.stdout).toContain('로그인 여정 보호');
    const record = JSON.parse(
      await readFile(
        join(dir, '.ditto', 'local', 'work-items', 'wi_x', 'regression-gate.json'),
        'utf8',
      ),
    );
    expect(record.result).toBe('fail');
    expect(record.journey_results).toEqual([{ journey_id: 'jrn-login', result: 'not_run' }]);
  });

  test('--journeys 빈 값은 자동 추림을 빈 목록으로 치환하지 못한다 → usage error', async () => {
    await Bun.write(
      join(dir, 'e2e', 'journeys', 'login.journey.md'),
      journeyDoc('jrn-login', '로그인 여정', ['component:src/auth/**']),
    );
    const res = run([
      'e2e',
      'regression',
      '--work-item',
      'wi_x',
      '--changed-files',
      'src/auth/session.ts',
      '--journeys',
      ' , ',
    ]);
    expect(res.exitCode).toBe(65);
    expect(res.stderr).toContain('--journeys');
    // 기록도 남지 않는다 — pass 둔갑 경로 차단
    expect(
      await exists(join(dir, '.ditto', 'local', 'work-items', 'wi_x', 'regression-gate.json')),
    ).toBe(false);
  });

  test('--journeys 미지의 id → 실패', () => {
    const res = run([
      'e2e',
      'regression',
      '--work-item',
      'wi_x',
      '--changed-files',
      'src/x.ts',
      '--journeys',
      'jrn-ghost',
    ]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('jrn-ghost');
  });
});

describe('ditto e2e lifecycle CLI (ac-8)', () => {
  test('--confirmed-by-user 없으면 usage error로 거부', () => {
    const res = run([
      'e2e',
      'lifecycle',
      '--action',
      'delete',
      '--journey-file',
      'e2e/journeys/login.journey.md',
    ]);
    expect(res.exitCode).toBe(65);
    expect(res.stderr).toContain('--confirmed-by-user');
  });

  test('잘못된 --action → usage error', () => {
    const res = run([
      'e2e',
      'lifecycle',
      '--action',
      'destroy',
      '--journey-file',
      'x.journey.md',
      '--confirmed-by-user',
    ]);
    expect(res.exitCode).toBe(65);
  });

  test('수동 spec → 거부, exit 비-0', async () => {
    await Bun.write(
      join(dir, 'e2e', 'journeys', 'login.journey.md'),
      journeyDoc('jrn-login', '로그인 여정', ['page:/login']),
    );
    await Bun.write(join(dir, 'e2e', 'generated', 'login.spec.ts'), '// human spec\n');
    const res = run([
      'e2e',
      'lifecycle',
      '--action',
      'delete',
      '--journey-file',
      'e2e/journeys/login.journey.md',
      '--confirmed-by-user',
    ]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('수동');
    expect(await exists(join(dir, 'e2e', 'generated', 'login.spec.ts'))).toBe(true);
  });

  test('정상 삭제 → exit 0, 파일 삭제, 결정 기록', async () => {
    await Bun.write(
      join(dir, 'e2e', 'journeys', 'login.journey.md'),
      journeyDoc('jrn-login', '로그인 여정', ['page:/login']),
    );
    await Bun.write(join(dir, 'e2e', 'generated', 'login.spec.ts'), GENERATED);
    const res = run([
      'e2e',
      'lifecycle',
      '--action',
      'delete',
      '--journey-file',
      'e2e/journeys/login.journey.md',
      '--confirmed-by-user',
      '--reason',
      '흐름 제거됨',
      '--work-item',
      'wi_x',
    ]);
    expect(res.exitCode).toBe(0);
    expect(await exists(join(dir, 'e2e', 'journeys', 'login.journey.md'))).toBe(false);
    expect(await exists(join(dir, 'e2e', 'generated', 'login.spec.ts'))).toBe(false);
    const ledger = await readFile(
      join(dir, '.ditto', 'local', 'work-items', 'wi_x', 'e2e-lifecycle.jsonl'),
      'utf8',
    );
    expect(JSON.parse(ledger.trim()).action).toBe('delete');
  });
});
