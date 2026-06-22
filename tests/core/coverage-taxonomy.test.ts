import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isCoverageTerminated } from '~/core/coverage-manager';
import {
  CATEGORY_NODE_PREFIX,
  FAR_FIELD_TAXONOMY_FLOOR,
  farFieldCategoriesEnabled,
  farFieldCoverageNodes,
  farFieldCoverageReport,
  farFieldLenses,
  loadFarFieldTaxonomy,
  resolveTaxonomy,
} from '~/core/coverage-taxonomy';
import type { CoverageMap } from '~/schemas/coverage';

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

// §8-2 — category-complete termination: seed each floor category as a coverage
// node so termination (existing `allClosed`) requires every category swept; an
// un-swept category cannot pass on novelty-dry alone (ac-2). Behind a flag so the
// existing root-only tree is unchanged by default (ac-7).
describe('far-field category seeding (wi_260622vjo §8-2)', () => {
  test('farFieldCoverageNodes seeds root + one open node per floor category', () => {
    const nodes = farFieldCoverageNodes('add login');
    // root + 19 categories
    expect(nodes.length).toBe(FAR_FIELD_TAXONOMY_FLOOR.length + 1);

    const root = nodes.find((n) => n.id === 'cov-root');
    expect(root).toBeDefined();
    expect(root?.parent_id).toBeNull();
    expect(root?.children.length).toBe(FAR_FIELD_TAXONOMY_FLOOR.length);

    const cats = nodes.filter((n) => n.id.startsWith(CATEGORY_NODE_PREFIX));
    expect(cats.length).toBe(FAR_FIELD_TAXONOMY_FLOOR.length);
    for (const c of cats) {
      expect(c.parent_id).toBe('cov-root');
      expect(c.state).toBe('open');
      expect(c.origin).toBe('seed');
      expect(c.children.length).toBe(0); // leaf frontier
    }
    // every category node id is reachable from the root's children (consistent tree)
    expect([...(root?.children ?? [])].sort()).toEqual(cats.map((c) => c.id).sort());
  });

  test('category node labels are the probing-question lenses (ac-1)', () => {
    const nodes = farFieldCoverageNodes('add login');
    const catLabels = nodes
      .filter((n) => n.id.startsWith(CATEGORY_NODE_PREFIX))
      .map((n) => n.label)
      .sort();
    expect(catLabels).toEqual(farFieldLenses().slice().sort());
  });

  test('a category-seeded map cannot terminate on novelty-dry alone — every category must close (ac-2)', () => {
    const map: CoverageMap = {
      schema_version: '0.1.0',
      work_item_id: 'wi_test',
      root_id: 'cov-root',
      nodes: farFieldCoverageNodes('add login'),
    };
    // dry counter well past K, but the categories are still open → NOT terminated.
    expect(isCoverageTerminated(map, 5)).toBe(false);

    // close every node → terminated once the dry depth also holds.
    const closed: CoverageMap = {
      ...map,
      nodes: map.nodes.map((n) => ({ ...n, state: 'resolved' as const })),
    };
    expect(isCoverageTerminated(closed, 5)).toBe(true);
    // breadth alone is not enough either: all closed but dry below K → not terminated.
    expect(isCoverageTerminated(closed, 0)).toBe(false);
  });

  test('farFieldCoverageReport summarizes the process coverage — sweep/skip(+reason)/open + completeness (ac-11a)', () => {
    const nodes = farFieldCoverageNodes('add login');
    const catIds = nodes.filter((n) => n.id.startsWith(CATEGORY_NODE_PREFIX)).map((n) => n.id);
    // resolve 2 (swept-dry), skip 1 out_of_scope + 1 user_owned with reasons, rest open.
    let nn = nodes;
    nn = nn.map((n) => (n.id === catIds[0] ? { ...n, state: 'resolved' as const } : n));
    nn = nn.map((n) => (n.id === catIds[1] ? { ...n, state: 'resolved' as const } : n));
    nn = nn.map((n) =>
      n.id === catIds[2]
        ? {
            ...n,
            state: 'out_of_scope' as const,
            close_reason: 'no external surface in this change',
          }
        : n,
    );
    nn = nn.map((n) =>
      n.id === catIds[3]
        ? {
            ...n,
            state: 'user_owned' as const,
            close_reason: 'product owner owns the rollout window',
          }
        : n,
    );
    const map: CoverageMap = {
      schema_version: '0.1.0',
      work_item_id: 'wi_test',
      root_id: 'cov-root',
      nodes: nn,
    };

    const r = farFieldCoverageReport(map);
    expect(r.seeded).toBe(FAR_FIELD_TAXONOMY_FLOOR.length);
    expect(r.resolved).toBe(2);
    expect(r.open).toBe(FAR_FIELD_TAXONOMY_FLOOR.length - 4);
    expect(r.skipped).toHaveLength(2);
    // every recorded skip carries its justification (ac-2 — no silent skip)
    for (const s of r.skipped) {
      expect(['out_of_scope', 'user_owned']).toContain(s.state);
      expect(s.reason).toBeTruthy();
    }
    // breadth not complete while any category is still open
    expect(r.complete).toBe(false);
  });

  test('farFieldCoverageReport reports complete once every seeded category is closed (resolved or justified-skip)', () => {
    // every node closed (root + categories) — structural completeness mirrors the
    // real sweep termination, which closes the root once its category children are done
    const nodes = farFieldCoverageNodes('add login').map((n) => ({
      ...n,
      state: 'resolved' as const,
    }));
    const map: CoverageMap = {
      schema_version: '0.1.0',
      work_item_id: 'wi_test',
      root_id: 'cov-root',
      nodes,
    };
    const r = farFieldCoverageReport(map);
    expect(r.open).toBe(0);
    expect(r.complete).toBe(true);
  });

  test('farFieldCoverageReport is not complete while a derived sub-scope node is still open (parity with isCoverageTerminated — derived nodes are not cov-cat-*)', () => {
    // Every category + root closed, but one derived (non-cov-cat) sub-scope still open.
    // The real sweep terminates only when EVERY node is closed; the report must agree.
    const base = farFieldCoverageNodes('add login').map((n) => ({
      ...n,
      state: 'resolved' as const,
    }));
    const catId = base.find((n) => n.id.startsWith(CATEGORY_NODE_PREFIX))?.id ?? 'cov-root';
    const map: CoverageMap = {
      schema_version: '0.1.0',
      work_item_id: 'wi_test',
      root_id: 'cov-root',
      nodes: [
        ...base,
        {
          id: 'cov-auth-sub',
          parent_id: catId,
          label: 'derived sub-scope still open',
          origin: 'derived' as const,
          depth_weight: 0.5,
          state: 'open' as const,
          children: [],
        },
      ],
    };
    const r = farFieldCoverageReport(map);
    // categories all closed, but a derived scope is open → sweep NOT structurally complete
    expect(r.complete).toBe(false);
  });

  test('farFieldCoverageReport on a root-only map (seeding off) reports zero seeded, not complete (ac-7)', () => {
    const map: CoverageMap = {
      schema_version: '0.1.0',
      work_item_id: 'wi_test',
      root_id: 'cov-root',
      nodes: [
        {
          id: 'cov-root',
          parent_id: null,
          label: 'add login',
          origin: 'seed',
          depth_weight: 1,
          state: 'open',
          children: [],
        },
      ],
    };
    const r = farFieldCoverageReport(map);
    expect(r.seeded).toBe(0);
    expect(r.complete).toBe(false);
  });

  test('farFieldCategoriesEnabled() defaults ON (activated); off only for explicit falsy env', () => {
    const saved = process.env.DITTO_FARFIELD_CATEGORIES;
    try {
      // biome-ignore lint/performance/noDelete: default-on means truly unset, not the "undefined" string
      delete process.env.DITTO_FARFIELD_CATEGORIES;
      expect(farFieldCategoriesEnabled()).toBe(true);
      process.env.DITTO_FARFIELD_CATEGORIES = 'off';
      expect(farFieldCategoriesEnabled()).toBe(false);
      process.env.DITTO_FARFIELD_CATEGORIES = '0';
      expect(farFieldCategoriesEnabled()).toBe(false);
      process.env.DITTO_FARFIELD_CATEGORIES = '1';
      expect(farFieldCategoriesEnabled()).toBe(true);
    } finally {
      if (saved === undefined) {
        // biome-ignore lint/performance/noDelete: restore the env var to truly unset
        delete process.env.DITTO_FARFIELD_CATEGORIES;
      } else {
        process.env.DITTO_FARFIELD_CATEGORIES = saved;
      }
    }
  });
});

