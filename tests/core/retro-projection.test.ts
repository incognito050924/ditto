import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryEventStore } from '~/core/memory-store';
import {
  type RetroNarrativeRecords,
  absorbRetroMemory,
  codeSourceIdsForPaths,
  projectRetroNarrative,
  retroMemoryEventId,
} from '~/core/retro-measure';
import type { MemorySource } from '~/schemas/memory-source';

let workDir: string;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'ditto-retro-'));
  await mkdir(join(workDir, '.ditto'), { recursive: true });
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function records(over: Partial<RetroNarrativeRecords> = {}): RetroNarrativeRecords {
  return {
    work_item_id: 'wi_retro001',
    unverified: [],
    residual_risks: [],
    close_reasons: [],
    intent_drift: [],
    evidence_refs: [],
    ...over,
  };
}

describe('projectRetroNarrative (ac-5: projection-only, no free-form generation)', () => {
  test('narrative carries ONLY what the passed records say', () => {
    const n = projectRetroNarrative(
      records({
        unverified: ['db migration not run'],
        residual_risks: ['rate-limit untested under load'],
        close_reasons: ['cov-cat-ops skipped: out of scope'],
        intent_drift: ['scope widened to add caching'],
      }),
    );
    const blob = JSON.stringify(n);
    expect(blob).toContain('db migration not run');
    expect(blob).toContain('rate-limit untested under load');
    expect(blob).toContain('cov-cat-ops skipped: out of scope');
    expect(blob).toContain('scope widened to add caching');
  });

  test('a fact NOT in the passed records NEVER appears (no invention)', () => {
    const n = projectRetroNarrative(records({ unverified: ['only this'] }));
    const blob = JSON.stringify(n);
    expect(blob).toContain('only this');
    // nothing the records did not state is fabricated.
    expect(blob).not.toContain('something the run never recorded');
    expect(blob).not.toContain('TODO');
  });

  test('empty records → an empty narrative (nothing notable), not invented prose', () => {
    const n = projectRetroNarrative(records());
    expect(n.items).toEqual([]);
  });
});

