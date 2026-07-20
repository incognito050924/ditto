import { describe, expect, test } from 'bun:test';

import { evidence, queueItem } from '../schemas';
import {
  boundaryEnvelope,
  isQueueDrained,
  type BoundaryEnvelope,
} from './host-adapter';
import { FakeHost } from './fake-host';

const drained: BoundaryEnvelope = {
  queue: [
    { id: 'q-1', kind: 'found-defect', exit: 'resolved' },
    { id: 'q-2', kind: 'unverified-ac', exit: 'escape' },
  ],
};

const open: BoundaryEnvelope = {
  queue: [
    { id: 'q-1', kind: 'found-defect', exit: 'resolved' },
    { id: 'q-2', kind: 'in-scope-residual' }, // still open — no exit door
  ],
};

describe('FakeHost — all five seam capabilities (ac-1)', () => {
  test('driveStep returns a validated boundary + deterministic sessionId', async () => {
    const host = new FakeHost({ boundaries: [drained] });
    const out = await host.driveStep({ prompt: 'x' });
    expect(out.sessionId).toBe('sess-1');
    expect(boundaryEnvelope.safeParse(out.boundary).success).toBe(true);
    expect(out.boundary.queue).toHaveLength(2);
  });

  test('driveStep reuses the resume session id when given', async () => {
    const host = new FakeHost({ boundaries: [drained] });
    const out = await host.driveStep({ prompt: 'x', resume: 'sess-prior' });
    expect(out.sessionId).toBe('sess-prior');
  });

  test('driveStep throws when no scripted boundary remains', () => {
    const host = new FakeHost({ boundaries: [] });
    expect(() => host.driveStep({ prompt: 'x' })).toThrow();
  });

  test('stopGate blocks on empty/uncertain, passes on grounded pass', () => {
    const host = new FakeHost();
    expect(host.stopGate({}).decision).toBe('block');
    expect(host.stopGate({ outcome: 'fail', grounds: 'x' }).decision).toBe(
      'block',
    );
    expect(host.stopGate({ outcome: 'pass' }).decision).toBe('block');
    const passed = host.stopGate({ outcome: 'pass', grounds: 'x' });
    expect(passed.decision).toBe('pass');
    expect(passed.grounds).toBe('x');
  });

  test('fanout returns the scripted opaque strings', async () => {
    const host = new FakeHost({ fanoutReturns: ['a', 'b'] });
    const out = await host.fanout([{ agentType: 't', prompt: 'p' }]);
    expect(out.map((s) => `${s}`)).toEqual(['a', 'b']);
  });

  test('fanout defaults to a per-task fixed string', async () => {
    const host = new FakeHost();
    const out = await host.fanout([
      { agentType: 'impl', prompt: 'p' },
      { agentType: 'review', prompt: 'q' },
    ]);
    expect(out.map((s) => `${s}`)).toEqual(['fanout:impl', 'fanout:review']);
  });

  test('readSidecar parses a valid scripted JSON', async () => {
    const item = { id: 'q-1', kind: 'found-defect' };
    const host = new FakeHost({ sidecars: { './s.json': JSON.stringify(item) } });
    const parsed = await host.readSidecar('./s.json', queueItem);
    expect(parsed.id).toBe('q-1');
    expect(parsed.kind).toBe('found-defect');
  });
});

describe('boundaryEnvelope fail-closed (ac-2)', () => {
  test('accepts a well-formed envelope with optional gate', () => {
    expect(
      boundaryEnvelope.safeParse({
        queue: [{ id: 'q-1', kind: 'found-defect' }],
        gate: { decision: 'block' },
      }).success,
    ).toBe(true);
  });

  test('accepts a well-formed envelope without gate', () => {
    expect(boundaryEnvelope.safeParse({ queue: [] }).success).toBe(true);
  });

  test('rejects an extra unknown key (.strict)', () => {
    expect(
      boundaryEnvelope.safeParse({ queue: [], extra: 1 }).success,
    ).toBe(false);
  });

  test('rejects a queue item with a bad exit value', () => {
    expect(
      boundaryEnvelope.safeParse({
        queue: [{ id: 'q-1', kind: 'found-defect', exit: 'done' }],
      }).success,
    ).toBe(false);
  });

  test('rejects a non-array queue', () => {
    expect(
      boundaryEnvelope.safeParse({ queue: { id: 'q-1' } }).success,
    ).toBe(false);
  });
});

describe('readSidecar fail-closed (ac-3)', () => {
  test('rejects a scripted sidecar whose JSON violates the schema', async () => {
    // evidence requires a non-empty summary and a path/hash reference.
    const host = new FakeHost({
      sidecars: { './bad.json': JSON.stringify({ kind: 'command' }) },
    });
    let threw = false;
    try {
      await host.readSidecar('./bad.json', evidence);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  test('resolves a valid one', async () => {
    const good = {
      kind: 'command',
      path: './out.log',
      summary: 'ran the suite',
    };
    const host = new FakeHost({
      sidecars: { './good.json': JSON.stringify(good) },
    });
    const parsed = await host.readSidecar('./good.json', evidence);
    expect(parsed.summary).toBe('ran the suite');
  });

  test('rejects a missing sidecar path', async () => {
    const host = new FakeHost({ sidecars: {} });
    let threw = false;
    try {
      await host.readSidecar('./nope.json', evidence);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe('core predicate driven only by the fake (ac-4)', () => {
  test('isQueueDrained is true for a drained boundary, false for an open one', async () => {
    const host = new FakeHost({ boundaries: [drained, open] });
    const first = await host.driveStep({ prompt: 'x' });
    expect(isQueueDrained(first.boundary)).toBe(true);
    const second = await host.driveStep({ prompt: 'y' });
    expect(isQueueDrained(second.boundary)).toBe(false);
  });
});
