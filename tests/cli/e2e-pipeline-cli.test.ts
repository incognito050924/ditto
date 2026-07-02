import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildGenerateInput } from '~/cli/commands/e2e';
import { type RunGeneratorSeams, runGenerator } from '~/core/e2e/generator';
import { computeSourceDigest } from '~/core/e2e/journey-digest';
import { parseJourneyDoc, splitFrontMatter } from '~/core/e2e/journey-dsl';
import { projectJourneyToPlan } from '~/core/e2e/plan-adapter';

/**
 * wi_2607026qs pipeline CLI surface (integration-style, spawned binary):
 * - `ditto e2e plan`       — DSL v2 → plan.md + sidecar map, secrets redacted (ac-2).
 * - `ditto e2e generate`   — probe → degrade fallback (@ditto-unverified) + map (ac-3, ADR-0018).
 * - `ditto e2e mapping`    — assertion map + hard-fail gate on unmapped (ac-6).
 * - `ditto e2e init-agents`— dual-host version gate + non-destructive scaffold (ac-9).
 *
 * The LIVE official-generator drive (usable path) needs a real browser + agents and
 * is exercised by N-demonstrate, not here — these tests cover the deterministic
 * scaffolding + routing the CLI owns. The temp dir has no browser/Playwright, so
 * `generate` deterministically takes the ADR-0018 degrade route.
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

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** A rich DSL v2 journey with a secret column, an edge case and a failure state. */
function journeyV2(): string {
  return [
    '---',
    'ditto_journey: v2',
    'id: jrn-login',
    'name: 로그인',
    'description: 로그인 흐름 검증',
    'surfaces:',
    '  - "page:/login"',
    'implementation_intent: 사용자는 이메일과 비밀번호로 로그인한다',
    'constraints:',
    '  - 세션은 30분 유지된다',
    'secret_vars:',
    '  - PASSWORD',
    'edge_cases:',
    '  - case: 빈 비밀번호',
    '    handling: 인라인 오류 메시지 표시',
    'failure_states:',
    '  - trigger: 잘못된 비밀번호',
    '    expected: 인증 실패 오류 표시',
    '---',
    '',
    '1. [s1] 이동: /login',
    '2. [s2] 입력: 비밀번호 {PASSWORD}',
    '3. [s3] 클릭: 로그인 버튼',
    '4. [s4] 확인: contains 대시보드',
    '',
    '## 케이스',
    '| 케이스 | PASSWORD |',
    '| --- | --- |',
    '| 정상 | hunter2 |',
    '',
  ].join('\n');
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'ditto-e2e-pipe-')));
  await mkdir(join(dir, 'e2e', 'journeys'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto e2e plan CLI (ac-2)', () => {
  test('projects plan.md + sidecar map; secret only as <env:VAR>', async () => {
    await Bun.write(join(dir, 'e2e', 'journeys', 'login.journey.md'), journeyV2());
    const res = run(['e2e', 'plan', '--journey', 'e2e/journeys/login.journey.md']);
    expect(res.exitCode).toBe(0);

    const plan = await readFile(join(dir, 'specs', 'login.plan.md'), 'utf8');
    // official plan shape: title + provenance + overview (intent + constraints).
    expect(plan).toContain('# 로그인 Test Plan');
    expect(plan).toContain('@ditto-plan v1');
    expect(plan).toContain('## Application Overview');
    expect(plan).toContain('사용자는 이메일과 비밀번호로 로그인한다');
    expect(plan).toContain('세션은 30분 유지된다');
    // one scenario per body + one ### per edge_case + one ### per failure_state.
    expect(plan).toContain('빈 비밀번호');
    expect(plan).toContain('인라인 오류 메시지 표시');
    expect(plan).toContain('잘못된 비밀번호');
    expect(plan).toContain('인증 실패 오류 표시');
    // redaction: the secret literal never lands, only its reference placeholder.
    expect(plan).toContain('<env:PASSWORD>');
    expect(plan).not.toContain('hunter2');

    // sidecar carries the authoritative plan-step → DSL-step join.
    const sidecar = JSON.parse(await readFile(join(dir, 'specs', 'login.plan.map.json'), 'utf8'));
    expect(JSON.stringify(sidecar)).toContain('s1');
    expect(sidecar.map).toBeDefined();
    expect(sidecar.assertions).toBeDefined();
  });

  test('honors --out and writes the matching .map.json sidecar', async () => {
    await Bun.write(join(dir, 'e2e', 'journeys', 'login.journey.md'), journeyV2());
    const res = run([
      'e2e',
      'plan',
      '--journey',
      'e2e/journeys/login.journey.md',
      '--out',
      'specs/custom.plan.md',
    ]);
    expect(res.exitCode).toBe(0);
    expect(await exists(join(dir, 'specs', 'custom.plan.md'))).toBe(true);
    expect(await exists(join(dir, 'specs', 'custom.plan.map.json'))).toBe(true);
  });

  test('a v1 (or unparseable) journey is refused as a usage error', async () => {
    await Bun.write(
      join(dir, 'e2e', 'journeys', 'old.journey.md'),
      ['---', 'ditto_journey: v1', 'id: jrn-old', 'name: 옛', '---', '', '1. [s1] 한다', ''].join(
        '\n',
      ),
    );
    const res = run(['e2e', 'plan', '--journey', 'e2e/journeys/old.journey.md']);
    expect(res.exitCode).toBe(65);
  });
});

