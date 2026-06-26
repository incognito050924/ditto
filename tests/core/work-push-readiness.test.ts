import { describe, expect, test } from 'bun:test';
import { type StemView, pushReadiness } from '~/core/work-item-store';
import { type WorkItem, workItem } from '~/schemas/work-item';

// ac-6 (wi_260626wnv) — STRONG push-readiness signal (Part A, pure core function).
// Push/deploy is the user's irreversible decision; ditto only COMPUTES a readiness
// signal (surfaced pull-only via `work push-ready`). A bare completion verdict=pass
// is too weak a bar — push-readiness adds evidence DEPTH (a real command-kind
// evidence per AC), the self-caused-regression block (ac-4), and a fully-done stem
// chain (ac-5). `ready` is the AND of all four; `reasons` lists exactly what failed.

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return workItem.parse({
    schema_version: '0.1.0',
    id: 'wi_pushready1',
    title: 't',
    source_request: 'r',
    goal: 'g',
    acceptance_criteria: [
      {
        id: 'ac-1',
        statement: 'the command exits 0',
        verdict: 'pass',
        evidence: [{ kind: 'command', command: 'bun test', summary: 'exit 0' }],
      },
    ],
    status: 'in_progress',
    owner_profile: 'workspace-write',
    child_ids: [],
    changed_files: [],
    risks: [],
    runs: [],
    created_at: '2026-06-26T00:00:00.000Z',
    updated_at: '2026-06-26T00:00:00.000Z',
    ...overrides,
  });
}

describe('ac-6 A: pushReadiness — strong push-readiness computation', () => {
  test('all four conditions hold → ready, reasons empty', () => {
    const r = pushReadiness(makeItem());
    expect(r.ready).toBe(true);
    expect(r.reasons).toEqual([]);
  });

  test('cond 1: an AC not verdict=pass → not ready, reason names it', () => {
    const item = makeItem({
      acceptance_criteria: [
        {
          id: 'ac-1',
          statement: 's',
          verdict: 'partial',
          evidence: [{ kind: 'command', command: 'x', summary: 'exit 0' }],
        },
      ],
    });
    const r = pushReadiness(item);
    expect(r.ready).toBe(false);
    expect(r.reasons.some((x) => x.includes('ac-1'))).toBe(true);
  });

  // The defining test: a bare verdict=pass is NOT enough — the AC must carry real
  // (command-kind) evidence, not merely a note. This is what makes push-readiness
  // a STRONGER bar than `work done` (which one lightweight verify can earn).
  test('cond 2: verdict=pass but evidence is ONLY a note → NOT ready (strong bar beats bare verdict)', () => {
    const item = makeItem({
      acceptance_criteria: [
        {
          id: 'ac-1',
          statement: 's',
          verdict: 'pass',
          evidence: [{ kind: 'note', summary: 'looked at it' }],
        },
      ],
    });
    const r = pushReadiness(item);
    expect(r.ready).toBe(false);
    expect(r.reasons.some((x) => /evidence/i.test(x) && x.includes('ac-1'))).toBe(true);
  });

  test('cond 3: unresolved self-caused high bug follow-up → not ready', () => {
    const item = makeItem({
      follow_ups: [{ kind: 'bug', note: 'broke the parser', severity: 'high', self_caused: true }],
    });
    const r = pushReadiness(item);
    expect(r.ready).toBe(false);
    expect(r.reasons.some((x) => /follow-?up|regression|bug/i.test(x))).toBe(true);
  });

  test('cond 3: a RESOLVED self-caused high bug does NOT block (others hold → ready)', () => {
    const item = makeItem({
      follow_ups: [
        {
          kind: 'bug',
          note: 'broke the parser',
          severity: 'high',
          self_caused: true,
          resolved: true,
        },
      ],
    });
    expect(pushReadiness(item).ready).toBe(true);
  });

  test('cond 3: a low-severity / non-self-caused follow-up does NOT block', () => {
    const item = makeItem({
      follow_ups: [
        { kind: 'bug', note: 'minor', severity: 'low', self_caused: true },
        { kind: 'bug', note: 'someone else', severity: 'critical' },
        { kind: 'idea', note: 'extract later' },
      ],
    });
    expect(pushReadiness(item).ready).toBe(true);
  });

  test('cond 4: participates in a stem (>1 member) but chain not done → not ready', () => {
    const stem: StemView = {
      members: [
        { id: 'wi_pushready1', status: 'done' },
        { id: 'wi_other00002', status: 'in_progress', follows: 'wi_pushready1' },
      ],
      rolled_up: 'open',
    };
    const r = pushReadiness(makeItem(), stem);
    expect(r.ready).toBe(false);
    expect(r.reasons.some((x) => /stem|chain/i.test(x))).toBe(true);
  });

  test('cond 4: a fully-done stem chain (>1 member, rolled_up=done) → ready', () => {
    const stem: StemView = {
      members: [
        { id: 'wi_pushready1', status: 'done' },
        { id: 'wi_other00002', status: 'done', follows: 'wi_pushready1' },
      ],
      rolled_up: 'done',
    };
    expect(pushReadiness(makeItem(), stem).ready).toBe(true);
  });

  test('cond 4: a lone WI (single-member stem) does not trigger the chain condition', () => {
    const stem: StemView = {
      members: [{ id: 'wi_pushready1', status: 'in_progress' }],
      rolled_up: 'open',
    };
    expect(pushReadiness(makeItem(), stem).ready).toBe(true);
  });

  test('multiple failures accumulate distinct reasons', () => {
    const item = makeItem({
      acceptance_criteria: [
        {
          id: 'ac-1',
          statement: 's',
          verdict: 'partial',
          evidence: [{ kind: 'note', summary: 'n' }],
        },
      ],
      follow_ups: [{ kind: 'bug', note: 'b', severity: 'critical', self_caused: true }],
    });
    const r = pushReadiness(item);
    expect(r.ready).toBe(false);
    expect(r.reasons.length).toBeGreaterThanOrEqual(3);
  });
});
