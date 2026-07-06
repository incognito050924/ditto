import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectBacklog } from '~/core/work-item-project';
import { WorkItemStore } from '~/core/work-item-store';

// WS0-T1 (wi_260706aka): the backlog projection layer. Recompute-on-read derivation
// over the committed Record tier (no cache file). Tested at the store/projection
// layer — CLI display of these fields is a separate node.

let dir: string;
let store: WorkItemStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-wiproj-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
  store = new WorkItemStore(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function baseInput(overrides: Record<string, unknown> = {}) {
  return {
    title: 't',
    source_request: 'r',
    goal: 'g',
    acceptance_criteria: [
      {
        id: 'ac-1',
        statement: 'the command exits 0',
        verdict: 'unverified' as const,
        evidence: [],
      },
    ],
    ...overrides,
  };
}

describe('projectBacklog', () => {
  test('ac-1: widens each row with fields derived from the committed Record', async () => {
    const wi = await store.create(baseInput());
    await store.update(wi.id, (cur) => ({
      ...cur,
      follow_ups: [
        { kind: 'bug', note: 'regression X', severity: 'high', self_caused: true },
        { kind: 'idea', note: 'later', resolved: true },
      ],
      github_issue: { repo: 'me/repo', number: 42 },
    }));

    const rows = await projectBacklog(dir);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    if (row === undefined) throw new Error('expected one row');
    expect(row.id).toBe(wi.id);
    expect(row.status).toBe('draft');
    // UNRESOLVED follow-ups only (the resolved idea does not count).
    expect(row.unresolved_follow_ups).toBe(1);
    // unresolved self-caused high-severity bug → blocked from done.
    expect(row.blocking_reason).toBeDefined();
    expect(row.github_issue).toEqual({ repo: 'me/repo', number: 42 });
    // AC still unverified → not push-ready.
    expect(row.push_ready).toBe(false);
    // lone WI → one-member stem marker.
    expect(row.lineage?.members.map((m) => m.id)).toEqual([wi.id]);
  });

  test('ac-1: unblocked WI omits blocking_reason and counts unresolved bug + idea', async () => {
    const wi = await store.create(baseInput());
    await store.update(wi.id, (cur) => ({
      ...cur,
      // a low-severity self-caused bug does NOT block done, but is still unresolved.
      follow_ups: [
        { kind: 'bug', note: 'minor', severity: 'low', self_caused: true },
        { kind: 'idea', note: 'candidate' },
      ],
    }));
    const rows = await projectBacklog(dir);
    const row = rows[0];
    if (row === undefined) throw new Error('expected one row');
    expect(row.unresolved_follow_ups).toBe(2);
    expect(row.blocking_reason).toBeUndefined();
    expect(row.github_issue).toBeUndefined();
  });

  test('WS0-T1 dual-base: legacy Run-only work items appear alongside committed Records', async () => {
    // A committed Record (record.json + events under .ditto/work-items/).
    const committed = await store.create(baseInput({ title: 'committed' }));
    // A legacy Run-only WI: created, then its committed Record dir removed, leaving
    // only the personal mirror (.ditto/local/work-items/<id>/work-item.json) — the
    // exact shape of the ~67 not-yet-migrated items (WS0-T4 migrates them later).
    const legacy = await store.create(baseInput({ title: 'legacy' }));
    await rm(join(dir, '.ditto', 'work-items', legacy.id), { recursive: true, force: true });

    const rows = await projectBacklog(dir);
    const ids = rows.map((r) => r.id).sort();
    // Both cohorts show up — the daily `ditto work list` utility is not truncated to
    // the committed 3.
    expect(ids).toEqual([committed.id, legacy.id].sort());
    // The legacy row still carries the widened fields (here a lone one-member stem).
    const legacyRow = rows.find((r) => r.id === legacy.id);
    if (legacyRow === undefined) throw new Error('expected legacy row');
    expect(legacyRow.lineage?.members.map((m) => m.id)).toEqual([legacy.id]);
    expect(legacyRow.push_ready).toBe(false);
  });

  test('ac-5: a committed row is identical after wiping the Run tier (legacy rows drop)', async () => {
    // Committed chain a→b→c (record.json + events under .ditto/work-items/).
    const a = await store.create(baseInput({ title: 'a' }));
    const b = await store.create(baseInput({ title: 'b', follows: a.id }));
    const c = await store.create(baseInput({ title: 'c', follows: b.id }));
    // Make `a` a real done (AC pass + command evidence) so the chain rollup mixes
    // terminal + non-terminal members.
    await store.update(a.id, (cur) => ({
      ...cur,
      acceptance_criteria: [
        {
          id: 'ac-1',
          statement: 'x',
          verdict: 'pass',
          evidence: [{ kind: 'command', command: 'bun test', summary: 'ok' }],
        },
      ],
    }));
    await store.close(a.id, 'done');
    // A legacy Run-only WI (no committed Record) — it legitimately vanishes when the
    // Run tier is deleted (it was never committed; WS0-T4 migrates such items).
    const legacy = await store.create(baseInput({ title: 'legacy' }));
    await rm(join(dir, '.ditto', 'work-items', legacy.id), { recursive: true, force: true });

    const before = await projectBacklog(dir);
    // Dual-base: the legacy row is present before the wipe.
    expect(before.map((r) => r.id)).toContain(legacy.id);
    // Multi-member stem is exercised: b's lineage sees the whole committed chain.
    const rowBBefore = before.find((r) => r.id === b.id);
    if (rowBBefore === undefined) throw new Error('expected row b');
    expect(rowBBefore.lineage?.members.map((m) => m.id)).toEqual([a.id, b.id, c.id]);
    expect(rowBBefore.lineage?.rolled_up).toBe('open'); // b,c still non-terminal

    // Wipe the ENTIRE Run tier (personal, gitignored): mirrors, runs, ledgers, and
    // the legacy WI's only copy.
    await rm(join(dir, '.ditto', 'local'), { recursive: true, force: true });

    const after = await projectBacklog(dir);
    // The determinism guarantee is scoped to COMMITTED Records: b's projected row and
    // every derived field reproduce byte-for-byte from the committed Record alone.
    const rowBAfter = after.find((r) => r.id === b.id);
    expect(rowBAfter).toEqual(rowBBefore);
    // The legacy Run-only item is gone (never committed — not part of the guarantee).
    expect(after.map((r) => r.id)).not.toContain(legacy.id);
  });
});
