import { describe, expect, test } from 'bun:test';

import { detectFreshness, type FreshnessInput } from './freshness';

// A source that lives in the root repo, captured at commit `aaa`, content hash `h1`.
function baseInput(over: Partial<FreshnessInput> = {}): FreshnessInput {
  return {
    manifest: {
      serving_version: 'set-v1',
      source_revisions: [
        { source_id: 'src_root0001', repo: '.', hash: 'h1', git_commit: 'a'.repeat(40) },
      ],
    },
    currentSetHash: 'set-v1',
    currentSources: [{ source_id: 'src_root0001', repo: '.', content_hash: 'h1' }],
    headOf: () => 'a'.repeat(40),
    isDirty: () => false,
    ...over,
  };
}

describe('detectFreshness — the code↔SoT consistency axes (ADR-0015)', () => {
  test('all-aligned repo at the manifest commit, clean tree, matching set hash ⇒ fresh', () => {
    expect(detectFreshness(baseInput()).freshness).toBe('fresh');
  });

  test('a missing manifest ⇒ absent', () => {
    expect(detectFreshness(baseInput({ manifest: null })).freshness).toBe('absent');
  });

  test('owning-repo HEAD diverged from the stored git_commit ⇒ code_drift, and the source is listed', () => {
    const result = detectFreshness(baseInput({ headOf: () => 'b'.repeat(40) }));
    expect(result.freshness).toBe('code_drift');
    expect(result.drifted_sources).toEqual(['src_root0001']);
    expect(result.drifted_repos).toEqual(['.']);
  });

  test('a dirty owning-repo tree ⇒ code_dirty (a label, not a suppressor)', () => {
    expect(detectFreshness(baseInput({ isDirty: () => true })).freshness).toBe('code_dirty');
  });

  test('axis-1 set-hash mismatch ⇒ stale', () => {
    expect(detectFreshness(baseInput({ currentSetHash: 'set-v2' })).freshness).toBe('stale');
  });

  test('priority: code_drift outranks stale', () => {
    const result = detectFreshness(
      baseInput({ currentSetHash: 'set-v2', headOf: () => 'b'.repeat(40) }),
    );
    expect(result.freshness).toBe('code_drift');
  });

  test('priority: stale outranks code_dirty (a dirty dev tree must not mask a stale projection)', () => {
    const result = detectFreshness(
      baseInput({ currentSetHash: 'set-v2', isDirty: () => true }),
    );
    expect(result.freshness).toBe('stale');
  });

  test('a non-git source (no git_commit) drifts by content_hash move only, never raising code_dirty', () => {
    const input = baseInput({
      manifest: {
        serving_version: 'set-v1',
        source_revisions: [{ source_id: 'src_snap0001', repo: '.', hash: 'h1' }],
      },
      currentSources: [{ source_id: 'src_snap0001', repo: '.', content_hash: 'h2' }],
    });
    const result = detectFreshness(input);
    // content_hash moved ⇒ axis-1 stale via dirty_sources; no git_commit ⇒ no code_drift/code_dirty.
    expect(result.freshness).toBe('stale');
    expect(result.dirty_sources).toEqual(['src_snap0001']);
  });
});
