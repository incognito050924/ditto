import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { completionContract } from '~/schemas/completion-contract';
import { decisionLedgerEntry } from '~/schemas/convergence';
import { commandLogEntry } from '~/schemas/evidence-log';
import { glossary } from '~/schemas/glossary';
import { languageChange, languageLedger } from '~/schemas/language-ledger';
import { reviewerOutput } from '~/schemas/reviewer-output';
import { runManifest } from '~/schemas/run-manifest';
import { workItem } from '~/schemas/work-item';
import {
  corpusEntry,
  parseCorpus,
  runGate,
} from '../fixtures/scenarios/gate-coverage/corpus-schema';

const FIXTURE_ROOT = join(
  import.meta.dir,
  '..',
  'fixtures',
  'scenarios',
  'password-strength',
  '.ditto',
);

async function loadJson(path: string): Promise<unknown> {
  const text = await readFile(join(FIXTURE_ROOT, path), 'utf8');
  return JSON.parse(text);
}

describe('password-strength golden fixture', () => {
  test('work-item.json conforms to workItem schema', async () => {
    const data = await loadJson('work-items/wi_pwdcheck/work-item.json');
    const parsed = workItem.parse(data);
    expect(parsed.id).toBe('wi_pwdcheck');
    expect(parsed.status).toBe('partial');
    expect(parsed.acceptance_criteria).toHaveLength(3);
    expect(parsed.runs).toEqual(['run_pwdcheck1']);
  });

  test('run manifest conforms to runManifest schema', async () => {
    const data = await loadJson('runs/run_pwdcheck1/manifest.json');
    const parsed = runManifest.parse(data);
    expect(parsed.work_item_id).toBe('wi_pwdcheck');
    expect(parsed.provider).toBe('claude-code');
    expect(parsed.verifications).toHaveLength(3);
    expect(parsed.unverified.length).toBeGreaterThan(0);
  });

  test('completion claim conforms to completionContract schema', async () => {
    const data = await loadJson('work-items/wi_pwdcheck/completion.json');
    const parsed = completionContract.parse(data);
    expect(parsed.final_verdict).toBe('partial');
    expect(parsed.next_handoff_path).toBeDefined();
    expect(parsed.acceptance.map((a) => a.criterion_id).sort()).toEqual(['ac-1', 'ac-2', 'ac-3']);
  });

  test('reviewer output conforms to reviewerOutput schema', async () => {
    const data = await loadJson('work-items/wi_pwdcheck/reviews/rv_pwdcheck1.json');
    const parsed = reviewerOutput.parse(data);
    expect(parsed.kind).toBe('cross-provider-reviewer');
    expect(parsed.different_provider_than_generator).toBe(true);
    expect(parsed.verdict).toBe('partial');
  });

  test('glossary conforms to glossary schema', async () => {
    const data = await loadJson('knowledge/glossary.json');
    const parsed = glossary.parse(data);
    expect(parsed.entries.length).toBeGreaterThanOrEqual(3);
    const terms = parsed.entries.map((e) => e.term);
    expect(terms).toContain('password policy');
  });

  test('language ledger conforms to languageLedger schema', async () => {
    const data = await loadJson('work-items/wi_pwdcheck/language-ledger.json');
    const parsed = languageLedger.parse(data);
    expect(parsed.work_item_id).toBe('wi_pwdcheck');
    expect(parsed.changes).toEqual([]);
  });

  test('commands.jsonl lines conform to commandLogEntry schema', async () => {
    const text = await readFile(
      join(FIXTURE_ROOT, 'work-items/wi_pwdcheck/evidence/commands.jsonl'),
      'utf8',
    );
    const lines = text.split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBe(3);
    for (const line of lines) {
      commandLogEntry.parse(JSON.parse(line));
    }
  });
});

