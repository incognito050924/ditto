import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContextPacket } from '~/core/context-packet';
import { RunStore } from '~/core/run-store';
import { WorkItemStore } from '~/core/work-item-store';

let dir: string;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-context-'));
  git(['init']);
  git(['config', 'user.email', 'ditto@example.test']);
  git(['config', 'user.name', 'DITTO Test']);
  await mkdir(join(dir, '.ditto'), { recursive: true });
  await writeFile(join(dir, 'README.md'), 'hello\n', 'utf8');
  git(['add', '.']);
  git(['commit', '-m', 'initial']);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('buildContextPacket', () => {
  test('writes default markdown with work item, git state, acceptance, and run exits', async () => {
    const workStore = new WorkItemStore(dir);
    const item = await workStore.create({
      title: 'Context packet sample',
      source_request: 'make context',
      goal: 'Build a markdown packet',
      acceptance_criteria: [
        {
          id: 'ac-1',
          statement: 'packet includes criteria',
          verdict: 'pass',
          evidence: [],
        },
        {
          id: 'ac-2',
          statement: 'packet includes run exits',
          verdict: 'unverified',
          evidence: [],
        },
      ],
    });
    const runStore = new RunStore(dir);
    const run = await runStore.create({
      work_item_id: item.id,
      provider: 'codex',
      entrypoint: 'codex mock',
      profile: 'workspace-write',
      cwd: '.',
      model_reported: null,
      git_before: {
        head: git(['rev-parse', 'HEAD']),
        branch: 'main',
        dirty: false,
        untracked_count: 0,
      },
    });
    await runStore.update(run.id, (cur) => ({ ...cur, exit_code: 0 }));
    await workStore.update(item.id, (cur) => ({ ...cur, runs: [run.id] }));

    const result = await buildContextPacket(dir, { work_item_id: item.id });
    expect(result.output_path).toBe(`.ditto/work-items/${item.id}/context-packet.md`);
    const text = await Bun.file(join(dir, result.output_path)).text();
    expect(text).toContain('# Context packet sample');
    expect(text).toContain('Build a markdown packet');
    expect(text).toContain('- ac-1 [pass] packet includes criteria');
    expect(text).toContain('- ac-2 [unverified] packet includes run exits');
    expect(text).toContain('- head:');
    expect(text).toContain('- branch:');
    expect(text).toContain('- dirty:');
    expect(text).toContain(`- ${run.id}: exit_code=0`);
  });
});