describe('ditto e2e mapping CLI (ac-6)', () => {
  test('exact assertion → gate passes, exit 0, doc written', async () => {
    await Bun.write(join(dir, 'e2e', 'journeys', 'login.journey.md'), journeyV2());
    await mkdir(join(dir, 'e2e', 'generated'), { recursive: true });
    const spec = [
      "import { test, expect } from '@playwright/test';",
      "test('정상', async ({ page }) => {",
      '  // @step jrn-login/s4 확인: contains 대시보드',
      "  await expect(page.getByText('대시보드')).toContainText('대시보드');",
      '});',
      '',
    ].join('\n');
    await Bun.write(join(dir, 'e2e', 'generated', 'login.spec.ts'), spec);

    const res = run([
      'e2e',
      'mapping',
      '--journey',
      'e2e/journeys/login.journey.md',
      '--generated',
      'e2e/generated/login.spec.ts',
      '--work-item',
      'wi_x',
    ]);
    expect(res.exitCode).toBe(0);
    expect(await exists(join(dir, 'specs', 'login.assertion-map.md'))).toBe(true);
    const machine = JSON.parse(
      await readFile(
        join(dir, '.ditto', 'local', 'work-items', 'wi_x', 'e2e-assertion-map.json'),
        'utf8',
      ),
    );
    expect(machine.unmapped_count).toBe(0);
  });

  test('a dropped (unmapped) assertion → hard-fail gate, exit non-zero', async () => {
    await Bun.write(join(dir, 'e2e', 'journeys', 'login.journey.md'), journeyV2());
    await mkdir(join(dir, 'e2e', 'generated'), { recursive: true });
    // No @step marker / no expect for the 확인 step → unmapped.
    const spec = [
      "import { test } from '@playwright/test';",
      "test('정상', async ({ page }) => {",
      "  await page.goto('/login');",
      '});',
      '',
    ].join('\n');
    await Bun.write(join(dir, 'e2e', 'generated', 'login.spec.ts'), spec);

    const res = run([
      'e2e',
      'mapping',
      '--journey',
      'e2e/journeys/login.journey.md',
      '--generated',
      'e2e/generated/login.spec.ts',
    ]);
    expect(res.exitCode).not.toBe(0);
  });
});

describe('ditto e2e generate CLI (ac-3, ADR-0018 degrade)', () => {
  test('no browser → fallback spec (@ditto-unverified) + map doc + non-zero signal', async () => {
    await Bun.write(join(dir, 'e2e', 'journeys', 'login.journey.md'), journeyV2());
    const res = run([
      'e2e',
      'generate',
      '--journey',
      'e2e/journeys/login.journey.md',
      '--host',
      'claude',
    ]);
    // degrade is a signal, not a crash — non-zero but the artifacts are written.
    expect(res.exitCode).not.toBe(0);
    const spec = await readFile(join(dir, 'e2e', 'generated', 'login.spec.ts'), 'utf8');
    expect(spec).toContain('@ditto-unverified');
    // the embedded plan is redacted — no secret leaks into the committed scaffold.
    expect(spec).not.toContain('hunter2');
    expect(await exists(join(dir, 'specs', 'login.assertion-map.md'))).toBe(true);
  });

  test('rejects an invalid --host', async () => {
    await Bun.write(join(dir, 'e2e', 'journeys', 'login.journey.md'), journeyV2());
    const res = run([
      'e2e',
      'generate',
      '--journey',
      'e2e/journeys/login.journey.md',
      '--host',
      'firefox',
    ]);
    expect(res.exitCode).toBe(65);
  });
});

