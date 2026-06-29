import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `ditto doctor github` (wi_2606289h9 ac-6) — a READ-ONLY, LOCAL-ONLY config
 * checker: surfaces a 구버전 github config that has the integration set up but is
 * MISSING `claim_status_map.in_progress`. That gap silently skips the board move
 * to "In progress" on claim, so the user must be told to re-run `ditto github
 * setup`.
 *
 * Constraints: no `gh`/network probe (offline must not hang or false-fail); it
 * only inspects the local `.ditto/local/config.json` github block presence and
 * its `claim_status_map.in_progress` mapping. No auto-fix.
 */
const cliEntry = join(process.cwd(), 'src/cli/index.ts');

let dir: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
}

function spawnDitto(args: string[]): { stdout: string; stderr: string; exitCode: number | null } {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], { cwd: dir, env: { ...process.env } });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

async function writeConfig(github: Record<string, unknown> | undefined): Promise<void> {
  const localDir = join(dir, '.ditto', 'local');
  await mkdir(localDir, { recursive: true });
  const config = github === undefined ? {} : { github };
  await writeFile(join(localDir, 'config.json'), JSON.stringify(config, null, 2));
}

// A valid github block WITHOUT claim_status_map (the "구버전" shape).
const legacyGithub = {
  project: { owner: 'me', number: 2 },
  status_map: { done: 'opt_done', abandoned: 'opt_abandoned' },
  auto_reflect: true,
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-doctor-github-'));
  git(['init']);
  git(['config', 'user.email', 't@t.test']);
  git(['config', 'user.name', 't']);
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto doctor github', () => {
  test('github configured but claim_status_map.in_progress missing -> finding (json, exit 1)', async () => {
    await writeConfig(legacyGithub);
    const res = spawnDitto(['doctor', 'github', '--output', 'json']);
    expect(res.exitCode).toBe(1);
    const payload = JSON.parse(res.stdout);
    expect(payload.status).toBe('drift');
    expect(payload.github_configured).toBe(true);
    expect(payload.claim_in_progress_mapped).toBe(false);
    expect(payload.finding_count).toBe(1);
    expect(payload.findings[0].kind).toBe('claim_status_map_missing');
  });

  test('human output names the gap and the remediation command', async () => {
    await writeConfig(legacyGithub);
    const res = spawnDitto(['doctor', 'github']);
    expect(res.exitCode).toBe(1);
    expect(res.stdout).toContain('claim_status_map.in_progress');
    expect(res.stdout).toContain('ditto github setup');
  });

  test('claim_status_map.in_progress set -> ok (exit 0)', async () => {
    await writeConfig({ ...legacyGithub, claim_status_map: { in_progress: 'opt_inprog' } });
    const res = spawnDitto(['doctor', 'github', '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.status).toBe('ok');
    expect(payload.claim_in_progress_mapped).toBe(true);
    expect(payload.finding_count).toBe(0);
  });

  test('no github block -> ok, exit 0 (not using the integration)', async () => {
    await writeConfig(undefined);
    const res = spawnDitto(['doctor', 'github', '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.status).toBe('ok');
    expect(payload.github_configured).toBe(false);
  });

  test('no config file at all -> ok, exit 0 (offline, no hang)', async () => {
    const res = spawnDitto(['doctor', 'github']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('github');
  });

  test('--advisory reports the finding but exits 0', async () => {
    await writeConfig(legacyGithub);
    const res = spawnDitto(['doctor', 'github', '--advisory']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('claim_status_map.in_progress');
  });

  test('invalid --output is a usage error (exit 65)', async () => {
    const res = spawnDitto(['doctor', 'github', '--output', 'xml']);
    expect(res.exitCode).toBe(65);
  });
});
