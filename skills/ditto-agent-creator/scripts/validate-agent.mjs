#!/usr/bin/env node
// Contract test for a ditto autopilot owner-subagent definition (agents/<name>.md).
// Pure Node ESM — no deps; runs under `node` or `bun`. This is the value that a
// ditto-specific agent creator adds over the generic skill-creator: it enforces
// the *ditto* owner-subagent convention shared by every agent in agents/, so a
// generated agent is consistent with implementer/researcher/reviewer and plugs
// into autopilot's delegation + owner-return envelope contract.
//
// Convention enforced (errors block ok):
//   - frontmatter: name (lowercase-hyphen), description, tools (EXPLICIT — never
//     inherit-all, for least privilege)
//   - body markers: Context Isolation note · owner-return envelope · ## Contract
//   - least privilege: a read-only agent (description says "read-only") must NOT
//     grant Edit or Write
// Stylistic gaps (4 decisive classes, 6-section packet) are warnings.

import { readFileSync } from 'node:fs';

const RESERVED = ['anthropic', 'claude'];
const MUTATING_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

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
 * @param {string} text full agents/<name>.md content
 * @returns {{ok: boolean, errors: string[], warnings: string[]}}
 */
export function validateAgent(text) {
  const errors = [];
  const warnings = [];
  const parsed = splitFrontmatter(text);
  if (!parsed)
    return { ok: false, errors: ['missing YAML frontmatter (--- delimited block)'], warnings };
  const { fm, body } = parsed;

  // name
  if (!fm.name) errors.push('frontmatter missing required field: name');
  else {
    if (!/^[a-z0-9-]+$/.test(fm.name))
      errors.push('name has bad charset — only lowercase letters, digits, hyphens allowed');
    for (const w of RESERVED)
      if (fm.name.toLowerCase().includes(w)) errors.push(`name contains reserved word "${w}"`);
  }

  // description
  if (!fm.description) errors.push('frontmatter missing required field: description');

  // tools must be explicit (omitting inherits ALL — violates least privilege)
  const toolsRaw = fm.tools;
  if (!toolsRaw)
    errors.push(
      'frontmatter missing required field: tools — omitting inherits ALL tools (least-privilege violation)',
    );
  const tools = (toolsRaw ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  // ditto owner-subagent body markers
  if (!/context isolation/i.test(body))
    errors.push(
      'body missing the Context Isolation note (owner subagents do not see driver/other-node state)',
    );
  if (!/owner-return envelope/i.test(body))
    errors.push('body missing the owner-return envelope contract (summary/verbatim_detail/...)');
  if (!/^##\s+contract\b/im.test(body) && !/\bContract\b/.test(body))
    errors.push('body missing a Contract section');

  // least privilege: read-only agents must not mutate
  const isReadOnly = /read-only/i.test(fm.description ?? '');
  if (isReadOnly) {
    const granted = tools.filter((t) => MUTATING_TOOLS.includes(t));
    if (granted.length)
      errors.push(
        `read-only agent grants mutating tool(s) ${granted.join(', ')} (Edit/Write) — least-privilege violation`,
      );
  }

  // warnings — convention completeness
  if (!/decisive class/i.test(body))
    warnings.push(
      'body does not mention the four decisive classes (intent·decisions·irreversible-risks·uncertainty)',
    );
  if (!/packet/i.test(body))
    warnings.push('body does not mention the delegation packet (TASK·EXPECTED OUTCOME·…·CONTEXT)');

  return { ok: errors.length === 0, errors, warnings };
}

// CLI: validate-agent.mjs <path-to-agent.md>
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) {
    console.error('usage: validate-agent.mjs <path-to-agent.md>');
    process.exit(2);
  }
  const r = validateAgent(readFileSync(path, 'utf8'));
  for (const w of r.warnings) console.warn(`  warn: ${w}`);
  for (const e of r.errors) console.error(`  ERROR: ${e}`);
  console.log(r.ok ? `OK ${path}` : `FAIL ${path} (${r.errors.length} error(s))`);
  process.exit(r.ok ? 0 : 1);
}
