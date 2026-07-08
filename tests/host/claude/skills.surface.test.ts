// Claude Code host surface: slash skills (N2-claude-surface-coverage, wi_260613f9d).
//
// Asserts every user-facing skill exists with a valid Claude-skill frontmatter
// (name/description) and ships in the plugin build. Thin host-contract layer over
// the existing surface-inventory catalog (tests/core/surface-inventory.plugin.test.ts):
// that test pins the COUNT (drift); this one pins each skill's frontmatter SHAPE
// — what Claude Code actually parses to register the slash command.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const REPO = join(import.meta.dir, '..', '..', '..');

// The 11 user-facing skills (task surface (a)). Pinned so a deleted/renamed skill fails.
const SKILLS = [
  'autopilot',
  'deep-interview',
  'dialectic',
  'dialectic-review',
  'e2e',
  'e2e-author',
  'handoff',
  'knowledge-update',
  'memory-graph',
  'prism',
  'verify',
] as const;

function frontmatter(text: string): Record<string, unknown> {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) throw new Error('no YAML frontmatter');
  return parseYaml(m[1]) as Record<string, unknown>;
}

describe('Claude host surface — skills', () => {
  test('all 11 user-facing skills are pinned (no silent add/remove)', () => {
    expect(SKILLS.length).toBe(11);
  });

  test.each(SKILLS)('skills/%s/SKILL.md exists with a valid frontmatter', (name) => {
    const path = join(REPO, 'skills', name, 'SKILL.md');
    expect(existsSync(path)).toBe(true);
    const fm = frontmatter(readFileSync(path, 'utf8'));
    // Claude Code registers a skill by its frontmatter name + description.
    expect(fm.name).toBe(name);
    expect(typeof fm.description).toBe('string');
    expect((fm.description as string).length).toBeGreaterThan(0);
  });

  test('skills/ is a product-surface dir that the plugin build ships', () => {
    // dist/plugin is a build artifact (gitignored), so assert the assembler
    // copies skills/ wholesale rather than rebuilding here. build-plugin.mjs
    // lists skills in ALWAYS_DIRS and copies the dir verbatim, so every
    // source skill above ships unchanged.
    const assembler = readFileSync(join(REPO, 'scripts', 'build-plugin.mjs'), 'utf8');
    expect(assembler).toMatch(/ALWAYS_DIRS\s*=\s*\[[^\]]*'skills'/);
  });
});
