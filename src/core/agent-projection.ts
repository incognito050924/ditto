import { join } from 'node:path';
import { listFiles, readTextIfExists } from './hosts/shared';

/**
 * Project Claude Code agents (`agents/*.md`, Markdown + YAML frontmatter) into
 * Codex custom agents (`.codex/agents/<name>.toml`). Dual-host plan M4
 * (reports/design/dual-host-surface-adapter-plan.md §M4).
 *
 * Codex custom agents require three fields: `name`, `description`,
 * `developer_instructions` (https://developers.openai.com/codex/subagents).
 * We map frontmatter name/description verbatim and the Markdown body into
 * developer_instructions.
 *
 * Tool restriction (dialectic G1, plan obj 3): Codex custom agents have no
 * per-tool allowlist — only `sandbox_mode`/`mcp_servers`. A read-only agent
 * (frontmatter `tools` carries no Edit/Write/MultiEdit) maps to
 * `sandbox_mode = "read-only"` so "no file mutation" is actually enforced, not
 * left as an advisory comment that the agent could ignore. A mutating agent
 * maps to `workspace-write`. This mapping is non-negotiable: an advisory comment
 * would let a Codex read-only agent write files and break the verification
 * contract.
 *
 * `sandbox_mode = "read-only"` is NOT a faithful per-tool mapping — Bash itself
 * still runs and a runtime override can replace the agent default — so per-tool
 * allowlist fidelity is emitted as `unverified`/unsupported in the generated
 * TOML comment header.
 */

const MUTATING_TOOLS = ['Edit', 'Write', 'MultiEdit'];

export type SandboxMode = 'read-only' | 'workspace-write';

export interface AgentProjection {
  /** frontmatter name → Codex agent name and `<name>.toml` filename. */
  name: string;
  description: string;
  /** Markdown body → Codex developer_instructions. */
  developerInstructions: string;
  /** read-only role → "read-only"; mutating role → "workspace-write". */
  sandboxMode: SandboxMode;
  /** frontmatter tools, parsed (for the unverified-fidelity comment). */
  tools: string[];
  /** TOML file contents. */
  toml: string;
}

interface Frontmatter {
  name?: string;
  description?: string;
  tools: string[];
}

/**
 * Split `---\n<yaml>\n---\n\n<body>` into frontmatter text and Markdown body.
 * Throws when the leading fence is missing — every agent file carries one.
 */
function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  if (!text.startsWith('---\n')) {
    throw new Error('agent file: missing leading frontmatter fence');
  }
  const rest = text.slice(4);
  const end = rest.indexOf('\n---');
  if (end === -1) throw new Error('agent file: unterminated frontmatter');
  const frontmatter = rest.slice(0, end);
  // After the closing fence skip the trailing newline(s) before the body.
  const body = rest.slice(end + '\n---'.length).replace(/^\n+/, '');
  return { frontmatter, body };
}

/**
 * Parse the flat scalar frontmatter the agent files use: `key: value` lines and
 * a comma-separated `tools:` list. This is not a general YAML parser — the agent
 * frontmatter is intentionally flat (name/description/tools).
 */
function parseFrontmatter(text: string): Frontmatter {
  const out: Frontmatter = { tools: [] };
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, value] = m;
    if (key === 'name') out.name = value.trim();
    else if (key === 'description') out.description = value.trim();
    else if (key === 'tools') {
      out.tools = value
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean);
    }
  }
  return out;
}

function isReadOnly(tools: string[]): boolean {
  return !tools.some((t) => MUTATING_TOOLS.includes(t));
}

/**
 * Rewrite `${CLAUDE_PLUGIN_ROOT}/bin/ditto` to a neutral command token in the
 * build artifact. Codex injects CLAUDE_PLUGIN_ROOT into plugin *hook* commands,
 * but there is no guarantee it is present when a custom-agent instruction body
 * runs. `setup --host codex` later rewrites this token in the installed target
 * to that target's absolute `.agents/plugins/ditto/bin/ditto` path, avoiding the
 * macOS `/usr/bin/ditto` collision in the final surface.
 */
function rewritePluginRoot(body: string): string {
  return body.replace(/"\$\{CLAUDE_PLUGIN_ROOT\}\/bin\/ditto"/g, 'ditto');
}

/** Escape a TOML basic-string value (used for name/description). */
function tomlBasicString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Render a TOML multiline basic string (`"""..."""`). A multiline string cannot
 * contain a literal `"""`; escape any such run so the value round-trips.
 */
function tomlMultilineString(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
  // Leading newline after the opening delimiter is trimmed by TOML, so add one
  // to keep the body starting on its own line.
  return `"""\n${escaped}"""`;
}

function renderToml(p: Omit<AgentProjection, 'toml'>): string {
  const fidelity = `# Generated from agents/${p.name}.md by ditto agent-projection (dual-host plan M4).\n# tools (Claude per-tool allowlist): ${p.tools.join(', ') || '(none)'}\n# UNVERIFIED/UNSUPPORTED: Codex custom agents have no per-tool allowlist; the\n# Claude 'tools' list is mapped only to sandbox_mode below. sandbox_mode=\n# "read-only" blocks file writes but Bash still runs and a runtime override\n# can replace this default, so per-tool fidelity is not preserved.\n`;
  return `${fidelity}name = ${tomlBasicString(p.name)}\ndescription = ${tomlBasicString(p.description)}\nsandbox_mode = ${tomlBasicString(p.sandboxMode)}\ndeveloper_instructions = ${tomlMultilineString(p.developerInstructions)}\n`;
}

/** Project one agent Markdown file's text into a Codex custom agent TOML. */
export function projectAgent(markdown: string): AgentProjection {
  const { frontmatter, body } = splitFrontmatter(markdown);
  const fm = parseFrontmatter(frontmatter);
  if (!fm.name) throw new Error('agent file: missing frontmatter name');
  if (!fm.description) throw new Error('agent file: missing frontmatter description');
  const developerInstructions = `${rewritePluginRoot(body).trimEnd()}\n`;
  const sandboxMode: SandboxMode = isReadOnly(fm.tools) ? 'read-only' : 'workspace-write';
  const partial = {
    name: fm.name,
    description: fm.description,
    developerInstructions,
    sandboxMode,
    tools: fm.tools,
  };
  return { ...partial, toml: renderToml(partial) };
}

/** Project every `agents/*.md` under `repoRoot` into Codex custom agent TOMLs. */
export async function projectAgents(repoRoot: string): Promise<AgentProjection[]> {
  const out: AgentProjection[] = [];
  for (const file of await listFiles(join(repoRoot, 'agents'))) {
    if (!file.id.endsWith('.md')) continue;
    const text = await readTextIfExists(file.path);
    if (text === null) continue;
    out.push(projectAgent(text));
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