// ac-10 — the floor is the code DEFAULT, but a project tunes it via a git-tracked
// tier-② config (.ditto/coverage-taxonomy.json): disable floor categories that do
// not apply, add product-specific ones. Absent/malformed config → the floor
// (fail-open). The resolved taxonomy drives both the seeded nodes and the lenses.
describe('far-field taxonomy project config (wi_260622vjo ac-10)', () => {
  const floor = FAR_FIELD_TAXONOMY_FLOOR;

  test('resolveTaxonomy with empty config returns the floor unchanged', () => {
    expect(resolveTaxonomy(floor, {})).toEqual([...floor]);
  });

  test('resolveTaxonomy disables floor categories by id', () => {
    const out = resolveTaxonomy(floor, { disabled: ['authentication', 'time-clock'] });
    const ids = out.map((c) => c.id);
    expect(ids).not.toContain('authentication');
    expect(ids).not.toContain('time-clock');
    expect(out.length).toBe(floor.length - 2);
  });

  test('resolveTaxonomy appends project-added categories', () => {
    const out = resolveTaxonomy(floor, {
      added: [
        { id: 'tenancy-isolation', lens: '이 변경이 테넌트 경계를 넘나? 데이터/캐시 격리는?' },
      ],
    });
    expect(out.length).toBe(floor.length + 1);
    expect(out.find((c) => c.id === 'tenancy-isolation')?.lens).toContain('테넌트');
  });

  test('resolveTaxonomy: an added id colliding with a floor id overrides that lens (no duplicate)', () => {
    const out = resolveTaxonomy(floor, {
      added: [{ id: 'authentication', lens: 'OVERRIDDEN auth lens?' }],
    });
    const auth = out.filter((c) => c.id === 'authentication');
    expect(auth).toHaveLength(1);
    expect(auth[0]?.lens).toBe('OVERRIDDEN auth lens?');
    expect(out.length).toBe(floor.length);
  });

  test('loadFarFieldTaxonomy returns the floor when no config file exists (fail-open)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ditto-tax-absent-'));
    try {
      const out = await loadFarFieldTaxonomy(repo);
      expect(out).toEqual([...floor]);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('loadFarFieldTaxonomy merges a valid git-tracked config (.ditto/coverage-taxonomy.json)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ditto-tax-valid-'));
    try {
      await mkdir(join(repo, '.ditto'), { recursive: true });
      await writeFile(
        join(repo, '.ditto', 'coverage-taxonomy.json'),
        JSON.stringify({
          disabled: ['authentication'],
          added: [{ id: 'tenancy', lens: '테넌트 경계?' }],
        }),
      );
      const out = await loadFarFieldTaxonomy(repo);
      const ids = out.map((c) => c.id);
      expect(ids).not.toContain('authentication');
      expect(ids).toContain('tenancy');
      expect(out.length).toBe(floor.length); // -1 disabled +1 added
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('loadFarFieldTaxonomy fails open to the floor on a malformed config (+onMalformed)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ditto-tax-bad-'));
    try {
      await mkdir(join(repo, '.ditto'), { recursive: true });
      await writeFile(join(repo, '.ditto', 'coverage-taxonomy.json'), '{ not json');
      let flagged = false;
      const out = await loadFarFieldTaxonomy(repo, () => {
        flagged = true;
      });
      expect(out).toEqual([...floor]);
      expect(flagged).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('farFieldLenses(taxonomy) returns the resolved taxonomy lenses (not always the floor)', () => {
    const custom = [
      { id: 'a', lens: 'lens A?' },
      { id: 'b', lens: 'lens B?' },
    ];
    expect(farFieldLenses(custom)).toEqual(['lens A?', 'lens B?']);
    // default (no arg) stays the floor (ac-7)
    expect(farFieldLenses()).toEqual(floor.map((c) => c.lens));
  });

  test('farFieldCoverageNodes(intent, root, taxonomy) seeds nodes for the resolved taxonomy', () => {
    const custom = [
      { id: 'a', lens: 'lens A?' },
      { id: 'b', lens: 'lens B?' },
    ];
    const nodes = farFieldCoverageNodes('add login', 'cov-root', custom);
    const cats = nodes.filter((n) => n.id.startsWith(CATEGORY_NODE_PREFIX));
    expect(cats.map((n) => n.id).sort()).toEqual(['cov-cat-a', 'cov-cat-b']);
  });
});
