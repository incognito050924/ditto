// Claude Code host surface: subagent definitions (N2-claude-surface-coverage, wi_260613f9d).
//
// Asserts the 18 agents/*.md exist and carry the frontmatter Claude Code parses
// to register a subagent (name/description/tools), and that agents/ ships in the
// plugin build. Companion to skills.surface.test.ts; the catalog test pins the
// count, this pins each agent's frontmatter shape.
import { describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const REPO = join(import.meta.dir, '..', '..', '..');
const AGENTS_DIR = join(REPO, 'agents');

// The 18 product agents (task surface (e)). Pinned so a deleted/renamed agent fails.
const AGENTS = [
  'dialectic-opponent',
  'dialectic-producer',
  'dialectic-synthesizer',
  'e2e-scripter',
  'implementer',
  'knowledge-curator',
  'memory-extractor',
  'planner',
  'playwright-e2e',
  'question-gate',
  'question-generator',
  'refactorer',
  'relevance-judge',
  'researcher',
  'retrospective',
  'reviewer',
  'security-reviewer',
  'verifier',
] as const;

function frontmatter(text: string): Record<string, unknown> {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error('no YAML frontmatter');
  return parseYaml(m[1]) as Record<string, unknown>;
}

describe('Claude host surface — agents', () => {
  test('exactly the 18 pinned agent markdown files exist on disk (no drift)', () => {
    const onDisk = readdirSync(AGENTS_DIR)
      .filter((f) => f.endsWith('.md'))
      .map((f) => f.replace(/\.md$/, ''))
      .sort();
    expect(onDisk).toEqual([...AGENTS].sort());
  });

  test.each(AGENTS)('agents/%s.md has name/description/tools frontmatter', (name) => {
    const fm = frontmatter(readFileSync(join(AGENTS_DIR, `${name}.md`), 'utf8'));
    expect(fm.name).toBe(name);
    expect(typeof fm.description).toBe('string');
    expect((fm.description as string).length).toBeGreaterThan(0);
    // tools is the allow-list Claude Code grants the subagent; must be a
    // non-empty CSV string (the repo convention, e.g. "Read, Grep, Edit").
    expect(typeof fm.tools).toBe('string');
    expect((fm.tools as string).trim().length).toBeGreaterThan(0);
  });

  test('agents/ is a product-surface dir that the plugin build ships', () => {
    const assembler = readFileSync(join(REPO, 'scripts', 'build-plugin.mjs'), 'utf8');
    expect(assembler).toMatch(/ALWAYS_DIRS\s*=\s*\[[^\]]*'agents'/);
  });

  // wi_260620njg — agents must write runtime output under the canonical tier-③
  // path `.ditto/local/work-items/` (ADR-0012), never the legacy pre-isolation
  // `.ditto/work-items/` which is NOT gitignored and pollutes the tracked tree.
  test.each(AGENTS)('agents/%s.md never instructs the legacy non-local work-items path', (name) => {
    const text = readFileSync(join(AGENTS_DIR, `${name}.md`), 'utf8');
    // Strip the canonical path, then any remaining `.ditto/work-items/` is the legacy leak.
    const residual = text.split('.ditto/local/work-items/').join('');
    expect(residual).not.toContain('.ditto/work-items/');
  });
});
