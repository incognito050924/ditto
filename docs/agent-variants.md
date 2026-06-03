# Agent Variants — project-specialized subagent routing

DITTO's autopilot runs each node through a fixed **role** (the node `owner`):
`researcher`, `planner`, `implementer`, `reviewer`, `verifier`, `architect`,
`playwright-e2e`, `knowledge-curator`, `security-reviewer`, `refactorer`,
`retrospective`. One `implementer` handles every implement node — frontend,
backend, infra, all the same prompt.

A **variant** lets a project specialize a role without changing that fixed set.
You drop a subagent definition under `.ditto/agents/`, and dispatch offers it as a
routing *candidate* for the matching role. The final pick is **late-bound**: the
engine narrows candidates deterministically (by role + file scope), and the
driver (main agent) chooses among them by reading their descriptions. No
LLM/description matching happens in code — selection is the driver's judgment.

If `.ditto/agents/` does not exist, the catalog is empty and autopilot behaves
exactly as before (the node `owner` runs). Variants are purely additive.

## Where to put them

One markdown file per variant under `.ditto/agents/`:

```
.ditto/agents/
  frontend-implementer.md
  backend-implementer.md
  ...
```

Each file is a standard Claude Code subagent definition — YAML frontmatter plus a
body that *is* the subagent's system prompt. The body is whatever specialized
instructions that agent needs; DITTO only reads the frontmatter for routing.

```markdown
---
name: frontend-implementer
role: implementer
match:
  - "src/web/**"
  - "*.tsx"
description: |
  Implements UI in this repo's frontend stack (React 19 + react-hook-form +
  Tailwind). Use when changing components under src/web. NOT for backend/API
  code, BPMN, or test-only changes.
---

You implement frontend changes for <project>. Conventions:
- forms use react-hook-form + zod
- styling is Tailwind
- ...
```

## Frontmatter fields

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | The `subagent_type` spawned when this variant is chosen. Must be unique. A file with no `name` (or no `role`) is skipped. |
| `role` | yes | Which fixed role this variant specializes — one of the owner values above. A variant is only ever a candidate for a node whose `owner` equals this `role`. |
| `description` | recommended | What the driver reads to pick among 2+ candidates. Write it as a trigger + boundary: *"Use when … / NOT for …"*. Routing quality is only as good as this text. |
| `match` | optional | A list of globs. The variant is a candidate only if some path in the node's file scope matches some glob. Empty/absent `match` ⇒ the variant is a candidate for every node of that role (scope-independent). |

`match` globs support `*` (within a path segment) and `**` (across segments), and
are anchored to the whole path. `description` accepts a single line, a quoted
string, or a `|` block; `match` accepts an inline `[a, b]` list or a YAML `- item`
list.

## How routing works

When autopilot is about to spawn a node:

1. It resolves the node's fixed `owner` (role) as usual.
2. It loads the catalog from `.ditto/agents/*.md`.
3. It filters candidates: keep variants where `role === owner` **and**
   (`match` is empty **or** some path in the node's file scope matches a glob).
4. The surviving candidates are attached to the delegation packet as
   `variant_candidates` (a list of `{name, description}`).
5. The driver picks the `subagent_type` to spawn:
   - **2+ candidates** → choose the best fit by reading each `description`;
   - **exactly 1** → use it;
   - **0** → fall back to the node `owner` (the default agent).

The node's **file scope** is `node.file_scope` when the node declares one (the
planner can set it), otherwise the work item's `changed_files`. So a variant with
a `match` only routes once the relevant files are in scope — if the scope is
empty and a variant declares a `match`, that variant is not yet a candidate.

## Letting the planner suggest a variant (optional)

The planner may add an optional `agent_hint` to a generated node naming a
variant. If that name is present among the filtered candidates, it is moved to the
**front** of `variant_candidates` so the driver sees the suggestion first. The
hint never auto-selects and never errors — an unknown hint is ignored, and the
final choice still belongs to the driver. Use it when the planner can tell from
the task which specialization fits; otherwise leave it off and let file-scope +
description routing decide.

## Writing a good `description`

Routing is the driver reading descriptions, so make them discriminating:

- State the **trigger** (when this variant applies) and the **boundary**
  (`NOT for …`) so two variants of the same role don't blur together.
- Name the concrete stack/area, not adjectives. `"React 19 + react-hook-form
  under src/web"` routes; `"good at frontend"` does not.
- If two variants of one role have overlapping `match`, their descriptions are
  the only thing separating them — make the boundary explicit.

## Example: splitting `implementer`

```markdown
---
name: backend-implementer
role: implementer
match: ["src/api/**", "src/server/**"]
description: |
  Implements backend/service code (HTTP handlers, persistence, domain logic).
  Use for changes under src/api or src/server. NOT for UI/components or BPMN.
---
You implement backend changes for <project>. ...
```

With `frontend-implementer` and `backend-implementer` both present, a node whose
file scope is `src/web/checkout/Form.tsx` yields only `frontend-implementer` as a
candidate; a node scoped to `src/api/orders.ts` yields only `backend-implementer`.
Because their file scopes are disjoint, autopilot can also dispatch the two as a
parallel wave (see the file-overlap gate).

## When a variant does *not* route

- `.ditto/agents/` missing or empty → no candidates → the node `owner` runs.
- `role` does not equal the node's owner → never a candidate.
- `match` is set but no path in the node's file scope matches → not a candidate.
- File with no frontmatter, or missing `name`/`role` → skipped (not loaded).
