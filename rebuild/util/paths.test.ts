import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

import { committedWorkItemDir, dittoDir, localDir } from './paths';

describe('dittoDir', () => {
  test('returns <root>/.ditto (project-shared tier)', () => {
    expect(dittoDir('/repo')).toBe(join('/repo', '.ditto'));
  });
});

describe('localDir', () => {
  test('returns <root>/.ditto/local with no segments', () => {
    expect(localDir('/repo')).toBe(join('/repo', '.ditto', 'local'));
  });

  test('appends segments under .ditto/local', () => {
    expect(localDir('/repo', 'work-items', 'wi_x')).toBe(
      join('/repo', '.ditto', 'local', 'work-items', 'wi_x'),
    );
  });
});

describe('committedWorkItemDir', () => {
  test('returns <root>/.ditto/work-items/<id> (committed Record tier, NOT under local/)', () => {
    expect(committedWorkItemDir('/repo', 'wi_abc')).toBe(
      join('/repo', '.ditto', 'work-items', 'wi_abc'),
    );
  });
});
