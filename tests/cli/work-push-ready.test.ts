import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ac-6 (wi_260626wnv) — Part B: the PULL-ONLY query surface. `work push-ready <wi>`
// runs pushReadiness and reports ready + reasons. This is the ONLY way the strong
// push-readiness signal is surfaced — the USER runs it. ditto never proactively
// proposes a push anywhere (the pull-only invariant is guarded separately).

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
let dir: string;

function ditto(args: string[]) {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], { cwd: dir, env: { ...process.env } });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

function start(goal: string, extra: string[] = []): string {
  const s = ditto([
    'work',
    'start',
    goal,
    '--request',
    'do the thing',
    '--criteria',
    'the command returns 0',
    ...extra,
    '--output',
    'json',
  ]);
  expect(s.exitCode).toBe(0);
  return JSON.parse(s.stdout).work_item_id as string;
}

function gradeAc1Pass(wid: string): void {
  const wiPath = join(dir, '.ditto', 'local', 'work-items', wid, 'work-item.json');
  // Real command-kind evidence (verdict=pass + a command evidence entry).
  expect(ditto(['verify', wid, '--criterion', 'ac-1', '--', 'cat', wiPath]).exitCode).toBe(0);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-pushready-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ac-6 B: ditto work push-ready', () => {
  test('a freshly started WI (unverified, no evidence) is NOT push-ready, with reasons', () => {
    const wid = start('a step');
    const r = ditto(['work', 'push-ready', wid, '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ready).toBe(false);
    expect(Array.isArray(out.reasons)).toBe(true);
    expect(out.reasons.length).toBeGreaterThan(0);
  });

  test('after a real command-evidence verify of every AC → push-ready (ready:true, reasons empty)', () => {
    const wid = start('a step');
    gradeAc1Pass(wid);
    const r = ditto(['work', 'push-ready', wid, '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ready).toBe(true);
    expect(out.reasons).toEqual([]);
  });

  test('cond 4: a half-finished STEM chain is not push-ready even when the WI itself is verified', () => {
    const a = start('first step');
    const b = start('second step', ['--follows', a]); // b → a
    gradeAc1Pass(b); // b itself is fully verified...
    // ...but a (its predecessor in the chain) is still draft → chain not done.
    const r = ditto(['work', 'push-ready', b, '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ready).toBe(false);
    expect(out.reasons.some((x: string) => /stem|chain/i.test(x))).toBe(true);
  });

  test('human output prints ready + reasons and never suggests a push', () => {
    const wid = start('a step');
    const r = ditto(['work', 'push-ready', wid]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toLowerCase()).toContain('ready');
    // pull-only: the readiness report itself must not nudge the user to push/deploy.
    expect(r.stdout).not.toMatch(
      /\b(push now|go ahead and push|please push|deploy now|propose|suggest)\b/i,
    );
  });

  test('unknown work item is a usage error', () => {
    const r = ditto(['work', 'push-ready', 'wi_doesnotexist01']);
    expect(r.exitCode).not.toBe(0);
  });
});
