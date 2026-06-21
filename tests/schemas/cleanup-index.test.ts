import { describe, expect, test } from 'bun:test';
import { cleanupEntry, cleanupIndex } from '~/schemas/cleanup-index';

const NOW = '2026-06-20T12:00:00.000Z';

const entry = (over: Record<string, unknown> = {}) => ({
  name: 'old-plan.md',
  original_path: 'reports/old-plan.md',
  owning_repo: null,
  action: 'delete-candidate' as const,
  staged_path: '.ditto/local/cleanup/cleanup-20260620-120000/delete-candidate/old-plan.md',
  summary: 'superseded by ADR-0010',
  basis: [{ kind: 'stale' as const, detail: 'last touched 2 years ago' }],
  audit: { classified_at: NOW, aggressiveness: 3 },
  ...over,
});

const index = (over: Record<string, unknown> = {}) => ({
  schema_version: '0.1.0' as const,
  run_id: 'cleanup-20260620-120000',
  created_at: NOW,
  workspace_root: '/Users/me/repo',
  params: {
    tracked_filter: 'tracked-only' as const,
    categories: ['design'],
    auto_cleanup: false,
    concurrency: 4,
    aggressiveness: 3,
  },
  entries: [entry()],
  ...over,
});

describe('cleanupEntry', () => {
  test('valid entry parses', () => {
    expect(cleanupEntry.safeParse(entry()).success).toBe(true);
  });

  test('rejects empty basis array (ac-5)', () => {
    expect(cleanupEntry.safeParse(entry({ basis: [] })).success).toBe(false);
  });

  test('rejects invalid action enum', () => {
    expect(cleanupEntry.safeParse(entry({ action: 'nuke' })).success).toBe(false);
  });

  test('rejects basis signal with unknown kind', () => {
    expect(cleanupEntry.safeParse(entry({ basis: [{ kind: 'vibes', detail: 'x' }] })).success).toBe(
      false,
    );
  });

  test('owning_repo may be a string', () => {
    expect(cleanupEntry.safeParse(entry({ owning_repo: 'packages/sub' })).success).toBe(true);
  });
});

describe('cleanupIndex', () => {
  test('valid index parses', () => {
    expect(cleanupIndex.safeParse(index()).success).toBe(true);
  });

  test('rejects malformed run_id', () => {
    expect(cleanupIndex.safeParse(index({ run_id: 'run-bad' })).success).toBe(false);
  });

  test('accepts collision-suffixed run_id', () => {
    expect(cleanupIndex.safeParse(index({ run_id: 'cleanup-20260620-120000-2' })).success).toBe(
      true,
    );
  });

  test('rejects aggressiveness out of 1-5 range', () => {
    const p = index();
    p.params.aggressiveness = 6;
    expect(cleanupIndex.safeParse(p).success).toBe(false);
  });

  test('rejects bad tracked_filter enum', () => {
    const p = index();
    (p.params as Record<string, unknown>).tracked_filter = 'all';
    expect(cleanupIndex.safeParse(p).success).toBe(false);
  });

  test('entries default to empty array', () => {
    const { entries, ...rest } = index();
    void entries;
    const parsed = cleanupIndex.parse(rest);
    expect(parsed.entries).toEqual([]);
  });
});
