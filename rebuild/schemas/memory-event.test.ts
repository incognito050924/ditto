import { describe, expect, test } from 'bun:test';

import { memoryEvent } from './memory-event';

const base = {
  schema_version: '0.1.0',
  event_id: 'memevt_abc123def456',
  event_type: 'observation',
  actor: { kind: 'agent', role: 'bootstrap' },
  text: '관찰 내용',
  created_at: '2026-07-24T00:00:00.000Z',
};

describe('memory event schema — the immutable per-entity SoT record', () => {
  test('minimal pending event fills defaults', () => {
    const parsed = memoryEvent.parse(base);
    expect(parsed.status).toBe('pending');
    expect(parsed.confidence_kind).toBe('EXTRACTED');
    expect(parsed.sensitivity).toBe('internal');
    expect(parsed.sources).toEqual([]);
    expect(parsed.governs).toEqual([]);
  });

  test('event_id and source refs are shape-checked', () => {
    expect(() => memoryEvent.parse({ ...base, event_id: 'evt_bad' })).toThrow();
    expect(() => memoryEvent.parse({ ...base, event_id: 'memevt_ab' })).toThrow(); // too short
    expect(memoryEvent.parse({ ...base, sources: ['src_a1fa40cf815e'] }).sources).toEqual([
      'src_a1fa40cf815e',
    ]);
    expect(() => memoryEvent.parse({ ...base, sources: ['bad_ref'] })).toThrow();
  });

  test('approved and rejected events require approved_by and decided_at', () => {
    expect(() => memoryEvent.parse({ ...base, status: 'approved' })).toThrow();
    expect(() =>
      memoryEvent.parse({ ...base, status: 'approved', approved_by: 'user' }),
    ).toThrow();
    const ok = memoryEvent.parse({
      ...base,
      status: 'approved',
      approved_by: 'user',
      decided_at: '2026-07-24T01:00:00.000Z',
    });
    expect(ok.status).toBe('approved');
    expect(() =>
      memoryEvent.parse({ ...base, status: 'rejected', decided_at: '2026-07-24T01:00:00.000Z' }),
    ).toThrow(); // rejected also needs approved_by
  });

  test('pending events must not carry approved_by', () => {
    expect(() => memoryEvent.parse({ ...base, approved_by: 'user' })).toThrow();
  });

  test('governs is decision-only', () => {
    const decision = memoryEvent.parse({
      ...base,
      event_type: 'decision',
      governs: ['src/core/thing.ts'],
    });
    expect(decision.governs).toEqual(['src/core/thing.ts']);
    expect(() => memoryEvent.parse({ ...base, governs: ['src/core/thing.ts'] })).toThrow();
  });

  test('supersedes points at another event id; text is bounded', () => {
    expect(
      memoryEvent.parse({ ...base, supersedes: 'memevt_01d4f81783eb' }).supersedes,
    ).toBe('memevt_01d4f81783eb');
    expect(() => memoryEvent.parse({ ...base, supersedes: 'src_x' })).toThrow();
    expect(() => memoryEvent.parse({ ...base, text: '' })).toThrow();
    expect(() => memoryEvent.parse({ ...base, text: 'x'.repeat(4001) })).toThrow();
  });

  test('closed enums: event_type, actor.kind, status, confidence_kind, sensitivity', () => {
    expect(() => memoryEvent.parse({ ...base, event_type: 'rumor' })).toThrow();
    expect(() => memoryEvent.parse({ ...base, actor: { kind: 'robot' } })).toThrow();
    expect(() => memoryEvent.parse({ ...base, status: 'archived' })).toThrow();
    expect(() => memoryEvent.parse({ ...base, confidence_kind: 'GUESSED' })).toThrow();
    expect(() => memoryEvent.parse({ ...base, sensitivity: 'top-secret' })).toThrow();
  });
});
