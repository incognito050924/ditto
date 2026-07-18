// Per-gate catch-rate + specificity REPORT assertions (wi_260718srh, n7).
//
// WHY this file exists: it pins the n7 report contract (design-note + pre-mortem) so the
// approver/consumer read the intent, not just the assertion. Each `describe` names the AC
// clause / pre-mortem distinction it encodes. The report is derived ONLY from the n6 drive
// tuples (gate_id, verdict, defect_id) + the n5 corpus/runGate specificity control — NO raw
// timestamp, NO synthesizeDecisionId, NO Date.now/Math.random (clock-free, ac-6).

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_ID, type GateId } from '~/core/gates';
import { type DriveResult, driveCorpus, loadCorpus } from '../drive/harness';
import { type GateCoverageReport, buildReport } from './report';

const CORPUS = loadCorpus();
const HERE = dirname(fileURLToPath(import.meta.url));
const ALL_GATE_IDS = Object.values(GATE_ID) as GateId[];

const report = (): GateCoverageReport => buildReport(CORPUS, driveCorpus(CORPUS));

// ── ac-4 / MUST-DO 1: 16-gate rows, per-gate catch-rate + specificity ─────────
describe('16-gate iteration: every GATE_ID gets a row with catch-rate + specificity', () => {
  test('report enumerates all 16 GATE_IDs in canonical order', () => {
    const r = report();
    expect(r.gates.map((g) => g.gate_id)).toEqual(ALL_GATE_IDS);
    expect(r.gates).toHaveLength(16);
  });

  test('the 7 targeted gates have catch_rate 1 and specificity 1 (clean_pair PASSes)', () => {
    const r = report();
    const targetedGateIds = new Set(
      CORPUS.defects.filter((d) => !d.is_expected_miss).map((d) => d.expected_gate_id as GateId),
    );
    expect(targetedGateIds.size).toBe(7);
    for (const row of r.gates) {
      if (targetedGateIds.has(row.gate_id)) {
        expect(row.targeted).toBeGreaterThan(0);
        expect(row.catch_rate).toBe(1); // caught/targeted, all caught
        expect(row.specificity).toBe(1); // clean control PASSes the SAME gate
        expect(row.catch0).toBeNull(); // healthy: nothing missed
      }
    }
  });
});

// ── denominator-0 → N/A (coverage gap), NOT 0% ────────────────────────────────
describe('denominator-0: targeted==0 → catch_rate = N/A, never 0%', () => {
  test('an untargeted gate row reports N/A (not 0) for catch_rate and specificity', () => {
    const r = report();
    const untargeted = r.gates.find((g) => g.targeted === 0);
    expect(untargeted).toBeTruthy();
    expect((untargeted as GateCoverageReport['gates'][number]).catch_rate).toBe('N/A');
    expect((untargeted as GateCoverageReport['gates'][number]).specificity).toBe('N/A');
  });

  test('untargeted_gates = the 9 GATE_IDs with no targeted defect', () => {
    const r = report();
    expect(r.untargeted_gates).toHaveLength(16 - 7);
    // Every untargeted gate has targeted==0.
    for (const g of r.untargeted_gates) {
      const row = r.gates.find((x) => x.gate_id === g);
      expect(row?.targeted).toBe(0);
    }
  });

  test('defensive: report asserts ≥1 real (targeted) defect — vacuous corpus is rejected', () => {
    expect(report().has_real_defect).toBe(true);
    // A corpus of ONLY expected-miss entries would let every catch_rate be a vacuous N/A;
    // buildReport must refuse it so an empty/all-miss corpus cannot pass silently.
    const vacuous = {
      ...CORPUS,
      defects: CORPUS.defects.filter((d) => d.is_expected_miss),
    };
    expect(() => buildReport(vacuous, driveCorpus(vacuous))).toThrow(/real defect|targeted/i);
  });
});

