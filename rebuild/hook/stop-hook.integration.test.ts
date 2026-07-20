import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseQueueState } from '../state/queue-state';

// ac-2 evidence: the REAL command Stop hook, spawned as a subprocess, runs a
// REAL bun test runner and gates the stop: red → exit 2, green → exit 0.

const HOOK = join(import.meta.dir, 'stop-hook.ts');
const workspaces: string[] = [];

function makeWorkspace(stateOverride: Record<string, unknown> = {}) {
  const ws = mkdtempSync(join(tmpdir(), 'vehicle-hook-'));
  workspaces.push(ws);
  mkdirSync(join(ws, 'state'), { recursive: true });
  const state = {
    round: 1,
    items: [
      {
        id: 'i1',
        kind: 'found-defect',
        exit: 'resolved',
        evidence_ref: 'ref#1',
        disposition_note: 'done',
      },
    ],
    acceptance_criteria: [
      { id: 'ac-1', status: 'pass', evidence_ref: 'log#1' },
    ],
    last_stop_hook: null,
    backstop: { turns: 1, no_progress_rounds: 0, queue_size_trend: [1] },
    blocker: null,
    ...stateOverride,
  };
  writeFileSync(join(ws, 'state', 'queue.json'), JSON.stringify(state, null, 2));
  return ws;
}

function writeFixtureTest(ws: string, pass: boolean): string {
  const p = join(ws, `fixture.test.ts`);
  const expr = pass ? 'expect(1).toBe(1)' : 'expect(1).toBe(2)';
  writeFileSync(
    p,
    `import { test, expect } from 'bun:test';\ntest('fixture', () => { ${expr}; });\n`,
  );
  return p;
}

function runHook(ws: string, testCmd: string) {
  const proc = Bun.spawnSync(['bun', HOOK], {
    cwd: ws,
    env: {
      ...process.env,
      VEHICLE_WORKSPACE: ws,
      VEHICLE_TEST_CMD: testCmd,
    },
    stdin: new TextEncoder().encode(JSON.stringify({ stop_hook_active: false })),
  });
  return {
    exitCode: proc.exitCode,
    stderr: new TextDecoder().decode(proc.stderr),
  };
}

afterAll(() => {
  for (const ws of workspaces) rmSync(ws, { recursive: true, force: true });
});

describe('command Stop hook — real runner, two paths (ac-2)', () => {
  test('GREEN: real passing test + drained state → exit 0', () => {
    const ws = makeWorkspace();
    const fixture = writeFixtureTest(ws, true);
    const r = runHook(ws, `bun test ${fixture}`);
    expect(r.exitCode).toBe(0);
    // last_stop_hook recorded with exit_code 0.
    const state = parseQueueState(
      readFileSync(join(ws, 'state', 'queue.json'), 'utf8'),
    );
    expect(state.last_stop_hook?.exit_code).toBe(0);
    expect(state.last_stop_hook?.command).toContain('bun test');
  });

  test('RED: real failing test → exit 2 blocks stop, cites "red"', () => {
    const ws = makeWorkspace();
    const fixture = writeFixtureTest(ws, false);
    const r = runHook(ws, `bun test ${fixture}`);
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toLowerCase()).toContain('red');
    const state = parseQueueState(
      readFileSync(join(ws, 'state', 'queue.json'), 'utf8'),
    );
    expect(state.last_stop_hook?.exit_code).toBe(2);
  });

  test('PENDING: green tests but a pending queue item → exit 2', () => {
    const ws = makeWorkspace({
      items: [
        {
          id: 'i2',
          kind: 'in-scope-residual',
          exit: null,
          evidence_ref: null,
          disposition_note: null,
        },
      ],
    });
    const fixture = writeFixtureTest(ws, true);
    const r = runHook(ws, `bun test ${fixture}`);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('pending');
  });

  test('AC OVER-CLAIM: green tests but a pass-AC without evidence → exit 2', () => {
    const ws = makeWorkspace({
      acceptance_criteria: [
        { id: 'ac-9', status: 'pass', evidence_ref: null },
      ],
    });
    const fixture = writeFixtureTest(ws, true);
    const r = runHook(ws, `bun test ${fixture}`);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('ac-9');
  });

  test('FAIL-CLOSED: missing state/queue.json → exit 2', () => {
    const ws = mkdtempSync(join(tmpdir(), 'vehicle-hook-nostate-'));
    workspaces.push(ws);
    const fixture = writeFixtureTest(ws, true);
    const r = runHook(ws, `bun test ${fixture}`);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('fail-closed');
  });
});
