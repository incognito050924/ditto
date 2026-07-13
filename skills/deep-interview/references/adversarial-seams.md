# Deep-interview adversarial seams (host-delegated)

The three optional hardening passes the SKILL body points to. Open this when you
reach pre-mortem promotion (§4) or the pre-finalize block (§5.5/§5.6). All three
share one idiom and one discipline; only the target and the gate differ.

Contents: Shared idiom · Shared discipline · Pre-mortem opponent (§4) ·
Intent-dissent seam (§5.5) · Semantic critic (§5.6).

## Shared idiom

Every seam runs the same three moves:

1. **Emit briefs** — a deterministic CLI (`*-briefs` / `*-targets`) makes **no model
   call** (ADR-0001); it just emits one target per item, each carrying only the
   minimal brief (the item/dimension + the ORIGINAL intent).
2. **Spawn one opponent per target in the host layer** — a fresh Task, one level
   deep, given ONLY that brief, **never the interview transcript** (session-blind
   independence is the whole point). The model judgment lives here, never in the CLI.
3. **Record verdicts back** through a fail-closed CLI (`*-record`) in one write.

## Shared discipline

- **No model call in the CLI.** Judgment lives in the spawned opponent agents (ADR-0001).
- **Honest degrade (ADR-0018).** No opponent host, or an empty/whitespace verdict
  text, records `host_absent` — never a false `engaged` "it was refuted" stamp. A
  `host_absent` item still stands.
- **Anti-inflation.** An opponent returns a *sharper* reading of the SAME intent,
  never a bigger one. A verdict that enlarges the ask is out of contract — do not record it.
- **Fail-closed on foreign/malformed payloads.** A verdict pointing at a target that
  is not in range is **rejected** at the write boundary; a malformed payload is a
  usage error and writes nothing.

## Pre-mortem opponent (§4 — `blast_radius>=high` only)

After promotion (§4), put each recorded `blast_radius` `high`/`critical` item under
ONE independent adversarial pass — never a blanket sweep (the category-complete
pre-mortem sweep belongs to the autopilot PLAN stage; do not duplicate it here).

```bash
# For each recorded premortem item with blast_radius>=high, spawn ONE dialectic-opponent
# with a minimal brief: the item's scenario + the ORIGINAL intent. Ask it exactly:
#   "Is this risk real, or already mitigated by what the change already does?"
# Then fold the refutation back onto the item BY ITS INDEX in interview-state.premortem:
ditto deep-interview premortem-refute-record --work-item <wi> \
  --json '{"verdicts":[{"index":0,"text":"<is-it-real / already-mitigated judgment>"}]}'
```

- **`blast_radius>=high` only.** `premortem-refute-record` **rejects** a verdict whose
  `index` is out of range OR points at a non-high-blast item (localization enforced at
  the write boundary, not merely advised).
- **Low priority — not a gate.** The interview does not block on it. A refutation that
  says "already mitigated" is a signal to reconsider the promotion, never an automatic demotion.

## Intent-dissent seam (§5.5 — before finalize, gates finalize)

Before locking the interview, put each **critical** dimension's intent under
independent pressure: an opponent re-derives the ORIGINAL intent from scratch and
judges whether the user's stated intent is mis-stated, returning a **sharper (more
accurate, never bigger)** reading.

```bash
# 1) emit the briefs — NO model call. One target per critical dimension, each carrying its
#    dimension id + label + the ORIGINAL intent (WI Record source_request/goal):
ditto deep-interview dissent-briefs --work-item <wi> --output json
```

For each `dissent_targets[]` entry, **spawn one `intent-dissent-opponent` agent** with
ONLY that brief. Each returns `{verdict: accept|revise|reject, impact, text}`. Carry
back **only the real dissents** — `revise`/`reject` with the sharper text. An `accept`
(the stated intent is already the most accurate reading) is NOT a dissent: omit it.

```jsonc
{ "verdicts": [
  { "dimension_id": "<critical dim>", "text": "<sharper, same-intent restatement>" }
] }
```

```bash
# 2) feed the dissents back — validated + fail-closed, persisted in ONE write:
ditto deep-interview dissent-record --work-item <wi> --json '<verdicts>' --briefed "<id>,<id>"
```

- **Anti-inflation via `INTENT_DISSENT_CONSTRAINT`** — the brief carries it; a dissent
  that enlarges the ask is out of contract.
- **Fail-closed on foreign dimensions.** A verdict whose `dimension_id` is not an
  interview dimension is **rejected** (never an orphan the finalize gate can't map).
- **The dissent gates finalize.** A recorded `revise`/`reject` on a critical dimension
  is a high-impact block: `finalize` returns `blocked_by_dissent` until the user
  reviews it and acknowledges it, then re-runs finalize:

  ```bash
  ditto deep-interview acknowledge-dissent --work-item <wi> --dimension <id>
  ```

  This reads the durable `dimension.dissent` record (the same one the projection path
  writes) rather than re-invoking the opponent, so the gate stays stable across retries.
- **Honest degrade (ADR-0018).** No host → skip the record for that dimension (no
  engaged dissent → finalize is not blocked by an absent opponent); note the degradation.

## Semantic critic (§5.6 — A1 achieve-vs-characterize, ADVISORY / NON-blocking)

A dimension marked `resolved` means its question got an answer — NOT that the answer
**achieves** the original intent's HOW versus only **characterizing** it. This pass
surfaces that gap. It writes a SEPARATE `dimension.semantic_*` field pair that the
readiness gate and `finalize` never read, so it can never hard-block the loop (the
intent-layer port of prism's non-blocking A1). Do NOT gate on it.

```bash
# 1) emit the covered (fragment,dimension) targets — NO model call. The intent is decomposed
#    into fragments and mapped to RESOLVED dimensions by whole-token match (deterministic); capped:
ditto deep-interview semantic-targets --work-item <wi> --output json
```

For each `semantic_targets[]` pair, **spawn one semantic critic** with the fragment
text + the dimension label, asking exactly: **"Does this dimension ACHIEVE the
fragment, or only CHARACTERIZE it?"** Carry back only the `characterize` verdicts (an
`achieve` is clean). Fold them back:

```bash
# 2) record the critiques — validated + fail-closed, advisory (finalize is NOT blocked):
ditto deep-interview semantic-record --work-item <wi> --json '{"verdicts":[{"dimension_id":"<id>","text":"<achieve-vs-characterize judgment>"}]}'
```

- **Covered pairs only.** `semantic-targets` fires only where a fragment
  whole-token-matches a resolved dimension's notes (no word-internal substring match).
  Uncovered dimensions get no critique.
- **Advisory, never a gate.** A `characterize` verdict is a signal to reconsider
  whether the dimension truly resolved the intent — readiness/finalize ignore it.
</content>
</invoke>
