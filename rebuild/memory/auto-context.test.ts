import { afterEach, describe, expect, test } from 'bun:test';

import type { MemoryEvent } from '../schemas/memory-event';
import { autoMemoryContext } from './auto-context';

const original = process.env.DITTO_MEMORY;
afterEach(() => {
  if (original === undefined) delete process.env.DITTO_MEMORY;
  else process.env.DITTO_MEMORY = original;
});

let seq = 0;
function approved(text: string, id: string): MemoryEvent {
  seq += 1;
  return {
    schema_version: '0.1.0',
    event_id: id,
    event_type: 'observation',
    actor: { kind: 'agent', role: 'test' },
    text,
    created_at: `2026-07-24T00:00:${String(seq).padStart(2, '0')}.000Z`,
    status: 'approved',
    approved_by: 'user',
    decided_at: '2026-07-24T01:00:00.000Z',
    sources: [],
    confidence_kind: 'EXTRACTED',
    sensitivity: 'internal',
    governs: [],
  } as MemoryEvent;
}

describe('autoMemoryContext — the auto-inject entry, gated by the master switch (fail-open)', () => {
  const events = [approved('ADR-0020 상류 데이터', 'memevt_a0000001')];

  test('when off, returns undefined so the caller path is byte-for-byte unchanged', () => {
    process.env.DITTO_MEMORY = 'off';
    expect(autoMemoryContext(events, { text: 'ADR-0020' })).toBeUndefined();
  });

  test('when on (default), returns the matching visible hits', () => {
    delete process.env.DITTO_MEMORY;
    const hits = autoMemoryContext(events, { text: 'ADR-0020' });
    expect(hits?.map((h) => h.event_id)).toEqual(['memevt_a0000001']);
  });

  test('on but no match still yields undefined (nothing to inject), not an empty array', () => {
    delete process.env.DITTO_MEMORY;
    expect(autoMemoryContext(events, { text: 'nonexistent-term' })).toBeUndefined();
  });
});