describe('ditto e2e init-agents CLI (ac-9, dual-host)', () => {
  test('wrong host/loop pairing → usage error', () => {
    const res = run(['e2e', 'init-agents', '--host', 'claude', '--loop', 'codex']);
    expect(res.exitCode).toBe(65);
  });

  test('codex + Playwright < 1.61 → refused, exit non-zero, nothing written', async () => {
    const res = run(['e2e', 'init-agents', '--host', 'codex', '--playwright-version', '1.56.0']);
    expect(res.exitCode).not.toBe(0);
    expect(await exists(join(dir, '.ditto', 'local', 'e2e-agents.json'))).toBe(false);
  });

  test('--dry-run reports the plan and writes nothing', async () => {
    const res = run([
      'e2e',
      'init-agents',
      '--host',
      'claude',
      '--playwright-version',
      '1.62.0',
      '--dry-run',
    ]);
    expect(res.exitCode).toBe(0);
    expect(await exists(join(dir, 'playwright.config.ts'))).toBe(false);
    expect(await exists(join(dir, '.ditto', 'local', 'e2e-agents.json'))).toBe(false);
  });

  test('install (claude) writes scaffold + merged .mcp.json + version record', async () => {
    const res = run(['e2e', 'init-agents', '--host', 'claude', '--playwright-version', '1.62.0']);
    expect(res.exitCode).toBe(0);
    expect(await exists(join(dir, 'playwright.config.ts'))).toBe(true);
    expect(await exists(join(dir, 'e2e', 'seed.spec.ts'))).toBe(true);
    const record = JSON.parse(
      await readFile(join(dir, '.ditto', 'local', 'e2e-agents.json'), 'utf8'),
    );
    expect(record.loop).toBe('claude');
    expect(record.plan_format_version).toBe('v1');
    const mcp = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf8'));
    expect(mcp.mcpServers['playwright-test']).toBeDefined();
  });

  test('Playwright absent/unparseable → degrade, exit 0, no auto-install (ADR-0018)', async () => {
    const res = run([
      'e2e',
      'init-agents',
      '--host',
      'claude',
      '--playwright-version',
      'not-a-version',
    ]);
    expect(res.exitCode).toBe(0);
    expect(await exists(join(dir, '.ditto', 'local', 'e2e-agents.json'))).toBe(false);
  });
});

/**
 * ac-3/ac-4 PRIMARY (usable) path — the CLI wiring the spawned no-browser tests
 * above can never reach. `ditto e2e generate` projects the journey then hands the
 * result to `runGenerator`; the projection carries a parallel `확인:` assertion
 * channel that MUST be threaded as `planAssertions`, or every assertion step
 * lands in `unmatched` and the command fails loud (writing no spec). This drives
 * the exact input the command builds (`buildGenerateInput`) through a
 * usable-probe seam so the assertion-channel wiring cannot regress.
 */
describe('ditto e2e generate wiring — primary path threads the 확인 assertion channel (ac-3/ac-4)', () => {
  // A usable generator: live browser + Playwright >= 1.61 + installed agents + MCP.
  function usableSeams(rawSpec: string): RunGeneratorSeams {
    return {
      probeBrowser: async () => ({ available: true, reason: 'browser ok' }),
      readPlaywrightVersion: async () => 'Version 1.61.0',
      readAgentsRecord: async () => ({
        installed_at: '2026-07-02T00:00:00.000Z',
        playwright_version: '1.61.0',
        loop: 'claude',
        plan_format_version: 'v1',
        healer: 'constrained',
      }),
      probeMcp: async () => true,
      driveOfficialGenerator: async () => rawSpec,
    };
  }

  test('the DSL 확인: step gets a @step marker (unmatched empty → spec written)', async () => {
    const text = journeyV2();
    const parsed = parseJourneyDoc(text);
    if (!parsed.ok) throw new Error(`fixture journey did not parse: ${parsed.error}`);
    const frontMatter = parsed.frontMatter;
    const body = splitFrontMatter(text)?.body ?? '';
    const digest = computeSourceDigest(text);

    // The exact projection the command performs (plan + sidecar map + 확인 channel).
    const projection = projectJourneyToPlan({
      journey: frontMatter,
      body,
      sourcePath: 'e2e/journeys/login.journey.md',
      digest,
      resolveVar: (v) => process.env[v],
    });

    // The official generator emits action steps as `// N.` comments and each
    // Expected Result as a BARE expect() — the case title carries the case name so
    // the post-pass can resolve both channels.
    const rawSpec = [
      "import { test, expect } from '@playwright/test';",
      '',
      "test('정상 로그인', async ({ page }) => {",
      '  // 1. 이동: /login',
      "  await page.goto('/login');",
      '  // 2. 입력: 비밀번호',
      "  await page.getByLabel('비밀번호').fill('x');",
      '  // 3. 클릭: 로그인 버튼',
      "  await page.getByRole('button').click();",
      "  await expect(page.getByText('대시보드')).toContainText('대시보드');",
      '});',
      '',
    ].join('\n');

    const input = buildGenerateInput({
      repoRoot: dir,
      host: 'claude',
      journey: frontMatter,
      journeyText: text,
      journeyAbs: join(dir, 'e2e', 'journeys', 'login.journey.md'),
      slug: 'login',
      digest,
      projection,
    });
    const result = await runGenerator(input, usableSeams(rawSpec));

    expect(result.used_fallback).toBe(false);
    // action steps stay traceable via the planMap `// N.` join …
    expect(result.spec).toContain('@step jrn-login/s1');
    // … AND the 확인: step (s4) via the threaded assertion channel (the regression).
    expect(result.spec).toContain('@step jrn-login/s4');
    // no step left unmarked → the command's fail-loud gate passes → spec is written.
    expect(result.unmatched).toEqual([]);
  });
});
