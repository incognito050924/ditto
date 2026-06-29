import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ExecPushGateInput, type RunTest, execPushGate } from '~/cli/commands/push-gate';
import type { RecipePushGate } from '~/schemas/recipe';

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

function runGate(stdin: string, env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(['bun', cli, 'push-gate'], {
    cwd: workDir,
    env: { ...process.env, ...env },
    stdin: new TextEncoder().encode(stdin),
  });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
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