describe('schema rejects invalid documents', () => {
  test('completion contract rejects final_verdict=pass with non-pass acceptance', () => {
    const bad = {
      schema_version: '0.1.0',
      work_item_id: 'wi_bad0001',
      declared_by: 'main',
      declared_at: '2026-05-24T11:00:00+09:00',
      summary: '실패한 acceptance로 pass를 주장하는 잘못된 contract',
      changed_files: [],
      acceptance: [{ criterion_id: 'ac-1', verdict: 'fail', evidence: [] }],
      verifications: [],
      unverified: [],
      remaining_risks: [],
      final_verdict: 'pass',
    };
    expect(() => completionContract.parse(bad)).toThrow();
  });

  test('completion contract rejects non-pass without next_handoff_path', () => {
    const bad = {
      schema_version: '0.1.0',
      work_item_id: 'wi_bad0002',
      declared_by: 'main',
      declared_at: '2026-05-24T11:00:00+09:00',
      summary: 'partial을 주장하면서 handoff 경로를 빠뜨림',
      changed_files: [],
      acceptance: [{ criterion_id: 'ac-1', verdict: 'partial', evidence: [] }],
      verifications: [],
      unverified: [],
      remaining_risks: [],
      final_verdict: 'partial',
    };
    expect(() => completionContract.parse(bad)).toThrow();
  });

  test('work item id rejects bad prefix', () => {
    const bad = {
      schema_version: '0.1.0',
      id: 'wrong-prefix',
      title: 't',
      source_request: 's',
      goal: 'g',
      acceptance_criteria: [{ id: 'ac-1', statement: 's' }],
      created_at: '2026-05-24T00:00:00+09:00',
      updated_at: '2026-05-24T00:00:00+09:00',
    };
    expect(() => workItem.parse(bad)).toThrow();
  });

  test('relative path rejects parent traversal', () => {
    const bad = {
      schema_version: '0.1.0',
      id: 'wi_traverse',
      title: 't',
      source_request: 's',
      goal: 'g',
      acceptance_criteria: [{ id: 'ac-1', statement: 's' }],
      changed_files: ['../etc/passwd'],
      created_at: '2026-05-24T00:00:00+09:00',
      updated_at: '2026-05-24T00:00:00+09:00',
    };
    expect(() => workItem.parse(bad)).toThrow();
  });

  test('reviewer output unverified verdict requires evidence or review_not_run_reason', () => {
    const bad = {
      schema_version: '0.1.0',
      id: 'rv_bad0001',
      work_item_id: 'wi_bad0001',
      kind: 'verifier',
      reviewer: 'verifier',
      different_provider_than_generator: false,
      started_at: '2026-05-24T00:00:00+09:00',
      verdict: 'unverified',
      evidence: [],
      findings: [],
      unverified: [],
      recommended_next_action: 'next',
    };
    expect(() => reviewerOutput.parse(bad)).toThrow();
  });

  test('completion contract rejects final_verdict=pass with in-scope unverified', () => {
    const bad = {
      schema_version: '0.1.0',
      work_item_id: 'wi_unverif1',
      declared_by: 'main',
      declared_at: '2026-05-24T11:00:00+09:00',
      summary: 'pass를 주장하면서 in-scope unverified가 남아 있음',
      changed_files: [],
      acceptance: [{ criterion_id: 'ac-1', verdict: 'pass', evidence: [] }],
      verifications: [],
      unverified: [{ item: '회귀 테스트', reason: '시간 부족', out_of_scope: false }],
      remaining_risks: [],
      final_verdict: 'pass',
    };
    expect(() => completionContract.parse(bad)).toThrow();
  });

  test('completion contract allows final_verdict=pass when all unverified marked out_of_scope', () => {
    const ok = {
      schema_version: '0.1.0',
      work_item_id: 'wi_outscop1',
      declared_by: 'main',
      declared_at: '2026-05-24T11:00:00+09:00',
      summary: 'out_of_scope unverified만 남기고 pass 주장',
      changed_files: [],
      acceptance: [{ criterion_id: 'ac-1', verdict: 'pass', evidence: [] }],
      verifications: [],
      unverified: [{ item: '다른 OS 검증', reason: '본 PR 범위 밖', out_of_scope: true }],
      remaining_risks: [],
      final_verdict: 'pass',
    };
    expect(() => completionContract.parse(ok)).not.toThrow();
  });

  test('work item rejects non-terminal status without re_entry', () => {
    const bad = {
      schema_version: '0.1.0',
      id: 'wi_blocked1',
      title: 't',
      source_request: 's',
      goal: 'g',
      acceptance_criteria: [{ id: 'ac-1', statement: 's' }],
      status: 'blocked',
      created_at: '2026-05-24T00:00:00+09:00',
      updated_at: '2026-05-24T00:00:00+09:00',
    };
    expect(() => workItem.parse(bad)).toThrow();
  });

  test('work item rejects partial status with empty re_entry', () => {
    const bad = {
      schema_version: '0.1.0',
      id: 'wi_partial1',
      title: 't',
      source_request: 's',
      goal: 'g',
      acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'partial' }],
      status: 'partial',
      re_entry: { fresh_evidence_needed: [] },
      created_at: '2026-05-24T00:00:00+09:00',
      updated_at: '2026-05-24T00:00:00+09:00',
    };
    expect(() => workItem.parse(bad)).toThrow();
  });

  test('work item allows partial status when re_entry.command is set', () => {
    const ok = {
      schema_version: '0.1.0',
      id: 'wi_partial2',
      title: 't',
      source_request: 's',
      goal: 'g',
      acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'partial' }],
      status: 'partial',
      re_entry: { command: 'ditto work resume wi_partial2', fresh_evidence_needed: [] },
      created_at: '2026-05-24T00:00:00+09:00',
      updated_at: '2026-05-24T00:00:00+09:00',
    };
    expect(() => workItem.parse(ok)).not.toThrow();
  });

  test('command log entry rejects missing required fields', () => {
    const bad = {
      ts: '2026-05-24T00:00:00+09:00',
      kind: 'command',
      // command missing
      exit_code: 0,
    };
    expect(() => commandLogEntry.parse(bad)).toThrow();
  });

  test('command log entry rejects wrong kind discriminator', () => {
    const bad = {
      ts: '2026-05-24T00:00:00+09:00',
      kind: 'note',
      command: 'echo hi',
      exit_code: 0,
    };
    expect(() => commandLogEntry.parse(bad)).toThrow();
  });
});

