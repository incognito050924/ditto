import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureDir } from './fs';
import { fileExists } from './hosts/shared';

/**
 * Agent variant catalog (variant routing). See docs/agent-variants.md for the
 * user-facing overview. A variant is a specialized subagent
 * profile declared under `.ditto/agents/*.md` frontmatter. DITTO loads the
 * catalog and deterministically filters candidates by the chosen node's owner
 * (role) and file scope; *selecting* among 2+ candidates is the driver's job,
 * not this module's (no LLM/description-based selection in code).
 */
export interface AgentVariant {
  name: string;
  role: string;
  description: string;
  match: string[];
}

/**
 * Load the variant catalog from `.ditto/agents/*.md` frontmatter. A missing
 * `.ditto/agents` directory yields an empty catalog (ac-1, ac-4). Files with no
 * frontmatter or no `name`/`role` are skipped.
 */
export async function loadVariantCatalog(repoRoot: string): Promise<AgentVariant[]> {
  const dir = join(repoRoot, '.ditto', 'agents');
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const catalog: AgentVariant[] = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.md')) continue;
    const text = await Bun.file(join(dir, entry)).text();
    const variant = parseVariant(text);
    if (variant) catalog.push(variant);
  }
  return catalog;
}

/**
 * Deterministic, pure candidate filter. Keep variants whose role equals the
 * chosen owner AND (match is empty OR some file in scope matches some glob).
 * 0 matches → empty array (ac-2).
 *
 * An optional planner `hint` (late binding): if a variant with that name exists
 * in the (already filtered) candidates, it is moved FIRST so the driver sees the
 * suggestion at the head of the list. The hint never selects and never crashes —
 * a hint absent from the catalog is ignored, and selection stays the driver's job.
 */
export function selectVariantCandidates(
  catalog: AgentVariant[],
  owner: string,
  fileScope: string[],
  hint?: string,
): { name: string; description: string }[] {
  const candidates = catalog
    .filter(
      (v) =>
        v.role === owner &&
        (v.match.length === 0 ||
          v.match.some((glob) => fileScope.some((path) => globMatch(glob, path)))),
    )
    .map((v) => ({ name: v.name, description: v.description }));

  if (hint === undefined) return candidates;
  const hinted = candidates.find((c) => c.name === hint);
  if (!hinted) return candidates; // hint not in catalog → ignore
  return [hinted, ...candidates.filter((c) => c.name !== hint)];
}

/**
 * Parse a single variant from a markdown file's leading `---`…`---` frontmatter
 * block. Returns null if there is no frontmatter or no `name`/`role`. Minimal
 * hand-written parser (no YAML dependency): supports `key: value`, a
 * `description: |` multiline block, and `match` as an inline `[a, b]` list or a
 * YAML `- item` list.
 */
function parseVariant(text: string): AgentVariant | null {
  const fm = extractFrontmatter(text);
  if (fm === null) return null;
  const lines = fm.split('\n');

  let name: string | undefined;
  let role: string | undefined;
  let description = '';
  let match: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    const rest = (m[2] ?? '').trim();

    if (key === 'name') name = stripQuotes(rest);
    else if (key === 'role') role = stripQuotes(rest);
    else if (key === 'description') {
      if (rest === '|' || rest === '>') {
        // Multiline block: gather subsequent more-indented lines.
        const block: string[] = [];
        const baseIndent = indentOf(lines[i + 1] ?? '');
        while (i + 1 < lines.length) {
          const next = lines[i + 1] ?? '';
          if (next.trim() === '') {
            block.push('');
            i++;
            continue;
          }
          if (indentOf(next) < baseIndent) break;
          block.push(next.slice(baseIndent));
          i++;
        }
        description = block.join('\n').trim();
      } else {
        description = stripQuotes(rest);
      }
    } else if (key === 'match') {
      if (rest.startsWith('[')) {
        match = parseInlineList(rest);
      } else if (rest === '') {
        // YAML block list: gather subsequent `- item` lines.
        const items: string[] = [];
        while (i + 1 < lines.length) {
          const next = lines[i + 1] ?? '';
          const im = /^\s*-\s+(.*)$/.exec(next);
          if (!im) break;
          items.push(stripQuotes((im[1] ?? '').trim()));
          i++;
        }
        match = items;
      } else {
        match = [stripQuotes(rest)];
      }
    }
  }

  if (!name || !role) return null;
  return { name, role, description, match };
}

/**
 * Pure heuristic mapping a discovered agent's name+description to a recommended
 * ditto owner role by keyword (case-insensitive), in priority order. Used by
 * `ditto setup` to suggest a role when linking a project's `.claude/agents`.
 * Selection/override stays the user's job; this only *recommends* (ac-1).
 */
export function recommendVariantRole(name: string, description: string): string {
  const text = `${name} ${description}`.toLowerCase();
  if (/security|appsec|vuln/.test(text)) return 'security-reviewer';
  if (/review|audit/.test(text)) return 'reviewer';
  if (/architect|architecture|design/.test(text)) return 'architect';
  if (/research|investigate/.test(text)) return 'researcher';
  if (/test|qa/.test(text)) return 'verifier';
  if (/refactor|tidy/.test(text)) return 'refactorer';
  return 'implementer';
}

/**
 * Idempotent variant writer. Writes each `AgentVariant` to
 * `.ditto/agents/<name>.md` in the same frontmatter format `parseVariant`
 * reads. An already-existing target is SKIPPED (never overwritten) so user
 * hand-edits survive re-runs (ac-4). Returns the names written vs skipped.
 */
export async function writeAgentVariants(
  repoRoot: string,
  variants: AgentVariant[],
): Promise<{ written: string[]; skipped: string[] }> {
  const dir = join(repoRoot, '.ditto', 'agents');
  const written: string[] = [];
  const skipped: string[] = [];
  for (const variant of variants) {
    const file = join(dir, `${variant.name}.md`);
    if (await fileExists(file)) {
      skipped.push(variant.name);
      continue;
    }
    await ensureDir(dir);
    await Bun.write(file, renderVariant(variant));
    written.push(variant.name);
  }
  return { written, skipped };
}

function renderVariant(variant: AgentVariant): string {
  const lines = ['---', `name: ${variant.name}`, `role: ${variant.role}`];
  if (variant.match.length > 0) lines.push(`match: [${variant.match.join(', ')}]`);
  // description as a `|` block so multiline text round-trips through parseVariant.
  lines.push('description: |');
  for (const line of variant.description.split('\n')) lines.push(`  ${line}`);
  lines.push('---', '');
  return lines.join('\n');
}

function extractFrontmatter(text: string): string | null {
  const lines = text.split('\n');
  if ((lines[0] ?? '').trim() !== '---') return null;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trim() === '---') {
      return lines.slice(1, i).join('\n');
    }
  }
  return null;
}

function indentOf(line: string): number {
  const m = /^(\s*)/.exec(line);
  return (m?.[1] ?? '').length;
}

function stripQuotes(s: string): string {
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

function parseInlineList(s: string): string[] {
  const inner = s.replace(/^\[/, '').replace(/\]$/, '').trim();
  if (inner === '') return [];
  return inner
    .split(',')
    .map((part) => stripQuotes(part.trim()))
    .filter((part) => part.length > 0);
}

/**
 * Tiny anchored glob matcher supporting `*` (within a path segment) and `**`
 * (across segments). Converts the glob to an anchored RegExp; no external lib.
 */
function globMatch(glob: string, path: string): boolean {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else if ('.+?^${}()|[]\\/'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`).test(path);
}
