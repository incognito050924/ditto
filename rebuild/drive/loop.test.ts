import { describe, expect, test } from 'bun:test';

import { queueItem } from '../schemas';
import { driveStep } from './loop';

const openItem = queueItem.parse({ id: 'd1', kind: 'found-defect' });

describe('driveStep — thin drive-loop, one item through decideGate (ac-6 slice)', () => {
  test('pass outcome WITH grounds → exit resolved (disposed)', () => {
    const r = driveStep(openItem, {
      outcome: 'pass',
      grounds: 'bun test rebuild/ → 85 pass 0 fail',
    });
    expect(r.disposed).toBe(true);
    expect(r.item.exit).toBe('resolved');
    expect(r.grounds).toBe('bun test rebuild/ → 85 pass 0 fail');
    // Output item must still satisfy the locked queue-item contract.
    expect(() => queueItem.parse(r.item)).not.toThrow();
  });

  test('pass outcome WITHOUT grounds → block, item stays open (fail-closed)', () => {
    const r = driveStep(openItem, { outcome: 'pass' });
    expect(r.disposed).toBe(false);
    expect(r.item.exit).toBeUndefined();
  });

  test('empty/whitespace grounds → block (fail-closed via decideGate)', () => {
    const r = driveStep(openItem, { outcome: 'pass', grounds: '   ' });
    expect(r.disposed).toBe(false);
    expect(r.item.exit).toBeUndefined();
  });

  test('fail outcome → block, item stays open', () => {
    const r = driveStep(openItem, { outcome: 'fail', grounds: 'still red' });
    expect(r.disposed).toBe(false);
    expect(r.item.exit).toBeUndefined();
  });

  test('undecidable (no outcome) → block (fail-closed default)', () => {
    const r = driveStep(openItem, {});
    expect(r.disposed).toBe(false);
    expect(r.item.exit).toBeUndefined();
  });

  test('does not mutate the input item', () => {
    driveStep(openItem, { outcome: 'pass', grounds: 'x' });
    expect(openItem.exit).toBeUndefined();
  });

  test('gate block + route new-scope-deferral WITH grounds → disposed to that door', () => {
    const r = driveStep(openItem, {
      route: 'new-scope-deferral',
      grounds: 'belongs to a later scope; logged to backlog',
    });
    expect(r.disposed).toBe(true);
    expect(r.item.exit).toBe('new-scope-deferral');
    expect(r.grounds).toBe('belongs to a later scope; logged to backlog');
    expect(() => queueItem.parse(r.item)).not.toThrow();
    expect(openItem.exit).toBeUndefined();
  });

  test('gate block + route escape WITH grounds → disposed to escape door', () => {
    const r = driveStep(openItem, {
      route: 'escape',
      grounds: 'plan direction reversed; human decision needed',
    });
    expect(r.disposed).toBe(true);
    expect(r.item.exit).toBe('escape');
    expect(r.grounds).toBe('plan direction reversed; human decision needed');
    expect(() => queueItem.parse(r.item)).not.toThrow();
  });

  test('route set but grounds empty/whitespace → stays open (fail-closed)', () => {
    const r = driveStep(openItem, { route: 'escape', grounds: '   ' });
    expect(r.disposed).toBe(false);
    expect(r.item.exit).toBeUndefined();
  });

  test('route set but no grounds → stays open (fail-closed)', () => {
    const r = driveStep(openItem, { route: 'new-scope-deferral' });
    expect(r.disposed).toBe(false);
    expect(r.item.exit).toBeUndefined();
  });

  test('gate pass wins over route → resolved, not the routed door', () => {
    const r = driveStep(openItem, {
      outcome: 'pass',
      grounds: 'bun test rebuild/ → all green',
      route: 'escape',
    });
    expect(r.disposed).toBe(true);
    expect(r.item.exit).toBe('resolved');
  });
});