describe('self-declared booleans require backing', () => {
  // ── decisionLedgerEntry.admissible ──────────────────────────────────────
  const baseLedger = {
    id: 'obj-1',
    round: 0,
    objection: 'o',
    kind: 'hypothesis' as const,
    severity: 'low' as const,
    admissible: false,
    status: 'dismissed' as const,
    confidence: 'low' as const,
    backed_by: [],
    reason: 'r',
  };

  test('decision ledger rejects admissible=true with non-high/critical severity', () => {
    expect(() =>
      decisionLedgerEntry.parse({ ...baseLedger, admissible: true, severity: 'low' }),
    ).toThrow();
    expect(() =>
      decisionLedgerEntry.parse({ ...baseLedger, admissible: true, severity: 'medium' }),
    ).toThrow();
  });

  test('decision ledger allows admissible=true with high or critical severity', () => {
    expect(() =>
      decisionLedgerEntry.parse({ ...baseLedger, admissible: true, severity: 'high' }),
    ).not.toThrow();
    expect(() =>
      decisionLedgerEntry.parse({ ...baseLedger, admissible: true, severity: 'critical' }),
    ).not.toThrow();
  });

  test('decision ledger allows admissible=false regardless of severity', () => {
    expect(() =>
      decisionLedgerEntry.parse({ ...baseLedger, admissible: false, severity: 'low' }),
    ).not.toThrow();
  });

  // ── languageChange.agreed_with_user ─────────────────────────────────────
  const baseChange = {
    op: 'add' as const,
    term: 't',
    rationale: 'r',
    proposed_by: 'user',
    agreed_with_user: false,
  };

  test('language change rejects agreed_with_user=true without decided_at', () => {
    expect(() => languageChange.parse({ ...baseChange, agreed_with_user: true })).toThrow();
  });

  test('language change allows agreed_with_user=true with decided_at', () => {
    expect(() =>
      languageChange.parse({
        ...baseChange,
        agreed_with_user: true,
        decided_at: '2026-05-24T00:00:00+09:00',
      }),
    ).not.toThrow();
  });

  test('language change allows agreed_with_user=false without decided_at', () => {
    expect(() => languageChange.parse({ ...baseChange, agreed_with_user: false })).not.toThrow();
  });

  // ── reviewerOutput.different_provider_than_generator ─────────────────────
  const baseReview = {
    schema_version: '0.1.0',
    id: 'rv_xprov001',
    work_item_id: 'wi_xprov001',
    kind: 'cross-provider-reviewer' as const,
    reviewer: 'codex/gpt',
    different_provider_than_generator: false,
    started_at: '2026-05-24T00:00:00+09:00',
    verdict: 'pass' as const,
    evidence: [],
    findings: [],
    unverified: [],
    recommended_next_action: 'next',
  };

  test('reviewer output rejects different_provider=true with empty evidence', () => {
    expect(() =>
      reviewerOutput.parse({ ...baseReview, different_provider_than_generator: true }),
    ).toThrow();
  });

  test('reviewer output allows different_provider=true with non-empty evidence', () => {
    expect(() =>
      reviewerOutput.parse({
        ...baseReview,
        different_provider_than_generator: true,
        evidence: [{ kind: 'command', command: 'bun test', summary: 'all pass' }],
      }),
    ).not.toThrow();
  });

  test('reviewer output allows different_provider=false with empty evidence', () => {
    expect(() =>
      reviewerOutput.parse({ ...baseReview, different_provider_than_generator: false }),
    ).not.toThrow();
  });
});

