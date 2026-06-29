# ditto agent conventions — rationale & sources

Why ditto owner subagents look the way they do, with pointers to the authority
(code is the source of truth, charter §4-11).

## Why a strict shared convention

ditto's autopilot delegates each graph node to an owner subagent and collects
evidence uniformly. If agents returned free-form text, the orchestrator couldn't
load results without context rot or losing the decisive facts. The convention
makes every owner interchangeable from the driver's view: same packet in, same
envelope out.

## The envelope, in code

- Schema: `src/schemas/owner-return-envelope.ts`.
- Guards: `guardOwnerEnvelope` / `guardEnvelopeArtifact` in `src/core/autopilot-loop.ts`
  (a bare summary without `verbatim_detail`/`artifact_location` is rejected; the G7
  contentfulness guard forces an empty/ack-only result to a fixable failure even if
  it claims `pass`).
- Recorded via `ditto autopilot record-result` (`recordResultPayload`).

The single most important property: **`summary` is the only slot the main
orchestrator loads into context.** Everything else is reachable but not auto-loaded.
That is why the four decisive classes (intent · decisions · irreversible-risks ·
uncertainty) must survive in `summary` (flagged) + `verbatim_detail` (full) — losing
them in a summary is the failure mode the guard exists to prevent.

## Context Isolation (charter §4-9)

An owner does not receive the driver's hypotheses or other nodes' state. This is a
deliberate anti-bias / anti-context-rot measure: fresh context per node, condensed
return. State it in the agent body so the model doesn't fabricate shared context.

## ADR surfacing (charter §4-10, ADR-0020)

Read-only research/review agents should surface governing ADRs found while working
(`ditto memory query <node>` indexes decision · rejected alternatives · change
condition). A conflict is cheapest to catch in the findings, before code is written.
See `agents/researcher.md` for the worked pattern.

## Least privilege (charter §7)

Grant only the tools the job needs. Read-only roles (research/review/verify/judge)
must not list `Edit`/`Write`; only implement/refactor owners mutate. The contract
test (`scripts/validate-agent.mjs`) enforces this from the description's "read-only"
marker and rejects an omitted `tools` line (which would inherit everything).

## Dual-host (ADR-0016)

Source lives in `agents/` at the repo root. `scripts/build-plugin.mjs` copies it
verbatim into `dist/plugin/agents/` (Claude Code); `scripts/build-codex-plugin.mjs`
into the Codex plugin. Always rebuild both — a one-host agent is half-shipped.

## Worked examples (read these)

- `agents/implementer.md` — the only mutating owner; red-first for code-behavior AC.
- `agents/researcher.md` — read-only, memory + ADR surfacing, finding vs hypothesis.
- `agents/reviewer.md`, `agents/verifier.md`, `agents/security-reviewer.md` — read-only verdict roles.
