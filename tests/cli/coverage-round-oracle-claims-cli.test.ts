import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * wi_260706n4w n7 fix r0 (ac-1 product-surface reachability / ac-6 additive):
 * the coverage-round CLI `--json` payload carries `oracle_claims` and threads
 * them to recordCoverageRound's oracle seam. Before this fix the CLI parsed no
 * claims, so the injection/secret fail-closed tier was unreachable from the
 * product surface (dead wiring). Asserted at the CLI level: a claim's verdict
 * persists to the oracle-provenance.json sidecar, and a refuted risk-tier
 * (injection) claim blocks the close on disk.
 *
 * The temp repo is a REAL git repo (git grep is the absence executor) with one
 * tracked file carrying a known token, mirroring
 * tests/integration/coverage-loop-oracle-wiring.test.ts.
 */

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const WI = 'wi_covorcli01';
/** The token the tracked file really contains — an absence claim over it is fabricated. */
const REAL_TOKEN = 'dangerousEvalSinkToken';

let dir: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
}

function spawnDitto(args: string[]): { stdout: string; stderr: string; exitCode: number | null } {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], {
    cwd: dir,
    // Category seeding must be ON so cov-cat-* nodes carry their dispositions.
    env: { ...process.env, DITTO_FARFIELD_CATEGORIES: '1' },
  });
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
        title: 'coverage-round oracle_claims CLI test',
        source_request: 'reach the oracle tier from the product surface',
        goal: 'oracle_claims ride the coverage-round --json payload',
        acceptance_criteria: [
          { id: 'ac-1', statement: 'claims reach the oracle', verdict: 'unverified', evidence: [] },
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
  await writeFile(
    join(wiDir, 'autopilot.json'),
    `${JSON.stringify(
      {
        schema_version: '0.1.0',
        autopilot_id: 'orch_covorcli01',
        work_item_id: WI,
        mode: 'autopilot',
        root_goal: 'drive the coverage loop',
        completion_boundary: 'entire_work_item',
        approval_gate: {
          status: 'not_required',
          source: 'small_reversible_policy',
          approved_at: null,
          approved_by: null,
          evidence_refs: [],
        },
        nodes: [
          {
            id: 'N1',
            kind: 'design',
            owner: 'planner',
            purpose: 'design step',
            status: 'pending',
            depends_on: [],
            acceptance_refs: ['ac-1'],
            evidence_refs: [],
            attempts: { fix: 0, switch: 0 },
          },
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

function roundJson(nodeId: string, claim: Record<string, unknown>): string {
  return JSON.stringify({
    node_id: nodeId,
    admissibleBranchesAdded: 0,
    close_as: 'resolved',
    axis_signals: { neutrality: { opponent_ran: true, verdict: 'accept' } },
    oracle_claims: [claim],
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-covorcli-'));
  git(['init']);
  git(['config', 'user.email', 't@t.test']);
  git(['config', 'user.name', 't']);
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'a.ts'), `export const ${REAL_TOKEN} = 1;\n`, 'utf8');
  git(['add', '-A']);
  git(['commit', '-m', 'init']);
  await seed();
  // Seed the category-complete coverage tree (cov-cat-* nodes carry dispositions).
  const next = spawnDitto(['autopilot', 'coverage-next', '--workItem', WI, '--output', 'json']);
  if (next.exitCode !== 0) throw new Error(`coverage-next seed failed: ${next.stderr}`);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('coverage-round --json oracle_claims (ac-1 product-surface reachability)', () => {
  test('a claim rides the CLI payload and its verdict persists to oracle-provenance.json', async () => {
    const res = spawnDitto([
      'autopilot',
      'coverage-round',
      '--workItem',
      WI,
      '--output',
      'json',
      '--json',
      roundJson('cov-cat-boundary-edge', {
        claim_id: 'clm-cli-ok',
        category_id: 'boundary-edge',
        claim: { mode: 'absence', pattern: 'zz_cli_never_present_zz', scope_path: 'src' },
      }),
    ]);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.closed).toBe(true); // confirmed claim never blocks

    const sidecarFile = Bun.file(
      join(dir, '.ditto', 'local', 'runs', WI, 'oracle-provenance.json'),
    );
    expect(await sidecarFile.exists()).toBe(true); // the CLI actually reached the oracle seam
    const sidecar = JSON.parse(await sidecarFile.text());
    expect(sidecar.oracle_verdicts).toHaveLength(1);
    expect(sidecar.oracle_verdicts[0].claim_id).toBe('clm-cli-ok');
    expect(sidecar.oracle_verdicts[0].outcome).toBe('confirmed');
  });

  test('a REFUTED risk-tier (injection) claim sent via the CLI blocks the close (fail-closed)', async () => {
    const res = spawnDitto([
      'autopilot',
      'coverage-round',
      '--workItem',
      WI,
      '--output',
      'json',
      '--json',
      roundJson('cov-cat-injection', {
        claim_id: 'clm-cli-fabricated',
        category_id: 'injection',
        claim: { mode: 'absence', pattern: REAL_TOKEN, scope_path: 'src' },
      }),
    ]);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.closed).toBe(false); // fail-closed: the verdict changed the round result
    expect(payload.reasons.some((x: string) => x.includes('oracle hard-rejected'))).toBe(true);

    // The node really stayed open on disk (runtime artifact, not just the CLI output).
    const map = JSON.parse(
      await Bun.file(join(dir, '.ditto', 'local', 'runs', WI, 'coverage.json')).text(),
    );
    expect(map.nodes.find((n: { id: string }) => n.id === 'cov-cat-injection').state).toBe('open');

    // The hard verdict persisted as evidence: refuted + hard_reject + exit 0 (git grep match).
    const sidecar = JSON.parse(
      await Bun.file(join(dir, '.ditto', 'local', 'runs', WI, 'oracle-provenance.json')).text(),
    );
    const v = sidecar.oracle_verdicts.find(
      (x: { claim_id: string }) => x.claim_id === 'clm-cli-fabricated',
    );
    expect(v.outcome).toBe('refuted');
    expect(v.tier).toBe('hard_reject');
    expect(v.exit_code).toBe(0);
  });
});
