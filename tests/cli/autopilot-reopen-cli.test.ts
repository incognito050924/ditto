import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Background (wi_260713wxq, issue #31 — n2-reopen): the user-action CLI entrypoint
// `ditto autopilot reopen`. This entrypoint is the ONLY origin of a reopen (ac-2,
// no-auto-pick) — never an autonomous record-result payload flag. These tests pin:
//   ac-2  the CLI reopens a passed implement node passed→pending.
//   ac-5  the CLI refuses a non-passed target and a fully-terminal graph.

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const WI = 'wi_reopencli1';

let dir: string;

function spawnDitto(args: string[]): { stdout: string; stderr: string; exitCode: number | null } {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], { cwd: dir, env: { ...process.env } });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

function apNode(
  id: string,
  kind: string,
  owner: string,
  status: string,
  depends_on: string[],
): unknown {
  return {
    id,
    kind,
    owner,
    purpose: `${kind} step`,
    status,
    depends_on,
    acceptance_refs: ['ac-1'],
    evidence_refs: [],
    ac_verdicts: [],
    attempts: { fix: 0, switch: 0 },
    file_scope: kind === 'implement' ? ['src/x.ts'] : [],
  };
}

async function seed(nodes: unknown[]): Promise<void> {
  const wiDir = join(dir, '.ditto', 'local', 'work-items', WI);
  await mkdir(wiDir, { recursive: true });
  await writeFile(
    join(wiDir, 'work-item.json'),
    `${JSON.stringify(
      {
        schema_version: '0.1.0',
        id: WI,
        title: 'reopen cli test',
        source_request: 'reopen via CLI',
        goal: 'the reopen entrypoint works',
        acceptance_criteria: [
          {
            id: 'ac-1',
            statement: 'the implement is correct',
            verdict: 'unverified',
            evidence: [],
          },
        ],
        status: 'in_progress',
        owner_profile: 'workspace-write',
        child_ids: [],
        changed_files: ['src/x.ts'],
        risks: [],
        runs: [],
        created_at: '2026-06-01T00:00:00.000Z',
        updated_at: '2026-06-01T00:00:00.000Z',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeFile(
    join(wiDir, 'autopilot.json'),
    `${JSON.stringify(
      {
        schema_version: '0.1.0',
        autopilot_id: 'orch_reopencli',
        work_item_id: WI,
        mode: 'autopilot',
        root_goal: 'goal',
        completion_boundary: 'entire_work_item',
        approval_gate: {
          status: 'not_required',
          source: 'small_reversible_policy',
          approved_at: null,
          approved_by: null,
          evidence_refs: [],
        },
        nodes,
        caps: {
          fix_per_node: 2,
          switch_per_node: 1,
          converge_rounds: 3,
          oracle_failures_to_block: 3,
          loop_rounds: 12,
          no_progress_rounds: 3,
          progress_continuation_cap: 24,
        },
        continue_policy: {
          continue_after_approval: true,
          continue_after_checkpoint: true,
          continue_after_fixable_failure: true,
          ask_user_only_for_user_owned_decisions: true,
        },
        stop_conditions: [],
        user_interrupt_policy: 'ask_only_for_user_owned_decisions',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

async function graphNodes(): Promise<Record<string, string>> {
  const raw = JSON.parse(
    await readFile(join(dir, '.ditto', 'local', 'work-items', WI, 'autopilot.json'), 'utf8'),
  );
  const byId: Record<string, string> = {};
  for (const n of raw.nodes) byId[n.id] = n.status;
  return byId;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-reopencli-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto autopilot reopen (user-action CLI entrypoint)', () => {
  test('ac-2: reopens a passed implement node passed→pending', async () => {
    await seed([
      apNode('N1', 'design', 'planner', 'passed', []),
      apNode('N2', 'implement', 'implementer', 'passed', ['N1']),
      apNode('N3', 'verify', 'verifier', 'passed', ['N2']),
      apNode('N4', 'docs', 'implementer', 'pending', []),
    ]);
    const res = spawnDitto([
      'autopilot',
      'reopen',
      '--workItem',
      WI,
      '--node',
      'N2',
      '--feedback',
      'boundary case still fails',
    ]);
    expect(res.exitCode).toBe(0);
    const statuses = await graphNodes();
    expect(statuses.N2).toBe('pending');
  });

  test('ac-5: refuses a non-passed target (non-zero exit)', async () => {
    await seed([
      apNode('N1', 'design', 'planner', 'passed', []),
      apNode('N2', 'implement', 'implementer', 'running', ['N1']),
    ]);
    const res = spawnDitto(['autopilot', 'reopen', '--workItem', WI, '--node', 'N2']);
    expect(res.exitCode).not.toBe(0);
  });

  test('ac-5: refuses on a fully-terminal graph (non-zero exit)', async () => {
    await seed([
      apNode('N1', 'design', 'planner', 'passed', []),
      apNode('N2', 'implement', 'implementer', 'passed', ['N1']),
      apNode('N3', 'verify', 'verifier', 'passed', ['N2']),
    ]);
    const res = spawnDitto(['autopilot', 'reopen', '--workItem', WI, '--node', 'N2']);
    expect(res.exitCode).not.toBe(0);
  });
});
