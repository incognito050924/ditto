import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BUILTIN_DEFAULT_RECIPE,
  PROJECT_RECIPE_FILENAME,
  loadRecipeFile,
  loadResolvedRecipe,
  resolveRecipe,
} from '~/core/recipe/load';
import { parseRecipe } from '~/core/recipe/parse';
import { recipe } from '~/schemas/recipe';

describe('parseRecipe — yaml parse + zod validate (ac-4 enum / ac-5 policy)', () => {
  test('valid partial recipe (only host) parses', () => {
    const r = parseRecipe('host: codex\n');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.recipe).toEqual({ host: 'codex' });
  });

  test('valid full recipe parses all four stages', () => {
    const text = [
      'host: both',
      'tools:',
      '  - codeql',
      '  - playwright',
      'agents:',
      '  - name: my-impl',
      '    role: implementer',
      'memory: submodule',
    ].join('\n');
    const r = parseRecipe(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.recipe).toEqual({
        host: 'both',
        tools: ['codeql', 'playwright'],
        agents: [{ name: 'my-impl', role: 'implementer' }],
        memory: 'submodule',
      });
    }
  });

  test('empty document → valid empty recipe', () => {
    const r = parseRecipe('');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.recipe).toEqual({});
  });

  // ac-4: enum constraint (NOT z.string) — semantically-invalid value must FAIL.
  test('invalid host enum value → fail', () => {
    expect(parseRecipe('host: gitlab\n').ok).toBe(false);
  });

  test('invalid memory enum value → fail', () => {
    expect(parseRecipe('memory: rsync\n').ok).toBe(false);
  });

  test('invalid agent role enum value → fail', () => {
    expect(parseRecipe('agents:\n  - name: x\n    role: implementor\n').ok).toBe(false);
  });

  // pseudo-owners are NOT valid recipe roles (driver/main-session excluded).
  test('pseudo-owner role (driver) → fail', () => {
    expect(parseRecipe('agents:\n  - name: x\n    role: driver\n').ok).toBe(false);
  });

  test('pseudo-owner role (main-session) → fail', () => {
    expect(parseRecipe('agents:\n  - name: x\n    role: main-session\n').ok).toBe(false);
  });

  test('a real autopilot owner role (verifier) → valid', () => {
    const r = parseRecipe('agents:\n  - name: x\n    role: verifier\n');
    expect(r.ok).toBe(true);
  });

  test('malformed yaml → fail', () => {
    // a bare scalar is not a mapping → zod object rejects it
    const r = parseRecipe('just a string');
    expect(r.ok).toBe(false);
  });

  test('schema accepts canonical enum members directly', () => {
    expect(recipe.safeParse({ host: 'claude-code' }).success).toBe(true);
    expect(recipe.safeParse({ memory: 'gitignore' }).success).toBe(true);
    expect(recipe.safeParse({ host: 'nope' }).success).toBe(false);
  });
});

describe('parseRecipe — push_gate block (wi_260629i9c)', () => {
  // recipe 철학(load.ts:16-22): default 없음, 명시 override만 — push_gate 부재 = 게이트 비활성.
  test('valid push_gate parses and is retained', () => {
    const text = [
      'push_gate:',
      '  protected_branches:',
      '    - main',
      '    - master',
      '  test_command: bun test',
    ].join('\n');
    const r = parseRecipe(text);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.recipe.push_gate).toEqual({
        protected_branches: ['main', 'master'],
        test_command: 'bun test',
      });
  });

  test('absent push_gate → undefined (gate inactive)', () => {
    const r = parseRecipe('host: codex\n');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.recipe.push_gate).toBeUndefined();
  });

  // present-but-incomplete must FAIL (not silently drop) — a half-declared gate is dead config.
  test('push_gate with empty protected_branches → fail', () => {
    expect(parseRecipe('push_gate:\n  protected_branches: []\n  test_command: bun test\n').ok).toBe(
      false,
    );
  });

  test('push_gate missing test_command → fail', () => {
    expect(parseRecipe('push_gate:\n  protected_branches:\n    - main\n').ok).toBe(false);
  });
});

