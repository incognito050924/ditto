import { describe, expect, test } from 'bun:test';

import type { MemoryEvent } from '../schemas/memory-event';
import { projectMemory, visibleHeads } from './projection';

let seq = 0;
function approved(over: Partial<MemoryEvent> & { event_id: string }): MemoryEvent {
  seq += 1;
  return {
    schema_version: '0.1.0',
    event_type: 'observation',
    actor: { kind: 'agent', role: 'test' },
    text: `event ${over.event_id}`,
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

describe('memory visibility — the single read-visibility rule (approved head ∧ ≠secret)', () => {
  test('exposes approved heads but never pending, rejected, or secret events', () => {
    const events = [
      approved({ event_id: 'memevt_public00', sensitivity: 'public' }),
      approved({ event_id: 'memevt_secret00', sensitivity: 'secret' }),
      { ...approved({ event_id: 'memevt_pending0' }), status: 'pending', approved_by: undefined, decided_at: undefined } as MemoryEvent,
    ];
    expect(visibleHeads(events).map((e) => e.event_id)).toEqual(['memevt_public00']);
  });

  test('a superseded approved event drops out of the visible set', () => {
    const events = [
      approved({ event_id: 'memevt_old00000' }),
      approved({ event_id: 'memevt_new00000', supersedes: 'memevt_old00000' }),
    ];
    expect(visibleHeads(events).map((e) => e.event_id)).toEqual(['memevt_new00000']);
  });
});

describe('projectMemory — the serving projection over visible heads', () => {
  test('projection carries the visible heads, a stable setHash, and a clock-injected timestamp', () => {
    const events = [
      approved({ event_id: 'memevt_a1111111' }),
      approved({ event_id: 'memevt_secret11', sensitivity: 'secret' }),
    ];
    const projection = projectMemory(events, { now: new Date('2026-07-24T05:00:00.000Z') });
    expect(projection.nodes.map((n) => n.event_id)).toEqual(['memevt_a1111111']);
    expect(projection.generated_at).toBe('2026-07-24T05:00:00.000Z');
    expect(projection.projection_id).toMatch(/^proj_[a-f0-9]{12}$/);
    expect(projection.set_hash).toHaveLength(64);
  });

  test('projection_id is a function of the visible head set — stable across reorder, changes with content', () => {
    const a = approved({ event_id: 'memevt_h1111111' });
    const b = approved({ event_id: 'memevt_h2222222' });
    const now = new Date('2026-07-24T05:00:00.000Z');
    expect(projectMemory([a, b], { now }).projection_id).toBe(
      projectMemory([b, a], { now }).projection_id,
    );
    expect(projectMemory([a], { now }).projection_id).not.toBe(
      projectMemory([a, b], { now }).projection_id,
    );
  });
});
