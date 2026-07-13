---
name: knowledge-update
description: Curate one durable-knowledge update for a work item with the knowledge-curator agent — promote agreed terms into the glossary, append an ADR/pattern/learning, write a single schema-valid knowledgeRecord, and project a summary into CLAUDE.md. Use when a work item produced a durable decision, agreed term, or repeated learning worth carrying forward.
argument-hint: "[work-item-id]"
---

# Knowledge Update

Curate one durable-knowledge update for a work item and produce a single schema-valid `knowledgeRecord` grounded in what was actually agreed or decided. This is the runtime for an autopilot `nodeKind=knowledge` node (owner `knowledge-curator`, mapped in `autopilot-graph.ts` `KIND_TO_OWNER`). One update per invocation — one record, no code mutation.

The contract detail (record structure, glossary ownership, ADR cross-field, runtime-log separation) lives in `reports/design/contracts/knowledge-contract.md`.

## Procedure (driver)

Run as the main agent; spawn the curation as its own 1-level Task.

1. **Build the curation input** from the work item: agreed candidate terms, technical decisions (with rationale + change condition), and repeated learnings/patterns worth carrying forward. Declare which of the three axis-4 triggers fired — `adr_worthy_decision` (a durable decision worth an ADR), `new_agreed_term` (a new ubiquitous-language term agreed with the user), `repeated_pattern` (a reusable pattern or repeated learning).
   **Done when** each trigger is marked fired / not-fired with its backing content named; all-false is a valid explicit skip (records nothing), not a silent omission.

2. **Spawn `knowledge-curator`** (1-level Task) with the input only. It is docs-write-only under `.ditto/knowledge/` (tools: Read, Grep, Glob, Write, Edit — no Bash, no code mutation) and:
   - promotes agreed terms into `.ditto/knowledge/CONTEXT.md` + `glossary.json` (agreed terms only — its judgment, no heuristic extractor);
   - appends a technical decision as `.ditto/knowledge/adr/ADR-YYYYMMDD-<slug>.md` carrying rationale + change_condition (a superseded ADR sets `상태: superseded` and names its successor; the `.md` files are the SoT — the `knowledge.json` decisions index was retired, ADR-20260624 amend);
   - carries repeated learnings/patterns in `learnings[]` / `patterns[]`, kept SEPARATE from `hooks/runtime-log.jsonl` (no auto-promotion of runtime-log lines).
   **Done when** the curator has written each fired trigger's content under `.ditto/knowledge/` and touched nothing else.

3. **Write exactly one `knowledgeRecord`** (`src/schemas/knowledge-record.ts`) to `.ditto/knowledge/knowledge.json`, validated through `knowledgeRecord.parse` (0 errors). The record indexes paths, patterns, and learnings — ADR bodies live under `adr/*.md`, not in the record. Then bind it to the declared triggers:
   - **Gate the recording** against the triggers: `ditto knowledge gate --json '{"triggers":{"adr_worthy_decision":…,"new_agreed_term":…,"repeated_pattern":…},"delta":{"decisions":N,"glossary_terms":N,"patterns":N,"learnings":N}}'` where `delta` is what THIS update recorded. The gate fails (non-zero) on **under-recording** (a fired trigger with no matching content) and **over-recording** (content with no trigger) — fix the curation until it passes. This makes "valuable durable change" an explicit, checkable surface, not a curator-only heuristic.
   - **Persist the carrier** so the Stop hook enforces the same gate at run time (not just this manual CLI). Write the SAME `{triggers, delta}` (plus `schema_version`) as `knowledgeGateCarrier` (`src/schemas/knowledge-gate-carrier.ts`) to `.ditto/local/work-items/<work-item-id>/knowledge-gate.json`. The Stop hook loads it whenever the graph has a terminal knowledge node and runs `knowledgeUpdateGate`, so a fired-trigger-without-record (or record-without-trigger) blocks the work item from closing — mirroring the four other Stop gates. The carrier is a valid explicit skip ONLY for a genuine no-trigger update; if any trigger fired, it is mandatory.
   **Done when** `knowledgeRecord.parse` returns 0 errors, `ditto knowledge gate` exits 0, and the carrier is written whenever a trigger fired.

4. **Project the summary into CLAUDE.md** via `syncKnowledgeProjection` (`src/core/knowledge-bridge.ts`): CONTEXT/glossary term headlines + ADR decision headlines + paths go into the SEPARATE `ditto:knowledge:*` managed block — NOT a second `ditto:managed` block. Then set `knowledgeRecord.projected_to_claude_md = true`. The existing AGENTS.md `ditto:managed` block stays single and unchanged. Use `{ check: true }` for a dry-run drift check (drift 0 ⇒ projection current).
   **Done when** the `ditto:knowledge:*` block sha256 matches its sources (drift 0), `projected_to_claude_md = true`, and the AGENTS.md `ditto:managed` block is unchanged.

Curate only terms and decisions the work item actually produced — promotion is a deliberate act, not a heuristic.

## Completion — the node's evidence

The produced record is the node's evidence:

- Exactly one `knowledgeRecord` at `.ditto/knowledge/knowledge.json` conforming to the schema (`knowledgeRecord.parse`, 0 validation errors).
- `ditto knowledge gate` passes — every declared trigger has matching recorded content, and no content was recorded without a trigger (no under/over-recording).
- The carrier `.ditto/local/work-items/<work-item-id>/knowledge-gate.json` (`knowledgeGateCarrier`) holds the same `{triggers, delta}` (mandatory whenever a trigger fired), so the Stop hook re-runs the gate at run time.
- When ≥1 trigger fired, at least one of: a promoted agreed term, an appended ADR, or a recorded pattern/learning (a no-trigger update correctly records none).
- `projected_to_claude_md = true`; the CLAUDE.md `ditto:knowledge:*` block sha256 matches the sources (drift 0); the AGENTS.md `ditto:managed` block is unchanged.
