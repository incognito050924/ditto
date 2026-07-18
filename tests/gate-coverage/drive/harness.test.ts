// Drive-harness assertions (wi_260718srh, n6) — encodes ac-3 (LLM-free execution-path
// per-defect catch) and the pre-mortem constraints (a)-(h). Each `describe` names the
// constraint it pins so the approver/consumer read the intent, not just the assertion.

import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CorpusEntry,
  type CorpusManifest,
  type DriveResult,
  assertNoHarnessErrors,
  catchMap,
  catchRate,
  driveCorpus,
  driveDefect,
  loadCorpus,
} from './harness';

const CORPUS: CorpusManifest = loadCorpus();
const targeted = (m: CorpusManifest): CorpusEntry[] => m.defects.filter((d) => !d.is_expected_miss);

// ── (h) per-defect ≥1-gate sensitivity oracle ────────────────────────────────
// Each targeted seeded defect MUST be caught by its expected gate. An escape here is a
// LOUD CI failure — that is the whole point of the corpus. Expected-miss are excluded.
describe('(h) per-defect sensitivity: every targeted defect is caught', () => {
  const results = driveCorpus(CORPUS);
  const byId = new Map(results.map((r) => [r.defect_id, r]));

  for (const entry of targeted(CORPUS)) {
    test(`${entry.defect_id} → ${entry.expected_gate_id} FAILs (caught)`, () => {
      const r = byId.get(entry.defect_id) as DriveResult;
      expect(r.verdict).toBe('caught');
      expect(r.expected_gate_id).toBe(entry.expected_gate_id);
      // A real catch carries the gate's FAIL reasons (evidence for the n7 report).
      expect((r.reasons ?? []).length).toBeGreaterThan(0);
    });
  }

  test('specificity: each clean_pair PASSes the SAME gate (catch is defect-specific, not "always-fail")', () => {
    // Guards against a false-positive catch from a gate that fails on any input: the
    // clean control must PASS the very gate the defect fails.
    for (const entry of targeted(CORPUS)) {
      const clean = driveDefect({ ...entry, fixture_state: entry.clean_pair });
      expect(clean.verdict).toBe('missed'); // "missed" == gate PASSed on the clean control
    }
  });

  test('all 7 targeted caught, both expected-miss are n/a', () => {
    expect(results.filter((r) => r.verdict === 'caught')).toHaveLength(7);
    expect(results.filter((r) => r.verdict === 'n/a')).toHaveLength(2);
    expect(results.filter((r) => r.verdict === 'missed')).toHaveLength(0);
  });
});

// ── (b) HARNESS_ERROR is a separate tier, never a silent miss ─────────────────
describe('(b) HARNESS_ERROR tier: a throwing drive is classified apart from missed', () => {
  test('a gate that throws yields harness_error, NOT missed', () => {
    // Synthetic entry whose fixture_state makes the convergence gate throw (null.versions).
    const r = driveDefect({
      defect_id: 'synthetic-throw',
      expected_gate_id: 'convergence',
      fixture_state: null,
      clean_pair: {},
      is_expected_miss: false,
    } as CorpusEntry);
    expect(r.verdict).toBe('harness_error');
    expect(r.verdict).not.toBe('missed');
    expect(r.error).toBeTruthy();
  });

  test('assertNoHarnessErrors throws loud when any harness_error is present', () => {
    const broken: DriveResult[] = [
      { defect_id: 'x', expected_gate_id: 'convergence', verdict: 'harness_error', error: 'boom' },
    ];
    expect(() => assertNoHarnessErrors(broken)).toThrow(/HARNESS_ERROR/);
  });

  test('the real corpus drive contains zero harness_errors (loud backstop passes)', () => {
    expect(() => assertNoHarnessErrors(driveCorpus(CORPUS))).not.toThrow();
  });
});

