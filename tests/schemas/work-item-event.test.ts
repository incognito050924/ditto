import { describe, expect, test } from 'bun:test';
import { acceptanceCriterion, workItem, workItemEvent } from '~/schemas/work-item';

// wi_2607069bk WS0-T0 (Record/Run split) §2.1: the committed per-event immutable
// log entry. seq/actor/event_id are REQUIRED (per-writer monotonic order +
// content-hash dedupe); ts is informational only. payload is per-kind.

function omit(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const clone = { ...obj };
  delete clone[key];
  return clone;
}

function eventBase(extra: Record<string, unknown> = {}) {
  return {
    schema_version: '0.1.0',
    work_item_id: 'wi_test0001',
    seq: 0,
    actor: 'workspace-write@sess-1',
    event_id: 'evt-abc123',
    ts: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

describe('workItemEvent per-kind payloads (wi_2607069bk §2.1)', () => {
  test('status event parses { to, closed_at }', () => {
    const e = workItemEvent.parse(
      eventBase({ kind: 'status', payload: { to: 'done', closed_at: '2026-01-02T00:00:00.000Z' } }),
    );
    expect(e.kind).toBe('status');
    if (e.kind === 'status') {
      expect(e.payload.to).toBe('done');
      expect(e.payload.closed_at).toBe('2026-01-02T00:00:00.000Z');
    }
  });

  test('status event allows closed_at = null (reopen drops the timestamp)', () => {
    const e = workItemEvent.parse(
      eventBase({ kind: 'status', payload: { to: 'in_progress', closed_at: null } }),
    );
    expect(e.kind).toBe('status');
    if (e.kind === 'status') expect(e.payload.closed_at).toBeNull();
  });

  test('verdict event parses { criterion_id, verdict, evidence[] }', () => {
    const e = workItemEvent.parse(
      eventBase({
        seq: 1,
        kind: 'verdict',
        payload: {
          criterion_id: 'ac-1',
          verdict: 'pass',
          evidence: [{ kind: 'command', command: 'bun test', summary: 'all green' }],
        },
      }),
    );
    expect(e.kind).toBe('verdict');
    if (e.kind === 'verdict') {
      expect(e.payload.criterion_id).toBe('ac-1');
      expect(e.payload.verdict).toBe('pass');
      expect(e.payload.evidence).toHaveLength(1);
    }
  });

  test('github_post event parses posted decision/claim markers', () => {
    const e = workItemEvent.parse(
      eventBase({
        kind: 'github_post',
        payload: {
          posted_decision_id: 'dec-1',
          posted_claim_marker: 'claim:ditto/wi_2607069bk',
          claimed_branch: 'ditto/wi_2607069bk',
        },
      }),
    );
    expect(e.kind).toBe('github_post');
    if (e.kind === 'github_post') expect(e.payload.posted_decision_id).toBe('dec-1');
  });

  test('claim and claim_release events parse', () => {
    const claim = workItemEvent.parse(
      eventBase({
        kind: 'claim',
        payload: { claimed_branch: 'ditto/wi', posted_claim_marker: 'claim:ditto/wi' },
      }),
    );
    const release = workItemEvent.parse(
      eventBase({ seq: 2, kind: 'claim_release', payload: { claimed_branch: 'ditto/wi' } }),
    );
    expect(claim.kind).toBe('claim');
    expect(release.kind).toBe('claim_release');
  });
});

describe('workItemEvent required fields (wi_2607069bk §2.1)', () => {
  const valid = () => eventBase({ kind: 'status', payload: { to: 'draft' } });

  test('rejects an event missing seq', () => {
    expect(workItemEvent.safeParse(omit(valid(), 'seq')).success).toBe(false);
  });

  test('rejects an event missing actor', () => {
    expect(workItemEvent.safeParse(omit(valid(), 'actor')).success).toBe(false);
  });

  test('rejects an event missing event_id', () => {
    expect(workItemEvent.safeParse(omit(valid(), 'event_id')).success).toBe(false);
  });

  test('rejects empty actor and empty event_id', () => {
    expect(workItemEvent.safeParse(eventBase({ ...valid(), actor: '' })).success).toBe(false);
    expect(workItemEvent.safeParse(eventBase({ ...valid(), event_id: '' })).success).toBe(false);
  });

  test('rejects a negative seq', () => {
    expect(workItemEvent.safeParse(eventBase({ ...valid(), seq: -1 })).success).toBe(false);
  });

  test('rejects an unknown kind', () => {
    expect(workItemEvent.safeParse(eventBase({ kind: 'bogus', payload: {} })).success).toBe(false);
  });
});

// wi_2607069bk §1.2 Finding E: evidence_required is lifted onto the BASE
// acceptance criterion (record.json / Record), so deleting the intent.json (Run)
// sidecar loses no "kind of evidence required per AC" info. Additive + OPTIONAL
// (same idiom as oracle / superseded) so a legacy work-item.json AC parses
// unchanged; no schema_version bump.
function workItemLiteral(extra: Record<string, unknown> = {}) {
  return {
    schema_version: '0.1.0',
    id: 'wi_test0001',
    title: 'a work item',
    source_request: 'do the thing',
    goal: 'the outcome is observable',
    acceptance_criteria: [
      {
        id: 'ac-1',
        statement: 'an observable behavior',
        verdict: 'unverified' as const,
        evidence: [],
      },
    ],
    status: 'draft' as const,
    owner_profile: 'workspace-write' as const,
    child_ids: [],
    changed_files: [],
    risks: [],
    runs: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

describe('acceptanceCriterion.evidence_required (wi_2607069bk §1.2 Finding E)', () => {
  test('a legacy AC WITHOUT evidence_required parses; the field is omitted (optional)', () => {
    const ac = acceptanceCriterion.parse({ id: 'ac-1', statement: 'x' });
    expect(ac.evidence_required).toBeUndefined();
  });

  test('an AC WITH evidence_required parses and preserves the kinds', () => {
    const ac = acceptanceCriterion.parse({
      id: 'ac-1',
      statement: 'x',
      evidence_required: ['test', 'diff'],
    });
    expect(ac.evidence_required).toEqual(['test', 'diff']);
  });

  test('a legacy work-item.json (AC without evidence_required) parses; evidence_required is omitted (optional)', () => {
    const wi = workItem.parse(workItemLiteral());
    expect(
      (wi.acceptance_criteria[0] as (typeof wi.acceptance_criteria)[number]).evidence_required,
    ).toBeUndefined();
  });

  test('rejects an unknown evidence_required kind', () => {
    expect(
      acceptanceCriterion.safeParse({ id: 'ac-1', statement: 'x', evidence_required: ['bogus'] })
        .success,
    ).toBe(false);
  });
});

// wi_2607069bk §4 B1 boundary: the freshness stamp `source_digest` stays on
// intent.json (Run), NOT on the work-item Record. The Record schema does not model
// it, so an inbound source_digest is stripped (zod strips unknown keys).
describe('B1 boundary: Record carries no source_digest (wi_2607069bk §4 B1)', () => {
  test('workItem does not model source_digest (freshness stamp stays on the Run tier)', () => {
    const wi = workItem.parse(
      workItemLiteral({ source_digest: { doc_path: 'spec.md', sha256: 'a'.repeat(64) } }),
    );
    expect((wi as Record<string, unknown>).source_digest).toBeUndefined();
  });
});
