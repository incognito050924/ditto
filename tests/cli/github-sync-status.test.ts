import { describe, expect, test } from 'bun:test';
import { syncStatusMaps } from '~/cli/commands/github';
import { type GhDegradeReason, createFakeGhClient } from '~/core/gh-client';
import type { DittoConfigGithub } from '~/schemas/ditto-config';

// The user's live board: Backlog, Ready, In progress (47fc9ee4), In review, Done
// (98236657). No Blocked column.
const USER_FIELD_LIST = {
  fields: [
    { id: 'PVTF_title', name: 'Title', type: 'ProjectV2Field' },
    {
      id: 'PVTSSF_status',
      name: 'Status',
      type: 'ProjectV2SingleSelectField',
      options: [
        { id: 'opt_backlog', name: 'Backlog' },
        { id: 'opt_ready', name: 'Ready' },
        { id: '47fc9ee4', name: 'In progress' },
        { id: 'opt_inreview', name: 'In review' },
        { id: '98236657', name: 'Done' },
      ],
    },
  ],
};

function baseConfig(over: Partial<DittoConfigGithub> = {}): DittoConfigGithub {
  return {
    project: { owner: 'incognito050924', number: 5, node_id: 'PVT_old' },
    status_map: { done: 'old_done' },
    auto_reflect: true,
    ...over,
  } as DittoConfigGithub;
}

describe('syncStatusMaps - fill (backfill) mode', () => {
  test('C1/ac: backfills missing claim_status_map.in_progress, preserves node_id/auto_reflect/status_map', () => {
    const { client } = createFakeGhClient({
      values: { projectFieldList: USER_FIELD_LIST, projectView: { id: 'PVT_old' } },
    });
    const existing = baseConfig({ status_map: { done: 'old_done' } }); // no claim_status_map
    const out = syncStatusMaps(client, existing, { mode: 'fill' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.config.claim_status_map).toEqual({ in_progress: '47fc9ee4' });
      // done already present → fill must NOT overwrite it (C6)
      expect(out.config.status_map).toEqual({ done: 'old_done' });
      expect(out.config.project.node_id).toBe('PVT_old');
      expect(out.config.auto_reflect).toBe(true);
      expect(out.config.project.owner).toBe('incognito050924');
    }
  });

  test('C6: fill never overwrites an existing claim_status_map.in_progress value', () => {
    const { client } = createFakeGhClient({ values: { projectFieldList: USER_FIELD_LIST } });
    const existing = baseConfig({ claim_status_map: { in_progress: 'user_chosen' } });
    const out = syncStatusMaps(client, existing, { mode: 'fill' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.config.claim_status_map?.in_progress).toBe('user_chosen');
  });

  test('fill backfills status_map.done when absent (가능 시 done)', () => {
    const { client } = createFakeGhClient({ values: { projectFieldList: USER_FIELD_LIST } });
    const existing = baseConfig({ status_map: {} });
    const out = syncStatusMaps(client, existing, { mode: 'fill' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.config.status_map).toEqual({ done: '98236657' });
  });

  test('C1: node_id preserved when projectView yields no id (best-effort)', () => {
    const { client } = createFakeGhClient({ values: { projectFieldList: USER_FIELD_LIST } });
    const existing = baseConfig();
    const out = syncStatusMaps(client, existing, { mode: 'fill' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.config.project.node_id).toBe('PVT_old');
  });
});

describe('syncStatusMaps - overwrite (re-sync) mode', () => {
  test('C3a: overwrites known key from board, preserves unknown/future key (blocked)', () => {
    const { client } = createFakeGhClient({ values: { projectFieldList: USER_FIELD_LIST } });
    const existing = baseConfig({
      claim_status_map: { in_progress: 'stale', blocked: 'keep_blocked' },
    });
    const out = syncStatusMaps(client, existing, { mode: 'overwrite' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.config.claim_status_map?.in_progress).toBe('47fc9ee4'); // overwritten
      expect(out.config.claim_status_map?.blocked).toBe('keep_blocked'); // future key preserved
    }
  });

  test('C3b: a known key not re-derivable from the board is preserved + warned, not deleted', () => {
    const NO_DONE = {
      fields: [
        {
          id: 'PVTSSF_status',
          name: 'Status',
          type: 'ProjectV2SingleSelectField',
          options: [
            { id: 'opt_backlog', name: 'Backlog' },
            { id: '47fc9ee4', name: 'In progress' },
          ],
        },
      ],
    };
    const { client } = createFakeGhClient({ values: { projectFieldList: NO_DONE } });
    const existing = baseConfig({ status_map: { done: 'old_done' } });
    const out = syncStatusMaps(client, existing, { mode: 'overwrite' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.config.status_map.done).toBe('old_done'); // preserved, not deleted
      expect(out.notices.join(' ')).toContain('not re-derivable');
    }
  });
});

describe('syncStatusMaps - safety', () => {
  test('C3c: gh fetch degraded → abort, ok:false (no write candidate produced)', () => {
    const { client } = createFakeGhClient({
      degrade: { ok: false, reason: 'gh_unavailable' as GhDegradeReason, detail: 'network' },
    });
    const out = syncStatusMaps(client, baseConfig(), { mode: 'overwrite' });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('gh_unavailable');
  });

  test('C4: ambiguous detection leaves the key unset + warning (no find-first guess)', () => {
    const AMBIG = {
      fields: [
        {
          id: 'PVTSSF_status',
          name: 'Status',
          type: 'ProjectV2SingleSelectField',
          options: [
            { id: 'a', name: 'In Progress' },
            { id: 'b', name: 'in-progress' },
          ],
        },
      ],
    };
    const { client } = createFakeGhClient({ values: { projectFieldList: AMBIG } });
    const existing = baseConfig({ status_map: {} });
    const out = syncStatusMaps(client, existing, { mode: 'fill' });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.config.claim_status_map).toBeUndefined(); // not guessed
      expect(out.warnings.join(' ')).toContain('ambiguous');
    }
  });
});
