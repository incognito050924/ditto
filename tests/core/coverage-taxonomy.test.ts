import { describe, expect, test } from 'bun:test';
import { FAR_FIELD_TAXONOMY_FLOOR, farFieldLenses } from '~/core/coverage-taxonomy';

// wi_260622vjo §6-floor — the always-on far-field category FLOOR. Each category is
// a probing QUESTION (a lens the sweep must answer for the change's scope), not a
// bare noun (ac-1). These lenses seed cross_cutting_constraints so the fresh judge
// sees every far-field domain instead of only what it happens to recall (§2/§3).
describe('far-field taxonomy floor (wi_260622vjo §6-floor)', () => {
  test('floor enumerates the 19 cross-validated categories', () => {
    expect(FAR_FIELD_TAXONOMY_FLOOR.length).toBe(19);
  });

  test('category ids are unique and kebab-case', () => {
    const ids = FAR_FIELD_TAXONOMY_FLOOR.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
  });

  test('each category is a probing QUESTION lens, not a bare noun (ac-1)', () => {
    for (const c of FAR_FIELD_TAXONOMY_FLOOR) {
      expect(c.lens.length).toBeGreaterThan(10);
      // the lens form is a question the sweep answers for this scope
      expect(c.lens).toContain('?');
    }
  });

  test('farFieldLenses() returns the floor lens strings for cross_cutting_constraints injection (§8-1)', () => {
    const lenses = farFieldLenses();
    expect(lenses).toEqual(FAR_FIELD_TAXONOMY_FLOOR.map((c) => c.lens));
    expect(lenses.length).toBe(19);
  });

  test('the floor covers the security-relevant far-field domains the user emphasized (auth/authz/audit)', () => {
    const ids = new Set(FAR_FIELD_TAXONOMY_FLOOR.map((c) => c.id));
    for (const must of ['authentication', 'authorization', 'auditing']) {
      expect(ids.has(must)).toBe(true);
    }
  });

  test('the floor includes the minimal-increment design-discipline lens (user-added)', () => {
    const cat = FAR_FIELD_TAXONOMY_FLOOR.find((c) => c.id === 'minimal-increment');
    expect(cat).toBeDefined();
    // the lens probes for the smallest/clearest increment (over-engineering is the
    // most common failure — charter §4-3/§4-4, 범위 axiom)
    expect(cat?.lens).toContain('증분');
  });
});
