import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkItemStore } from '~/core/work-item-store';

// ac-1 (D, wi_260626wnv) — `ditto verify` must reject an unambiguous no-op command
// (true, :, bare echo) BEFORE recording a pass: a no-op must never grade a
// criterion as pass.

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

async function workItemWithRealAC() {
  return new WorkItemStore(dir).create({
    title: 'direct fix',
    source_request: 'fix the thing',
    goal: 'the thing is fixed',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'the command exits 0', verdict: 'unverified', evidence: [] },
    ],
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-verifynoop-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto verify — no-op rejection', () => {
  test.each([
    ['true', ['true']],
    ['colon', [':']],
    ['bare echo', ['echo', 'ok']],
  ])('D: %s is rejected and does not grade the criterion pass', async (_label, tail) => {
    const wi = await workItemWithRealAC();
    const r = ditto(['verify', wi.id, '--criterion', 'ac-1', '--', ...tail]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/no-op/i);
    const item = await new WorkItemStore(dir).get(wi.id);
    expect(item.acceptance_criteria[0].verdict).toBe('unverified');
  });

  test('D: a real command still grades the criterion pass', async () => {
    const wi = await workItemWithRealAC();
    const wiPath = join(dir, '.ditto', 'local', 'work-items', wi.id, 'work-item.json');
    const r = ditto(['verify', wi.id, '--criterion', 'ac-1', '--', 'cat', wiPath]);
    expect(r.exitCode).toBe(0);
    const item = await new WorkItemStore(dir).get(wi.id);
    expect(item.acceptance_criteria[0].verdict).toBe('pass');
  });
});
