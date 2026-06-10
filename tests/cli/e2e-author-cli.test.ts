import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderGeneratedHeader, sha256Hex } from '~/core/e2e/journey-digest';

/**
 * CLI surface for the authoring pipeline gates (wi_260610p9h):
 * - `ditto e2e conformance` — ac-3 step↔marker traceability + digest freshness.
 * - `ditto e2e verify-generated` — ac-2 usage validation (the run path itself
 *   is covered by core tests with injected probe/runner spies).
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

const JOURNEY = `---
ditto_journey: v1
id: jrn-login-basic
name: 기본 로그인
description: 등록 사용자가 로그인할 수 있다.
surfaces:
  - page:/login
uses_blocks:
  - blk-login
flaky_history: []
---

1. [s1] 블록: blk-login (user=user@example.com, password=secret123)
2. [s2] 확인: url contains /dashboard
`;

const BLOCK = `---
ditto_block: v1
id: blk-login
name: 로그인
params:
  - user
  - password
---

1. [b1] 방문: /login
2. [b2] 클릭: "로그인" 버튼
`;

function generatedSpec(journeySource: string): string {
  const header = renderGeneratedHeader({
    sourcePath: 'e2e/journeys/login-basic.journey.md',
    digest: sha256Hex(journeySource),
    kind: 'journey',
    id: 'jrn-login-basic',
  });
  return `${header}
import { test, expect } from '@playwright/test';
import { blkLogin } from './support/blk-login.block';

test('jrn-login-basic', async ({ page }) => {
  // @step jrn-login-basic/s1 블록: blk-login (user=user@example.com, password=secret123)
  await blkLogin(page, { user: 'user@example.com', password: 'secret123' });
  // @step jrn-login-basic/s2 확인: url contains /dashboard
  await expect(page).toHaveURL(/\\/dashboard/);
});
`;
}

function supportHelper(blockSource: string): string {
  const header = renderGeneratedHeader({
    sourcePath: 'e2e/journeys/blocks/blk-login.block.md',
    digest: sha256Hex(blockSource),
    kind: 'block',
    id: 'blk-login',
  });
  return `${header}
export async function blkLogin(page, params) {
  // @step blk-login/b1 방문: /login
  await page.goto('/login');
  // @step blk-login/b2 클릭: "로그인" 버튼
  await page.getByRole('button', { name: '로그인' }).click();
}
`;
}

async function writeFixture(opts: { generated?: string; support?: string } = {}) {
  await mkdir(join(dir, 'e2e', 'journeys', 'blocks'), { recursive: true });
  await mkdir(join(dir, 'e2e', 'generated', 'support'), { recursive: true });
  await writeFile(join(dir, 'e2e', 'journeys', 'login-basic.journey.md'), JOURNEY);
  await writeFile(join(dir, 'e2e', 'journeys', 'blocks', 'blk-login.block.md'), BLOCK);
  await writeFile(
    join(dir, 'e2e', 'generated', 'login-basic.spec.ts'),
    opts.generated ?? generatedSpec(JOURNEY),
  );
  await writeFile(
    join(dir, 'e2e', 'generated', 'support', 'blk-login.block.ts'),
    opts.support ?? supportHelper(BLOCK),
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-e2e-author-cli-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto e2e conformance CLI (ac-3)', () => {
  test('fresh generated spec with full marker coverage → exit 0', async () => {
    await writeFixture();
    const res = run([
      'e2e',
      'conformance',
      '--journey',
      'e2e/journeys/login-basic.journey.md',
      '--generated',
      'e2e/generated/login-basic.spec.ts',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.ok).toBe(true);
    expect(payload.missing).toEqual([]);
  });

  test('missing step marker → non-zero exit, missing id listed', async () => {
    const broken = generatedSpec(JOURNEY).replace(
      '  // @step jrn-login-basic/s2 확인: url contains /dashboard\n',
      '',
    );
    await writeFixture({ generated: broken });
    const res = run([
      'e2e',
      'conformance',
      '--journey',
      'e2e/journeys/login-basic.journey.md',
      '--generated',
      'e2e/generated/login-basic.spec.ts',
    ]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stdout + res.stderr).toContain('jrn-login-basic/s2');
  });

  test('stale-only failure (markers complete, digest mismatch) → JSON ok=false', async () => {
    // Markers fully cover the DSL (report.ok=true) but the header digest was
    // computed over different bytes → only `stale` fails. The aggregate ok in
    // the JSON output must be false — `...report` must not clobber it back.
    await writeFixture({ generated: generatedSpec(`${JOURNEY} `) });
    const res = run([
      'e2e',
      'conformance',
      '--journey',
      'e2e/journeys/login-basic.journey.md',
      '--generated',
      'e2e/generated/login-basic.spec.ts',
      '--output',
      'json',
    ]);
    expect(res.exitCode).not.toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.missing).toEqual([]);
    expect(payload.stale.length).toBeGreaterThan(0);
    expect(payload.ok).toBe(false);
  });

  test('DSL edited after generation (digest mismatch) → stale, non-zero exit', async () => {
    await writeFixture();
    // Edit the journey AFTER the spec was generated: header digest no longer matches.
    await writeFile(
      join(dir, 'e2e', 'journeys', 'login-basic.journey.md'),
      `${JOURNEY}3. [s3] 확인: "환영" visible\n`,
    );
    const res = run([
      'e2e',
      'conformance',
      '--journey',
      'e2e/journeys/login-basic.journey.md',
      '--generated',
      'e2e/generated/login-basic.spec.ts',
    ]);
    expect(res.exitCode).not.toBe(0);
    expect((res.stdout + res.stderr).toLowerCase()).toContain('stale');
  });
});

describe('ditto e2e verify-generated CLI (ac-2 usage surface)', () => {
  test('missing --files → usage error 65', async () => {
    const res = run(['e2e', 'verify-generated', '--runId', 'r-gv-cli-01']);
    expect(res.exitCode).toBe(65);
  });

  test('empty --files value → usage error 65', async () => {
    const res = run(['e2e', 'verify-generated', '--runId', 'r-gv-cli-02', '--files', ' , ']);
    expect(res.exitCode).toBe(65);
    expect(res.stderr).toContain('--files');
  });
});
