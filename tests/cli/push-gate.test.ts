import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type E2eGateWiring,
  type ExecPushGateInput,
  type RunTest,
  execPushGate,
  loadJourneyEntries,
  maybeRecordGreenForGate,
} from '~/cli/commands/push-gate';
import type { JourneyEntry } from '~/core/e2e/e2e-gate';
import type { EvidenceQueryResult, EvidenceSource } from '~/core/e2e/evidence-source';
import { type GreenCache, greenCachePath } from '~/core/push-gate-cache';
import { PUSH_GATE_HOOK_MARKER, setup } from '~/core/setup';
import type { RecipeE2eGate, RecipePushGate } from '~/schemas/recipe';

// ───────────────────────────────────────────────────────────────────────────
// UNIT — execPushGate policy (decision → exit code), runTest injected so the
// passed/failed/unrunnable branches are deterministic with no real spawning.
// ───────────────────────────────────────────────────────────────────────────

const PUSH_MAIN = 'refs/heads/main a refs/heads/main b\n';
const PUSH_FEATURE = 'refs/heads/feature a refs/heads/feature b\n';
const gate: RecipePushGate = { protected_branches: ['main'], test_command: 'bun test' };

const passes: RunTest = async () => ({ kind: 'passed' });
const fails: RunTest = async () => ({ kind: 'failed', exitCode: 1 });
const unrunnable: RunTest = async () => ({ kind: 'unrunnable', reason: 'bun: command not found' });
// A runTest that MUST NOT be invoked (decision should short-circuit before it).
const never: RunTest = async () => {
  throw new Error('runTest must not be called for this decision');
};

function input(over: Partial<ExecPushGateInput>): ExecPushGateInput {
  return {
    stdin: PUSH_MAIN,
    gate,
    malformedRecipe: false,
    env: {},
    cwd: '/repo',
    runTest: never,
    ...over,
  };
}

describe('execPushGate — protected branch runs the gate (ac-2)', () => {
  test('protected push + passing tests → exit 0 (allow)', async () => {
    const r = await execPushGate(input({ runTest: passes }));
    expect(r.exitCode).toBe(0);
  });

  test('protected push + failing tests → non-zero (block)', async () => {
    const r = await execPushGate(input({ runTest: fails }));
    expect(r.exitCode).not.toBe(0);
  });

  test('non-protected push → exit 0; the test command is never run', async () => {
    const r = await execPushGate(input({ stdin: PUSH_FEATURE, runTest: never }));
    expect(r.exitCode).toBe(0);
  });

  test('absent gate (no recipe push_gate) → exit 0; never runs tests', async () => {
    const r = await execPushGate(input({ gate: undefined, runTest: never }));
    expect(r.exitCode).toBe(0);
  });

  test('deletion-only push (no branches) → exit 0', async () => {
    const r = await execPushGate(input({ stdin: '', runTest: never }));
    expect(r.exitCode).toBe(0);
  });
});

describe('execPushGate — "*" wildcard gates every branch (ac-1 via CLI)', () => {
  const star: RecipePushGate = { protected_branches: ['*'], test_command: 'bun test' };

  test('an unlisted branch is gated under "*" (failing tests → block)', async () => {
    const r = await execPushGate(input({ stdin: PUSH_FEATURE, gate: star, runTest: fails }));
    expect(r.exitCode).not.toBe(0);
  });

  test('"*" + passing tests → exit 0', async () => {
    const r = await execPushGate(input({ stdin: PUSH_FEATURE, gate: star, runTest: passes }));
    expect(r.exitCode).toBe(0);
  });
});

describe('execPushGate — fail-closed degradation (ac-4)', () => {
  test('malformed recipe on a push → non-zero + actionable guidance; tests never run', async () => {
    const r = await execPushGate(input({ gate: undefined, malformedRecipe: true, runTest: never }));
    expect(r.exitCode).not.toBe(0);
    expect(r.message ?? '').toMatch(/DITTO_SKIP_HOOKS/);
  });

  test('test runner absent (unrunnable) on a protected push → non-zero + guidance', async () => {
    const r = await execPushGate(input({ runTest: unrunnable }));
    expect(r.exitCode).not.toBe(0);
    expect(r.message ?? '').toMatch(/DITTO_SKIP_HOOKS/);
  });
});

