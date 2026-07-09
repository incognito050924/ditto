import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordPremortemRefutation } from '~/core/interview-driver';
import { InterviewStore } from '~/core/interview-store';
import {
  type PremortemItem,
  premortemItem,
  premortemRefutationVerdicts,
} from '~/schemas/interview-state';

// wi_260709d3m (#17): premortem 경량 강화 — oracle-link(maps_to) + 경량 opponent refutation.

const BASE: PremortemItem = {
  scenario: 'migration overwrites a column → data loss',
  likelihood: 'low',
  blast_radius: 'critical',
  reversibility: 'irreversible',
  early_signal: 'row counts drop',
  promoted_to: 'ac',
  ref: 'ac-2',
};

describe('AC-1 premortemItem.maps_to (oracle-link)', () => {
  test('parses WITH maps_to (intent-fragment | file:line | ADR)', () => {
    const parsed = premortemItem.parse({
      ...BASE,
      maps_to: ['frag-intent-3', 'src/core/foo.ts:42', 'ADR-0018'],
    });
    expect(parsed.maps_to).toEqual(['frag-intent-3', 'src/core/foo.ts:42', 'ADR-0018']);
  });

  test('parses WITHOUT maps_to (optional — binding failure keeps prose, not forced)', () => {
    const parsed = premortemItem.parse(BASE);
    expect(parsed.maps_to).toBeUndefined();
  });
});

describe('AC-2 premortemItem.refutation + verdict payload schema', () => {
  test('premortemItem parses WITH a refutation record', () => {
    const parsed = premortemItem.parse({
      ...BASE,
      refutation: { status: 'engaged', text: 'already mitigated by the pre-write snapshot' },
    });
    expect(parsed.refutation?.status).toBe('engaged');
  });

  test('refutation is optional (pre-existing items parse unchanged)', () => {
    expect(premortemItem.parse(BASE).refutation).toBeUndefined();
  });

  test('premortemRefutationVerdicts payload validates index + text', () => {
    const parsed = premortemRefutationVerdicts.parse({
      verdicts: [{ index: 0, text: 'this risk is real; no existing mitigation' }],
    });
    expect(parsed.verdicts[0]?.index).toBe(0);
  });
});

describe('AC-2 recordPremortemRefutation (fail-closed record-back · ADR-0018 degrade)', () => {
  const NOW = new Date('2026-07-09T00:00:00.000Z');

  async function seed(items: PremortemItem[]): Promise<string> {
    const repo = mkdtempSync(join(tmpdir(), 'premortem-refute-'));
    const store = new InterviewStore(repo);
    const wi = 'wi_test0001';
    await store.write({
      schema_version: '0.1.0',
      work_item_id: wi,
      status: 'active',
      started_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
      dimensions: [],
      readiness: { score: 0, threshold: 0.8, critical_unresolved: [], gate: 'blocked' },
      questions: [],
      assumptions: [],
      premortem: items,
      exit: {
        reason: 'readiness_met',
        closure_mode: 'mutual_agreement',
        question_cap: 10,
        questions_asked: 0,
      },
    });
    return repo;
  }

  test('non-empty text on a high-blast item → engaged', async () => {
    const repo = await seed([BASE]);
    const out = await recordPremortemRefutation(
      repo,
      'wi_test0001',
      [{ index: 0, text: 'is real' }],
      NOW,
    );
    expect(out.status).toBe('recorded');
    if (out.status !== 'recorded') return;
    expect(out.engaged).toEqual([0]);
    expect(out.state.premortem[0]?.refutation).toEqual({ status: 'engaged', text: 'is real' });
  });

  test('whitespace-only text → host_absent degrade (never a fake engaged)', async () => {
    const repo = await seed([BASE]);
    const out = await recordPremortemRefutation(
      repo,
      'wi_test0001',
      [{ index: 0, text: '   ' }],
      NOW,
    );
    expect(out.status).toBe('recorded');
    if (out.status !== 'recorded') return;
    expect(out.degraded).toEqual([0]);
    expect(out.state.premortem[0]?.refutation?.status).toBe('host_absent');
  });

  test('index out of range → foreign, writes NOTHING', async () => {
    const repo = await seed([BASE]);
    const out = await recordPremortemRefutation(
      repo,
      'wi_test0001',
      [{ index: 5, text: 'x' }],
      NOW,
    );
    expect(out.status).toBe('foreign');
    if (out.status !== 'foreign') return;
    expect(out.foreign).toEqual([5]);
    const state = await new InterviewStore(repo).get('wi_test0001');
    expect(state.premortem[0]?.refutation).toBeUndefined();
  });

  test('a non-high-blast item is NOT a valid refutation target (§17 localization) → foreign', async () => {
    const low: PremortemItem = {
      ...BASE,
      blast_radius: 'low',
      reversibility: 'reversible',
      promoted_to: 'none',
      ref: '',
    };
    const repo = await seed([low]);
    const out = await recordPremortemRefutation(
      repo,
      'wi_test0001',
      [{ index: 0, text: 'x' }],
      NOW,
    );
    expect(out.status).toBe('foreign');
  });
});
