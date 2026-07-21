import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { boundaryEnvelope, type HostAdapter } from '../seam/host-adapter';
import { decideGate } from '../schemas';
import type { CodexDeps } from '../verify/codex';
import type { QueueState } from '../state/queue-state';
import {
  runDrive,
  checkOracleIntegrity,
  writeQueueStateAtomic,
  type AtomicFs,
  type DriveDeps,
  type DriveConfig,
} from './outer-loop';

/**
 * ac-1 (autonomous drive loop → queue-drain) + ac-6 (ABSOLUTE_ROUND_CEILING).
 * The HostAdapter is MOCKED — this is a unit-tier test, NO real claude/codex
 * process ever runs. Each test pins one folded coverage finding as a red-first
 * assertion: fixpoint drain / no-progress→park / churn→round-ceiling /
 * timeout→escape / torn-write→atomic recovery / oracle-mutation→reject.
 */

const ORACLE = 'rebuild/hook/stop-gate.ts';

// A mock host: scripted boundary per round (function of round index), or a
// `hang` that never resolves so the loop's timeout must fire.
class MockHost implements HostAdapter {
  private round = 0;
  constructor(
    private readonly opts: {
      boundary?: (round: number) => unknown;
      hang?: boolean;
    },
  ) {}
  driveStep(input: { prompt: string; resume?: string }) {
    if (this.opts.hang) return new Promise<never>(() => {}); // never resolves
    const raw = this.opts.boundary!(this.round);
    this.round += 1;
    return Promise.resolve({
      sessionId: input.resume ?? `sess-${this.round}`,
      boundary: boundaryEnvelope.parse(raw),
    });
  }
  stopGate(signal: { outcome?: 'pass' | 'fail'; grounds?: string }) {
    return decideGate(signal);
  }
  fanout() {
    return Promise.resolve([]);
  }
  readSidecar<T>(): Promise<T> {
    return Promise.reject(new Error('not used'));
  }
}

function seedState(): QueueState {
  return {
    round: 0,
    items: [
      { id: 'q1', kind: 'unverified-ac', exit: null, evidence_ref: null, disposition_note: null },
      { id: 'q2', kind: 'in-scope-residual', exit: null, evidence_ref: null, disposition_note: null },
    ],
    acceptance_criteria: [
      { id: 'ac-1', status: 'unverified', evidence_ref: null },
      { id: 'ac-6', status: 'unverified', evidence_ref: null },
    ],
    last_stop_hook: null,
    backstop: { turns: 0, no_progress_rounds: 0, queue_size_trend: [] },
    blocker: null,
  };
}

const verifiedCodex = (): CodexDeps => ({
  which: () => '/usr/local/bin/codex',
  run: () => ({ exitCode: 0, lastMessage: 'evidence holds\nVERDICT: verified', stderr: '' }),
});

function makeDeps(overrides: Partial<DriveDeps> = {}): {
  deps: DriveDeps;
  writes: QueueState[];
} {
  const writes: QueueState[] = [];
  const deps: DriveDeps = {
    readState: () => seedState(),
    writeState: (s) => {
      writes.push(structuredClone(s));
    },
    readOracleContent: () => 'FROZEN-ORACLE-BODY',
    roundDiff: () => [],
    codex: verifiedCodex(),
    ...overrides,
  };
  return { deps, writes };
}

function cfg(overrides: Partial<DriveConfig> = {}): DriveConfig {
  return {
    absoluteRoundCeiling: 20,
    maxNoProgressRounds: 5,
    timeoutMs: 1000,
    oraclePaths: [ORACLE],
    ...overrides,
  };
}

const q = (id: string, kind: string, exit?: string) =>
  exit ? { id, kind, exit } : { id, kind };

