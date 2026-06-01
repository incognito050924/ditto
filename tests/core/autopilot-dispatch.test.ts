import { describe, expect, test } from 'bun:test';
import {
  buildDelegationPacket,
  decideOnFailure,
  guardChildResult,
} from '~/core/autopilot-dispatch';
import { buildInitialNodes } from '~/core/autopilot-graph';
import type { WorkItem } from '~/schemas/work-item';

const nodes = buildInitialNodes(['ac-1', 'ac-2']);
const byKind = (kind: string) => {
  const node = nodes.find((n) => n.kind === kind);
  if (!node) throw new Error(`no ${kind} node`);
  return node;
};
const implementNode = byKind('implement');
const verifyNode = byKind('verify');

const workItem = {
  id: 'wi_dispatch1',
  changed_files: ['src/password.ts'],
} as unknown as WorkItem;

const caps = { fix_per_node: 2, switch_per_node: 1 };

describe('buildDelegationPacket (6-section, Context Isolation)', () => {
  test('carries task, scope, done_when, and isolation guard', () => {
    const p = buildDelegationPacket(implementNode, workItem);
    expect(p.task).toBe(implementNode.purpose);
    expect(p.context.work_item_id).toBe('wi_dispatch1');
    expect(p.context.file_scope).toEqual(['src/password.ts']);
    expect(p.context.acceptance_refs).toEqual(['ac-1', 'ac-2']);
    expect(p.must_not_do.some((m) => m.includes('Context Isolation'))).toBe(true);
    expect(p.required_tools).toContain('Edit'); // implementer may mutate
  });

  test('read-only owners are told not to mutate', () => {
    const p = buildDelegationPacket(verifyNode, workItem);
    expect(p.required_tools).not.toContain('Edit');
    expect(p.must_not_do.some((m) => m.includes('read-only'))).toBe(true);
  });
});

describe('decideOnFailure (caps automatic; escalate to user beyond)', () => {
  test('fixable under cap => retry', () => {
    expect(decideOnFailure('fixable', { fix: 0, switch: 0 }, caps)).toEqual({
      decision: 'retry',
      cap_exceeded: false,
    });
  });

  test('fixable at cap => escalate + cap_exceeded (non-pass)', () => {
    expect(decideOnFailure('fixable', { fix: 2, switch: 0 }, caps)).toEqual({
      decision: 'escalate',
      cap_exceeded: true,
    });
  });

  test('wrong_approach under cap => switch_approach', () => {
    expect(decideOnFailure('wrong_approach', { fix: 0, switch: 0 }, caps)).toEqual({
      decision: 'switch_approach',
      cap_exceeded: false,
    });
  });

  test('wrong_approach at cap => escalate + cap_exceeded', () => {
    expect(decideOnFailure('wrong_approach', { fix: 0, switch: 1 }, caps)).toEqual({
      decision: 'escalate',
      cap_exceeded: true,
    });
  });

  test('blocked_external and user_decision_needed escalate to the user', () => {
    expect(decideOnFailure('blocked_external', { fix: 0, switch: 0 }, caps).decision).toBe(
      'escalate',
    );
    expect(decideOnFailure('user_decision_needed', { fix: 0, switch: 0 }, caps).decision).toBe(
      'escalate',
    );
  });
});

describe('guardChildResult (G7: completion signal ≠ completion proof)', () => {
  test('an empty / whitespace-only child result is non-contentful (not PASS)', () => {
    expect(guardChildResult('')).toMatchObject({ contentful: false, failure_class: 'fixable' });
    expect(guardChildResult('   \n\t  ')).toMatchObject({ contentful: false });
  });

  test('a bare ack ("done"/"ok"/"completed") is non-contentful (ack ≠ proof)', () => {
    for (const ack of ['done', 'Done.', 'ok', 'okay!', 'completed', 'passed', '✓', '👍']) {
      expect(guardChildResult(ack).contentful).toBe(false);
    }
  });

  test('a result carrying actual work/evidence is contentful', () => {
    expect(guardChildResult('ran `bun test` → 513 pass / 0 fail').contentful).toBe(true);
    expect(guardChildResult('edited src/gates.ts:80 to add deriveClosureMode').contentful).toBe(
      true,
    );
  });

  test('non-contentful routes through the existing failure pipeline as fixable (respawn)', () => {
    const guard = guardChildResult('');
    if (guard.contentful) throw new Error('expected non-contentful');
    // a fixable classification under cap retries (respawn smaller), never PASS.
    expect(decideOnFailure(guard.failure_class, { fix: 0, switch: 0 }, caps).decision).toBe(
      'retry',
    );
  });
});
