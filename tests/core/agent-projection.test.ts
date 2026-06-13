import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { projectAgent, projectAgents } from '~/core/agent-projection';

const REPO_ROOT = join(import.meta.dir, '..', '..');

// Frontmatter `tools` for the real agent set (dual-host plan M4). Read-only =
// no Edit/Write/MultiEdit → sandbox_mode="read-only"; mutating → "workspace-write".
const READ_ONLY = [
  'reviewer',
  'researcher',
  'verifier',
  'security-reviewer',
  'planner',
  'dialectic-opponent',
  'dialectic-producer',
  'dialectic-synthesizer',
  'memory-extractor',
  'playwright-e2e',
  'retrospective',
];
const MUTATING = ['implementer', 'refactorer', 'e2e-scripter', 'knowledge-curator'];

describe('agent-projection: agents/*.md → Codex custom-agent TOML (M4)', () => {
  test('projects a read-only agent with the 3 Codex required fields', () => {
    const md = [
      '---',
      'name: reviewer',
      'description: Review the change; read-only.',
      'tools: Read, Grep, Glob, Bash',
      '---',
      '',
      '# Reviewer',
      '',
      'body',
      '',
    ].join('\n');
    const p = projectAgent(md);
    expect(p.name).toBe('reviewer');
    expect(p.description).toBe('Review the change; read-only.');
    expect(p.sandboxMode).toBe('read-only');
    const parsed = parseToml(p.toml) as Record<string, unknown>;
    expect(parsed.name).toBe('reviewer');
    expect(parsed.description).toBe('Review the change; read-only.');
    expect(parsed.sandbox_mode).toBe('read-only');
    expect(typeof parsed.developer_instructions).toBe('string');
    expect(parsed.developer_instructions).toContain('# Reviewer');
  });

  test('G1: mutating tools → sandbox_mode="workspace-write"', () => {
    const md = [
      '---',
      'name: implementer',
      'description: Make the change.',
      'tools: Read, Grep, Glob, Edit, Write, Bash',
      '---',
      '',
      'body',
    ].join('\n');
    expect(projectAgent(md).sandboxMode).toBe('workspace-write');
  });

  test('rewrites ${CLAUDE_PLUGIN_ROOT}/bin/ditto to the stable PATH command', () => {
    const md = [
      '---',
      'name: x',
      'description: d',
      'tools: Read',
      '---',
      '',
      'run `"${CLAUDE_PLUGIN_ROOT}/bin/ditto" memory query n`',
    ].join('\n');
    const p = projectAgent(md);
    expect(p.toml).not.toContain('CLAUDE_PLUGIN_ROOT');
    expect(p.developerInstructions).toContain('run `ditto memory query n`');
  });

  test('TOML comment header marks per-tool fidelity as unverified/unsupported', () => {
    const md = ['---', 'name: x', 'description: d', 'tools: Read, Bash', '---', '', 'b'].join('\n');
    const p = projectAgent(md);
    expect(p.toml).toContain('UNVERIFIED/UNSUPPORTED');
    expect(p.toml).toContain('Read, Bash');
  });

  test('a body containing a literal """ still round-trips through the TOML parser', () => {
    const md = ['---', 'name: x', 'description: d', 'tools: Read', '---', '', 'a """ b'].join('\n');
    const p = projectAgent(md);
    const parsed = parseToml(p.toml) as Record<string, unknown>;
    expect(parsed.developer_instructions).toContain('a """ b');
  });

  test('every real agent projects to valid TOML with all required fields', async () => {
    const projections = await projectAgents(REPO_ROOT);
    expect(projections.length).toBe(READ_ONLY.length + MUTATING.length); // 15
    for (const p of projections) {
      const parsed = parseToml(p.toml) as Record<string, unknown>;
      expect(typeof parsed.name).toBe('string');
      expect(typeof parsed.description).toBe('string');
      expect(typeof parsed.developer_instructions).toBe('string');
      expect(['read-only', 'workspace-write']).toContain(parsed.sandbox_mode as string);
      expect(p.toml).not.toContain('CLAUDE_PLUGIN_ROOT');
    }
  });

  test('G1 security contract: read-only/mutating agents map to the right sandbox_mode', async () => {
    const byName = new Map((await projectAgents(REPO_ROOT)).map((p) => [p.name, p.sandboxMode]));
    for (const name of READ_ONLY) expect(byName.get(name)).toBe('read-only');
    for (const name of MUTATING) expect(byName.get(name)).toBe('workspace-write');
  });

  test('core agents reviewer/planner/verifier are generated', async () => {
    const names = new Set((await projectAgents(REPO_ROOT)).map((p) => p.name));
    expect(names.has('reviewer')).toBe(true);
    expect(names.has('planner')).toBe(true);
    expect(names.has('verifier')).toBe(true);
  });
});
