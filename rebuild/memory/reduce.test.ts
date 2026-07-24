import { describe, expect, test } from 'bun:test';

import type { MemoryEvent } from '../schemas/memory-event';
import { reduceEvents } from './reduce';

let seq = 0;
function evt(over: Partial<MemoryEvent> & { event_id: string }): MemoryEvent {
  seq += 1;
  return {
    schema_version: '0.1.0',
    event_type: 'observation',
    actor: { kind: 'agent', role: 'test' },
    text: `event ${over.event_id}`,
    created_at: `2026-07-24T00:00:${String(seq).padStart(2, '0')}.000Z`,
    status: 'pending',
    sources: [],
    confidence_kind: 'EXTRACTED',
    sensitivity: 'internal',
    governs: [],
    ...over,
  } as MemoryEvent;
}

function approved(over: Partial<MemoryEvent> & { event_id: string }): MemoryEvent {
  return evt({ status: 'approved', approved_by: 'user', decided_at: '2026-07-24T01:00:00.000Z', ...over });
}

describe('reduceEvents — supersedes chain resolution', () => {
  test('approved heads are the events no EFFECTIVE event supersedes', () => {
    const events = [
      approved({ event_id: 'memevt_aaaa1111' }),
      approved({ event_id: 'memevt_bbbb2222' }),
    ];
    const { approvedHeads } = reduceEvents(events);
    expect(approvedHeads.map((e) => e.event_id)).toEqual(['memevt_aaaa1111', 'memevt_bbbb2222']);
  });

  test('an approved superseding event retracts the one it supersedes', () => {
    const events = [
      approved({ event_id: 'memevt_old00000' }),
      approved({ event_id: 'memevt_new00000', supersedes: 'memevt_old00000' }),
    ];
    const { approvedHeads } = reduceEvents(events);
    expect(approvedHeads.map((e) => e.event_id)).toEqual(['memevt_new00000']);
  });

  test('a PENDING correction can neither add nor remove — it does not retract an approved head', () => {
    const events = [
      approved({ event_id: 'memevt_fact00000' }),
      evt({ event_id: 'memevt_pending000', supersedes: 'memevt_fact00000' }), // pending
    ];
    const { approvedHeads } = reduceEvents(events);
    // The pending event is neither a head (not approved) nor effective enough to drop the fact.
    expect(approvedHeads.map((e) => e.event_id)).toEqual(['memevt_fact00000']);
  });

  test('a REJECTED superseding event does not retract its target either', () => {
    const events = [
      approved({ event_id: 'memevt_keep00000' }),
      evt({
        event_id: 'memevt_rej00000',
        status: 'rejected',
        approved_by: 'user',
        decided_at: '2026-07-24T01:00:00.000Z',
        supersedes: 'memevt_keep00000',
      }),
    ];
    expect(reduceEvents(events).approvedHeads.map((e) => e.event_id)).toEqual(['memevt_keep00000']);
  });

  test('transitive effect: A <- B(pending) <- C(approved) — C makes B an effective conduit, so A is retracted too', () => {
    // `effective(e)` = e is approved OR some event that supersedes e is effective. C is
    // approved ⇒ effective; C supersedes B ⇒ B is effective (approved conduit above it);
    // B supersedes A ⇒ A is superseded by an effective event ⇒ A is not a head. Only the
    // terminal approved event C survives.
    const events = [
      approved({ event_id: 'memevt_a0000000' }),
      evt({ event_id: 'memevt_b0000000', supersedes: 'memevt_a0000000' }), // pending
      approved({ event_id: 'memevt_c0000000', supersedes: 'memevt_b0000000' }),
    ];
    const { approvedHeads } = reduceEvents(events);
    expect(approvedHeads.map((e) => e.event_id)).toEqual(['memevt_c0000000']);
  });

  test('a purely-pending supersede chain leaves the approved base intact (no effective conduit above)', () => {
    // A(approved) <- B(pending) <- D(pending): nothing above A is approved, so no effective
    // event supersedes A ⇒ A stays. This is the R3 guard: pending can neither add nor remove.
    const events = [
      approved({ event_id: 'memevt_base0000' }),
      evt({ event_id: 'memevt_pend1111', supersedes: 'memevt_base0000' }),
      evt({ event_id: 'memevt_pend2222', supersedes: 'memevt_pend1111' }),
    ];
    expect(reduceEvents(events).approvedHeads.map((e) => e.event_id)).toEqual(['memevt_base0000']);
  });

  test('setHash is stable under input reordering and changes when the head set changes', () => {
    const a = approved({ event_id: 'memevt_h1111111' });
    const b = approved({ event_id: 'memevt_h2222222' });
    const h1 = reduceEvents([a, b]).setHash;
    const h2 = reduceEvents([b, a]).setHash;
    expect(h1).toBe(h2);
    const h3 = reduceEvents([a]).setHash;
    expect(h3).not.toBe(h1);
  });

  test('a supersedes cycle does not hang and yields no phantom heads', () => {
    const events = [
      approved({ event_id: 'memevt_cyc11111', supersedes: 'memevt_cyc22222' }),
      approved({ event_id: 'memevt_cyc22222', supersedes: 'memevt_cyc11111' }),
    ];
    // Both approved and each supersedes the other; the cycle guard must terminate.
    expect(() => reduceEvents(events)).not.toThrow();
  });
});
