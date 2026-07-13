import { beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `ditto deep-interview branch-order` — the branch-walking continuity seam (wi_260713cx4, #27,
 * impl-cli; closes ac-4/ac-5 at the CLI boundary).
 *
 * WHY this test exists: the branch-walking loop is SKILL-driven. To decide "what to ask next"
 * DETERMINISTICALLY the SKILL must call a CLI seam that returns the continuity-ordered pending
 * work (ac-5) plus the open critical branches that must not be starved (ac-3/ac-6). record-turn
 * / check-readiness surface readiness + exit_reason (the value-exhaustion CLOSE signal is already
 * folded into exit_reason=diminishing_returns there) but NEITHER returns the continuity ORDER nor
 * the criticalBranchesOpen view — so `orderPendingBranchWork` was an orphan at the CLI seam,
 * exactly as `selectSingleFire` was before `select-single`. This command is its runtime call site:
 * a pure read (no state mutation), deterministic, mirroring select-single's ROLE (pick next) and
 * dissent-briefs' transport (workItem in → derived JSON out).
 *
 * The scenario pins the load-bearing behavior: with pending dims created in order
 * [d-auth, d-ui, d-token] and a branch edge d-auth→d-token, the branch is WALKED CONTIGUOUSLY —
 * d-token is pulled up next to d-auth (its component), deferring d-ui, so the order is
 * [d-auth, d-token, d-ui] and NOT the raw creation order. A critical, unresolved branch target
 * (d-token) surfaces in criticalBranchesOpen so the driver cannot silently starve it.
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

// One record-turn upserting a pending (unresolved) dimension + a question carrying optional
// branch_edges. All question presentation-contract fields are supplied (the write path runs the
// check-question gate). The dimension stays `partial` so it remains pending in the ordering.
function recordTurn(
  wi: string,
  dimId: string,
  opts: { critical?: boolean; edges?: { from: string; to: string }[] } = {},
): void {
  const r = spawnDitto([
    'deep-interview',
    'record-turn',
    '--workItem',
    wi,
    '--json',
    JSON.stringify({
      dimension: {
        id: dimId,
        critical: opts.critical ?? false,
        state: 'partial',
        ambiguity: 0.4,
        notes: `${dimId} topic`,
      },
      question: {
        text: `${dimId}?`,
        why_matters: 'matters',
        user_explanation: `${dimId} 결정을 사용자 언어로 확인하는 질문입니다.`,
        recommended_answer: `추천: ${dimId} 기본값을 사용합니다.`,
        info_gain_estimate: 'medium',
        ...(opts.edges ? { branch_edges: opts.edges } : {}),
      },
    }),
    '--output',
    'json',
  ]);
  expect(r.exitCode).toBe(0);
}

function seedBranchState(): string {
  const wi = JSON.parse(
    spawnDitto([
      'work',
      'start',
      'auth flow',
      '--request',
      'design the auth flow',
      '--output',
      'json',
    ]).stdout,
  ).work_item_id as string;
  expect(
    spawnDitto(['deep-interview', 'start', '--workItem', wi, '--output', 'json']).exitCode,
  ).toBe(0);
  // Creation order d-auth, d-ui, d-token; the branch edge d-auth→d-token binds auth+token
  // into one component so continuity ordering must pull d-token ahead of d-ui.
  recordTurn(wi, 'd-auth', { edges: [{ from: 'd-auth', to: 'd-token' }] });
  recordTurn(wi, 'd-ui');
  recordTurn(wi, 'd-token', { critical: true });
  return wi;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-branch-seam-'));
  git(['init']);
});

describe('deep-interview branch-order — continuity seam (ac-4/ac-5)', () => {
  test('returns pending work in continuity order (branch walked contiguously)', () => {
    const wi = seedBranchState();
    const res = spawnDitto([
      'deep-interview',
      'branch-order',
      '--workItem',
      wi,
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      ordered: { id: string; text: string }[];
      critical_branches_open: string[];
    };
    // Contiguous branch walk: d-token pulled up next to d-auth, d-ui deferred — NOT raw
    // creation order [d-auth, d-ui, d-token]. (`start` also seeds user-intent dimensions,
    // a separate component; filter to the branch dims under test to pin their relative order.)
    const branchIds = parsed.ordered.map((o) => o.id).filter((id) => id.startsWith('d-'));
    expect(branchIds).toEqual(['d-auth', 'd-token', 'd-ui']);
  });

  test('surfaces the open critical branch target (anti-starvation signal)', () => {
    const wi = seedBranchState();
    const parsed = JSON.parse(
      spawnDitto(['deep-interview', 'branch-order', '--workItem', wi, '--output', 'json']).stdout,
    ) as { critical_branches_open: string[] };
    expect(parsed.critical_branches_open).toEqual(['d-token']);
  });

  test('does NOT mutate interview state (pure read)', () => {
    const wi = seedBranchState();
    const before = JSON.parse(
      spawnDitto(['deep-interview', 'check-readiness', '--workItem', wi, '--output', 'json'])
        .stdout,
    ) as { questions_asked: number };
    spawnDitto(['deep-interview', 'branch-order', '--workItem', wi, '--output', 'json']);
    const after = JSON.parse(
      spawnDitto(['deep-interview', 'check-readiness', '--workItem', wi, '--output', 'json'])
        .stdout,
    ) as { questions_asked: number };
    expect(after.questions_asked).toBe(before.questions_asked);
  });
});