// ── (f) ordering-permutation determinism ─────────────────────────────────────
describe('(f) ordering: original vs deterministic shuffle → identical catch map', () => {
  // Deterministic permutations only — NO Math.random (unavailable / non-deterministic here).
  const permute = (m: CorpusManifest, order: (d: CorpusEntry[]) => CorpusEntry[]): CorpusManifest => ({
    ...m,
    defects: order([...m.defects]),
  });
  const reversed = permute(CORPUS, (d) => d.reverse());
  const byIdDesc = permute(CORPUS, (d) => d.sort((a, b) => (a.defect_id < b.defect_id ? 1 : -1)));

  const base = catchMap(driveCorpus(CORPUS));

  test('reversed order gives the same per-defect verdicts', () => {
    expect(catchMap(driveCorpus(reversed))).toEqual(base);
  });
  test('defect_id-descending order gives the same per-defect verdicts', () => {
    expect(catchMap(driveCorpus(byIdDesc))).toEqual(base);
  });
});

// ── (g) config(threshold) pinned by corpus → stable catch-rate on re-run ──────
describe('(g) threshold pin: same corpus driven twice → identical catch-rate', () => {
  test('catch-rate is env-independent and repeatable', () => {
    // Thresholds (e.g. interview readiness 0.7) are pinned in each fixture_state, not read
    // from env — so a second identical drive yields the identical rate.
    const rate1 = catchRate(driveCorpus(CORPUS));
    const rate2 = catchRate(driveCorpus(loadCorpus()));
    expect(rate1).toBe(1); // all 7 targeted caught
    expect(rate2).toBe(rate1);
  });
});

// ── (c) per-scenario isolation ───────────────────────────────────────────────
describe('(c) isolation: drives share no mutable state', () => {
  test('driving one defect does not perturb another (pure functions)', () => {
    const before = catchMap(driveCorpus(CORPUS));
    // Interleave an unrelated (throwing) drive; the corpus result must be unchanged.
    driveDefect({
      defect_id: 'noise',
      expected_gate_id: 'convergence',
      fixture_state: undefined,
      clean_pair: {},
      is_expected_miss: false,
    } as CorpusEntry);
    expect(catchMap(driveCorpus(CORPUS))).toEqual(before);
  });
});

// ── (a) egress: no gh / subprocess is ever spawned ───────────────────────────
// PRIMARY guarantee is structural: this harness calls only pure gate functions and
// never enters the autopilot loop / resolveTarget / directPostDecisions, so no
// subprocess can spawn regardless of work-item coordinates (no src/core change). Below
// is the POSITIVE proof: a recording `gh` stub on PATH is asserted at zero invocations.
describe('(a) hermeticity: driving the corpus spawns gh zero times', () => {
  let bin: string;
  let counter: string;
  const savedPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = savedPath;
    if (bin && existsSync(bin)) rmSync(bin, { recursive: true, force: true });
  });

  test('a PATH-mounted recording gh stub records 0 calls', () => {
    bin = mkdtempSync(join(tmpdir(), 'drive-egress-'));
    counter = join(bin, 'gh.calls');
    const stub = join(bin, 'gh');
    writeFileSync(stub, `#!/bin/sh\necho called >> "${counter}"\nexit 0\n`);
    chmodSync(stub, 0o755);
    process.env.PATH = `${bin}:${savedPath}`;

    // Drive the whole corpus with the stub live on PATH.
    const results = driveCorpus(CORPUS);
    assertNoHarnessErrors(results);

    // The stub was never invoked → the counter file was never created.
    expect(existsSync(counter)).toBe(false);
  });
});

// ── (d) iteration cap + timeout, (e) blocked=terminal ────────────────────────
// N/A by design: this harness drives PURE gate verdict functions and never runs the
// autopilot loop. There is no iteration to cap, no non-terminating fixture, and no
// `blocked` loop-state to re-poll. Recorded here explicitly so the omission is a
// deliberate, reasoned N/A (per the packet) — not a forgotten constraint.
describe('(d)/(e) N/A: pure runGate, no loop to cap or to reach a blocked state', () => {
  test('the drive path invokes no loop iteration primitive (documented N/A)', () => {
    // Nothing to assert behaviorally; the corpus drive is a single synchronous map over
    // pure functions (see driveCorpus). This test pins the N/A rationale in the suite.
    expect(driveCorpus(CORPUS)).toHaveLength(CORPUS.defects.length);
  });
});
