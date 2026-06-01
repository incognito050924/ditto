---
name: knowledge-update
description: Curate one durable-knowledge update for a work item with the knowledge-curator agent — promote agreed terms into the glossary, append an ADR/pattern/learning, write a single schema-valid knowledgeRecord, and project a summary into CLAUDE.md. Use when a work item produced a durable decision, agreed term, or repeated learning worth carrying forward.
argument-hint: "[work-item-id]"
---

# Knowledge Update

Curate one durable-knowledge update and produce a single schema-valid `knowledgeRecord` whose contents are grounded in what was actually agreed/decided. This is the runtime for an autopilot `nodeKind=knowledge` node (owner `knowledge-curator`, mapped in `autopilot-graph.ts` `KIND_TO_OWNER`).

How (contract structure, glossary ownership, ADR cross-field, runtime-log separation) is owned by `reports/design/contracts/knowledge-contract.md`.

## Procedure (driver)
Run as the main agent; spawn the curation as its own Task (1-level). One knowledge update per invocation — never multi-record, never code mutation.

1. **Build the curation input** from the work item: candidate terms agreed with the user, technical decisions made (with rationale + change condition), and repeated learnings/patterns worth carrying forward.
2. **Spawn `knowledge-curator`** (1-level Task) with the input only. The agent is docs-write-only under `.ditto/knowledge/` (tools: Read, Grep, Glob, Write, Edit — NO Bash, NO code mutation). It:
   - promotes agreed terms into `.ditto/knowledge/CONTEXT.md` + `glossary.json` (agreed terms only — its judgment, no heuristic extractor);
   - appends a technical decision as `.ditto/knowledge/adr/ADR-NNNN-<slug>.md` and a `decisions[]` entry (rationale + change_condition; `status=superseded` ⇒ `superseded_by`);
   - carries repeated learnings/patterns in `learnings[]` / `patterns[]`, kept SEPARATE from `hooks/runtime-log.jsonl` (no auto-promotion of runtime-log lines).
3. **Write exactly one `knowledgeRecord`** (`src/schemas/knowledge-record.ts`) to `.ditto/knowledge/knowledge.json`, validated through `knowledgeRecord.parse` (0 errors). The schema enforces the ADR cross-field invariants at runtime.
4. **Project the summary into CLAUDE.md** via `syncKnowledgeProjection` (`src/core/knowledge-bridge.ts`): a summary of CONTEXT/glossary term headlines + ADR decision headlines + paths goes into the SEPARATE `ditto:knowledge:*` managed block — NOT a second `ditto:managed` block. Then set `knowledgeRecord.projected_to_claude_md = true`. The existing AGENTS.md `ditto:managed` block stays single and unchanged. Use `{ check: true }` for a dry-run drift check (drift 0 ⇒ projection current).

The driver curates and spawns; it does not invent terms or decisions the work item never produced. Promotion is a deliberate act, not a heuristic.

## knowledgeRecord → completion
The produced record is the node's evidence: exactly one schema-valid `knowledgeRecord` at `.ditto/knowledge/knowledge.json` with `projected_to_claude_md=true` and `source ↔ projection` drift 0.

## Output contract
- Exactly one `knowledgeRecord` (`.ditto/knowledge/knowledge.json`) conforming to the schema (0 validation errors).
- At least one of: a promoted agreed term, an appended ADR, or a recorded pattern/learning.
- `projected_to_claude_md=true`; the CLAUDE.md `ditto:knowledge:*` block sha256 matches the sources (drift 0); the AGENTS.md `ditto:managed` block is unchanged.
