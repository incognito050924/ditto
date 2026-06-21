import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import {
  checkCiteGate,
  conflictsFromHits,
  crossValidateCite,
  detectActiveConflicts,
} from '~/core/cite-gate';
import type { CiteGateResult } from '~/core/cite-gate';
import type { MeasurementReport } from '~/core/memory-measure';
import { usageLogPath } from '~/core/memory-warmstart';
import { type Autopilot, type AutopilotNode, autopilot } from '~/schemas/autopilot';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-citegate-'));
  await mkdir(join(repo, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const WI = 'wi_citegate';

const node = (over: Partial<AutopilotNode> & Pick<AutopilotNode, 'id'>): AutopilotNode => ({
  kind: 'research',
  owner: 'researcher',
  purpose: 'do work',
  status: 'passed',
  depends_on: [],
  acceptance_refs: [],
  evidence_refs: [],
  ac_verdicts: [],
  attempts: { fix: 0, switch: 0 },
  ...over,
});

const graphWith = (nodes: AutopilotNode[]): Autopilot =>
  autopilot.parse({
    schema_version: '0.1.0',
    autopilot_id: 'orch_citegate',
    work_item_id: WI,
    root_goal: 'goal',
    approval_gate: { status: 'not_required', source: 'small_reversible_policy' },
    nodes,
    caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: 3 },
    continue_policy: {},
    stop_conditions: [],
  });

/** Append a warm-start usage record (the denominator source). */
async function writeUsage(records: Record<string, unknown>[]): Promise<void> {
  const path = usageLogPath(repo, WI);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, records.map((r) => JSON.stringify(r)).join('\n'), 'utf8');
}

const usage = (over: Record<string, unknown>) => ({
  ts: '2026-06-17T00:00:00.000Z',
  work_item_id: WI,
  node_id: 'N1',
  owner: 'researcher',
  opportunity: true,
  attempt: true,
  hit: true,
  actionable: true,
  ...over,
});

describe('checkCiteGate (ac-2 완료측 cite-or-abstain advisory gate)', () => {
  test('(a) a lineage-pushed node whose output neither cites nor abstains → WARNING (non-blocking)', async () => {
    await writeUsage([usage({ node_id: 'N1', actionable: true })]);
    const graph = graphWith([
      node({
        id: 'N1',
        evidence_refs: [{ kind: 'note', summary: 'did the thing, no decision ref' }],
      }),
    ]);
    const result = await checkCiteGate(repo, { workItemId: WI, graph });
    expect(result.verdict).toBe('warning');
    expect(result.warnings.map((w) => w.node_id)).toContain('N1');
    // advisory only — the gate must NOT signal a hard block.
    expect(result).not.toHaveProperty('block');
  });

  test('(b) zero-denominator (no actionable push) → skip/info, NOT a checked pass', async () => {
    // usage exists but nothing was actionable ⇒ no lineage push ⇒ empty denominator.
    await writeUsage([usage({ node_id: 'N1', actionable: false, hit: false })]);
    const graph = graphWith([node({ id: 'N1', evidence_refs: [] })]);
    const result = await checkCiteGate(repo, { workItemId: WI, graph });
    expect(result.verdict).toBe('skip');
    expect(result.warnings).toEqual([]);
  });

  test('(b2) no usage log at all → skip (empty denominator, not vacuous pass)', async () => {
    const graph = graphWith([node({ id: 'N1', evidence_refs: [] })]);
    const result = await checkCiteGate(repo, { workItemId: WI, graph });
    expect(result.verdict).toBe('skip');
  });

  test('(c) a lineage-pushed node that cited a decision → clean pass, no warnings', async () => {
    await writeUsage([usage({ node_id: 'N1', actionable: true })]);
    const graph = graphWith([
      node({
        id: 'N1',
        evidence_refs: [
          { kind: 'note', summary: 'followed decision:d1 (ADR-0007) on internal_packages' },
        ],
      }),
    ]);
    const result = await checkCiteGate(repo, { workItemId: WI, graph });
    expect(result.verdict).toBe('pass');
    expect(result.warnings).toEqual([]);
  });

  test('(c2) a lineage-pushed node that explicitly abstained → clean pass', async () => {
    await writeUsage([usage({ node_id: 'N1', actionable: true })]);
    const graph = graphWith([
      node({
        id: 'N1',
        evidence_refs: [
          {
            kind: 'note',
            summary: 'cite-or-abstain: none of the governing decisions apply to this task',
          },
        ],
      }),
    ]);
    const result = await checkCiteGate(repo, { workItemId: WI, graph });
    expect(result.verdict).toBe('pass');
  });
});

