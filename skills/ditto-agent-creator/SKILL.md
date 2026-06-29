---
name: ditto-agent-creator
description: Author a new ditto autopilot owner subagent (agents/<name>.md) that follows the shared ditto owner-subagent convention — 6-section delegation packet, Context Isolation, owner-return envelope, the four decisive classes, a Contract section, and least-privilege tools. Use when the user wants to add, scaffold, or improve a ditto subagent/owner, create a new autopilot worker role (implementer/researcher/reviewer-style), or asks how ditto agents are structured. Validates the draft against the convention with a contract test and rebuilds both host plugins.
---

# ditto agent creator

Create a new **autopilot owner subagent** for this repo. ditto's core role is agent orchestration, so its agents are not generic Claude Code subagents — they all share one strict convention so autopilot can delegate to any of them and collect evidence uniformly. This skill encodes that convention so a generated agent is consistent with `implementer`/`researcher`/`reviewer`/`verifier` out of the box, and proves it with a contract test.

## When to create a subagent (and when NOT to)

Create one when there is a **repeated, self-contained worker** whose verbose work should stay out of the main context and return only a summary — exactly autopilot's owner pattern. Do **not** create one for: a quick local change, work that needs frequent back-and-forth, or several phases sharing one big context (those belong in the main conversation). If the need is reusable *knowledge/workflow* rather than an isolated worker, make a skill with `ditto-skill-creator` instead. Don't pre-build shallow single-use agents.

## Procedure

1. **Capture intent.** What single responsibility does this owner have? Is it read-only (research/review/verify) or mutating (implement/refactor)? Which acceptance-criterion oracle does it serve?
2. **Pick least-privilege tools** from the role → tools table below.
3. **Draft `agents/<name>.md`** from the template in `references/owner-subagent-template.md` (copy it, fill the role specifics). Keep the shared convention intact.
4. **Validate** against the convention:
   ```bash
   node skills/ditto-agent-creator/scripts/validate-agent.mjs agents/<name>.md
   ```
   Fix every ERROR. (Or add it to `tests/skills/validate-agent.test.ts` and run `bun test tests/skills/validate-agent.test.ts`.)
5. **Rebuild both hosts** (dual-host, ADR-0016): `bun run build:plugin && bun run build:codex-plugin`. The build copies `agents/` verbatim into `dist/plugin/agents/` and the Codex plugin — author under `agents/` and rebuild, no registry to edit.

## The ditto owner-subagent convention (what the contract test enforces)

Every owner agent body must carry these, because autopilot depends on them:

- **Delegation packet** — the agent receives a 6-section packet (TASK · EXPECTED OUTCOME · REQUIRED TOOLS · MUST DO · MUST NOT DO · CONTEXT, incl. `file_scope`/`done_when`) and works only from it.
- **Context Isolation** — it does **not** see the driver's hypotheses, other nodes' results, or the broader plan. State this explicitly so the agent doesn't invent shared context it wasn't given.
- **owner-return envelope** — it returns the structured envelope (schema `src/schemas/owner-return-envelope.ts`, gated by `guardOwnerEnvelope`): `summary` (the ONLY slot loaded into the orchestrator's context — a pointer-index, not the body) · `verbatim_detail` (lossless detail, no size cap) · `conclusion` · `verdict` · `evidence[]` · `uncertainty[]` · `owner_kind`. A bare summary with neither `verbatim_detail` nor `artifact_location` is rejected.
- **Four decisive classes** — loading `summary` alone must lose NONE of: intent · decisions · irreversible-risks · uncertainty. `uncertainty[]` has a slot; place the other three in `verbatim_detail` and flag them in `summary`.
- **Contract** section — a short closing list restating read-only vs mutating, minimum-viable change, and the evidence to return.

## Role → least-privilege tools

| Role kind | Typical tools | Mutates? |
|---|---|---|
| research / review / verify / judge | `Read, Grep, Glob` (+ `Bash` to run evidence, +`WebSearch, WebFetch` for research) | No — must NOT list `Edit`/`Write` |
| implement / refactor (owner) | `Read, Grep, Glob, Edit, Write, Bash` | Yes — the only owners permitted to mutate |

A read-only agent (its description says "read-only") that lists `Edit`/`Write` is a least-privilege violation — the contract test fails it. Omitting `tools` entirely inherits ALL tools and is also rejected.

See `references/owner-subagent-template.md` for the fill-in-the-blanks template and `references/ditto-agent-conventions.md` for rationale + source pointers.

## Anti-patterns to avoid

Inheriting all tools (omitting `tools`) · granting mutation to a read-only role · collapsing `verbatim_detail` into `summary` (loses the decisive classes) · referencing the driver's plan/other nodes (breaks Context Isolation) · adding unrequested defensive code or extra features inside the agent's job · shipping to only one host build.