describe('runDrive — autonomous queue-drain (ac-1)', () => {
  test('fixpoint drain: resolves every item over rounds → outcome drained, persisted each round', async () => {
    // round 0: q1 resolved, q2 still open; round 1+: both resolved → drained.
    const host = new MockHost({
      boundary: (round) => ({
        queue: [
          q('q1', 'unverified-ac', 'resolved'),
          round >= 1 ? q('q2', 'in-scope-residual', 'resolved') : q('q2', 'in-scope-residual'),
        ],
        gate: { decision: 'pass', grounds: 'bun test rebuild/ → green' },
      }),
    });
    const { deps, writes } = makeDeps();
    const res = await runDrive(host, deps, cfg());

    expect(res.outcome).toBe('drained');
    expect(res.rounds).toBe(2);
    // Every open item eventually took its exit door (completion-as-fixpoint).
    expect(res.state.items.every((i) => i.exit !== null)).toBe(true);
    // Persisted at least once per accepted round (atomic writer path).
    expect(writes.length).toBeGreaterThanOrEqual(2);
    // net-efficacy recorded per round.
    expect(res.efficacy.length).toBe(2);
  });

  test('completion authority (maker≠checker) gates the final drain: codex refuted → parked, not drained', async () => {
    const host = new MockHost({
      boundary: () => ({
        queue: [q('q1', 'unverified-ac', 'resolved'), q('q2', 'in-scope-residual', 'resolved')],
        gate: { decision: 'pass', grounds: 'green' },
      }),
    });
    const refutingCodex: CodexDeps = {
      which: () => '/usr/local/bin/codex',
      run: () => ({ exitCode: 0, lastMessage: 'no\nVERDICT: refuted', stderr: '' }),
    };
    const { deps } = makeDeps({ codex: refutingCodex });
    const res = await runDrive(host, deps, cfg());
    expect(res.outcome).toBe('parked');
    expect(res.state.blocker).toContain('completion withheld');
  });
});

describe('runDrive — negative backstop (no-progress → park)', () => {
  test('a run that resolves nothing accrues no_progress_rounds → backstop trips → parked', async () => {
    const host = new MockHost({
      boundary: () => ({
        // nothing resolved: open stays 2 every round.
        queue: [q('q1', 'unverified-ac'), q('q2', 'in-scope-residual')],
        gate: { decision: 'pass', grounds: 'ran but nothing moved' },
      }),
    });
    const { deps } = makeDeps();
    const res = await runDrive(host, deps, cfg({ maxNoProgressRounds: 2, absoluteRoundCeiling: 20 }));
    expect(res.outcome).toBe('parked');
    expect(res.rounds).toBe(2);
    expect(res.state.blocker).toContain('backstop');
  });
});

describe('runDrive — ABSOLUTE_ROUND_CEILING (ac-6, independent of heuristics)', () => {
  test('churn-livelock that evades the progress heuristics is still stopped by the hard round cap', async () => {
    // Churn: open oscillates 1,2,1,... — never drains, never monotonic-growing,
    // never accrues enough no-progress rounds. Only the absolute cap can stop it.
    const host = new MockHost({
      boundary: (round) => ({
        queue: [
          round % 2 === 0 ? q('q1', 'unverified-ac', 'resolved') : q('q1', 'unverified-ac'),
          q('q2', 'in-scope-residual'), // q2 never resolves → never drained
        ],
        gate: { decision: 'pass', grounds: 'churn' },
      }),
    });
    const { deps } = makeDeps();
    // Heuristics deliberately disabled (very high thresholds) to isolate the cap.
    const res = await runDrive(
      host,
      deps,
      cfg({ absoluteRoundCeiling: 3, maxNoProgressRounds: 1000 }),
    );
    expect(res.outcome).toBe('ceiling');
    expect(res.rounds).toBe(3);
    expect(res.state.blocker).toContain('ABSOLUTE_ROUND_CEILING');
  });
});

describe('runDrive — per-subprocess timeout (time-clock)', () => {
  test('a stalled driveStep does not hang the loop: it times out and escapes', async () => {
    const host = new MockHost({ hang: true });
    const { deps } = makeDeps();
    const start = Date.now();
    const res = await runDrive(host, deps, cfg({ timeoutMs: 20 }));
    const elapsed = Date.now() - start;
    expect(res.outcome).toBe('timeout');
    expect(res.state.blocker).toContain('timed out');
    // Escaped promptly rather than hanging on the never-resolving driveStep.
    expect(elapsed).toBeLessThan(2000);
  });
});

