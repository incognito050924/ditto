import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ADR-0024 결정5, ac-1: `ditto autopilot status` must surface each in-play AC's
// frozen oracle (verification_method · maps_to · direction), READ from
// work-item.acceptance_criteria[].oracle. View-only: no recompute, no sweep,
// idempotent. This is ac-1's oracle anchor — the test that re-evaluates this AC.

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const WI = 'wi_orcview01';

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

function node(id: string, kind: string, owner: string, depends_on: string[]) {
  return {
    id,
    kind,
    owner,
    purpose: `${kind} step`,
    status: 'pending',
    depends_on,
    acceptance_refs: ['ac-1'],
    evidence_refs: [],
    attempts: { fix: 0, switch: 0 },
  };
}

async function seedGraph(): Promise<void> {
  const wiDir = join(dir, '.ditto', 'local', 'work-items', WI);
  await mkdir(wiDir, { recursive: true });
  await writeFile(
    join(wiDir, 'autopilot.json'),
    `${JSON.stringify(
      {
        schema_version: '0.1.0',
        autopilot_id: 'orch_orcview1',
        work_item_id: WI,
        mode: 'autopilot',
        root_goal: 'render oracles in status',
        completion_boundary: 'entire_work_item',
        approval_gate: {
          status: 'pending',
          source: null,
          approved_at: null,
          approved_by: null,
          evidence_refs: [],
          change_surface: ['src/foo.ts'],
          plan_brief: {
            interface_changes: ['add foo()'],
            dod: ['foo returns bar'],
            test_scenarios: ['unit: foo(1) === bar'],
          },
        },
        nodes: [
          node('N1', 'design', 'planner', []),
          node('N2', 'implement', 'implementer', ['N1']),
        ],
        caps: { fix_per_node: 2, switch_per_node: 1 },
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

async function seedWorkItem(): Promise<void> {
  const wiDir = join(dir, '.ditto', 'local', 'work-items', WI);
  await mkdir(wiDir, { recursive: true });
  await writeFile(
    join(wiDir, 'work-item.json'),
    `${JSON.stringify(
      {
        schema_version: '0.1.0',
        id: WI,
        title: 'oracle view test',
        source_request: 'show oracles in status',
        goal: 'each AC oracle is visible in status output',
        acceptance_criteria: [
          {
            id: 'ac-1',
            statement: 'status renders the oracle',
            verdict: 'unverified',
            evidence: [],
            oracle: {
              verification_method: 'dynamic_test',
              maps_to: 'ac-1',
              direction: 'forward',
            },
          },
          {
            id: 'ac-2',
            statement: 'a legacy AC with no oracle',
            verdict: 'unverified',
            evidence: [],
          },
          {
            id: 'ac-3',
            statement: 'a static-scan oracle',
            verdict: 'unverified',
            evidence: [],
            oracle: {
              verification_method: 'static_scan',
              maps_to: 'src/foo.ts:bar',
              direction: 'backward',
            },
          },
        ],
        status: 'in_progress',
        owner_profile: 'workspace-write',
        child_ids: [],
        changed_files: [],
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
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-orcview-'));
  git(['init']);
  git(['config', 'user.email', 't@t.test']);
  git(['config', 'user.name', 't']);
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto autopilot status — per-AC oracle view (ADR-0024 ac-1)', () => {
  test('json: each AC with an oracle renders method/maps_to/direction; AC without is omitted', async () => {
    await seedGraph();
    await seedWorkItem();
    const res = spawnDitto(['autopilot', 'status', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(Array.isArray(out.acceptance_oracles)).toBe(true);
    // ac-2 has no oracle → omitted cleanly (only ac-1 and ac-3 appear).
    expect(out.acceptance_oracles).toEqual([
      {
        ac_id: 'ac-1',
        verification_method: 'dynamic_test',
        maps_to: 'ac-1',
        direction: 'forward',
      },
      {
        ac_id: 'ac-3',
        verification_method: 'static_scan',
        maps_to: 'src/foo.ts:bar',
        direction: 'backward',
      },
    ]);
    // no leaked undefined anywhere in the serialized output.
    expect(res.stdout).not.toContain('undefined');
  });

  test('human: oracle lines appear for AC-with-oracle, AC-without is omitted, no undefined', async () => {
    await seedGraph();
    await seedWorkItem();
    const res = spawnDitto(['autopilot', 'status', '--workItem', WI]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('dynamic_test');
    expect(res.stdout).toContain('static_scan');
    expect(res.stdout).toContain('ac-1');
    expect(res.stdout).toContain('src/foo.ts:bar');
    expect(res.stdout).toContain('forward');
    expect(res.stdout).toContain('backward');
    // ac-2 (no oracle) must NOT appear in the oracle section, and nothing undefined.
    expect(res.stdout).not.toContain('undefined');
    // ac-2's id should not be rendered as an oracle line.
    expect(res.stdout).not.toMatch(/ac-2\b.*(dynamic_test|static_scan|soft_judgment)/);
  });

  test('idempotent: two consecutive calls produce identical output (view-only)', async () => {
    await seedGraph();
    await seedWorkItem();
    const a = spawnDitto(['autopilot', 'status', '--workItem', WI, '--output', 'json']);
    const b = spawnDitto(['autopilot', 'status', '--workItem', WI, '--output', 'json']);
    expect(a.exitCode).toBe(0);
    expect(b.exitCode).toBe(0);
    expect(a.stdout).toBe(b.stdout);
    const ha = spawnDitto(['autopilot', 'status', '--workItem', WI]);
    const hb = spawnDitto(['autopilot', 'status', '--workItem', WI]);
    expect(ha.stdout).toBe(hb.stdout);
  });

  test('work item absent: status still works, oracle section empty (no crash)', async () => {
    await seedGraph();
    const res = spawnDitto(['autopilot', 'status', '--workItem', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.acceptance_oracles).toEqual([]);
    expect(res.stdout).not.toContain('undefined');
  });
});