describe('absorbRetroMemory (ac-5: idempotent + filtered cross-WI absorption)', () => {
  const projection = () =>
    projectRetroNarrative(
      records({
        unverified: ['db migration not run'],
        residual_risks: ['rate-limit untested under load'],
      }),
    );

  const opts = () => ({ createdAt: '2026-06-24T10:00:00+00:00', actorRole: 'retrospective' });

  test('idempotency key is stable and derived from the work item id', () => {
    expect(retroMemoryEventId('wi_retro001')).toBe(retroMemoryEventId('wi_retro001'));
    expect(retroMemoryEventId('wi_retro001')).not.toBe(retroMemoryEventId('wi_other999'));
    expect(retroMemoryEventId('wi_retro001')).toMatch(/^memevt_/);
  });

  test('re-driving the retro does NOT double-append the same event (append-once)', async () => {
    const store = new MemoryEventStore(workDir);
    const first = await absorbRetroMemory(store, projection(), opts());
    expect(first.appended).toBe(true);
    const second = await absorbRetroMemory(store, projection(), opts());
    expect(second.appended).toBe(false);
    // exactly one event on disk for this work item.
    const all = await store.list();
    expect(all.filter((e) => e.event_id === retroMemoryEventId('wi_retro001')).length).toBe(1);
  });

  test('absorbed event carries the durable projected content', async () => {
    const store = new MemoryEventStore(workDir);
    await absorbRetroMemory(store, projection(), opts());
    const e = await store.get(retroMemoryEventId('wi_retro001'));
    expect(e.text).toContain('db migration not run');
    expect(e.text).toContain('rate-limit untested under load');
  });

  test('absorption FILTER excludes process-health noise from durable cross-WI memory', async () => {
    const store = new MemoryEventStore(workDir);
    // The narrative may be assembled next to process-health, but post_cost-style
    // process noise must NOT pollute the durable warm-start prior.
    const n = projectRetroNarrative(
      records({ residual_risks: ['real residual'], process_health_note: 'post_cost=7 churn' }),
    );
    await absorbRetroMemory(store, n, opts());
    const e = await store.get(retroMemoryEventId('wi_retro001'));
    expect(e.text).toContain('real residual');
    expect(e.text).not.toContain('post_cost');
    expect(e.text).not.toContain('churn');
  });

  test('a whole-empty projection absorbs NOTHING (no empty durable event)', async () => {
    const store = new MemoryEventStore(workDir);
    const res = await absorbRetroMemory(store, projectRetroNarrative(records()), opts());
    expect(res.appended).toBe(false);
    expect(await store.list()).toEqual([]);
  });

  test('absorbed event BINDS the source_ids passed in opts (no longer hardcoded empty)', async () => {
    const store = new MemoryEventStore(workDir);
    await absorbRetroMemory(store, projection(), {
      ...opts(),
      sources: ['src_aaaa', 'src_bbbb'],
    });
    const e = await store.get(retroMemoryEventId('wi_retro001'));
    expect(e.sources).toEqual(['src_aaaa', 'src_bbbb']);
  });

  test('absent opts.sources stays an empty array (backward compatible)', async () => {
    const store = new MemoryEventStore(workDir);
    await absorbRetroMemory(store, projection(), opts());
    const e = await store.get(retroMemoryEventId('wi_retro001'));
    expect(e.sources).toEqual([]);
  });

  test('an OVERSIZED narrative (text > the 4000-char memory-event max) absorbs TRUNCATED, not silently dropped', async () => {
    // A legitimate large retro: many residual-risk rows whose joined text exceeds the
    // memory-event `.max(4000)`. The zod ceiling must NOT make the absorb throw (which
    // the loop's try/catch would swallow → a real retro lost with no log). The text is
    // truncated to fit the limit and exactly ONE event is appended (truncation over
    // silent-drop — the projection is bounded record content, so truncation is OK).
    const store = new MemoryEventStore(workDir);
    const bigRisks = Array.from({ length: 60 }, (_, i) => `residual risk ${i}: ${'x'.repeat(120)}`);
    const n = projectRetroNarrative(records({ residual_risks: bigRisks }));
    const joined = n.items
      .filter((i) => i.memory_eligible)
      .map((i) => `[${i.kind}] ${i.text}`)
      .join('\n');
    expect(joined.length).toBeGreaterThan(4000); // precondition: would overflow the schema max

    const res = await absorbRetroMemory(store, n, opts());
    expect(res.appended).toBe(true); // absorbed, not thrown / dropped
    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.text.length ?? 0).toBeLessThanOrEqual(4000); // fits the schema ceiling
  });
});

describe('codeSourceIdsForPaths (retro source binding: ground the event in changed code)', () => {
  const src = (id: string, type: MemorySource['source_type'], path: string): MemorySource =>
    ({ source_id: id, source_type: type, path }) as MemorySource;

  test('maps a changed-file path to its code source_id', () => {
    const sources = [src('src_a', 'code', 'src/core/worktree.ts')];
    expect(codeSourceIdsForPaths(sources, ['src/core/worktree.ts'])).toEqual(['src_a']);
  });

  test('excludes non-code sources even when the path matches', () => {
    const sources = [
      src('doc_a', 'markdown', 'reports/x.md'),
      src('src_a', 'code', 'src/core/a.ts'),
    ];
    expect(codeSourceIdsForPaths(sources, ['reports/x.md', 'src/core/a.ts'])).toEqual(['src_a']);
  });

  test('excludes code sources whose path is not in the changed set', () => {
    const sources = [src('src_a', 'code', 'src/core/a.ts'), src('src_b', 'code', 'src/core/b.ts')];
    expect(codeSourceIdsForPaths(sources, ['src/core/a.ts'])).toEqual(['src_a']);
  });

  test('dedups when the same path appears more than once', () => {
    const sources = [src('src_a', 'code', 'src/core/a.ts')];
    expect(codeSourceIdsForPaths(sources, ['src/core/a.ts', 'src/core/a.ts'])).toEqual(['src_a']);
  });

  test('empty when no changed path resolves to a code source', () => {
    const sources = [src('src_a', 'code', 'src/core/a.ts')];
    expect(codeSourceIdsForPaths(sources, ['unknown/path.ts'])).toEqual([]);
    expect(codeSourceIdsForPaths([], ['src/core/a.ts'])).toEqual([]);
  });
});
