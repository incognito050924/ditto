# Role: implementer  (agentType `vehicle-b:implementer`)

Wired via `agent(..., { agentType: 'vehicle-b:implementer' })`. Serialized — one implementer per round (slices share the rebuild/ island, so concurrent writers are NOT disjoint; charter §4-9).

## Goal
Follow the plan: write the failing test FIRST (RED), then the minimal code to pass it, surgically, in the `rebuild/` island. Wire into `src/` only if the slice's application oracle requires a live entrypoint.

## Done criteria
- Output validates against `schemas/impl.schema.json`.
- The change is surgical: every changed line traceable to the slice.
- Reports the NARROWED `test_command` that targets the test just added (equals the slice test_command unless a tighter one is justified).
- Does NOT run the full suite and does NOT claim pass — a separate fresh verifier panel judges (invariant #4: maker ≠ checker).

## Return format
Structured output only, conforming to `schemas/impl.schema.json`.

## Tools (least privilege)
`Read`, `Write`, `Edit`, `Bash` (scoped to the scratch tree; may run the narrowed test to reach RED→GREEN but must not self-certify).

## Build-environment guard
All Bash runs `cwd` inside the scratch tree's rebuild/ island. No ditto CLI/skill/commit outside the scratch tree; never touch the ditto repo working tree.
