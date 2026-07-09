import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * End-to-end orchestration of the prism opponent seam (wi_260708faa): the main-agent
 * flow the SKILL documents — `opponent-briefs` emits structured briefs → the host layer
 * (here, the test standing in for the spawned opponent agents) produces judgment text →
 * `opponent-record` consumes the verdict JSON and persists the record-back. This proves
 * the two CLIs compose into a real record path (no model call in either CLI; ADR-0001
 * keeps judgment in the host layer).
 */
const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const WI = 'wi_prismopp01';

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

async function readIssueMap(): Promise<{
  tree: { root_id: string };
  // biome-ignore lint/suspicious/noExplicitAny: test reads the persisted JSON shape ad hoc.
  evaluations: any[];
}> {
  const path = join(dir, '.ditto', 'local', 'work-items', WI, 'prism', 'issue-map.json');
  return JSON.parse(await readFile(path, 'utf8'));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-prism-opp-'));
  git(['init']);
  git(['config', 'user.email', 't@t.test']);
  git(['config', 'user.name', 't']);
  await mkdir(join(dir, '.ditto'), { recursive: true });
  const wiDir = join(dir, '.ditto', 'local', 'work-items', WI);
  await mkdir(wiDir, { recursive: true });
  await writeFile(
    join(wiDir, 'intent.json'),
    JSON.stringify(
      {
        schema_version: '0.1.0',
        work_item_id: WI,
        source_request: '결제 재시도 정책을 설계한다 — 원문 의도',
        goal: '재시도 정책 확정',
        in_scope: ['결제 재시도 정책 로직'],
        acceptance_criteria: [{ id: 'ac-1', statement: '재시도 정책이 정의된다' }],
      },
      null,
      2,
    ),
  );
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('prism opponent orchestration — briefs → host judgment → record (ac-3)', () => {
  test('all three concerns land engaged when the host answers every brief', async () => {
    // Seed a critical node then flag it (critical resolved-close without A2 inputs).
    const seeded = spawnDitto([
      'prism',
      'seed',
      '--wi',
      WI,
      '--label',
      '결제 재시도 정책',
      '--critical',
      '--output',
      'json',
    ]);
    expect(seeded.exitCode).toBe(0);
    const nodeId = JSON.parse(seeded.stdout).node_id;
    spawnDitto([
      'prism',
      'close',
      '--wi',
      WI,
      '--node',
      nodeId,
      '--state',
      'resolved',
      '--reason',
      'x',
    ]);

    // 1) main agent runs opponent-briefs (no model call).
    const briefsRes = spawnDitto(['prism', 'opponent-briefs', '--wi', WI]);
    expect(briefsRes.exitCode).toBe(0);
    const briefs = JSON.parse(briefsRes.stdout);
    expect(briefs.critique_targets.length).toBeGreaterThan(0);
    expect(briefs.semantic_targets.length).toBeGreaterThan(0);
    const rootId = briefs.dissent_anchor.node_id;

    // 2) HOST LAYER: spawned opponent agents produce judgment text per brief. The test
    //    stands in for that host — it does NOT happen inside the CLI (ADR-0001).
    const verdicts = {
      verdicts: [
        ...briefs.critique_targets.map((t: { node_id: string }) => ({
          concern: 'critique',
          node_id: t.node_id,
          text: `critique judgment for ${t.node_id}`,
        })),
        {
          concern: 'dissent',
          node_id: briefs.dissent_anchor.node_id,
          text: 'independent dissent from original intent',
        },
        ...briefs.semantic_targets.map((t: { node_id: string }) => ({
          concern: 'semantic',
          node_id: t.node_id,
          text: `semantic judgment for ${t.node_id}`,
        })),
      ],
    };

    // 3) main agent feeds the verdicts back to opponent-record.
    const recordRes = spawnDitto([
      'prism',
      'opponent-record',
      '--wi',
      WI,
      '--json',
      JSON.stringify(verdicts),
      '--output',
      'json',
    ]);
    expect(recordRes.exitCode).toBe(0);

    const map = await readIssueMap();
    const nodeRec = map.evaluations.find((e: { node_id: string }) => e.node_id === nodeId);
    expect(nodeRec.opponent_status).toBe('engaged');
    expect(nodeRec.opponent_critique).toContain('critique judgment');
    expect(nodeRec.semantic_status).toBe('engaged');
    expect(nodeRec.semantic_critique).toContain('semantic judgment');
    const rootRec = map.evaluations.find((e: { node_id: string }) => e.node_id === rootId);
    expect(rootRec.opponent_status).toBe('engaged');
    expect(rootRec.opponent_dissent).toBe('independent dissent from original intent');
  });
});
