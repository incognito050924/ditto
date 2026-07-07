import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { intentContract } from '~/schemas/intent';

// wi_260707loq ac-6: the `--e2e` CALLER for `e2eOptIn`. bootstrapAutopilot reads
// e2eOptIn but NO caller passed it and there was no CLI flag — the entry-phase e2e
// opt-in could never be ENABLED. This exercises the flag end-to-end: `ditto autopilot
// bootstrap --e2e` seeds the e2e-author node between design and implement; omitting it
// preserves the default skip.
const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const WI = 'wi_boote2e01';

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

async function seed(): Promise<void> {
  const wiDir = join(dir, '.ditto', 'local', 'work-items', WI);
  await mkdir(wiDir, { recursive: true });
  await writeFile(
    join(wiDir, 'work-item.json'),
    `${JSON.stringify(
      {
        schema_version: '0.1.0',
        id: WI,
        title: 'bootstrap e2e flag test',
        source_request: 'add a web surface with an entry-phase e2e journey',
        goal: 'POST /pw returns a numeric score',
        acceptance_criteria: [
          {
            id: 'ac-1',
            statement: 'POST /pw returns 200 with a numeric score',
            verdict: 'unverified',
            evidence: [],
          },
        ],
        status: 'draft',
        owner_profile: 'workspace-write',
        child_ids: [],
        changed_files: [],
        risks: [],
        runs: [],
        created_at: '2026-07-07T00:00:00.000Z',
        updated_at: '2026-07-07T00:00:00.000Z',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  // intentContract.parse fills the schema defaults so the CLI's IntentStore.get validates.
  const intent = intentContract.parse({
    schema_version: '0.1.0',
    work_item_id: WI,
    source_request: 'add a web surface with an entry-phase e2e journey',
    goal: 'POST /pw returns a numeric score',
    acceptance_criteria: [
      {
        id: 'ac-1',
        statement: 'POST /pw returns 200 with a numeric score',
        evidence_required: ['test'],
      },
    ],
    question_policy: 'ask_only_if_user_only_can_answer',
  });
  await writeFile(join(wiDir, 'intent.json'), `${JSON.stringify(intent, null, 2)}\n`, 'utf8');
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-boote2e-'));
  git(['init']);
  git(['config', 'user.email', 't@t.test']);
  git(['config', 'user.name', 't']);
  await mkdir(join(dir, '.ditto'), { recursive: true });
  await seed();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto autopilot bootstrap --e2e (wi_260707loq ac-6: the e2eOptIn caller)', () => {
  test('--e2e seeds an e2e-author node BETWEEN design and implement', async () => {
    const res = spawnDitto([
      'autopilot',
      'bootstrap',
      '--workItem',
      WI,
      '--e2e',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout) as { node_ids: string[] };
    // default seed is design(N1) → implement(N2) → verify(N3); the opt-in splices
    // N1-e2e-author right after design, so implement no longer follows design directly.
    const ids = payload.node_ids;
    expect(ids).toContain('N1-e2e-author');
    const designIdx = ids.indexOf('N1');
    const e2eIdx = ids.indexOf('N1-e2e-author');
    const implementIdx = ids.indexOf('N2');
    expect(e2eIdx).toBe(designIdx + 1);
    expect(e2eIdx).toBeLessThan(implementIdx);
  });

  test('without --e2e no e2e-author node is seeded (default skip preserved)', async () => {
    const res = spawnDitto(['autopilot', 'bootstrap', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout) as { node_ids: string[] };
    expect(payload.node_ids.some((id) => id.endsWith('-e2e-author'))).toBe(false);
  });
});
