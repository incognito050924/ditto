import { describe, expect, test } from 'bun:test';

import { queueItemKind, queueExit } from '../schemas';
import {
  acStatus,
  parseQueueState,
  queueState,
  pendingItems,
  pendingCount,
  isDrained,
  acsClaimingPassWithoutEvidence,
  progressLine,
} from './queue-state';

const validState = {
  round: 3,
  items: [
    {
      id: 'i1',
      kind: 'found-defect',
      exit: 'resolved',
      evidence_ref: 'state/queue.json#i1',
      disposition_note: 'fixed',
    },
    {
      id: 'i2',
      kind: 'in-scope-residual',
      exit: null,
      evidence_ref: null,
      disposition_note: null,
    },
  ],
  acceptance_criteria: [
    { id: 'ac-2', status: 'pass', evidence_ref: 'log#123' },
    { id: 'ac-3', status: 'unverified', evidence_ref: null },
  ],
  last_stop_hook: {
    command: 'bun test',
    exit_code: 0,
    timestamp: '2026-07-20T00:00:00Z',
    output_excerpt: '51 pass',
  },
  backstop: { turns: 4, no_progress_rounds: 0, queue_size_trend: [3, 2, 2] },
  blocker: null,
};

describe('queue-state schema', () => {
  test('kind enum is identical to the locked queue-item kind enum', () => {
    // Invariant: state model must reuse the schema-as-SoT enums exactly.
    expect(queueItemKind.options).toEqual([
      'found-defect',
      'in-scope-residual',
      'unverified-ac',
    ]);
  });

  test('item exit enum reuses the locked queue-item exit values (plus null)', () => {
    expect(queueExit.options).toEqual([
      'resolved',
      'new-scope-deferral',
      'escape',
    ]);
    // null is the pending marker on disk; the three non-null values must match.
    const parsed = queueState.parse(validState);
    expect(parsed.items[1]?.exit).toBeNull();
  });

  test('acStatus is the fail-closed AC subset pass|unverified|fail', () => {
    expect(acStatus.options).toEqual(['pass', 'unverified', 'fail']);
  });

  test('parses a well-formed state document', () => {
    expect(() => parseQueueState(JSON.stringify(validState))).not.toThrow();
  });

  test('fail-closed: rejects an item kind outside the locked enum', () => {
    const bad = structuredClone(validState);
    (bad.items[0] as { kind: string }).kind = 'made-up-kind';
    expect(() => parseQueueState(JSON.stringify(bad))).toThrow();
  });

  test('fail-closed: rejects an item exit outside the locked enum', () => {
    const bad = structuredClone(validState);
    (bad.items[0] as { exit: string }).exit = 'done';
    expect(() => parseQueueState(JSON.stringify(bad))).toThrow();
  });

  test('fail-closed: rejects unknown top-level keys (strict)', () => {
    const bad = { ...validState, surprise: 1 };
    expect(() => parseQueueState(JSON.stringify(bad))).toThrow();
  });
});

describe('pending computation (pending == exit null)', () => {
  test('pendingItems returns exactly the exit==null items', () => {
    const s = queueState.parse(validState);
    expect(pendingItems(s).map((i) => i.id)).toEqual(['i2']);
    expect(pendingCount(s)).toBe(1);
    expect(isDrained(s)).toBe(false);
  });

  test('isDrained true only when no item has exit null', () => {
    const s = queueState.parse(validState);
    const drained = {
      ...s,
      items: s.items.map((i) => ({ ...i, exit: 'resolved' as const })),
    };
    expect(pendingCount(drained)).toBe(0);
    expect(isDrained(drained)).toBe(true);
  });
});

describe('AC live-evidence rule (Stop hook input)', () => {
  test('flags an AC that claims pass but carries no evidence_ref', () => {
    const s = queueState.parse(validState);
    const overclaim = {
      ...s,
      acceptance_criteria: [
        { id: 'ac-9', status: 'pass' as const, evidence_ref: null },
        { id: 'ac-2', status: 'pass' as const, evidence_ref: 'log#1' },
      ],
    };
    expect(acsClaimingPassWithoutEvidence(overclaim).map((a) => a.id)).toEqual([
      'ac-9',
    ]);
  });

  test('an all-whitespace evidence_ref does not count as evidence', () => {
    const s = queueState.parse(validState);
    const overclaim = {
      ...s,
      acceptance_criteria: [
        { id: 'ac-9', status: 'pass' as const, evidence_ref: '   ' },
      ],
    };
    expect(acsClaimingPassWithoutEvidence(overclaim).map((a) => a.id)).toEqual([
      'ac-9',
    ]);
  });

  test('a pass AC with a real evidence_ref is not flagged', () => {
    const s = queueState.parse(validState);
    expect(acsClaimingPassWithoutEvidence(s)).toEqual([]);
  });
});

describe('progress.md line format', () => {
  test('open item renders exit as "open"', () => {
    const s = queueState.parse(validState);
    expect(progressLine(s.round, s.items[1]!)).toBe(
      '[round 3] i2 in-scope-residual → open: (none) (evidence: none)',
    );
  });

  test('disposed item renders exit + note + evidence', () => {
    const s = queueState.parse(validState);
    expect(progressLine(s.round, s.items[0]!)).toBe(
      '[round 3] i1 found-defect → resolved: fixed (evidence: state/queue.json#i1)',
    );
  });
});

describe('cross-process resume (ac-5 oracle)', () => {
  test('undisposed item set survives a serialize→parse round trip', () => {
    // process1 writes, process2 reads and must see the SAME pending set.
    const written = JSON.stringify(queueState.parse(validState));
    const reread = parseQueueState(written);
    expect(pendingItems(reread).map((i) => i.id)).toEqual(['i2']);
  });
});
