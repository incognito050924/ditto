# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

This repo keeps its authoritative domain knowledge under `.ditto/knowledge/` (not the template default of a root `CONTEXT.md` + `docs/adr/`). That layout is the source of truth per the charter's "authority lives in code + living guidance beside it" principle (CLAUDE.md §4-11); a summary is projected into `CLAUDE.md` under "DITTO Knowledge" and must not be edited by hand.

## Before exploring, read these

- **`.ditto/knowledge/CONTEXT.md`** — the project context.
- **`.ditto/knowledge/glossary.json`** — the ubiquitous language (domain terms). A projected term list also appears in `CLAUDE.md`.
- **`.ditto/knowledge/adr/`** — read the ADRs that touch the area you're about to work in. ADR identity is the immutable filename `ADR-YYYYMMDD-<slug>.md` (or the earlier `ADR-NNNN-<slug>.md`); there is no separate sequential number.

You can also query this knowledge programmatically: `ditto memory query` surfaces the relevant ADRs (decisions, rejected alternatives, withdrawal conditions) — the charter (§4-10, ADR-0020) requires consulting it when work touches a recorded decision.

If any of these files don't exist, **proceed silently**. Don't flag their absence; the `/domain-modeling` skill creates entries lazily when terms or decisions actually get resolved.

## File structure

```
/
├── CLAUDE.md                        ← charter + projected knowledge summary (do not hand-edit the projected block)
└── .ditto/knowledge/
    ├── CONTEXT.md                   ← project context
    ├── glossary.json                ← ubiquitous language
    └── adr/
        ├── ADR-0001-runtime-stack.md
        └── ADR-YYYYMMDD-<slug>.md
```

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in `.ditto/knowledge/glossary.json`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding — the charter (§4-10) requires disclosing the conflict with rationale:

> _Contradicts ADR-0007 (cross_repo policy) — but worth reopening because…_
