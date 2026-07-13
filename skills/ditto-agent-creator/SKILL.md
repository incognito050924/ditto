---
name: ditto-agent-creator
description: Author a new ditto autopilot owner subagent (agents/<name>.md) that follows the shared ditto owner-subagent convention — 6-section delegation packet, Context Isolation, owner-return envelope, the four decisive classes, a Contract section, and least-privilege tools. Use when the user wants to add, scaffold, or improve a ditto subagent/owner, create a new autopilot worker role (implementer/researcher/reviewer-style), or asks how ditto agents are structured. Validates the draft against the convention with a contract test and rebuilds both host plugins.
---

# ditto agent creator

Author a new **autopilot owner subagent** for this repo. ditto's core role is orchestration, so its agents are not generic subagents — they share one strict convention so autopilot can delegate to any of them and collect evidence uniformly. This skill encodes that convention (and proves it with a contract test) so a new agent is consistent with `implementer`/`researcher`/`reviewer`/`verifier` out of the box.

Author for **predictability** — the same process every run. An agent body is a prompt-context artifact like a skill, so the shared craft in `references/writing-great-artifacts.md` governs it too (leading words, completion criteria, pruning, prompt-the-positive); `references/ditto-agent-conventions.md` maps that craft onto the agent surface. When a habit here and the craft pull against each other, the craft wins — except for the functional contract below, which is not style.

## When to create a subagent

Create one for a **repeated, self-contained worker** whose verbose work should stay out of the main context and return only a summary — autopilot's owner pattern. For a quick local change, work that needs frequent back-and-forth, or several phases sharing one context, stay in the main conversation; for reusable knowledge/workflow, make a skill with `ditto-skill-creator`.

## Procedure

1. **Capture intent** — done when you can name the owner's single responsibility, whether it is read-only or mutating, and the acceptance-criterion oracle it serves.
2. **Pick least-privilege tools** from the role → tools table below.
3. **Draft** `agents/<name>.md` from `references/owner-subagent-template.md`, keeping the convention markers intact.
4. **Validate** — done when the contract test reports OK:
   ```bash
   node skills/ditto-agent-creator/scripts/validate-agent.mjs agents/<name>.md
   ```
5. **Rebuild both hosts** — done when both builds exit 0: `bun run build:plugin && bun run build:codex-plugin`. `agents/` is the source of truth, copied verbatim into both host plugins (dual-host, ADR-0016).

## The owner-subagent convention (functional contract — the test enforces it)

Autopilot depends on these, so keep every one:

- **Delegation packet** — the agent works only from a 6-section packet (TASK · EXPECTED OUTCOME · REQUIRED TOOLS · MUST DO · MUST NOT DO · CONTEXT, incl. `file_scope`/`done_when`).
- **Context Isolation** — it never sees the driver's hypotheses, other nodes' results, or the plan; state this so it doesn't invent shared context.
- **owner-return envelope** — it returns the structured envelope (`src/schemas/owner-return-envelope.ts`): `summary` is the only slot the orchestrator loads, so the four decisive classes (intent · decisions · irreversible-risks · uncertainty) must survive in `summary` (flagged) + `verbatim_detail` (full). Field detail lives in `references/ditto-agent-conventions.md`.
- **Contract section** — a short closing list restating read-only vs mutating, the minimum-viable change, and the evidence to return.

## Role → least-privilege tools

| Role kind | Typical tools | Mutates? |
|---|---|---|
| research / review / verify / judge | `Read, Grep, Glob` (+ `Bash` for evidence, +`WebSearch, WebFetch` for research) | No — lists no `Edit`/`Write` |
| implement / refactor (owner) | `Read, Grep, Glob, Edit, Write, Bash` | Yes — the only owners that mutate |

Grant exactly the tools the job needs: a read-only role listing `Edit`/`Write`, or an omitted `tools` line (which inherits everything), fails the contract test.

See `references/owner-subagent-template.md` for the fill-in template and `references/ditto-agent-conventions.md` for the craft mapping, rationale, and sources.