// ── seeded-defect corpus (gate-coverage substrate, wi_260718srh n5) ──────────
// The corpus is the substrate the n6 harness runs down the real gate path to
// measure per-gate catch-rate. These assertions pin: (1) the whole corpus passes
// the shared manifest schema; (2) an unknown/mistyped expected_gate_id is rejected
// fail-closed (the GATE_ID-derived enum, not a hand-copied literal set); (3) every
// TARGETED defect's fixture_state actually drives its gate to FAIL while its
// clean_pair drives the SAME gate to PASS — the specificity control, and the proof
// each fixture sits STRICTLY past the threshold, not on the boundary.
describe('seeded-defect gate-coverage corpus', () => {
  const CORPUS_PATH = join(
    import.meta.dir,
    '..',
    'fixtures',
    'scenarios',
    'gate-coverage',
    'corpus.json',
  );

  async function loadCorpus() {
    const raw = JSON.parse(await readFile(CORPUS_PATH, 'utf8'));
    return parseCorpus(raw);
  }

  test('corpus.json passes the shared manifest schema', async () => {
    const corpus = await loadCorpus();
    expect(corpus.defects.length).toBeGreaterThanOrEqual(7);
    expect(corpus.coverage_boundary.length).toBeGreaterThan(0);
  });

  test('corpus covers multiple distinct deterministic gates', async () => {
    const corpus = await loadCorpus();
    const gates = new Set(
      corpus.defects.filter((d) => !d.is_expected_miss).map((d) => d.expected_gate_id),
    );
    // A single-gate corpus makes the catch-rate report vacuous.
    expect(gates.size).toBeGreaterThanOrEqual(5);
  });

  test('includes 1..2 expected-miss defects (LLM-reviewer-layer, no gate)', async () => {
    const corpus = await loadCorpus();
    const misses = corpus.defects.filter((d) => d.is_expected_miss);
    expect(misses.length).toBeGreaterThanOrEqual(1);
    expect(misses.length).toBeLessThanOrEqual(2);
    for (const m of misses) expect(m.expected_gate_id).toBeNull();
  });

  test('every targeted fixture_state drives its gate to FAIL, clean_pair to PASS', async () => {
    const corpus = await loadCorpus();
    const targeted = corpus.defects.filter((d) => !d.is_expected_miss);
    expect(targeted.length).toBeGreaterThanOrEqual(7);
    for (const d of targeted) {
      const gateId = d.expected_gate_id;
      if (gateId === null) throw new Error(`targeted defect ${d.defect_id} has null gate id`);
      const failResult = runGate(gateId, d.fixture_state);
      expect(
        failResult.pass,
        `${d.defect_id}: fixture_state must FAIL gate ${gateId} (got pass; boundary-strict?)`,
      ).toBe(false);
      const passResult = runGate(gateId, d.clean_pair);
      expect(
        passResult.pass,
        `${d.defect_id}: clean_pair must PASS gate ${gateId} (got fail: ${passResult.reasons.join('; ')})`,
      ).toBe(true);
    }
  });

  test('unknown / mistyped expected_gate_id is rejected fail-closed', () => {
    const typo = {
      defect_id: 'seed-typo',
      expected_gate_id: 'acceptance_testabel', // deliberate typo — not in GATE_ID
      fixture_state: { statement: 'x' },
      clean_pair: { statement: 'y' },
      is_expected_miss: false,
    };
    expect(() => corpusEntry.parse(typo)).toThrow();
  });

  test('a whole manifest carrying an unknown gate id is rejected', () => {
    const bad = {
      coverage_boundary: 'deterministic gates only',
      defects: [
        {
          defect_id: 'seed-bad',
          expected_gate_id: 'not_a_real_gate',
          fixture_state: {},
          clean_pair: {},
          is_expected_miss: false,
        },
      ],
    };
    expect(() => parseCorpus(bad)).toThrow();
  });
});
