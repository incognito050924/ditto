import { describe, expect, test } from 'bun:test';

import type { MemoryEvent } from '../schemas/memory-event';
import { queryMemory } from './query';

let seq = 0;
function approved(text: string, over: Partial<MemoryEvent> & { event_id: string }): MemoryEvent {
  seq += 1;
  return {
    schema_version: '0.1.0',
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
    ...over,
  } as MemoryEvent;
}

describe('queryMemory — text search restricted to the visible set', () => {
  test('matches on a case-insensitive substring of the event text', () => {
    const events = [
      approved('ADR-0020 결정-모순 가드레일의 상류 데이터', { event_id: 'memevt_hit000001' }),
      approved('무관한 관찰', { event_id: 'memevt_miss00001' }),
    ];
    const hits = queryMemory(events, { text: 'guardrail 없음 ADR-0020' });
    expect(hits.map((h) => h.event_id)).toEqual(['memevt_hit000001']);
  });

  test('never returns a secret, pending, or superseded event even if its text matches', () => {
    const events = [
      approved('needle in a secret', { event_id: 'memevt_secret00', sensitivity: 'secret' }),
      { ...approved('needle pending', { event_id: 'memevt_pending0' }), status: 'pending', approved_by: undefined, decided_at: undefined } as MemoryEvent,
      approved('needle old', { event_id: 'memevt_old00000' }),
      approved('needle new', { event_id: 'memevt_new00000', supersedes: 'memevt_old00000' }),
    ];
    const hits = queryMemory(events, { text: 'needle' });
    expect(hits.map((h) => h.event_id)).toEqual(['memevt_new00000']);
  });

  test('an empty or whitespace query returns nothing', () => {
    const events = [approved('anything', { event_id: 'memevt_x0000000' })];
    expect(queryMemory(events, { text: '' })).toEqual([]);
    expect(queryMemory(events, { text: '   ' })).toEqual([]);
  });
});
