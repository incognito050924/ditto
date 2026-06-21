import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CompletionStore } from '~/core/completion-store';
import { WorkItemStore } from '~/core/work-item-store';

// wi_2606200ec — lightweight completion path. A work item fixed directly (no
// autopilot) must still be closable: `ditto work done` synthesizes a completion
// contract from the work item's OWN acceptance verdicts/evidence (set by
// `ditto verify`), gated by the SAME completionGate + completionEvidenceGate.
// No autopilot graph, no intent.json required — but the evidence gate still holds.

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
  dir = await mkdtemp(join(tmpdir(), 'ditto-workdone-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto work done — lightweight completion path', () => {
  test('verified AC (pass+evidence) → done synthesizes completion.json and closes', async () => {
    const wi = await workItemWithRealAC();
    // verify records a real (command) evidence ref and flips ac-1 to pass.
    const v = ditto(['verify', wi.id, '--criterion', 'ac-1', '--', 'echo', 'ok']);
    expect(v.exitCode).toBe(0);

    expect(await new CompletionStore(dir).exists(wi.id)).toBe(false); // none yet
    const d = ditto(['work', 'done', wi.id, '--output', 'json']);
    expect(d.exitCode).toBe(0);

    // completion.json synthesized with final_verdict=pass
    const completion = await new CompletionStore(dir).get(wi.id);
    expect(completion.final_verdict).toBe('pass');
    expect(completion.acceptance.find((a) => a.criterion_id === 'ac-1')?.verdict).toBe('pass');
    // status closed
    const item = await new WorkItemStore(dir).get(wi.id);
    expect(item.status).toBe('done');
  });

  test('unverified AC → done refuses, writes no completion.json, leaves status open', async () => {
    const wi = await workItemWithRealAC(); // ac-1 stays unverified, no evidence
    const d = ditto(['work', 'done', wi.id, '--output', 'json']);
    expect(d.exitCode).not.toBe(0);
    expect(await new CompletionStore(dir).exists(wi.id)).toBe(false);
    const item = await new WorkItemStore(dir).get(wi.id);
    expect(item.status).not.toBe('done');
  });

  test('placeholder AC (work start default) → done refuses even if verdict flipped', async () => {
    const s = ditto(['work', 'start', 'a goal', '--request', 'r', '--output', 'json']);
    expect(s.exitCode).toBe(0);
    const wid = JSON.parse(s.stdout).work_item_id as string;
    // flip the placeholder AC to pass with evidence, but the statement is still TBD
    ditto(['verify', wid, '--criterion', 'ac-1', '--', 'echo', 'ok']);
    const d = ditto(['work', 'done', wid, '--output', 'json']);
    expect(d.exitCode).not.toBe(0);
    expect(await new CompletionStore(dir).exists(wid)).toBe(false);
  });
});
