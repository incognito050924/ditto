import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { fileExists } from '~/core/hosts/shared';
import {
  checkCodexInstructions,
  compareClaudeProjection,
  loadProjection,
  loadSource,
} from '~/core/instruction-bridge';
import { buildManagedBlock } from '~/core/managed-resource';
import { ALLOW_RULE } from '~/core/settings-allowlist';
import { setup } from '~/core/setup';

const NOW = new Date('2026-06-08T00:00:00.000Z');

interface Dirs {
  resourcesDir: string;
  projectRoot: string;
  homeDir: string;
  pluginRoot?: string;
}

async function freshDirs(): Promise<Dirs> {
  const resourcesDir = await mkdtemp(join(tmpdir(), 'ditto-setup-res-'));
  const projectRoot = await mkdtemp(join(tmpdir(), 'ditto-setup-proj-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'ditto-setup-home-'));
  await writeFile(join(resourcesDir, 'CLAUDE.md'), 'CLAUDE charter body\n');
  await writeFile(join(resourcesDir, 'AGENTS.md'), 'AGENTS charter body\n');
  await writeFile(join(resourcesDir, 'GLOBAL_FOO.md'), 'global foo body\n');
  return { resourcesDir, projectRoot, homeDir };
}

async function freshCodexDirs(): Promise<Required<Dirs>> {
  const pluginRoot = await mkdtemp(join(tmpdir(), 'ditto-setup-codex-plugin-'));
  const resourcesDir = join(pluginRoot, 'resources', 'managed');
  const projectRoot = await mkdtemp(join(tmpdir(), 'ditto-setup-codex-proj-'));
  const homeDir = await mkdtemp(join(tmpdir(), 'ditto-setup-codex-home-'));

  await mkdir(resourcesDir, { recursive: true });
  await mkdir(join(pluginRoot, '.codex-plugin'), { recursive: true });
  await mkdir(join(pluginRoot, '.codex', 'agents'), { recursive: true });
  await mkdir(join(pluginRoot, 'skills', 'memory-graph'), { recursive: true });

  await writeFile(join(resourcesDir, 'AGENTS.md'), 'PROJECT AGENTS charter body\n');
  await writeFile(join(resourcesDir, 'CLAUDE.md'), 'PROJECT CLAUDE charter body\n');
  await writeFile(join(resourcesDir, 'GLOBAL_AGENTS.md'), 'GLOBAL AGENTS charter body\n');
  await writeFile(join(resourcesDir, 'GLOBAL_CLAUDE.md'), 'GLOBAL CLAUDE charter body\n');
  await writeFile(
    join(pluginRoot, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'ditto', version: '0.0.0', description: 'test' }),
  );
  await writeFile(
    join(pluginRoot, '.codex', 'agents', 'reviewer.toml'),
    'name = "reviewer"\ndeveloper_instructions = """\nRun `ditto memory query x`\n"""\n',
  );
  await writeFile(join(pluginRoot, '.codex', 'agents', 'planner.toml'), 'name = "planner"\n');
  await writeFile(
    join(pluginRoot, '.codex', 'agents', 'memory-extractor.toml'),
    [
      'name = "memory-extractor"',
      'description = "Host-delegated extraction for `ditto memory build --semantic`."',
      'developer_instructions = """',
      'Run `ditto memory build --semantic --fragments out.json`',
      '"""',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(pluginRoot, 'skills', 'memory-graph', 'SKILL.md'),
    'Run `"${CLAUDE_PLUGIN_ROOT}/bin/ditto" memory query x`.\n',
  );

  return { resourcesDir, projectRoot, homeDir, pluginRoot };
}

async function cleanup(d: Dirs): Promise<void> {
  await rm(d.resourcesDir, { recursive: true, force: true });
  await rm(d.projectRoot, { recursive: true, force: true });
  await rm(d.homeDir, { recursive: true, force: true });
  if (d.pluginRoot) await rm(d.pluginRoot, { recursive: true, force: true });
}

const MANAGED_START = /<!--\s*ditto:managed:start/;

describe('setup', () => {
  test('installs project + global resources, scaffolds .ditto, allowlists settings', async () => {
    const d = await freshDirs();
    try {
      const result = await setup({ ...d, now: NOW });

      // project resources land in projectRoot with a managed block
      const claude = await readFile(join(d.projectRoot, 'CLAUDE.md'), 'utf8');
      const agents = await readFile(join(d.projectRoot, 'AGENTS.md'), 'utf8');
      // AGENTS.md is the raw canonical source; CLAUDE.md is a managed projection
      // that mirrors it (not the bundled CLAUDE.md copy).
      expect(agents).not.toMatch(MANAGED_START);
      expect(agents).toContain('AGENTS charter body');
      expect(claude).toMatch(MANAGED_START);
      expect(claude).toContain('AGENTS charter body');

      // GLOBAL_ prefix strips to <homeDir>/.claude/FOO.md
      const globalFoo = await readFile(join(d.homeDir, '.claude', 'FOO.md'), 'utf8');
      expect(globalFoo).toMatch(MANAGED_START);
      expect(globalFoo).toContain('global foo body');
      expect(await fileExists(join(d.homeDir, '.claude', 'GLOBAL_FOO.md'))).toBe(false);

      // .ditto/ created
      expect(await fileExists(join(d.projectRoot, '.ditto', 'knowledge', 'glossary.json'))).toBe(
        true,
      );
      expect(result.scaffold.alreadyInitialized).toBe(false);

      // settings allow rule present
      const settings = JSON.parse(await readFile(result.allowlistPath, 'utf8'));
      expect(settings.permissions.allow).toContain(ALLOW_RULE);

      // every resource written cleanly
      expect(result.resources.every((r) => r.status === 'written')).toBe(true);
      expect(result.resources).toHaveLength(3);
    } finally {
      await cleanup(d);
    }
  });

  test('project CLAUDE.md is a doctor-valid managed projection of a raw AGENTS.md source', async () => {
    const d = await freshDirs();
    try {
      await setup({ ...d, now: NOW });

      // The canonical source (AGENTS.md) is raw — no managed block. doctor mirrors
      // AGENTS.md verbatim into CLAUDE.md, so wrapping the source would break the
      // sha/content match and (on a pre-existing source) duplicate the charter.
      const agents = await readFile(join(d.projectRoot, 'AGENTS.md'), 'utf8');
      expect(agents).not.toMatch(MANAGED_START);
      expect(agents).toBe('AGENTS charter body\n');

      // CLAUDE.md is sourced from AGENTS.md and mirrors it — zero doctor findings.
      const source = await loadSource(d.projectRoot);
      const projection = await loadProjection(d.projectRoot);
      expect(checkCodexInstructions(source)).toEqual([]);
      expect(compareClaudeProjection(source, projection)).toEqual([]);
    } finally {
      await cleanup(d);
    }
  });

  test('does not overwrite a pre-existing authored AGENTS.md source', async () => {
    const d = await freshDirs();
    try {
      await writeFile(join(d.projectRoot, 'AGENTS.md'), 'AUTHORED canonical charter\n');
      await setup({ ...d, now: NOW });

      // create-if-missing: an existing source is kept, never clobbered by the bundle…
      const agents = await readFile(join(d.projectRoot, 'AGENTS.md'), 'utf8');
      expect(agents).toBe('AUTHORED canonical charter\n');
      expect(agents).not.toMatch(MANAGED_START);

      // …and CLAUDE.md still projects whatever the on-disk source actually is.
      const source = await loadSource(d.projectRoot);
      const projection = await loadProjection(d.projectRoot);
      expect(compareClaudeProjection(source, projection)).toEqual([]);
    } finally {
      await cleanup(d);
    }
  });

  test('preserves pre-existing user text outside the managed block', async () => {
    const d = await freshDirs();
    try {
      await writeFile(join(d.projectRoot, 'CLAUDE.md'), 'USER PREAMBLE\n');
      await setup({ ...d, now: NOW });
      const claude = await readFile(join(d.projectRoot, 'CLAUDE.md'), 'utf8');
      expect(claude).toContain('USER PREAMBLE');
      expect(claude).toMatch(MANAGED_START);
    } finally {
      await cleanup(d);
    }
  });

  test('re-run is idempotent: .ditto_bak keeps the first original, no dup allow rule', async () => {
    const d = await freshDirs();
    try {
      await writeFile(join(d.projectRoot, 'CLAUDE.md'), 'FIRST ORIGINAL\n');
      await setup({ ...d, now: NOW });

      // mutate the file content, then re-run; backup must keep the FIRST original
      const afterFirst = await readFile(join(d.projectRoot, 'CLAUDE.md'), 'utf8');
      await writeFile(
        join(d.projectRoot, 'CLAUDE.md'),
        afterFirst.replace('FIRST ORIGINAL', 'EDITED'),
      );
      await setup({ ...d, now: NOW });

      const bak = await readFile(join(d.projectRoot, 'CLAUDE.md.ditto_bak'), 'utf8');
      expect(bak).toBe('FIRST ORIGINAL\n');

      const settings = JSON.parse(
        await readFile(join(d.projectRoot, '.claude', 'settings.json'), 'utf8'),
      );
      const occurrences = settings.permissions.allow.filter((r: string) => r === ALLOW_RULE).length;
      expect(occurrences).toBe(1);
    } finally {
      await cleanup(d);
    }
  });

  test('codex host installs AGENTS, repo marketplace, and project custom agents', async () => {
    const d = await freshCodexDirs();
    try {
      const result = await setup({ ...d, now: NOW, host: 'codex', pluginRoot: d.pluginRoot });
      await setup({ ...d, now: NOW, host: 'codex', pluginRoot: d.pluginRoot });

      // AGENTS.md is the raw canonical source (no managed block), kept across re-runs.
      const agents = await readFile(join(d.projectRoot, 'AGENTS.md'), 'utf8');
      expect(agents).not.toMatch(MANAGED_START);
      expect(agents).toBe('PROJECT AGENTS charter body\n');
      expect(await fileExists(join(d.projectRoot, 'CLAUDE.md'))).toBe(false);

      const globalAgents = await readFile(join(d.homeDir, '.codex', 'AGENTS.md'), 'utf8');
      expect(globalAgents).not.toMatch(MANAGED_START);
      expect(globalAgents).toBe('GLOBAL AGENTS charter body\n');
      expect(await fileExists(join(d.homeDir, '.claude', 'AGENTS.md'))).toBe(false);

      expect(result.allowlistApplied).toBe(false);
      expect(await fileExists(result.allowlistPath)).toBe(false);

      const marketplacePath = join(d.projectRoot, '.agents', 'plugins', 'marketplace.json');
      const marketplace = JSON.parse(await readFile(marketplacePath, 'utf8'));
      const dittoEntries = marketplace.plugins.filter((p: { name?: string }) => p.name === 'ditto');
      expect(dittoEntries).toHaveLength(1);
      expect(dittoEntries[0].source.path).toBe('./.agents/plugins/ditto');
      expect(
        await fileExists(
          join(d.projectRoot, '.agents', 'plugins', 'ditto', '.codex-plugin', 'plugin.json'),
        ),
      ).toBe(true);

      expect(await fileExists(join(d.projectRoot, '.codex', 'agents', 'reviewer.toml'))).toBe(true);
      expect(await fileExists(join(d.projectRoot, '.codex', 'agents', 'planner.toml'))).toBe(true);
      expect(result.codex?.pluginLoadStatus).toBe('needs_user_action');
      expect(result.codex?.enableCommands).toEqual([
        `codex plugin marketplace add ${JSON.stringify(d.projectRoot)}`,
        'codex plugin add ditto@ditto-local',
      ]);
      expect(await fileExists(join(d.projectRoot, '.ditto', 'local', 'surfaces.codex.json'))).toBe(
        true,
      );
      expect(
        await fileExists(join(d.projectRoot, '.ditto', 'local', 'codex-plugin-status.json')),
      ).toBe(true);
      expect(result.codex).not.toBeNull();
      const codex = result.codex;
      if (!codex) throw new Error('expected codex setup result');
      const dittoCommand = `"${join(codex.installedPluginDir, 'bin', 'ditto')}"`;
      const installedSkill = await readFile(
        join(codex.installedPluginDir, 'skills', 'memory-graph', 'SKILL.md'),
        'utf8',
      );
      const projectAgent = await readFile(
        join(d.projectRoot, '.codex', 'agents', 'reviewer.toml'),
        'utf8',
      );
      const memoryExtractorAgent = await readFile(
        join(d.projectRoot, '.codex', 'agents', 'memory-extractor.toml'),
        'utf8',
      );
      expect(installedSkill).toContain(dittoCommand);
      expect(installedSkill).not.toContain('CLAUDE_PLUGIN_ROOT');
      expect(projectAgent).toContain(dittoCommand);
      expect(projectAgent).not.toContain('`ditto memory query x`');
      expect(() => parseToml(memoryExtractorAgent)).not.toThrow();
      expect(memoryExtractorAgent).toContain('`ditto memory build --semantic`');
      expect(memoryExtractorAgent).toContain(dittoCommand);
      expect(result.codex?.agentsInstalled).toBe(3);
      expect(result.scaffold.alreadyInitialized).toBe(false);
    } finally {
      await cleanup(d);
    }
  });

  test('codex global AGENTS.md honors codexHome (CODEX_HOME isolation)', async () => {
    const d = await freshCodexDirs();
    const codexHome = await mkdtemp(join(tmpdir(), 'ditto-setup-codexhome-'));
    try {
      await setup({ ...d, now: NOW, host: 'codex', pluginRoot: d.pluginRoot, codexHome });
      // The global charter lands inside the isolated CODEX_HOME — NOT the real
      // ~/.codex — so a dogfood codex session never touches the user's home.
      expect(await readFile(join(codexHome, 'AGENTS.md'), 'utf8')).toBe(
        'GLOBAL AGENTS charter body\n',
      );
      expect(await fileExists(join(d.homeDir, '.codex', 'AGENTS.md'))).toBe(false);
    } finally {
      await rm(codexHome, { recursive: true, force: true });
      await cleanup(d);
    }
  });

  test('codex host fails when the plugin artifact has no projected custom agents', async () => {
    const d = await freshCodexDirs();
    try {
      await rm(join(d.pluginRoot, '.codex'), { recursive: true, force: true });

      await expect(
        setup({ ...d, now: NOW, host: 'codex', pluginRoot: d.pluginRoot }),
      ).rejects.toThrow('codex custom agents not found');
    } finally {
      await cleanup(d);
    }
  });

  test('codex host refuses to reinstall from the installed plugin directory without deleting it', async () => {
    const d = await freshCodexDirs();
    const installedPluginDir = join(d.projectRoot, '.agents', 'plugins', 'ditto');
    try {
      await mkdir(join(installedPluginDir, 'resources', 'managed'), { recursive: true });
      await mkdir(join(installedPluginDir, '.codex-plugin'), { recursive: true });
      await mkdir(join(installedPluginDir, '.codex', 'agents'), { recursive: true });

      await writeFile(join(installedPluginDir, 'resources', 'managed', 'AGENTS.md'), 'AGENTS\n');
      await writeFile(
        join(installedPluginDir, 'resources', 'managed', 'GLOBAL_AGENTS.md'),
        'GLOBAL\n',
      );
      await writeFile(join(installedPluginDir, '.codex-plugin', 'plugin.json'), '{}\n');
      await writeFile(
        join(installedPluginDir, '.codex', 'agents', 'reviewer.toml'),
        'name = "reviewer"\n',
      );
      await writeFile(join(installedPluginDir, 'keep.txt'), 'must survive\n');

      await expect(
        setup({
          resourcesDir: join(installedPluginDir, 'resources', 'managed'),
          projectRoot: d.projectRoot,
          homeDir: d.homeDir,
          now: NOW,
          host: 'codex',
          pluginRoot: installedPluginDir,
        }),
      ).rejects.toThrow('codex plugin source is already the installed plugin directory');

      expect(await readFile(join(installedPluginDir, 'keep.txt'), 'utf8')).toBe('must survive\n');
    } finally {
      await cleanup(d);
    }
  });
});

describe('setup — global managed-block double-wrap heal', () => {
  function startCount(text: string): number {
    return (text.match(/ditto:managed:start/g) ?? []).length;
  }
  function endCount(text: string): number {
    return (text.match(/ditto:managed:end/g) ?? []).length;
  }

  test('heals a legacy locked global ~/.claude (nested CLAUDE.md + wrapped AGENTS.md) to single clean blocks', async () => {
    const d = await freshDirs();
    try {
      // Resources that route to the global ~/.claude/{AGENTS,CLAUDE}.md.
      await writeFile(join(d.resourcesDir, 'GLOBAL_AGENTS.md'), 'GLOBAL charter body\n');
      await writeFile(join(d.resourcesDir, 'GLOBAL_CLAUDE.md'), 'GLOBAL charter body\n');

      // Reproduce the user's locked state, exactly as seen in a real ~/.claude:
      //  - global AGENTS.md is itself wrapped in a ditto block (legacy bug)
      //  - global CLAUDE.md is a NESTED double block (projection re-wrapped the above)
      const globalDir = join(d.homeDir, '.claude');
      await mkdir(globalDir, { recursive: true });
      const wrappedAgents = buildManagedBlock('GLOBAL charter body\n', 'GLOBAL_AGENTS.md');
      await writeFile(join(globalDir, 'AGENTS.md'), wrappedAgents);
      const nestedClaude = buildManagedBlock(wrappedAgents, 'AGENTS.md');
      await writeFile(join(globalDir, 'CLAUDE.md'), nestedClaude);
      // precondition: the locked state really is doubled
      expect(startCount(nestedClaude)).toBe(2);
      expect(endCount(nestedClaude)).toBe(2);

      await setup({
        resourcesDir: d.resourcesDir,
        projectRoot: d.projectRoot,
        homeDir: d.homeDir,
        now: NOW,
      });

      const claude = await readFile(join(globalDir, 'CLAUDE.md'), 'utf8');
      const agents = await readFile(join(globalDir, 'AGENTS.md'), 'utf8');
      // CLAUDE.md healed to exactly one managed block
      expect(startCount(claude)).toBe(1);
      expect(endCount(claude)).toBe(1);
      // AGENTS.md healed back to raw (the canonical source carries no markers)
      expect(startCount(agents)).toBe(0);
      expect(endCount(agents)).toBe(0);

      // and it stays healed on a second run (idempotent, not re-doubled)
      await setup({
        resourcesDir: d.resourcesDir,
        projectRoot: d.projectRoot,
        homeDir: d.homeDir,
        now: NOW,
      });
      const claude2 = await readFile(join(globalDir, 'CLAUDE.md'), 'utf8');
      expect(startCount(claude2)).toBe(1);
      expect(endCount(claude2)).toBe(1);
    } finally {
      await rm(d.resourcesDir, { recursive: true, force: true });
      await rm(d.projectRoot, { recursive: true, force: true });
      await rm(d.homeDir, { recursive: true, force: true });
    }
  });
});
