import { describe, expect, test } from 'bun:test';

import {
  CATEGORY_NODE_PREFIX,
  FAR_FIELD_TAXONOMY_FLOOR,
  farFieldLenses,
} from './taxonomy';

describe('far-field taxonomy floor — the category set that breadth is measured against', () => {
  test('the floor is a non-empty set of categories with unique kebab ids and probing-question lenses', () => {
    expect(FAR_FIELD_TAXONOMY_FLOOR.length).toBeGreaterThan(0);
    const ids = FAR_FIELD_TAXONOMY_FLOOR.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of FAR_FIELD_TAXONOMY_FLOOR) {
      expect(c.id).toMatch(/^[a-z][a-z-]*$/);
      expect(c.lens.trim().length).toBeGreaterThan(0);
    }
  });

  test('farFieldLenses projects each category to its probing-question lens', () => {
    expect(farFieldLenses()).toEqual(FAR_FIELD_TAXONOMY_FLOOR.map((c) => c.lens));
  });

  test('farFieldLenses honors a supplied taxonomy (project override / discovery additions)', () => {
    const custom = [{ id: 'my-domain', lens: '이 도메인 특유의 실패는?' }];
    expect(farFieldLenses(custom)).toEqual(['이 도메인 특유의 실패는?']);
  });

  test('the category-node prefix namespaces seeded category nodes', () => {
    expect(CATEGORY_NODE_PREFIX).toBe('cov-cat-');
  });
});
