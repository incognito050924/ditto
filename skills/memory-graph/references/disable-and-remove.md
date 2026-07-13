# Memory graph — disable, delete, and remove (reversibility)

The subsystem's four reversibility invariants (design §10-9, ac-13). Consult this only when turning the subsystem off, deleting its data, or excising it. The everyday CLI surface is in `../SKILL.md`.

## Disable (single switch — invariants ①②)
Set `DITTO_MEMORY=off` (or `0`) — one flag turns off the whole subsystem's automatic paths. It subsumes the granular `DITTO_MEMORY_WARMSTART=0`, so the master switch alone is enough. When off, the §5 warm-start push (`autopilot-loop → warmStartMemoryContext`) returns `undefined`, so the autopilot delegation packet is byte-for-byte what it was without memory. Explicit `ditto memory …` CLI calls are a user's own pull and still run — disabling targets auto-injection/instrumentation, not manual consultation. The flag is read in `src/core/memory-flag.ts` (`isMemoryEnabled()`); invariance is proven by `tests/core/memory-warmstart.test.ts` (`DITTO_MEMORY=off ⇒ undefined`, packet unchanged).

## Delete the data (invariant ③)
Deleting the SoT (`.ditto/memory/`) and the derived projections (`.ditto/local/memory/`) leaves the ditto core unchanged — only `ditto memory` commands are affected; autopilot/work/knowledge keep working (warm-start sees an absent projection and degrades to `undefined`).

## Remove the subsystem (invariant ④)
To excise memory entirely, remove only these splice points; everything else in ditto stays intact:
- **command** — the `memory` registration in `src/cli/index.ts` (`import { memoryCommand }` + `memory:` in `subCommands`) and `src/cli/commands/memory.ts`.
- **skill** — `skills/memory-graph/`.
- **agent** — `agents/memory-extractor.md`.
- **owner pull habit** — the one conditional "`ditto memory query` before grep/explore" line in each owner prompt (`agents/{implementer,reviewer,verifier,security-reviewer,playwright-e2e,researcher}.md`).
- **§5-1 splice** — the optional `memoryContext` field in `buildDelegationPacket` (`src/core/autopilot-dispatch.ts`) and the two `warmStartMemoryContext(...)` lookups in `src/core/autopilot-loop.ts`.

After those removals the rest of ditto (autopilot, work items, knowledge, ACG) is unaffected.