describe('execPushGate — DITTO_SKIP_HOOKS sanctioned escape (ac-4)', () => {
  test('skip even when the recipe is malformed → exit 0', async () => {
    const r = await execPushGate(
      input({
        gate: undefined,
        malformedRecipe: true,
        env: { DITTO_SKIP_HOOKS: '1' },
        runTest: never,
      }),
    );
    expect(r.exitCode).toBe(0);
  });

  test('skip even when tests would fail → exit 0; tests never run', async () => {
    const r = await execPushGate(input({ env: { DITTO_SKIP_HOOKS: '1' }, runTest: never }));
    expect(r.exitCode).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// INTEGRATION — the real `ditto push-gate` command end-to-end: reads stdin,
// discovers recipe.yaml at the workspace root, resolves the gate, spawns the
// real test_command. Exercises defaultRunTest (incl. the runner-absent path)
// and the stdin→decision→exit glue that the unit tests inject around.
// ───────────────────────────────────────────────────────────────────────────

const cli = join(process.cwd(), 'src/cli/index.ts');
let workDir: string;

function runGateIn(
  dir: string,
  stdin: string,
  opts: { args?: string[]; env?: Record<string, string> } = {},
) {
  // Strip an INHERITED DITTO_SKIP_HOOKS from the spawned gate's env: it is the gate's
  // kill switch (execPushGate → exit 0), so a developer running the suite with
  // `DITTO_SKIP_HOOKS=1` (the sanctioned PreToolUse-hook bypass) would otherwise leak it
  // into every real-spawn gate and make the block-expecting tests falsely pass exit 0.
  // An EXPLICIT opts.env value is preserved (applied after), so the sanctioned-bypass
  // test can still set it to exercise the kill switch on purpose.
  const { DITTO_SKIP_HOOKS: _inheritedKillSwitch, ...inheritedEnv } = process.env;
  const proc = Bun.spawnSync(['bun', cli, 'push-gate', ...(opts.args ?? [])], {
    cwd: dir,
    env: { ...inheritedEnv, ...(opts.env ?? {}) },
    stdin: new TextEncoder().encode(stdin),
  });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

function runGate(stdin: string, env: Record<string, string> = {}) {
  return runGateIn(workDir, stdin, { env });
}

async function writeRecipe(yaml: string) {
  await writeFile(join(workDir, 'recipe.yaml'), yaml, 'utf8');
}

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'ditto-pushgate-cli-'));
  // `.ditto` marker so findRepoRoot roots here (not the surrounding ditto repo).
  await mkdir(join(workDir, '.ditto'), { recursive: true });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('ditto push-gate (integration) — real recipe + real spawn', () => {
  test('protected branch + passing test_command ("true") → exit 0 (allow)', async () => {
    await writeRecipe('push_gate:\n  protected_branches:\n    - main\n  test_command: "true"\n');
    const r = runGate(PUSH_MAIN);
    expect(r.exitCode).toBe(0);
  });

  test('protected branch + failing test_command ("false") → non-zero (block)', async () => {
    await writeRecipe('push_gate:\n  protected_branches:\n    - main\n  test_command: "false"\n');
    const r = runGate(PUSH_MAIN);
    expect(r.exitCode).not.toBe(0);
  });

  test('non-protected branch → exit 0 (gate does not fire)', async () => {
    await writeRecipe('push_gate:\n  protected_branches:\n    - main\n  test_command: "false"\n');
    const r = runGate(PUSH_FEATURE);
    expect(r.exitCode).toBe(0);
  });

  test('"*" wildcard gates an unlisted branch (failing test → block)', async () => {
    await writeRecipe('push_gate:\n  protected_branches:\n    - "*"\n  test_command: "false"\n');
    const r = runGate(PUSH_FEATURE);
    expect(r.exitCode).not.toBe(0);
  });

  test('runner absent (test_command not found) → non-zero + guidance (fail-closed)', async () => {
    await writeRecipe(
      'push_gate:\n  protected_branches:\n    - main\n  test_command: "ditto-no-such-binary-zzz"\n',
    );
    const r = runGate(PUSH_MAIN);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/DITTO_SKIP_HOOKS/);
  });

  test('malformed recipe on a protected push → non-zero + guidance (fail-closed)', async () => {
    // `host: gitlab` is not in the canonical enum → schema-invalid → malformed.
    await writeRecipe('host: gitlab\n');
    const r = runGate(PUSH_MAIN);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/DITTO_SKIP_HOOKS/);
  });

  test('genuinely no recipe file → gate inactive → exit 0 (allow)', async () => {
    // no recipe.yaml written
    const r = runGate(PUSH_MAIN);
    expect(r.exitCode).toBe(0);
  });

  test('DITTO_SKIP_HOOKS=1 bypasses a failing gate → exit 0', async () => {
    await writeRecipe('push_gate:\n  protected_branches:\n    - main\n  test_command: "false"\n');
    const r = runGate(PUSH_MAIN, { DITTO_SKIP_HOOKS: '1' });
    expect(r.exitCode).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// ROOT-ONLY trust (wi_2606299kn ac-3): `ditto workspace sync` clones declared
// sub-repos into the workspace. A cloned sub-repo may ship its OWN
// `.ditto/recipe.yaml`; pushing from inside it must resolve the WORKSPACE-ROOT
// recipe — NEVER the sub-repo's own — else its `push_gate.test_command` is
// push-time RCE. `workDir` is the trusted workspace root (has `.ditto`).
// ───────────────────────────────────────────────────────────────────────────
describe('ditto push-gate — ROOT-ONLY trust: a cloned sub-repo never runs its OWN recipe (ac-3)', () => {
  /** Plant a cloned sub-repo `evil` whose OWN recipe would `touch` an RCE marker. */
  async function plantMaliciousSubRepo(): Promise<{ sub: string; pwned: string }> {
    const sub = join(workDir, 'evil');
    await mkdir(join(sub, '.ditto'), { recursive: true }); // the clone's own `.ditto`
    const pwned = join(workDir, 'PWNED');
    await writeFile(
      join(sub, 'recipe.yaml'),
      `push_gate:\n  protected_branches:\n    - main\n  test_command: "touch '${pwned}'"\n`,
    );
    return { sub, pwned };
  }

  test('push from inside a cloned sub-repo resolves the ROOT recipe, NOT the sub-repo own (walk-up)', async () => {
    // The ROOT recipe is the ONLY place a sub-repo may be declared trusted; here it
    // declares `evil` with NO gate of its own.
    await writeRecipe('repos:\n  - dir: evil\n');
    const { sub, pwned } = await plantMaliciousSubRepo();

    const r = runGateIn(sub, PUSH_MAIN);

    // INVARIANT: the cloned sub-repo's own test_command must NEVER execute.
    expect(existsSync(pwned)).toBe(false);
    // ROOT recipe declares `evil` without a gate → inactive → push allowed.
    expect(r.exitCode).toBe(0);
  });

  test('ROOT recipe gate for the sub-repo dir runs (not the sub-repo own gate)', async () => {
    // The root declares `evil` WITH its own (trusted) gate that FAILS → blocks the
    // push; the sub-repo's own `touch` command must still never run.
    await writeRecipe(
      'repos:\n  - dir: evil\n    push_gate:\n      protected_branches:\n        - main\n      test_command: "false"\n',
    );
    const { sub, pwned } = await plantMaliciousSubRepo();

    const r = runGateIn(sub, PUSH_MAIN);

    expect(existsSync(pwned)).toBe(false); // sub-repo's command never ran
    expect(r.exitCode).not.toBe(0); // the ROOT's `false` gate blocked the push
  });

  test('--workspace-root pins the trusted root (the N5-wired seam) over the sub-repo own', async () => {
    await writeRecipe('repos:\n  - dir: evil\n');
    const { sub, pwned } = await plantMaliciousSubRepo();

    // The installed sub-repo hook passes the absolute trusted workspace root.
    const r = runGateIn(sub, PUSH_MAIN, { args: ['--workspace-root', workDir] });

    expect(existsSync(pwned)).toBe(false);
    expect(r.exitCode).toBe(0);
  });

  test('NO regression: a normal single-repo push still resolves its OWN recipe', async () => {
    // workDir is a standalone repo (no parent declares it) → its own recipe governs.
    await writeRecipe('push_gate:\n  protected_branches:\n    - main\n  test_command: "false"\n');
    const r = runGateIn(workDir, PUSH_MAIN);
    expect(r.exitCode).not.toBe(0); // own gate fires and fails → blocked
  });
});

// ───────────────────────────────────────────────────────────────────────────
// UNIT — green-tree cache (wi_260706d0i): skip a re-run only on clean + exact
// tree match; record on a gate pass; dirty/mismatch always run the full command.
// ───────────────────────────────────────────────────────────────────────────
describe('execPushGate — green-tree cache', () => {
  const cacheOf = (trees: string[]) => ({
    trees: trees.map((t) => ({
      tree: t,
      recorded_at: '2026-07-07T00:00:00.000Z',
      command: 'bun test',
    })),
  });

  test('ac-1: clean tree recorded green → SKIP (runTest never called, cache-hit message)', async () => {
    const r = await execPushGate(
      input({
        runTest: never,
        treeState: { tree: 'abc', clean: true },
        greenCache: cacheOf(['abc']),
      }),
    );
    expect(r.exitCode).toBe(0);
    expect(r.message).toContain('green-tree cache hit');
  });

  test('ac-2: DIRTY tree with a matching hash still RUNS the gate (no skip)', async () => {
    let ran = false;
    const spy: RunTest = async () => {
      ran = true;
      return { kind: 'passed' };
    };
    const r = await execPushGate(
      input({
        runTest: spy,
        treeState: { tree: 'abc', clean: false },
        greenCache: cacheOf(['abc']),
      }),
    );
    expect(ran).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  test('ac-3: clean tree whose hash is NOT recorded → RUNS the gate', async () => {
    let ran = false;
    const spy: RunTest = async () => {
      ran = true;
      return { kind: 'passed' };
    };
    const r = await execPushGate(
      input({
        runTest: spy,
        treeState: { tree: 'zzz', clean: true },
        greenCache: cacheOf(['abc']),
      }),
    );
    expect(ran).toBe(true);
    expect(r.exitCode).toBe(0);
  });

  test('records the tree as green on a gate PASS (clean)', async () => {
    const recorded: Array<[string, string]> = [];
    await execPushGate(
      input({
        runTest: passes,
        treeState: { tree: 'newtree', clean: true },
        greenCache: cacheOf([]),
        recordGreen: (tree, command) => recorded.push([tree, command]),
      }),
    );
    expect(recorded).toEqual([['newtree', 'bun test']]);
  });

  test('does NOT record when a gate pass ran on a DIRTY tree (tested tree ≠ HEAD tree)', async () => {
    const recorded: Array<[string, string]> = [];
    await execPushGate(
      input({
        runTest: passes,
        treeState: { tree: 'newtree', clean: false },
        greenCache: cacheOf([]),
        recordGreen: (tree, command) => recorded.push([tree, command]),
      }),
    );
    expect(recorded).toEqual([]);
  });

  test('a cache HIT does not re-record (skip path never calls recordGreen)', async () => {
    const recorded: Array<[string, string]> = [];
    await execPushGate(
      input({
        runTest: never,
        treeState: { tree: 'abc', clean: true },
        greenCache: cacheOf(['abc']),
        recordGreen: (tree, command) => recorded.push([tree, command]),
      }),
    );
    expect(recorded).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// INTEGRATION — maybeRecordGreenForGate: the cross-tool producer (ac-4). Only a
// run of the gate's EXACT test_command on a clean tree primes the cache; a subset
// command or a failing run never does (the poison barrier).
// ───────────────────────────────────────────────────────────────────────────
describe('maybeRecordGreenForGate (cross-tool producer, ac-4)', () => {
  let dir: string;
  const git = (args: string[]) => Bun.spawnSync(['git', ...args], { cwd: dir });
  const readCache = (): GreenCache => {
    try {
      return JSON.parse(readFileSync(greenCachePath(dir), 'utf8')) as GreenCache;
    } catch {
      return { trees: [] };
    }
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ditto-greenprod-'));
    await mkdir(join(dir, '.ditto'), { recursive: true });
    await writeFile(join(dir, '.gitignore'), '.ditto/local/\n', 'utf8');
    await writeFile(
      join(dir, 'recipe.yaml'),
      'push_gate:\n  protected_branches: ["*"]\n  test_command: "bun test"\n',
      'utf8',
    );
    git(['init', '-q']);
    git(['config', 'user.email', 't@t']);
    git(['config', 'user.name', 't']);
    git(['add', '-A']);
    git(['commit', '-qm', 'init']);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('exact gate command + pass on a clean tree → records the HEAD tree', async () => {
    await maybeRecordGreenForGate(dir, 'bun test', 0);
    const tree = (
      Bun.spawnSync(['git', 'rev-parse', 'HEAD^{tree}'], { cwd: dir }).stdout?.toString() ?? ''
    ).trim();
    expect(readCache().trees.map((t) => t.tree)).toEqual([tree]);
  });

  test('a SUBSET command never records (poison barrier)', async () => {
    await maybeRecordGreenForGate(dir, 'bun test tests/foo.test.ts', 0);
    expect(readCache().trees).toEqual([]);
  });

  test('a FAILING run (exit ≠ 0) never records', async () => {
    await maybeRecordGreenForGate(dir, 'bun test', 1);
    expect(readCache().trees).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// UNIT — the E2E CI-evidence gate wired into execPushGate (wi_2607095fz). The
// EvidenceSource is INJECTED (a fake — no network), so the disposition, the
// cache-sequencing invariant (finding 7), and the "source is REACHED on the
// protected-push path" (not dead-wired) are all deterministic here.
// ───────────────────────────────────────────────────────────────────────────
describe('execPushGate — E2E CI-evidence gate (wi_2607095fz)', () => {
  const e2eGateCfg: RecipeE2eGate = {
    protected_branches: ['main'],
    evidence: { source: 'github-checks', check_name_template: 'e2e/{journey}' },
  };
  const LOGIN: JourneyEntry = { id: 'jrn-login', name: 'Login', excluded: false };

  /** A fake source that records the shas it was queried with and returns a fixed result. */
  function spySource(result: EvidenceQueryResult, calls: string[]): EvidenceSource {
    return {
      fetchCommitEvidence(_coord, sha) {
        calls.push(sha);
        return result;
      },
    };
  }
  /** A source that MUST NOT be consulted (throws) — proves the path short-circuits before it. */
  const throwingSource: EvidenceSource = {
    fetchCommitEvidence() {
      throw new Error('evidence source must not be consulted on this path');
    },
  };
  const allSuccess: EvidenceQueryResult = {
    ok: true,
    sha: 'a',
    checks: [{ name: 'e2e/jrn-login', status: 'completed', conclusion: 'success', head_sha: 'a' }],
  };

  function e2e(over: Partial<E2eGateWiring> = {}): E2eGateWiring {
    return {
      e2eGate: e2eGateCfg,
      journeys: [LOGIN],
      repoCoord: { repo: 'owner/name' },
      source: throwingSource,
      protectedBranches: ['main'],
      ...over,
    };
  }

  test('1. protected push + all mandatory checks success → ALLOW; source REACHED with the pushed sha', async () => {
    const calls: string[] = [];
    const r = await execPushGate(
      input({ runTest: passes, e2e: e2e({ source: spySource(allSuccess, calls) }) }),
    );
    expect(r.exitCode).toBe(0);
    // The wiring is LIVE, not dead: the injected source was queried for the exact
    // commit sha in the pushed ref (PUSH_MAIN's localSha is `a`).
    expect(calls).toContain('a');
  });

  test('2. a mandatory journey check missing → BLOCK with the per-journey message', async () => {
    const missing: EvidenceQueryResult = { ok: true, sha: 'a', checks: [] };
    const calls: string[] = [];
    const r = await execPushGate(
      input({ runTest: passes, e2e: e2e({ source: spySource(missing, calls) }) }),
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.message ?? '').toContain('jrn-login');
    expect(r.message ?? '').toMatch(/DITTO_SKIP_HOOKS/);
    expect(calls).toContain('a'); // the read happened
  });

  test('3. a gate.exclude journey is ignored → e2e passes (source never consulted)', async () => {
    // The only journey is excluded → 0 mandatory → engine degrades to PASS before any
    // fetch. throwingSource proves no read happens; the unit gate alone decides.
    const r = await execPushGate(
      input({ runTest: passes, e2e: e2e({ journeys: [{ ...LOGIN, excluded: true }] }) }),
    );
    expect(r.exitCode).toBe(0);
  });

  test('4. finding 7 (cache-sequencing): a green unit-cache hit does NOT bypass e2e — evidence absent still BLOCKS', async () => {
    // The tree hash is in the green cache, so the UNIT gate would short-circuit (skip,
    // runTest never). But e2e is evaluated FIRST and its evidence is unavailable → the
    // push BLOCKS. This is THE proof the cache can never let a doomed-on-e2e push through.
    const absent: EvidenceQueryResult = { ok: false, reason: 'source_absent' };
    const calls: string[] = [];
    const r = await execPushGate(
      input({
        runTest: never, // the unit run must never be reached; the block precedes it
        treeState: { tree: 'abc', clean: true },
        greenCache: {
          trees: [{ tree: 'abc', recorded_at: '2026-07-09T00:00:00.000Z', command: 'bun test' }],
        },
        e2e: e2e({ source: spySource(absent, calls) }),
      }),
    );
    expect(r.exitCode).not.toBe(0);
    expect(calls).toContain('a'); // e2e was evaluated (read attempted) BEFORE the cache
  });

  test('5. e2e_gate undefined → unit-only behavior unchanged; source never consulted', async () => {
    // Unit gate fails → block, purely on the unit path. e2e undefined → engine PASSes
    // before any fetch (ac-4 backward compat). throwingSource proves no e2e read.
    const r = await execPushGate(
      input({ runTest: fails, e2e: e2e({ e2eGate: undefined, protectedBranches: [] }) }),
    );
    expect(r.exitCode).not.toBe(0);
  });

  test('6. non-protected branch push → e2e not evaluated (no read), unit-only', async () => {
    const r = await execPushGate(input({ stdin: PUSH_FEATURE, runTest: never, e2e: e2e() }));
    expect(r.exitCode).toBe(0); // feature not in ['main'] for either gate → allow
  });

  test('7. DITTO_SKIP_HOOKS=1 bypasses BOTH gates (e2e source never consulted)', async () => {
    const r = await execPushGate(
      input({ env: { DITTO_SKIP_HOOKS: '1' }, runTest: never, e2e: e2e() }),
    );
    expect(r.exitCode).toBe(0);
  });

  test('8. evidence source unavailable (ok:false auth/timeout) → BLOCK (fail-closed), even with a passing unit gate', async () => {
    const timeout: EvidenceQueryResult = { ok: false, reason: 'timeout' };
    const r = await execPushGate(
      input({ runTest: passes, e2e: e2e({ source: spySource(timeout, []) }) }),
    );
    expect(r.exitCode).not.toBe(0);
    expect(r.message ?? '').toMatch(/DITTO_SKIP_HOOKS/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// UNIT — loadJourneyEntries (Task 3): journey membership from disk. gate.exclude
// maps to `excluded`; a MALFORMED journey becomes `unparseable` (never dropped) so
// it BLOCKS when not excluded; no journeys dir → empty list.
// ───────────────────────────────────────────────────────────────────────────
describe('loadJourneyEntries — journey membership from disk (findings 6/10)', () => {
  function journeyDoc(id: string, name: string, opts: { exclude?: boolean } = {}): string {
    const gate = opts.exclude ? ['gate:', '  exclude: true', '  exclude_reason: retired flow'] : [];
    return [
      '---',
      'ditto_journey: v2',
      `id: ${id}`,
      `name: ${name}`,
      `description: ${name} coverage`,
      'surfaces:',
      '  - "page:/x"',
      `implementation_intent: verify ${name}`,
      ...gate,
      '---',
      '',
      '1. [s1] does something',
      '',
    ].join('\n');
  }

  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ditto-journeys-'));
    await mkdir(join(dir, 'e2e', 'journeys'), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('maps gate.exclude, keeps mandatory, flags a malformed journey unparseable (never dropped)', async () => {
    const jd = join(dir, 'e2e', 'journeys');
    await writeFile(join(jd, 'login.journey.md'), journeyDoc('jrn-login', 'Login'));
    await writeFile(
      join(jd, 'legacy.journey.md'),
      journeyDoc('jrn-legacy', 'Legacy', { exclude: true }),
    );
    await writeFile(join(jd, 'broken.journey.md'), 'not a journey — no front matter');

    const byId = Object.fromEntries(loadJourneyEntries(dir).map((e) => [e.id, e]));
    expect(byId['jrn-login']?.excluded).toBe(false);
    expect(byId['jrn-legacy']?.excluded).toBe(true);
    // malformed → unparseable + NOT excluded (so it BLOCKS), keyed by the filename slug.
    expect(byId.broken?.unparseable).toBe(true);
    expect(byId.broken?.excluded).toBe(false);
  });

  test('no journeys dir → empty list (engine then degrades on 0 mandatory)', () => {
    expect(loadJourneyEntries(join(tmpdir(), 'ditto-no-such-dir-zzz-9271'))).toEqual([]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// SETUP hook install (Task 2 — the dead-wire gotcha): an e2e_gate-only project
// (no push_gate) must ALSO get the pre-push hook, else the gate never fires.
// ───────────────────────────────────────────────────────────────────────────
describe('setup() installs the pre-push hook for an e2e_gate-only project (Task 2)', () => {
  test('e2eGate option (no pushGate) → hook installed', async () => {
    const resourcesDir = await mkdtemp(join(tmpdir(), 'ditto-e2ehook-res-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'ditto-e2ehook-proj-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'ditto-e2ehook-home-'));
    execFileSync('git', ['init', '-q', '.'], { cwd: projectRoot });
    try {
      const result = await setup({
        resourcesDir,
        projectRoot,
        homeDir,
        now: new Date('2026-07-09T00:00:00.000Z'),
        host: 'claude-code',
        e2eGate: true, // e2e_gate present, NO push_gate
        hookTemplatePath: join(process.cwd(), 'resources', 'hooks', 'pre-push'),
      });
      expect(result.pushGateHook?.status).toBe('installed');
      const hookPath = join(projectRoot, '.git', 'hooks', 'pre-push');
      expect(await readFile(hookPath, 'utf8')).toContain(PUSH_GATE_HOOK_MARKER);
    } finally {
      await rm(resourcesDir, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// INTEGRATION — the REAL `ditto push-gate` run handler reaches the e2e gate on
// the runtime path (NOT dead-wired). Deterministic + NETWORK-FREE: a malformed
// mandatory journey BLOCKS inside verifyE2eEvidence BEFORE any CI fetch, so no gh
// spawn is needed. The recipe has NO push_gate — the ONLY thing that can block is
// the e2e gate, so a block proves the handler wired e2e end-to-end.
// ───────────────────────────────────────────────────────────────────────────
describe('ditto push-gate (integration) — e2e gate reached on the runtime path', () => {
  const E2E_RECIPE =
    'e2e_gate:\n  protected_branches:\n    - main\n  evidence:\n    repo: owner/name\n';

  async function seedMalformedJourney() {
    const jd = join(workDir, 'e2e', 'journeys');
    await mkdir(jd, { recursive: true });
    // No front-matter → loadJourneyEntries marks it unparseable (never dropped).
    await writeFile(join(jd, 'broken.journey.md'), 'not a journey — no front matter\n');
  }

  test('protected push + e2e_gate + a malformed mandatory journey → BLOCK (fail-closed, no network)', async () => {
    await writeRecipe(E2E_RECIPE);
    await seedMalformedJourney();
    const r = runGate(PUSH_MAIN);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr).toMatch(/e2e/i);
    expect(r.stderr).toMatch(/DITTO_SKIP_HOOKS/);
  });

  test('non-protected push + same e2e_gate → exit 0 (gate evaluated, does not fire off main)', async () => {
    await writeRecipe(E2E_RECIPE);
    await seedMalformedJourney();
    const r = runGate(PUSH_FEATURE);
    expect(r.exitCode).toBe(0);
  });
});
