import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentVariant,
  loadVariantCatalog,
  recommendVariantRole,
  selectVariantCandidates,
  writeAgentVariants,
} from '~/core/agent-variants';
import { ensureDir } from '~/core/fs';

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-variants-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

async function writeVariant(file: string, body: string): Promise<void> {
  const dir = join(repo, '.ditto', 'agents');
  await ensureDir(dir);
  await Bun.write(join(dir, file), body);
}

describe('loadVariantCatalog (ac-1)', () => {
  test('missing .ditto/agents dir returns an empty (0-item) catalog', async () => {
    const catalog = await loadVariantCatalog(repo);
    expect(catalog).toEqual([]);
  });

  test('loads name/role/description/match from frontmatter', async () => {
    await writeVariant(
      'sql-impl.md',
      `---
name: sql-implementer
role: implementer
description: specialized for SQL migrations
match: [src/db/**, "migrations/*.sql"]
---
# body ignored
`,
    );
    await writeVariant(
      'ui-impl.md',
      `---
name: ui-implementer
role: implementer
description: |
  Front-end specialist.
  Handles component work.
match:
  - src/ui/**
  - components/**
---
body
`,
    );
    const catalog = await loadVariantCatalog(repo);
    expect(catalog.length).toBe(2);
    const sql = catalog.find((v) => v.name === 'sql-implementer') as AgentVariant;
    expect(sql.role).toBe('implementer');
    expect(sql.description).toBe('specialized for SQL migrations');
    expect(sql.match).toEqual(['src/db/**', 'migrations/*.sql']);

    const ui = catalog.find((v) => v.name === 'ui-implementer') as AgentVariant;
    expect(ui.description).toBe('Front-end specialist.\nHandles component work.');
    expect(ui.match).toEqual(['src/ui/**', 'components/**']);
  });

  test('skips files with no frontmatter or missing name/role', async () => {
    await writeVariant('no-fm.md', '# just a markdown file\nno frontmatter here\n');
    await writeVariant(
      'no-role.md',
      `---
name: orphan
---
`,
    );
    await writeVariant(
      'good.md',
      `---
name: ok
role: reviewer
description: fine
---
`,
    );
    const catalog = await loadVariantCatalog(repo);
    expect(catalog.map((v) => v.name)).toEqual(['ok']);
  });

  test('match defaults to [] when absent', async () => {
    await writeVariant(
      'nomatch.md',
      `---
name: any
role: verifier
description: matches anything
---
`,
    );
    const catalog = await loadVariantCatalog(repo);
    expect(catalog[0]?.match).toEqual([]);
  });
});

describe('selectVariantCandidates (ac-2: deterministic role + scope filter)', () => {
  const catalog: AgentVariant[] = [
    {
      name: 'sql-impl',
      role: 'implementer',
      description: 'sql',
      match: ['src/db/**'],
    },
    {
      name: 'ui-impl',
      role: 'implementer',
      description: 'ui',
      match: ['src/ui/*.tsx'],
    },
    { name: 'any-impl', role: 'implementer', description: 'any', match: [] },
    { name: 'rev', role: 'reviewer', description: 'reviewer', match: [] },
  ];

  test('filters by role and file_scope glob match', () => {
    const out = selectVariantCandidates(catalog, 'implementer', ['src/db/users.ts']);
    // sql-impl matches src/db/**, any-impl has empty match (always), ui-impl no.
    expect(out.map((c) => c.name).sort()).toEqual(['any-impl', 'sql-impl']);
    expect(out.every((c) => 'description' in c)).toBe(true);
  });

  test('* matches within a single path segment only', () => {
    const out = selectVariantCandidates(catalog, 'implementer', ['src/ui/Button.tsx']);
    expect(out.map((c) => c.name).sort()).toEqual(['any-impl', 'ui-impl']);
  });

  test('empty match always qualifies for its role', () => {
    const out = selectVariantCandidates(catalog, 'reviewer', ['anything/at/all.ts']);
    expect(out).toEqual([{ name: 'rev', description: 'reviewer' }]);
  });

  test('0 matches returns an empty array', () => {
    expect(selectVariantCandidates([], 'implementer', ['src/x.ts'])).toEqual([]);
    expect(selectVariantCandidates(catalog, 'planner', ['src/db/x.ts'])).toEqual([]);
    // role matches but no scope glob and no empty-match variant
    const scoped = catalog.filter((v) => v.match.length > 0 && v.role === 'implementer');
    expect(selectVariantCandidates(scoped, 'implementer', ['unrelated/path.go'])).toEqual([]);
  });

  test('a hint surfaces the hinted catalog variant first (late binding, ordering only)', () => {
    // any-impl would otherwise come before sql-impl by catalog order; the hint
    // moves sql-impl to the head without dropping any candidate.
    const out = selectVariantCandidates(catalog, 'implementer', ['src/db/users.ts'], 'sql-impl');
    expect(out.map((c) => c.name)).toEqual(['sql-impl', 'any-impl']);
  });

  test('a hint absent from the candidate set is ignored (no crash, order unchanged)', () => {
    const noHint = selectVariantCandidates(catalog, 'implementer', ['src/db/users.ts']);
    const ghost = selectVariantCandidates(catalog, 'implementer', ['src/db/users.ts'], 'nope');
    expect(ghost).toEqual(noHint);
  });
});

