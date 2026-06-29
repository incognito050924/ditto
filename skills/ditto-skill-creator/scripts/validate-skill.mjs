#!/usr/bin/env node
// Contract test for a ditto-authored SKILL.md. Pure Node ESM — no deps; runs
// under `node` or `bun`. Encodes the Anthropic Agent Skills frontmatter rules
// (name/description validation, third-person + trigger guidance) so a generated
// skill is checked against the same bar the official docs state, before it ships.
//
// Rules are split: structural violations are ERRORS (block ok); stylistic /
// best-practice deviations are WARNINGS (surfaced, do not block). This mirrors
// the docs — "under 500 lines" / third-person are guidance, the field limits are
// hard validation.

import { readFileSync } from 'node:fs';

const RESERVED = ['anthropic', 'claude'];

/** Parse the leading `---`-delimited YAML-ish frontmatter. Returns null if absent. */
function splitFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return { fm, body: m[2] };
}

/**
 * @param {string} text full SKILL.md content
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validateSkill(text) {
  const errors = [];
  const warnings = [];
  const parsed = splitFrontmatter(text);

  if (!parsed) {
    return {
      ok: false,
      errors: ['missing YAML frontmatter (--- delimited block at top)'],
      warnings,
    };
  }
  const { fm, body } = parsed;

  // name
  const name = fm.name;
  if (!name) {
    errors.push('frontmatter missing required field: name');
  } else {
    if (name.length > 64) errors.push(`name exceeds 64 chars (${name.length})`);
    if (!/^[a-z0-9-]+$/.test(name))
      errors.push('name has bad charset — only lowercase letters, digits, hyphens allowed');
    for (const w of RESERVED)
      if (name.toLowerCase().includes(w)) errors.push(`name contains reserved word "${w}"`);
  }

  // description
  const desc = fm.description;
  if (!desc) {
    errors.push('frontmatter missing required field: description');
  } else {
    if (desc.length > 1024) errors.push(`description exceeds 1024 chars (${desc.length})`);
    if (/^\s*(I |I'|You |You'|We )/.test(desc) || /\b(I can|you can|we can)\b/i.test(desc))
      warnings.push('description should be written in third person (avoid "I"/"You"/"We")');
    if (!/\b(use when|use for|use this|when the user|when working)\b/i.test(desc))
      warnings.push(
        'description has no explicit "when to use" trigger phrase — triggering may be unreliable',
      );
  }

  // body size — guidance, not a hard limit
  const bodyLines = body.split(/\r?\n/).length;
  if (bodyLines > 500)
    warnings.push(`SKILL.md body is ${bodyLines} lines — keep under ~500; split into references/`);

  return { ok: errors.length === 0, errors, warnings };
}

// CLI: validate-skill.mjs <path-to-SKILL.md>
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: validate-skill.mjs <path-to-SKILL.md>');
    process.exit(2);
  }
  const r = validateSkill(readFileSync(path, 'utf8'));
  for (const w of r.warnings) console.warn(`  warn: ${w}`);
  for (const e of r.errors) console.error(`  ERROR: ${e}`);
  console.log(r.ok ? `OK ${path}` : `FAIL ${path} (${r.errors.length} error(s))`);
  process.exit(r.ok ? 0 : 1);
}