describe('crossValidateCite (ac-4 표식 단독 성공 판정 금지 — cite ↔ re-proposal rate)', () => {
  const citePass = (): CiteGateResult => ({
    verdict: 'pass',
    pushed_node_ids: ['N1'],
    warnings: [],
  });
  const measure = (over: Partial<MeasurementReport>): MeasurementReport => ({
    adrs_total: 1,
    adrs_with_rejected_section: 1,
    adrs_without_rejected_section: [],
    rejected_alternatives_total: 4,
    invariants_total: 0,
    candidates_total: 2,
    reproposals_detected: 0,
    reproposal_rate: 0,
    reproposal_hits: [],
    invariant_violations_computed: false,
    ...over,
  });

  test('(a) cite pass + re-proposal at/below baseline → confirmed', () => {
    const out = crossValidateCite(citePass(), measure({ reproposal_rate: 0.1 }), {
      baseline_reproposal_rate: 0.2,
    });
    expect(out.combined).toBe('confirmed');
  });

  test('(b) cite pass + re-proposal NOT improved (above baseline) → cited-but-unvalidated, NOT clean success', () => {
    const out = crossValidateCite(citePass(), measure({ reproposal_rate: 0.3 }), {
      baseline_reproposal_rate: 0.2,
    });
    expect(out.combined).toBe('cited-but-unvalidated');
    expect(out.combined).not.toBe('confirmed');
  });

  test('(c) cite pass + no baseline to compare → cannot-confirm (cite alone ≠ success)', () => {
    const out = crossValidateCite(citePass(), measure({ reproposal_rate: 0.1 }), {});
    expect(out.combined).toBe('cannot-confirm');
    expect(out.combined).not.toBe('confirmed');
  });

  test('(d) advisory only — never signals a block', () => {
    const out = crossValidateCite(citePass(), measure({ reproposal_rate: 0.3 }), {
      baseline_reproposal_rate: 0.2,
    });
    expect(out).not.toHaveProperty('block');
    expect(out.advisory).toBe(true);
  });

  test('(e) cite-gate skip/warning is not "confirmed" regardless of rate', () => {
    const skip: CiteGateResult = { verdict: 'skip', pushed_node_ids: [], warnings: [] };
    const out = crossValidateCite(skip, measure({ reproposal_rate: 0 }), {
      baseline_reproposal_rate: 0.2,
    });
    expect(out.combined).not.toBe('confirmed');
  });
});

describe('conflictsFromHits (active contradiction warning, 단계2)', () => {
  const baseReport: MeasurementReport = {
    adrs_total: 1,
    adrs_with_rejected_section: 1,
    adrs_without_rejected_section: [],
    rejected_alternatives_total: 1,
    invariants_total: 0,
    candidates_total: 2,
    reproposals_detected: 0,
    reproposal_rate: 0,
    reproposal_hits: [],
    invariant_violations_computed: false,
  };

  test('maps each reproposal hit to a per-node conflict warning', () => {
    const report: MeasurementReport = {
      ...baseReport,
      reproposal_hits: [
        {
          adr_id: 'ADR-0013',
          item: '**임베딩 (vector)**: 비결정적이라 기각.',
          matched_token: '임베딩',
          candidate_index: 1,
        },
      ],
    };
    const warnings = conflictsFromHits(['nodeA', 'nodeB'], report);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      node_id: 'nodeB',
      adr_id: 'ADR-0013',
      matched_token: '임베딩',
    });
    expect(warnings[0]?.message).toContain('재제안');
  });

  test('no hits → no warnings (advisory, never fabricates)', () => {
    expect(conflictsFromHits(['nodeA'], baseReport)).toEqual([]);
  });
});

describe('detectActiveConflicts (단계2 능동 모순경고 — end-to-end)', () => {
  async function writeAdr(): Promise<void> {
    const adrDir = join(repo, '.ditto', 'knowledge', 'adr');
    await mkdir(adrDir, { recursive: true });
    await writeFile(
      join(adrDir, 'ADR-0099-x.md'),
      ['# ADR-0099', '## 대안', '- **벡터 매칭 (vector)**: 비결정적이라 기각.'].join('\n'),
      'utf8',
    );
  }

  test('a pushed node re-proposing a rejected alternative → conflict warning', async () => {
    await writeAdr();
    await writeUsage([usage({ node_id: 'N1', actionable: true })]);
    const graph = graphWith([
      node({
        id: 'N1',
        evidence_refs: [{ kind: 'note', summary: '구현은 vector 매칭을 사용한다' }],
      }),
    ]);
    const conflicts = await detectActiveConflicts(repo, { workItemId: WI, graph });
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0]).toMatchObject({ node_id: 'N1', adr_id: 'ADR-0099-x.md' });
    expect(conflicts[0]?.matched_token).toContain('vector');
  });

  test('a pushed node NOT re-proposing → no conflict', async () => {
    await writeAdr();
    await writeUsage([usage({ node_id: 'N1', actionable: true })]);
    const graph = graphWith([
      node({ id: 'N1', evidence_refs: [{ kind: 'note', summary: '결정적 파싱으로 구현' }] }),
    ]);
    expect(await detectActiveConflicts(repo, { workItemId: WI, graph })).toEqual([]);
  });

  test('zero-denominator (no actionable push) → no conflict (advisory)', async () => {
    await writeAdr();
    const graph = graphWith([
      node({ id: 'N1', evidence_refs: [{ kind: 'note', summary: 'vector 매칭' }] }),
    ]);
    expect(await detectActiveConflicts(repo, { workItemId: WI, graph })).toEqual([]);
  });
});
