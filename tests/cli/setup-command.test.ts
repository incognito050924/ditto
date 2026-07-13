import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'citty';
import {
  discoverCodexAgents,
  discoverProjectAgents,
  resolveCodexPluginRoot,
  setupCommand,
} from '~/cli/commands/setup';
import {
  loadVariantCatalog,
  recommendVariantRole,
  selectVariantCandidates,
  writeAgentVariants,
} from '~/core/agent-variants';

describe('setup command', () => {
  test('source repo invocation prefers dist/codex-plugin over the source repo root', async () => {
    const repo = await mkdtemp(join(tmpdir(), 'ditto-setup-command-repo-'));
    const projectRoot = await mkdtemp(join(tmpdir(), 'ditto-setup-command-target-'));
    try {
      const resourcesDir = join(repo, 'resources', 'managed');
      const distRoot = join(repo, 'dist', 'codex-plugin');
      await mkdir(join(repo, '.codex-plugin'), { recursive: true });
      await mkdir(resourcesDir, { recursive: true });
      await mkdir(join(distRoot, '.codex-plugin'), { recursive: true });
      await mkdir(join(distRoot, '.codex', 'agents'), { recursive: true });

      await writeFile(join(repo, '.codex-plugin', 'plugin.json'), '{}\n');
      await writeFile(join(distRoot, '.codex-plugin', 'plugin.json'), '{}\n');
      await writeFile(join(distRoot, '.codex', 'agents', 'reviewer.toml'), 'name = "reviewer"\n');

      await expect(resolveCodexPluginRoot(resourcesDir, projectRoot)).resolves.toBe(distRoot);
    } finally {
      await rm(repo, { recursive: true, force: true });
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test('discoverCodexAgents surfaces user agents, excludes ditto-bundled, parses TOML description', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'ditto-codex-agents-'));
    try {
      const agentsDir = join(projectRoot, '.codex', 'agents');
      await mkdir(agentsDir, { recursive: true });
      // user custom agent with a single-line TOML description
      await writeFile(
        join(agentsDir, 'my-appsec.toml'),
        'name = "my-appsec"\ndescription = "audits auth and secrets"\nsandbox_mode = "read-only"\n',
      );
      // ditto-bundled agent (provenance header) — must be excluded
      await writeFile(
        join(agentsDir, 'reviewer.toml'),
        '# Generated from agents/reviewer.md by ditto agent-projection (dual-host plan M4).\nname = "reviewer"\ndescription = "review one node"\n',
      );
      // user agent without a description — name-only recommendation still works
      await writeFile(join(agentsDir, 'nodesc.toml'), 'name = "nodesc"\n');

      const out = await discoverCodexAgents(projectRoot);
      expect(out).toEqual([
        { name: 'my-appsec', description: 'audits auth and secrets' },
        { name: 'nodesc', description: '' },
      ]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test('discoverProjectAgents dispatches by host and unions+dedupes for both', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'ditto-project-agents-'));
    try {
      const claudeDir = join(projectRoot, '.claude', 'agents');
      const codexDir = join(projectRoot, '.codex', 'agents');
      await mkdir(claudeDir, { recursive: true });
      await mkdir(codexDir, { recursive: true });
      // claude markdown agents (frontmatter description)
      await writeFile(
        join(claudeDir, 'shared.md'),
        '---\nname: shared\ndescription: claude side\n---\n',
      );
      await writeFile(
        join(claudeDir, 'only-claude.md'),
        '---\nname: only-claude\ndescription: c\n---\n',
      );
      // codex toml agents — one shares a name with claude (dedupe), one unique
      await writeFile(
        join(codexDir, 'shared.toml'),
        'name = "shared"\ndescription = "codex side"\n',
      );
      await writeFile(
        join(codexDir, 'only-codex.toml'),
        'name = "only-codex"\ndescription = "x"\n',
      );

      const claudeOnly = await discoverProjectAgents(projectRoot, 'claude-code');
      expect(claudeOnly.map((a) => a.name).sort()).toEqual(['only-claude', 'shared']);

      const codexOnly = await discoverProjectAgents(projectRoot, 'codex');
      expect(codexOnly.map((a) => a.name).sort()).toEqual(['only-codex', 'shared']);

      const both = await discoverProjectAgents(projectRoot, 'both');
      expect(both.map((a) => a.name).sort()).toEqual(['only-claude', 'only-codex', 'shared']);
      // claude wins on name collision (discovered first)
      expect(both.find((a) => a.name === 'shared')?.description).toBe('claude side');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test('codex user agent flows through to a selectable variant candidate (e2e wiring)', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'ditto-codex-variant-'));
    try {
      const agentsDir = join(projectRoot, '.codex', 'agents');
      await mkdir(agentsDir, { recursive: true });
      await writeFile(
        join(agentsDir, 'appsec-auditor.toml'),
        'name = "appsec-auditor"\ndescription = "audits security vulnerabilities"\n',
      );
      // a ditto-bundled agent that must NOT leak into the catalog
      await writeFile(
        join(agentsDir, 'reviewer.toml'),
        '# Generated from agents/reviewer.md by ditto agent-projection (dual-host plan M4).\nname = "reviewer"\ndescription = "review one node"\n',
      );

      // discover (codex host) → recommend role → register variant
      const discovered = await discoverProjectAgents(projectRoot, 'codex');
      expect(discovered.map((a) => a.name)).toEqual(['appsec-auditor']); // reviewer excluded
      const variants = discovered.map((a) => ({
        name: a.name,
        role: recommendVariantRole(a.name, a.description),
        description: a.description,
        match: [] as string[],
      }));
      const w = await writeAgentVariants(projectRoot, variants);
      expect(w.written).toEqual(['appsec-auditor']);

      // round-trips through the catalog and is selectable for a security-reviewer node
      const catalog = await loadVariantCatalog(projectRoot);
      const candidates = selectVariantCandidates(catalog, 'security-reviewer', ['src/auth.ts']);
      expect(candidates.map((c) => c.name)).toContain('appsec-auditor');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  test('accepts the target project as a positional argument after options', () => {
    const args = parseArgs(
      ['--host', 'codex', '/tmp/ditto-target'],
      (setupCommand.args ?? {}) as Parameters<typeof parseArgs>[1],
    );

    expect(args.host).toBe('codex');
    expect(args.target).toBe('/tmp/ditto-target');
  });
});