describe('parseRecipe — repos array (multi-repo manifest, wi_260629i9c)', () => {
  // One recipe describes a multi-repo workspace: top-level push_gate = root repo,
  // each `repos[]` entry = a sub-repo (or submodule) by its dir, with its OWN gate.
  test('repos with per-repo push_gate parses and is retained', () => {
    const text = [
      'repos:',
      '  - dir: frontend',
      '    push_gate:',
      '      protected_branches: [main]',
      '      test_command: turbo run test',
      '  - dir: portal-backend',
      '    push_gate:',
      '      protected_branches: [main]',
      '      test_command: gradle test',
    ].join('\n');
    const r = parseRecipe(text);
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.recipe.repos).toEqual([
        {
          dir: 'frontend',
          push_gate: { protected_branches: ['main'], test_command: 'turbo run test' },
        },
        {
          dir: 'portal-backend',
          push_gate: { protected_branches: ['main'], test_command: 'gradle test' },
        },
      ]);
  });

  test('repos entry without dir → fail', () => {
    expect(
      parseRecipe(
        'repos:\n  - push_gate:\n      protected_branches: [main]\n      test_command: x\n',
      ).ok,
    ).toBe(false);
  });

  test('repos entry may omit push_gate (dir-only is valid — gate inactive for it)', () => {
    const r = parseRecipe('repos:\n  - dir: docs\n');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.recipe.repos).toEqual([{ dir: 'docs' }]);
  });

  test('top-level push_gate (root) and repos (sub-repos) coexist', () => {
    const text = [
      'push_gate:',
      '  protected_branches: [main]',
      '  test_command: bun test',
      'repos:',
      '  - dir: frontend',
      '    push_gate:',
      '      protected_branches: [main]',
      '      test_command: turbo run test',
    ].join('\n');
    const r = parseRecipe(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.recipe.push_gate).toEqual({
        protected_branches: ['main'],
        test_command: 'bun test',
      });
      expect(r.recipe.repos?.length).toBe(1);
    }
  });
});

describe('loadRecipeFile — explicit vs discovered malformed policy (ac-5)', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'recipe-load-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function write(name: string, content: string): Promise<string> {
    const p = join(repo, name);
    await writeFile(p, content, 'utf8');
    return p;
  }

  test('valid explicit recipe → parsed recipe', async () => {
    const p = await write('r.yaml', 'host: codex\n');
    expect(await loadRecipeFile(p, 'explicit')).toEqual({ host: 'codex' });
  });

  test('explicit malformed yaml → THROWS (hard error, NOT fail-open)', async () => {
    const p = await write('r.yaml', 'host: [unterminated\n');
    expect(loadRecipeFile(p, 'explicit')).rejects.toThrow();
  });

  test('explicit schema-invalid (bad enum) → THROWS (hard error)', async () => {
    const p = await write('r.yaml', 'host: gitlab\n');
    expect(loadRecipeFile(p, 'explicit')).rejects.toThrow();
  });

  test('explicit missing file → THROWS (an explicit flag must not silently no-op)', async () => {
    expect(loadRecipeFile(join(repo, 'nope.yaml'), 'explicit')).rejects.toThrow();
  });

  test('discovered malformed → fail-open absent + onMalformed warning', async () => {
    const p = await write('r.yaml', 'host: gitlab\n');
    let warned = '';
    const out = await loadRecipeFile(p, 'discovered', (m) => {
      warned = m;
    });
    expect(out).toBeUndefined();
    expect(warned.length).toBeGreaterThan(0);
  });

  test('discovered absent file → undefined, NO warning', async () => {
    let warned = 0;
    const out = await loadRecipeFile(join(repo, 'nope.yaml'), 'discovered', () => {
      warned++;
    });
    expect(out).toBeUndefined();
    expect(warned).toBe(0);
  });

  test('discovered valid → parsed recipe, no warning', async () => {
    const p = await write('r.yaml', 'memory: gitignore\n');
    let warned = 0;
    const out = await loadRecipeFile(p, 'discovered', () => {
      warned++;
    });
    expect(out).toEqual({ memory: 'gitignore' });
    expect(warned).toBe(0);
  });
});

