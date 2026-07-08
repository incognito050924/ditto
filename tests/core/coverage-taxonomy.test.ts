import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MINIMAL_INCREMENT_SELF_CHECK, charterProjection } from '~/core/charter';
import { isCoverageTerminated } from '~/core/coverage-manager';
import {
  CATEGORY_NODE_PREFIX,
  FAR_FIELD_ROUTED_OUT,
  FAR_FIELD_TAXONOMY_FLOOR,
  applyTaxonomyMutation,
  farFieldCategoriesEnabled,
  farFieldCoverageNodes,
  farFieldCoverageReport,
  farFieldLenses,
  loadFarFieldTaxonomy,
  resolveTaxonomy,
  warnMalformedTaxonomy,
} from '~/core/coverage-taxonomy';
import { startInterview } from '~/core/interview-driver';
import { type CoverageMap, coverageTaxonomyConfig } from '~/schemas/coverage';

// wi_260622vjo §6-floor — the always-on far-field category FLOOR. Each category is
// a probing QUESTION (a lens the sweep must answer for the change's scope), not a
// bare noun (ac-1). These lenses seed cross_cutting_constraints so the fresh judge
// sees every far-field domain instead of only what it happens to recall (§2/§3).
describe('far-field taxonomy floor (wi_260622vjo §6-floor)', () => {
  test('floor enumerates the 23 cross-validated categories', () => {
    // Still 23, but the composition changed (wi_260706n4w ac-2): minimal-increment
    // was routed OUT to the charter self-check (design-meta, not a far risk - the
    // removal is ledgered in FAR_FIELD_ROUTED_OUT, ac-3) and authorization was
    // facet-split into authorization (enforcement) + authorization-model (model).
    expect(FAR_FIELD_TAXONOMY_FLOOR.length).toBe(23);
  });

  test('the clear bundles are statically atomized into independently-groundable facets (§6-1)', () => {
    const ids = new Set(FAR_FIELD_TAXONOMY_FLOOR.map((c) => c.id));
    // security-privacy and resource-abuse were heterogeneous bundles; the binary
    // relevance gate needs independently-groundable units, so they are split (§6).
    expect(ids.has('security-privacy')).toBe(false);
    expect(ids.has('resource-abuse')).toBe(false);
    for (const facet of [
      'injection',
      'secret-exposure',
      'pii-leak',
      'regulatory',
      'resource-exhaustion',
      'abuse-vector',
    ]) {
      expect(ids.has(facet)).toBe(true);
    }
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
    expect(lenses.length).toBe(23);
  });

  test('the floor covers the security-relevant far-field domains the user emphasized (auth/authz/audit)', () => {
    const ids = new Set(FAR_FIELD_TAXONOMY_FLOOR.map((c) => c.id));
    for (const must of ['authentication', 'authorization', 'auditing']) {
      expect(ids.has(must)).toBe(true);
    }
  });

  test('minimal-increment is routed OUT of the floor to the charter self-check — recorded with route+reason, never silent (wi_260706n4w ac-3)', () => {
    // It is design-META quality (charter §4-3/§4-4, 범위 axiom), not a far risk,
    // so it leaves the pre-mortem sweep — but the removal itself stays in the
    // completeness ledger (no silent 23→22 narrowing).
    expect(FAR_FIELD_TAXONOMY_FLOOR.some((c) => c.id === 'minimal-increment')).toBe(false);
    const routed = FAR_FIELD_ROUTED_OUT.find((r) => r.id === 'minimal-increment');
    expect(routed).toBeDefined();
    expect(routed?.route).toBe('charter-self-check');
    expect(routed?.reason).toBeTruthy();
    expect(routed?.residual_risk).toBeTruthy();
    // single SoT: the ledger record carries the exact question the charter enforces
    expect(routed?.lens).toBe(MINIMAL_INCREMENT_SELF_CHECK.question);
    expect(MINIMAL_INCREMENT_SELF_CHECK.question).toContain('증분');
  });

  test('the charter receiver is executable, not documentation — the projection injects the self-check question every turn', () => {
    // charterProjection is what the UserPromptSubmit hook re-injects each turn;
    // carrying the question there makes the transfer live enforcement, not prose.
    expect(charterProjection()).toContain(MINIMAL_INCREMENT_SELF_CHECK.question);
  });
});

