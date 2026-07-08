import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { committedWorkItemDir, localDir } from '~/core/ditto-paths';
import { PrismStore } from '~/core/prism/store';
import { checkCommittedBase } from '../../scripts/check-committed-base-run-artifact';

// wi_260708cdl: the prism draft's decision + backlog records are the exploratory
// Run-tier execution trail (the issue-map draft is already Run tier), consumed only
// within the same prism session. They must NOT sit in the committed Record base
// (`.ditto/work-items/<id>/` = record.json + events/ ONLY, ADR-20260706) — where they
// trip the committed-base run-artifact guard and block the commit. They belong in the
// Run tier alongside the issue-map draft.
describe('PrismStore — decisions + backlog live in the Run tier, not the committed base (wi_260708cdl)', () => {
  async function writeRecords(repo: string, wi: string): Promise<PrismStore> {
    const store = new PrismStore(repo);
    await store.appendDecision({
      schema_version: '0.1.0',
      work_item_id: wi,
      kind: 'skip',
      reason: 'test skip decision',
      recorded_at: '2026-07-08T00:00:00.000Z',
    });
    await store.writeBacklogSplit({
      schema_version: '0.1.0',
      work_item_id: wi,
      items: [],
      materialized: [],
    });
    return store;
  }

  test('ac-1: records land under .ditto/local/.../prism, never the committed base; round-trip holds', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ditto-prism-store-'));
    const wi = 'wi_cdlstore01';
    try {
      const store = await writeRecords(repo, wi);

      // Run tier (local): both records exist under the prism dir.
      const runPrism = localDir(repo, 'work-items', wi, 'prism');
      expect(existsSync(join(runPrism, 'prism-decisions.jsonl'))).toBe(true);
      expect(existsSync(join(runPrism, 'prism-backlog-split.json'))).toBe(true);

      // Committed base (Record tier): NO prism artifacts leak here.
      const committed = committedWorkItemDir(repo, wi);
      expect(existsSync(join(committed, 'prism-decisions.jsonl'))).toBe(false);
      expect(existsSync(join(committed, 'prism-backlog-split.json'))).toBe(false);

      // Round-trip from the Run-tier path is intact.
      expect((await store.readDecisions(wi)).length).toBe(1);
      expect(await store.readBacklogSplit(wi)).not.toBeNull();
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('ac-2: after recording prism decisions, the committed-base guard reports zero violations', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ditto-prism-store-'));
    const wi = 'wi_cdlstore02';
    try {
      await writeRecords(repo, wi);
      // The landmine: pre-fix, the prism files sat in the committed base and this
      // guard blocked the commit. Post-fix, the committed base holds no prism leak.
      expect(await checkCommittedBase(repo)).toEqual([]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
