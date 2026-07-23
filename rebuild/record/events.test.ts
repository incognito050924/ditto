import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  appendEvent,
  createEvent,
  listEvents,
  workItemEvent,
} from './events';

async function freshDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ditto-events-'));
}

describe('work item event log (append-only, per-event files)', () => {
  test('createEvent derives a deterministic 64-hex event_id from logical content', () => {
    const a = createEvent({
      work_item_id: 'wi_x',
      seq: 1,
      actor: 'tester',
      ts: '2026-07-23T01:00:00.000Z',
      kind: 'status',
      payload: { to: 'in_progress' },
    });
    const b = createEvent({
      work_item_id: 'wi_x',
      seq: 1,
      actor: 'tester',
      ts: '2026-07-23T09:99:99.000Z', // ts differs — id must not
      kind: 'status',
      payload: { to: 'in_progress' },
    });
    expect(a.event_id).toMatch(/^[0-9a-f]{64}$/);
    expect(a.event_id).toBe(b.event_id);
  });

  test('appendEvent writes <seq6>.<actor>.<eid12>.json and never overwrites', async () => {
    const dir = await freshDir();
    const event = createEvent({
      work_item_id: 'wi_x',
      seq: 1,
      actor: 'Work Space/Write!',
      ts: '2026-07-23T01:00:00.000Z',
      kind: 'status',
      payload: { to: 'in_progress' },
    });
    await appendEvent(dir, event);

    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    const name = files[0]!;
    expect(name).toMatch(/^000001\.[a-z0-9-]+\.[0-9a-f]{12}\.json$/);

    const onDisk = workItemEvent.parse(
      JSON.parse(await readFile(join(dir, name), 'utf8')),
    );
    expect(onDisk).toEqual(event);

    // immutability: same event appended again must throw, file untouched
    await expect(appendEvent(dir, event)).rejects.toThrow();
    expect(await readdir(dir)).toHaveLength(1);
  });

  test('verdict events carry criterion verdicts under the 3-value contract', () => {
    const ok = createEvent({
      work_item_id: 'wi_x',
      seq: 2,
      actor: 'tester',
      ts: '2026-07-23T01:00:00.000Z',
      kind: 'verdict',
      payload: {
        criterion_id: 'ac1',
        verdict: 'pass',
        evidence: [{ kind: 'test', path: 'rebuild/x.test.ts', summary: 'green' }],
      },
    });
    expect(workItemEvent.parse(ok).kind).toBe('verdict');

    expect(
      workItemEvent.safeParse({
        ...ok,
        payload: { criterion_id: 'ac1', verdict: 'partial', evidence: [] },
      }).success,
    ).toBe(false);
  });

  test('listEvents returns all persisted events, schema-validated', async () => {
    const dir = await freshDir();
    const first = createEvent({
      work_item_id: 'wi_x',
      seq: 1,
      actor: 'a',
      ts: '2026-07-23T01:00:00.000Z',
      kind: 'status',
      payload: { to: 'in_progress' },
    });
    const second = createEvent({
      work_item_id: 'wi_x',
      seq: 2,
      actor: 'a',
      ts: '2026-07-23T02:00:00.000Z',
      kind: 'status',
      payload: { to: 'done', closed_at: '2026-07-23T02:00:00.000Z' },
    });
    await appendEvent(dir, first);
    await appendEvent(dir, second);

    const events = await listEvents(dir);
    expect(events).toHaveLength(2);
    expect(new Set(events.map((e) => e.seq))).toEqual(new Set([1, 2]));
  });

  test('listEvents on a missing events dir is an empty log, not an error', async () => {
    const dir = await freshDir();
    expect(await listEvents(join(dir, 'never-created'))).toEqual([]);
  });
});