describe('resolveRecipe — per-field precedence merge (ac-4)', () => {
  test('built-in default alone is empty', () => {
    expect(BUILTIN_DEFAULT_RECIPE).toEqual({});
  });

  test('order: cli > personal > project > default for the SAME field', () => {
    expect(
      resolveRecipe({
        builtinDefault: { host: 'claude-code' },
        project: { host: 'codex' },
        personal: { host: 'both' },
        cli: { host: 'codex' },
      }).host,
    ).toBe('codex');
    // drop cli → personal wins
    expect(
      resolveRecipe({
        builtinDefault: { host: 'claude-code' },
        project: { host: 'codex' },
        personal: { host: 'both' },
      }).host,
    ).toBe('both');
    // drop personal → project wins
    expect(
      resolveRecipe({
        builtinDefault: { host: 'claude-code' },
        project: { host: 'codex' },
      }).host,
    ).toBe('codex');
    // only default → default
    expect(resolveRecipe({ builtinDefault: { host: 'claude-code' } }).host).toBe('claude-code');
  });

  // GRANULARITY: a higher-priority source overrides ONLY the fields it sets.
  test('per-field merge — partial sources combine, not whole-file replace', () => {
    const merged = resolveRecipe({
      project: { host: 'codex', tools: ['codeql'] },
      personal: { memory: 'submodule' },
      cli: { host: 'both' },
    });
    expect(merged).toEqual({
      host: 'both', // cli overrode only host
      tools: ['codeql'], // survived from project (cli/personal did not set it)
      memory: 'submodule', // survived from personal
    });
  });

  test('agents field is replaced as a unit by a higher source that sets it', () => {
    const merged = resolveRecipe({
      project: { agents: [{ name: 'a', role: 'implementer' }] },
      personal: { agents: [{ name: 'b', role: 'reviewer' }] },
    });
    expect(merged.agents).toEqual([{ name: 'b', role: 'reviewer' }]);
  });

  test('a higher source that does NOT set agents preserves the lower agents', () => {
    const merged = resolveRecipe({
      project: { agents: [{ name: 'a', role: 'implementer' }] },
      personal: { host: 'codex' },
    });
    expect(merged.agents).toEqual([{ name: 'a', role: 'implementer' }]);
    expect(merged.host).toBe('codex');
  });
});

describe('loadResolvedRecipe — conventional paths + precedence (ac-4/ac-5)', () => {
  let repo: string;
  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'recipe-resolve-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  test('conventional project path is repo-root recipe.yaml', () => {
    expect(PROJECT_RECIPE_FILENAME).toBe('recipe.yaml');
  });

  test('personal (.ditto/local) overrides project (checked-in) per field', async () => {
    await writeFile(join(repo, 'recipe.yaml'), 'host: codex\ntools:\n  - codeql\n', 'utf8');
    const localD = join(repo, '.ditto', 'local');
    await mkdir(localD, { recursive: true });
    await writeFile(join(localD, 'recipe.yaml'), 'host: both\n', 'utf8');

    const merged = await loadResolvedRecipe(repo, undefined);
    expect(merged.host).toBe('both'); // personal wins
    expect(merged.tools).toEqual(['codeql']); // project survives per-field
  });

  test('explicit cli path overrides everything and hard-errors on malformed', async () => {
    await writeFile(join(repo, 'recipe.yaml'), 'host: codex\n', 'utf8');
    const cliPath = join(repo, 'cli.yaml');
    await writeFile(cliPath, 'host: both\n', 'utf8');
    expect((await loadResolvedRecipe(repo, cliPath)).host).toBe('both');

    await writeFile(cliPath, 'host: gitlab\n', 'utf8');
    expect(loadResolvedRecipe(repo, cliPath)).rejects.toThrow();
  });

  test('discovered project malformed → warned, not thrown', async () => {
    await writeFile(join(repo, 'recipe.yaml'), 'host: gitlab\n', 'utf8');
    const warnings: Array<{ source: string; message: string }> = [];
    const merged = await loadResolvedRecipe(repo, undefined, (source, message) => {
      warnings.push({ source, message });
    });
    expect(merged).toEqual({}); // malformed project ignored, default empty
    expect(warnings.some((w) => w.source === 'project')).toBe(true);
  });
});