// ── ac-5 catch-0 taxonomy: untargeted vs targeted-but-missed vs unreachable ────
describe('catch-0 taxonomy: 3 distinct kinds, untargeted is NOT dead', () => {
  test('untargeted gates are classified "untargeted" and are NOT dead candidates', () => {
    const r = report();
    for (const g of r.untargeted_gates) {
      const row = r.gates.find((x) => x.gate_id === g);
      expect(row?.catch0).toBe('untargeted');
      expect(row?.is_dead_candidate).toBe(false);
    }
    // untargeted gates never leak into dead_candidates.
    for (const g of r.untargeted_gates) {
      expect(r.dead_candidates).not.toContain(g);
    }
  });

  test('a targeted gate that MISSED is classified "targeted-but-missed" and IS a dead candidate', () => {
    // Synthesize a drive result where a targeted gate PASSed the seeded state (escape).
    // Reuse a REAL corpus defect (valid clean_pair, so specificity via runGate works) but
    // force its verdict to `missed`.
    const real = CORPUS.defects.find((d) => d.expected_gate_id === GATE_ID.convergence);
    expect(real).toBeTruthy();
    const g = GATE_ID.convergence as GateId;
    const escaped: DriveResult[] = [
      {
        defect_id: (real as (typeof CORPUS.defects)[number]).defect_id,
        expected_gate_id: g,
        verdict: 'missed',
      },
    ];
    const manifest = {
      coverage_boundary: CORPUS.coverage_boundary,
      defects: [real],
    } as typeof CORPUS;
    const r = buildReport(manifest, escaped);
    const row = r.gates.find((x) => x.gate_id === g);
    expect(row?.catch0).toBe('targeted-but-missed');
    expect(row?.is_dead_candidate).toBe(true);
    expect(r.dead_candidates).toContain(g);
  });

  test('unreachable-masked is documented as N/A in the pure runGate harness', () => {
    expect(report().unreachable_masked_note).toMatch(/unreachable-masked/i);
  });

  test('dead candidate count is 0 on the real corpus (all 7 targeted caught)', () => {
    expect(report().dead_candidates).toHaveLength(0);
  });
});

// ── pre-mortem: unstamped (gate_id undefined) vs no-gate (expected-miss=null) ──
describe('unstamped vs no-gate: reported differently', () => {
  test('the 2 expected-miss defects land in no_gate (coverage-boundary), NOT unstamped', () => {
    const r = report();
    const missIds = CORPUS.defects.filter((d) => d.is_expected_miss).map((d) => d.defect_id);
    expect(r.no_gate.defect_ids.sort()).toEqual([...missIds].sort());
    expect(r.unstamped.defect_ids).toHaveLength(0);
    expect(r.no_gate.note).toMatch(/expected-miss|coverage/i);
  });

  test('a result with an UNDEFINED gate_id is unstamped (attribution missing), not no-gate', () => {
    const orphan: DriveResult[] = [
      // expected_gate_id undefined → attribution missing, a DIFFERENT meaning from null.
      { defect_id: 'orphan', expected_gate_id: undefined as unknown as null, verdict: 'caught' },
    ];
    const r = buildReport(CORPUS, [...driveCorpus(CORPUS), ...orphan]);
    expect(r.unstamped.defect_ids).toContain('orphan');
    expect(r.no_gate.defect_ids).not.toContain('orphan');
    expect(r.unstamped.note).toMatch(/attribution|unstamped/i);
  });
});

// ── function-granularity note (sibling classifiers share parent gate_id) ──────
describe('granularity note: gate-level, not function-level (sibling classifiers)', () => {
  test('note names the sibling-classifier limitation', () => {
    const note = report().granularity_note;
    expect(note).toMatch(/resolvability/);
    expect(note).toMatch(/pass_close_residual/);
    expect(note).toMatch(/gate/i);
  });
});

// ── ac-8 coverage boundary section (LLM-reviewer-layer defects excluded) ───────
describe('ac-8 coverage boundary: LLM-reviewer-layer defects excluded', () => {
  test('report carries the corpus coverage_boundary verbatim', () => {
    expect(report().coverage_boundary).toBe(CORPUS.coverage_boundary);
    expect(report().coverage_boundary).toMatch(/DETERMINISTIC/);
  });
});

// ── ac-6 clock-free determinism: two builds → identical report ────────────────
describe('determinism: two identical builds produce an identical report', () => {
  test('buildReport is a pure function of (corpus, drive tuples)', () => {
    const a = buildReport(loadCorpus(), driveCorpus(loadCorpus()));
    const b = buildReport(loadCorpus(), driveCorpus(loadCorpus()));
    expect(a).toEqual(b);
  });
});

// ── ac-7 deploy-leak guard: gate-coverage never ships (read REAL ALWAYS_DIRS) ──
describe('ac-7 deploy leak guard: gate-coverage is absent from the shipped dirs', () => {
  test('build-plugin.mjs ALWAYS_DIRS/OPTIONAL_DIRS ship no gate-coverage / tests path', () => {
    const buildSrc = readFileSync(resolve(HERE, '../../../scripts/build-plugin.mjs'), 'utf8');
    // Read the ACTUAL arrays from source (not a hard-coded expectation).
    const shippedDirs: string[] = [];
    for (const name of ['ALWAYS_DIRS', 'OPTIONAL_DIRS']) {
      const m = buildSrc.match(new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`));
      expect(m).toBeTruthy();
      const dirs = (m?.[1] ?? '')
        .split(',')
        .map((s) => s.replace(/['"\s]/g, ''))
        .filter(Boolean);
      shippedDirs.push(...dirs);
    }
    // Sanity: we actually parsed the product dirs.
    expect(shippedDirs).toContain('hooks');
    // The guarantee: no shipped dir is (or contains) tests / gate-coverage.
    for (const d of shippedDirs) {
      expect(d).not.toBe('tests');
      expect(d).not.toContain('gate-coverage');
    }
  });
});