describe('recommendVariantRole (ac-1: 7-case keyword heuristic)', () => {
  test('security/appsec/vuln → security-reviewer (highest priority)', () => {
    expect(recommendVariantRole('appsec-bot', '')).toBe('security-reviewer');
    expect(recommendVariantRole('x', 'finds VULNerabilities')).toBe('security-reviewer');
    expect(recommendVariantRole('SecurityAuditor', 'review audit')).toBe('security-reviewer');
  });
  test('review/audit → reviewer', () => {
    expect(recommendVariantRole('code-reviewer', '')).toBe('reviewer');
    expect(recommendVariantRole('x', 'performs an AUDIT')).toBe('reviewer');
  });
  test('architect/architecture/design → architect', () => {
    expect(recommendVariantRole('the-architect', '')).toBe('architect');
    expect(recommendVariantRole('x', 'system DESIGN guidance')).toBe('architect');
  });
  test('research/investigate → researcher', () => {
    expect(recommendVariantRole('deep-research', '')).toBe('researcher');
    expect(recommendVariantRole('x', 'will INVESTIGATE the issue')).toBe('researcher');
  });
  test('test/qa → verifier', () => {
    expect(recommendVariantRole('test-writer', '')).toBe('verifier');
    expect(recommendVariantRole('x', 'QA specialist')).toBe('verifier');
  });
  test('refactor/tidy → refactorer', () => {
    expect(recommendVariantRole('refactor-helper', '')).toBe('refactorer');
    expect(recommendVariantRole('x', 'tidy first')).toBe('refactorer');
  });
  test('else → implementer (default)', () => {
    expect(recommendVariantRole('feature-builder', 'writes code')).toBe('implementer');
    expect(recommendVariantRole('', '')).toBe('implementer');
  });
});

describe('writeAgentVariants (ac-4: idempotent writer)', () => {
  test('writes new variants in parseVariant-readable frontmatter; round-trips', async () => {
    const result = await writeAgentVariants(repo, [
      { name: 'sec', role: 'security-reviewer', description: 'finds vulns', match: [] },
    ]);
    expect(result.written).toEqual(['sec']);
    expect(result.skipped).toEqual([]);

    const catalog = await loadVariantCatalog(repo);
    expect(catalog).toEqual([
      { name: 'sec', role: 'security-reviewer', description: 'finds vulns', match: [] },
    ]);
  });

  test('existing file is skipped, never overwritten (preserves user edits)', async () => {
    await writeVariant(
      'sec.md',
      `---
name: sec
role: implementer
description: user-edited body
---
hand edit
`,
    );
    const result = await writeAgentVariants(repo, [
      { name: 'sec', role: 'security-reviewer', description: 'auto', match: [] },
    ]);
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual(['sec']);

    // user edit preserved
    const text = await Bun.file(join(repo, '.ditto', 'agents', 'sec.md')).text();
    expect(text).toContain('user-edited body');
    expect(text).toContain('hand edit');
  });
});
