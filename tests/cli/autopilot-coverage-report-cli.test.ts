import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FAR_FIELD_ROUTED_OUT } from '~/core/coverage-taxonomy';

/**
 * `ditto autopilot coverage-report` human output — observation surface for the
 * far-field disposition routing (wi_260707rwf):
 *
 *   ac-1: the routed-out ledger (category id · route · reason) appears in the
 *         human output on BOTH paths — coverage.json present AND the absent
 *         early-return — so 'complete' never quietly means a smaller universe.
 *   ac-2: a map that exists WITHOUT seeded categories (e.g. deep-interview
 *         projected coverage.json before category seeding ran) is reported as a
 *         map-exists skip, not mislabeled 'far-field seeding off'.
 *
 * JSON output contract is untouched (additive: human format only).
 */
const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const WI = 'wi_covreport1';

let dir: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
}

function spawnDitto(
  args: string[],
  env: Record<string, string> = {},
): { stdout: string; stderr: string; exitCode: number | null } {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], {
    cwd: dir,
    env: { ...process.env, ...env },
  });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

/** Seed a coverage.json for WI; `withCategory` controls whether a cov-cat-* node exists. */
async function seedCoverage(withCategory: boolean): Promise<void> {
  const runDir = join(dir, '.ditto', 'local', 'runs', WI);
  await mkdir(runDir, { recursive: true });
  const category = {
    id: 'cov-cat-authentication',
    parent_id: 'cov-root',
    label: 'auth lens',
    origin: 'seed',
    depth_weight: 1,
    state: 'resolved',
    children: [],
  };
  await writeFile(
    join(runDir, 'coverage.json'),
    `${JSON.stringify({
      schema_version: '0.1.0',
      work_item_id: WI,
      root_id: 'cov-root',
      nodes: [
        {
          id: 'cov-root',
          parent_id: null,
          label: 'original intent',
          origin: 'seed',
          depth_weight: 1,
          state: 'open',
          children: withCategory ? ['cov-cat-authentication'] : [],
        },
        ...(withCategory ? [category] : []),
      ],
    })}\n`,
    'utf8',
  );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-covreport-'));
  git(['init']);
  git(['config', 'user.email', 't@t.test']);
  git(['config', 'user.name', 't']);
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto autopilot coverage-report — routed-out section (ac-1)', () => {
  test('coverage.json present: human output lists routed-out id · route · reason', async () => {
    await seedCoverage(true);
    const res = spawnDitto(['autopilot', 'coverage-report', '--workItem', WI]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('routed out');
    for (const r of FAR_FIELD_ROUTED_OUT) {
      expect(res.stdout).toContain(r.id);
      expect(res.stdout).toContain(r.route);
      expect(res.stdout).toContain(r.reason);
    }
  });

  test('coverage.json ABSENT (early return): routed-out section still appears', async () => {
    const res = spawnDitto(['autopilot', 'coverage-report', '--workItem', WI]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('no sweep recorded');
    expect(res.stdout).toContain('routed out');
    for (const r of FAR_FIELD_ROUTED_OUT) {
      expect(res.stdout).toContain(r.id);
      expect(res.stdout).toContain(r.route);
      expect(res.stdout).toContain(r.reason);
    }
  });
});

describe('ditto autopilot coverage-report — unseeded map wording (ac-2)', () => {
  test('map exists without categories + seeding ON → map-exists skip, NOT "far-field seeding off"', async () => {
    await seedCoverage(false);
    const res = spawnDitto(['autopilot', 'coverage-report', '--workItem', WI], {
      DITTO_FARFIELD_CATEGORIES: '1',
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('map-exists skip');
    expect(res.stdout).not.toContain('far-field seeding off');
  });

  test('map exists without categories + seeding OFF → still reported as seeding off', async () => {
    await seedCoverage(false);
    const res = spawnDitto(['autopilot', 'coverage-report', '--workItem', WI], {
      DITTO_FARFIELD_CATEGORIES: 'off',
    });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('far-field seeding off');
    expect(res.stdout).not.toContain('map-exists skip');
  });
});
