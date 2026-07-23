import { describe, expect, test } from 'bun:test';

import { memorySource } from './memory-source';

const base = {
  schema_version: '0.1.0',
  source_id: 'src_0308233ce209',
  source_type: 'spec',
  path: '.ditto/knowledge/adr/ADR-0012-x.md',
  content_hash: 'a'.repeat(64),
  captured_at: '2026-07-24T00:00:00.000Z',
  revision: 'snapshot:abcdef0123456789',
};

describe('memory source schema — provenance record behind events', () => {
  test('minimal path-based source fills defaults', () => {
    const parsed = memorySource.parse(base);
    expect(parsed.sensitivity).toBe('internal');
    expect(parsed.git_commit).toBeUndefined();
  });

  test('one of path or url is required', () => {
    const { path: _path, ...noPath } = base;
    expect(() => memorySource.parse(noPath)).toThrow();
    expect(memorySource.parse({ ...noPath, url: 'https://example.com/doc' }).url).toBe(
      'https://example.com/doc',
    );
  });

  test('content_hash is a full sha256 hex; git_commit is 40 hex when present', () => {
    expect(() => memorySource.parse({ ...base, content_hash: 'abc' })).toThrow();
    expect(memorySource.parse({ ...base, git_commit: 'b'.repeat(40) }).git_commit).toBe(
      'b'.repeat(40),
    );
    expect(() => memorySource.parse({ ...base, git_commit: 'xyz' })).toThrow();
  });

  test('source_id shape and source_type enum are closed', () => {
    expect(() => memorySource.parse({ ...base, source_id: 'source_1' })).toThrow();
    expect(() => memorySource.parse({ ...base, source_type: 'gossip' })).toThrow();
    for (const t of ['code', 'markdown', 'spec', 'note', 'log', 'chat', 'image', 'other'] as const) {
      expect(memorySource.parse({ ...base, source_type: t }).source_type).toBe(t);
    }
  });
});