// §8-2 — category-complete termination: seed each floor category as a coverage
// node so termination (existing `allClosed`) requires every category swept; an
// un-swept category cannot pass on novelty-dry alone (ac-2). Behind a flag so the
// existing root-only tree is unchanged by default (ac-7).
describe('far-field category seeding (wi_260622vjo §8-2)', () => {
  test('farFieldCoverageNodes seeds root + one open node per floor category', () => {
    const nodes = farFieldCoverageNodes('add login');
    // root + 23 categories
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
      // surrounding whitespace must not defeat the off switch (trim before compare)
      process.env.DITTO_FARFIELD_CATEGORIES = ' 0 ';
      expect(farFieldCategoriesEnabled()).toBe(false);
      process.env.DITTO_FARFIELD_CATEGORIES = ' off ';
      expect(farFieldCategoriesEnabled()).toBe(false);
      process.env.DITTO_FARFIELD_CATEGORIES = ' false ';
      expect(farFieldCategoriesEnabled()).toBe(false);
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

// wi_260706n4w ac-2/ac-3 — static disposition routing. Every floor category
// declares WHO answers it WHEN (code-verify / user-intent / runtime-post-impl);
// dual-personality categories are facet-split so each facet routes whole; tier-②
// config can re-route per project. Routing must never silently narrow the
// completeness ledger: seeded nodes carry their disposition, and a category
// removed from the floor stays visible in every report via FAR_FIELD_ROUTED_OUT.
describe('far-field disposition routing (wi_260706n4w ac-2/ac-3)', () => {
  const floor = FAR_FIELD_TAXONOMY_FLOOR;

  test('every floor category declares a static disposition (ac-2)', () => {
    for (const c of floor) {
      expect(['code-verify', 'user-intent', 'runtime-post-impl']).toContain(c.disposition);
    }
  });

  test('authorization is facet-split: enforcement stays code-verify, model routes user-intent (ac-2)', () => {
    const enforce = floor.find((c) => c.id === 'authorization');
    const model = floor.find((c) => c.id === 'authorization-model');
    expect(enforce?.disposition).toBe('code-verify');
    expect(model?.disposition).toBe('user-intent');
    // each facet is independently a probing question and cross-references its twin
    expect(model?.lens).toContain('?');
    expect(enforce?.lens).toContain('#authorization-model');
    expect(model?.lens).toContain('#authorization의');
  });

  test('regulatory routes user-intent whole (which obligations apply is user domain knowledge)', () => {
    expect(floor.find((c) => c.id === 'regulatory')?.disposition).toBe('user-intent');
  });

  test('farFieldCoverageNodes stamps the category disposition onto the seeded node — and the node stays OPEN (fail-open seed, ac-4 wiring is downstream)', () => {
    const nodes = farFieldCoverageNodes('add login');
    const model = nodes.find((n) => n.id === 'cov-cat-authorization-model');
    expect(model?.disposition).toBe('user-intent');
    expect(model?.state).toBe('open');
    // a custom taxonomy entry without a disposition seeds a node without one
    // (absent = DEFAULT_COVERAGE_DISPOSITION downstream — additive compat)
    const custom = farFieldCoverageNodes('x', 'cov-root', [{ id: 'a', lens: 'lens A?' }]);
    expect(custom.find((n) => n.id === 'cov-cat-a')?.disposition).toBeUndefined();
  });

  test('tier-② dispositions record re-routes a floor category WITHOUT touching its lens (partial override — never whole-object replacement)', () => {
    const out = resolveTaxonomy(floor, { dispositions: { auditing: 'user-intent' } });
    const auditing = out.find((c) => c.id === 'auditing');
    expect(auditing?.disposition).toBe('user-intent');
    expect(auditing?.lens).toBe(floor.find((c) => c.id === 'auditing')?.lens ?? 'MISSING');
    // untouched categories keep their static disposition
    expect(out.find((c) => c.id === 'injection')?.disposition).toBe('code-verify');
  });

  test('added[].disposition is honored; an added id colliding with a floor id WITHOUT one inherits the floor disposition (lens replacement cannot silently drop the route)', () => {
    const out = resolveTaxonomy(floor, {
      added: [
        { id: 'tenancy', lens: '테넌트 경계?', disposition: 'runtime-post-impl' },
        { id: 'authorization-model', lens: 'OVERRIDDEN model lens?' },
      ],
    });
    expect(out.find((c) => c.id === 'tenancy')?.disposition).toBe('runtime-post-impl');
    const model = out.find((c) => c.id === 'authorization-model');
    expect(model?.lens).toBe('OVERRIDDEN model lens?');
    expect(model?.disposition).toBe('user-intent'); // inherited from the floor twin
  });

  test('disposition precedence: added.disposition > dispositions[id] > floor static', () => {
    const explicit = resolveTaxonomy(floor, {
      added: [{ id: 'authorization-model', lens: 'L?', disposition: 'code-verify' }],
      dispositions: { 'authorization-model': 'runtime-post-impl' },
    });
    expect(explicit.find((c) => c.id === 'authorization-model')?.disposition).toBe('code-verify');
    const viaRecord = resolveTaxonomy(floor, {
      added: [{ id: 'authorization-model', lens: 'L?' }],
      dispositions: { 'authorization-model': 'runtime-post-impl' },
    });
    expect(viaRecord.find((c) => c.id === 'authorization-model')?.disposition).toBe(
      'runtime-post-impl',
    );
  });

  test('farFieldCoverageReport carries the routed-out ledger — a removed category stays visible with route+reason (ac-3 no silent narrowing)', () => {
    const map: CoverageMap = {
      schema_version: '0.1.0',
      work_item_id: 'wi_test',
      root_id: 'cov-root',
      nodes: farFieldCoverageNodes('add login'),
    };
    const r = farFieldCoverageReport(map);
    expect(r.routed_out.map((x) => x.id)).toContain('minimal-increment');
    for (const ro of r.routed_out) {
      expect(ro.route).toBe('charter-self-check');
      expect(ro.reason).toBeTruthy();
      expect(ro.residual_risk).toBeTruthy();
    }
    // the completeness predicate itself is unchanged (additive-only, ac-6)
    expect(r.complete).toBe(false);
  });

  test('report.skipped carries the closed node disposition (a routed skip stays diagnosable in the ledger)', () => {
    const nodes = farFieldCoverageNodes('add login').map((n) =>
      n.id === 'cov-cat-authorization-model'
        ? {
            ...n,
            state: 'user_owned' as const,
            close_reason: 'deep-interview 차원으로 라우팅됨',
            residual_risk: '인터뷰 미실행 시 이 질문이 누락된다',
          }
        : n,
    );
    const r = farFieldCoverageReport({
      schema_version: '0.1.0',
      work_item_id: 'wi_test',
      root_id: 'cov-root',
      nodes,
    });
    const skip = r.skipped.find((s) => s.id === 'cov-cat-authorization-model');
    expect(skip?.disposition).toBe('user-intent');
    // a skip on a node without a disposition stays undefined (additive)
    expect(
      r.skipped
        .filter((s) => s.id !== 'cov-cat-authorization-model')
        .every((s) => s.disposition === undefined),
    ).toBe(true);
  });
});

// wi_260625l0v — relevance gate (design §3·§5·§7). A category judged NOT relevant to
// the change is seeded PRE-CLOSED (out_of_scope + close_reason + residual_risk) so the
// ledger stays complete (no silent drop) and the pre-closed node is never swept (cost
// saved). Conservative default: a category is skipped ONLY with a well-formed
// justification (relevant:false ∧ reason ∧ residual_risk); anything else stays open
// (애매하면 포함). Grounding/adversarial-refute that PRODUCE the verdict are upstream.
describe('far-field relevance gate — pre-closed skip (wi_260625l0v §3·§5)', () => {
  const taxo = [
    { id: 'a', lens: 'lens A?' },
    { id: 'b', lens: 'lens B?' },
    { id: 'c', lens: 'lens C?' },
  ];

  test('a not-relevant verdict pre-closes that category out_of_scope with reason+residual_risk; others stay open', () => {
    const nodes = farFieldCoverageNodes('refactor README', 'cov-root', taxo, [
      {
        id: 'b',
        relevant: false,
        reason: 'b 도메인을 이 변경이 건드리지 않음',
        residual_risk: '오판 시 b 실패가 사전점검에서 누락',
      },
    ]);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const b = byId.get('cov-cat-b');
    expect(b?.state).toBe('out_of_scope');
    expect(b?.close_reason).toBe('b 도메인을 이 변경이 건드리지 않음');
    expect(b?.residual_risk).toBe('오판 시 b 실패가 사전점검에서 누락');
    expect(byId.get('cov-cat-a')?.state).toBe('open');
    expect(byId.get('cov-cat-c')?.state).toBe('open');
    // ledger complete: every category still seeded + reachable from root (no silent drop)
    const root = byId.get('cov-root');
    expect([...(root?.children ?? [])].sort()).toEqual(['cov-cat-a', 'cov-cat-b', 'cov-cat-c']);
  });

  test('conservative default: a not-relevant verdict WITHOUT residual_risk cannot skip — stays open', () => {
    const nodes = farFieldCoverageNodes('refactor README', 'cov-root', taxo, [
      { id: 'b', relevant: false, reason: 'b 무관 (단 residual_risk 누락)' },
    ]);
    expect(nodes.find((n) => n.id === 'cov-cat-b')?.state).toBe('open');
  });

  test('a relevant:true verdict keeps the category open (covered fully)', () => {
    const nodes = farFieldCoverageNodes('refactor README', 'cov-root', taxo, [
      { id: 'a', relevant: true, reason: '', residual_risk: '' },
    ]);
    expect(nodes.find((n) => n.id === 'cov-cat-a')?.state).toBe('open');
  });

  test('no verdicts → every category open (backward compat, ac-7)', () => {
    const nodes = farFieldCoverageNodes('refactor README', 'cov-root', taxo);
    const cats = nodes.filter((n) => n.id.startsWith(CATEGORY_NODE_PREFIX));
    expect(cats.every((c) => c.state === 'open')).toBe(true);
  });
});

// wi_260707phi (ac-2/ac-3/ac-4) — taxonomy write-back. A mutation (add / disable /
// re-route) is applied to .ditto/coverage-taxonomy.json fail-CLOSED: the next config
// is zod-validated BEFORE the write, so a malformed candidate never lands; unrelated
// (unknown) keys survive the round-trip (.passthrough); re-applying the same mutation
// is byte-stable (idempotent); disable records its justification in disabled_reasons.
describe('taxonomy write-back (wi_260707phi ac-2/ac-3/ac-4)', () => {
  test('add→disable round-trip is byte-stable (idempotent) and preserves unknown keys (ac-2)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ditto-tax-wb-'));
    try {
      await mkdir(join(repo, '.ditto'), { recursive: true });
      const file = join(repo, '.ditto', 'coverage-taxonomy.json');
      // seed a config carrying an unknown key a newer ditto version might have written
      await writeFile(
        file,
        `${JSON.stringify(
          { future_field: { note: 'unknown to this schema' }, disabled: ['authentication'] },
          null,
          2,
        )}\n`,
      );

      await applyTaxonomyMutation(repo, {
        kind: 'add',
        id: 'tenancy',
        lens: '이 변경이 테넌트 경계를 넘나?',
      });
      await applyTaxonomyMutation(repo, {
        kind: 'disable',
        id: 'time-clock',
        reason: '이 제품은 시간 의존 로직이 없음',
      });
      const first = await readFile(file, 'utf8');

      // re-apply the SAME two mutations → identical bytes (idempotent, ac-2)
      await applyTaxonomyMutation(repo, {
        kind: 'add',
        id: 'tenancy',
        lens: '이 변경이 테넌트 경계를 넘나?',
      });
      await applyTaxonomyMutation(repo, {
        kind: 'disable',
        id: 'time-clock',
        reason: '이 제품은 시간 의존 로직이 없음',
      });
      const second = await readFile(file, 'utf8');
      expect(second).toBe(first);

      const parsed = JSON.parse(first);
      // unknown key survived the parse→mutate→serialize round-trip (.passthrough)
      expect(parsed.future_field).toEqual({ note: 'unknown to this schema' });
      // disabled stays a bare id[] (no union-widen), no duplicate id
      expect(parsed.disabled).toEqual(['authentication', 'time-clock']);
      // add did not duplicate the tenancy entry
      expect(parsed.added.filter((a: { id: string }) => a.id === 'tenancy')).toHaveLength(1);
      // and the whole config still validates against the schema
      expect(coverageTaxonomyConfig.safeParse(parsed).success).toBe(true);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('disable records its justification in disabled_reasons (ac-4)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ditto-tax-wb-'));
    try {
      await mkdir(join(repo, '.ditto'), { recursive: true });
      await applyTaxonomyMutation(repo, {
        kind: 'disable',
        id: 'injection',
        reason: '이 서비스는 신뢰 경계에서 인터프리터로 들어가는 경로가 없음',
      });
      const parsed = JSON.parse(
        await readFile(join(repo, '.ditto', 'coverage-taxonomy.json'), 'utf8'),
      );
      expect(parsed.disabled).toContain('injection');
      expect(parsed.disabled_reasons.injection).toBe(
        '이 서비스는 신뢰 경계에서 인터프리터로 들어가는 경로가 없음',
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('re-route records a floor-category disposition override (dispositions map)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ditto-tax-wb-'));
    try {
      await mkdir(join(repo, '.ditto'), { recursive: true });
      await applyTaxonomyMutation(repo, {
        kind: 'reroute',
        id: 'auditing',
        disposition: 'user-intent',
      });
      const parsed = JSON.parse(
        await readFile(join(repo, '.ditto', 'coverage-taxonomy.json'), 'utf8'),
      );
      expect(parsed.dispositions.auditing).toBe('user-intent');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('a malformed candidate is rejected fail-closed — NO file is written (ac-3)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ditto-tax-wb-'));
    try {
      await mkdir(join(repo, '.ditto'), { recursive: true });
      const file = join(repo, '.ditto', 'coverage-taxonomy.json');
      // no config exists yet; an add with an empty lens violates lens.min(1)
      await expect(
        applyTaxonomyMutation(repo, { kind: 'add', id: 'x', lens: '' }),
      ).rejects.toThrow();
      // fail-closed: nothing landed
      expect(await Bun.file(file).exists()).toBe(false);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('a malformed candidate never overwrites an existing valid config (ac-3)', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ditto-tax-wb-'));
    try {
      await mkdir(join(repo, '.ditto'), { recursive: true });
      const file = join(repo, '.ditto', 'coverage-taxonomy.json');
      await applyTaxonomyMutation(repo, {
        kind: 'disable',
        id: 'time-clock',
        reason: '이 제품은 시간 의존 로직이 없음',
      });
      const before = await readFile(file, 'utf8');
      await expect(
        applyTaxonomyMutation(repo, { kind: 'add', id: 'y', lens: '' }),
      ).rejects.toThrow();
      // the prior valid config is untouched
      expect(await readFile(file, 'utf8')).toBe(before);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

// wi_260707phi (ac-3 read side) — the two real callers of loadFarFieldTaxonomy
// (coverage-loop.nextCoverageNode, interview-driver.startInterview) wire an
// onMalformed callback that SURFACES a warning, so a malformed tier-② override
// fails open to the floor WITH a signal, never silently (dead-wire class, fixed 3x).
describe('malformed-taxonomy warning wiring (wi_260707phi ac-3)', () => {
  test('warnMalformedTaxonomy surfaces a console warning naming the config file', () => {
    const original = console.warn;
    const seen: string[] = [];
    console.warn = (...args: unknown[]) => {
      seen.push(args.map(String).join(' '));
    };
    try {
      warnMalformedTaxonomy('/tmp/some-repo');
    } finally {
      console.warn = original;
    }
    expect(seen.length).toBe(1);
    expect(seen[0]).toContain('coverage-taxonomy.json');
  });

  test('startInterview wires the warning LIVE — a malformed config warns AND still fails open to the floor', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ditto-tax-iv-'));
    try {
      await mkdir(join(repo, '.ditto'), { recursive: true });
      await writeFile(join(repo, '.ditto', 'coverage-taxonomy.json'), '{ not json');
      const original = console.warn;
      const seen: string[] = [];
      console.warn = (...args: unknown[]) => {
        seen.push(args.map(String).join(' '));
      };
      let state: Awaited<ReturnType<typeof startInterview>>;
      try {
        state = await startInterview(repo, {
          workItemId: 'wi_taxbad01',
          seedUserIntentDimensions: true,
        });
      } finally {
        console.warn = original;
      }
      // the wire is LIVE: the malformed config produced a warning (not silent)
      expect(seen.some((m) => m.includes('coverage-taxonomy.json'))).toBe(true);
      // fail-open preserved: floor user-intent categories still seeded as dimensions
      expect(state.dimensions.length).toBeGreaterThan(0);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