describe('runDrive — oracle-integrity (folds ac-2/ac-3/ac-5): reject a round that touches oracle files', () => {
  test('round diff touches an oracle path → round rejected/reverted, outcome oracle-violation', async () => {
    const host = new MockHost({
      boundary: () => ({
        queue: [q('q1', 'unverified-ac', 'resolved'), q('q2', 'in-scope-residual', 'resolved')],
        gate: { decision: 'pass', grounds: 'green but touched an oracle file' },
      }),
    });
    const { deps } = makeDeps({ roundDiff: () => [ORACLE] });
    const res = await runDrive(host, deps, cfg());
    expect(res.outcome).toBe('oracle-violation');
    // Reverted: the mutation was NOT accepted, so nothing drained.
    expect(res.state.items.every((i) => i.exit === null)).toBe(true);
    expect(res.state.blocker).toContain('oracle');
  });

  test('oracle file content changes between capture and check (hash-freeze breach) → oracle-violation', async () => {
    let call = 0;
    const host = new MockHost({
      boundary: () => ({
        queue: [q('q1', 'unverified-ac', 'resolved'), q('q2', 'in-scope-residual', 'resolved')],
        gate: { decision: 'pass', grounds: 'green' },
      }),
    });
    // First read (capture-window) = frozen body; later read = altered body.
    const { deps } = makeDeps({
      readOracleContent: () => (call++ === 0 ? 'FROZEN-ORACLE-BODY' : 'WEAKENED-ORACLE-BODY'),
    });
    const res = await runDrive(host, deps, cfg());
    expect(res.outcome).toBe('oracle-violation');
    expect(res.state.blocker).toContain('oracle');
  });
});

describe('checkOracleIntegrity — pure, injectable (no real git)', () => {
  test('denylist: a touched oracle path is rejected', () => {
    const r = checkOracleIntegrity({
      touched: ['rebuild/drive/outer-loop.ts', ORACLE],
      oraclePaths: [ORACLE],
      capturedHashes: {},
      currentContent: {},
    });
    expect(r.ok).toBe(false);
    expect(r.reasons.join(' ')).toContain(ORACLE);
  });

  test('hash-freeze: an altered oracle body is rejected even if the diff did not list it', () => {
    const captured = { [ORACLE]: 'hash-of-frozen' };
    const r = checkOracleIntegrity({
      touched: [],
      oraclePaths: [ORACLE],
      capturedHashes: captured,
      currentContent: { [ORACLE]: 'a different body' },
    });
    expect(r.ok).toBe(false);
  });

  test('deleted oracle file is rejected', () => {
    const r = checkOracleIntegrity({
      touched: [],
      oraclePaths: [ORACLE],
      capturedHashes: { [ORACLE]: 'x' },
      currentContent: { [ORACLE]: null },
    });
    expect(r.ok).toBe(false);
  });

  test('untouched + intact oracle → ok', () => {
    const body = 'intact frozen body';
    const { hashTestContent } = require('../verify/red-first');
    const r = checkOracleIntegrity({
      touched: ['rebuild/drive/outer-loop.ts'],
      oraclePaths: [ORACLE],
      capturedHashes: { [ORACLE]: hashTestContent(body) },
      currentContent: { [ORACLE]: body },
    });
    expect(r.ok).toBe(true);
  });
});

describe('writeQueueStateAtomic — temp-file + rename, never a direct rewrite (data-integrity)', () => {
  test('writes to a temp path and only then renames onto the target', () => {
    const calls: string[] = [];
    const fakeFs: AtomicFs = {
      writeFile: (path) => calls.push(`write:${path}`),
      rename: (from, to) => calls.push(`rename:${from}->${to}`),
    };
    writeQueueStateAtomic('/w/state/queue.json', seedState(), fakeFs);
    expect(calls[0]).toBe('write:/w/state/queue.json.tmp');
    expect(calls[1]).toBe('rename:/w/state/queue.json.tmp->/w/state/queue.json');
    // The target file is never written directly.
    expect(calls.some((c) => c === 'write:/w/state/queue.json')).toBe(false);
  });

  test('torn write (crash before rename) leaves the previous good file intact (atomic recovery)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'outer-loop-atomic-'));
    const target = join(dir, 'queue.json');
    try {
      // A previously-good committed state on disk.
      const good = seedState();
      writeFileSync(target, `${JSON.stringify(good, null, 2)}\n`);

      // Simulate a crash: the temp write happens but rename throws before commit.
      const crashingFs: AtomicFs = {
        writeFile: (path, data) => writeFileSync(path, data),
        rename: () => {
          throw new Error('simulated crash before rename commit');
        },
      };
      const next = { ...seedState(), round: 99 };
      expect(() => writeQueueStateAtomic(target, next, crashingFs)).toThrow();

      // The target still holds the ORIGINAL good state — never a torn/partial file.
      const onDisk = JSON.parse(readFileSync(target, 'utf8')) as QueueState;
      expect(onDisk.round).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
