import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `ditto prism` CLI (wi_260707oi1, node oi1-issuemap-engine). Drives the prism
 * issue-map engine end-to-end: seed (cap-enforced growth), close (MODEL-1 gate),
 * summary (ac-3 label-only), and status (ac-2 termination + ac-4 one-shot launch
 * notification). Spawns the source CLI with cwd=<temp repo> so all writes land in
 * an isolated tree (never the real .ditto).
 */
const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const WI = 'wi_prismcli01';

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

function seed(label: string, extra: string[] = []): { node_id: string } {
  const res = spawnDitto([
    'prism',
    'seed',
    '--wi',
    WI,
    '--label',
    label,
    '--output',
    'json',
    ...extra,
  ]);
  expect(res.exitCode).toBe(0);
  return JSON.parse(res.stdout);
}

/** Read the durable Record-tier decision KINDS actually persisted for WI. */
async function decisionKinds(): Promise<string[]> {
  const path = join(dir, '.ditto', 'work-items', WI, 'prism-decisions.jsonl');
  try {
    const text = await readFile(path, 'utf8');
    return text
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l).kind as string);
  } catch {
    return [];
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-prism-'));
  git(['init']);
  git(['config', 'user.email', 't@t.test']);
  git(['config', 'user.name', 't']);
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto prism summary — label-only (ac-3)', () => {
  test('renders labels only; no node id / severity / axis leaks', () => {
    const critical = seed('결제 실패 시 재시도 정책', ['--critical']);
    seed('로그 포맷 통일');
    const res = spawnDitto(['prism', 'summary', '--wi', WI]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('결제 실패 시 재시도 정책');
    expect(res.stdout).toContain('로그 포맷 통일');
    // no leaks of the internal node id, severity enum, or coverage axis name.
    expect(res.stdout).not.toContain(critical.node_id);
    expect(res.stdout).not.toContain('critical');
    expect(res.stdout).not.toContain('completeness');
  });
});

describe('ditto prism close — MODEL-1 unknown-close gate (ac-2)', () => {
  test('a no-residual unknown-close of a critical node is rejected', () => {
    const c = seed('인증 경계', ['--critical']);
    const res = spawnDitto([
      'prism',
      'close',
      '--wi',
      WI,
      '--node',
      c.node_id,
      '--state',
      'out_of_scope',
    ]);
    expect(res.exitCode).not.toBe(0);
    expect(res.stderr).toContain('residual_risk');
  });

  test('an unknown-close WITH residual is accepted and records a durable decision', () => {
    const c = seed('인증 경계', ['--critical']);
    const res = spawnDitto([
      'prism',
      'close',
      '--wi',
      WI,
      '--node',
      c.node_id,
      '--state',
      'user_owned',
      '--reason',
      '사용자 결정',
      '--residual',
      '인증 미검증 잔여',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout).ok).toBe(true);
  });
});

describe('ditto prism status — termination + one-shot launch notification (ac-2/ac-4)', () => {
  test('0-critical map does NOT report terminated (B1 guard) and does not notify', () => {
    seed('로그 포맷 통일'); // non-critical only
    const res = spawnDitto(['prism', 'status', '--wi', WI, '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.terminated).toBe(false);
    expect(payload.notified).toBe(false);
  });

  test('all critical resolved → notify ONCE, then silent (one-shot)', () => {
    const c = seed('인증 경계', ['--critical']);
    seed('로그 포맷 통일'); // a surviving non-critical item
    const closed = spawnDitto([
      'prism',
      'close',
      '--wi',
      WI,
      '--node',
      c.node_id,
      '--state',
      'resolved',
      '--reason',
      '해결',
    ]);
    expect(closed.exitCode).toBe(0);

    const first = spawnDitto(['prism', 'status', '--wi', WI]);
    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain('최소한으로 착수할 수 있어요');

    const second = spawnDitto(['prism', 'status', '--wi', WI]);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).not.toContain('최소한으로 착수할 수 있어요');
  });
});

describe('ditto prism diverge — divergence emit is reachable from a shipped command (ac-10)', () => {
  test('a re-challenge WITH new evidence persists a durable challenge_admit decision', async () => {
    const c = seed('인증 경계', ['--critical']);
    const res = spawnDitto([
      'prism',
      'diverge',
      '--wi',
      WI,
      '--challenge-of',
      c.node_id,
      '--signature',
      '인증 경계 다시',
      '--new-evidence',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);
    expect(payload.verdict.action).toBe('challenge-node');
    expect(payload.decision.kind).toBe('challenge_admit');
    // The whole point: it landed in the durable Record tier, not just in memory.
    expect(await decisionKinds()).toContain('challenge_admit');
  });

  test('a meaningless divergence (repeat question) persists a durable early_exit decision', async () => {
    const res = spawnDitto([
      'prism',
      'diverge',
      '--wi',
      WI,
      '--question',
      '재시도 횟수?',
      '--seen',
      '재시도 횟수?',
      '--output',
      'json',
    ]);
    // A flagged meaningless divergence is a STOP (not a green continue).
    expect(res.exitCode).not.toBe(0);
    expect(await decisionKinds()).toContain('early_exit');
  });

  test('no divergence → no decision recorded (never a spurious Record entry)', async () => {
    const res = spawnDitto([
      'prism',
      'diverge',
      '--wi',
      WI,
      '--question',
      '완전히 새로운 질문?',
      '--seen',
      '이전 질문',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    expect(JSON.parse(res.stdout).verdict.action).toBe('continue');
    expect(await decisionKinds()).toHaveLength(0);
  });
});

describe('ditto prism seed — cap really stops growth (ac-10)', () => {
  test('the tree-node cap halts the seed with an escalation (cap ≠ success)', () => {
    // --max-nodes 2: root(1) + one seed = 2 nodes; the next seed hits the cap.
    const ok = spawnDitto(['prism', 'seed', '--wi', WI, '--label', '첫 항목', '--max-nodes', '2']);
    expect(ok.exitCode).toBe(0);
    const halted = spawnDitto([
      'prism',
      'seed',
      '--wi',
      WI,
      '--label',
      '둘째 항목',
      '--max-nodes',
      '2',
    ]);
    expect(halted.exitCode).not.toBe(0);
    expect(halted.stderr).toContain('cap');
  });
});
