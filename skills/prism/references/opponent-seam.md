# Prism opponent seam — host-delegated critique / dissent / semantic

Open this when a run wants to sharpen the prism map's argumentation with a real
opponent, beside the bare `ditto prism opponent` degrade path. The model judgment
happens in the **host layer** (spawned opponent agents), never inside the CLI
(ADR-0001); the two CLIs only emit the briefs and consume/validate/persist the
structured verdicts — the pass-in-JSON idiom
(mirrors `autopilot coverage-next --relevance`).

Three concerns:

- **critique** — a devil's-advocate critique + refutation over the A2-flagged critical nodes.
- **dissent** — an independent second view re-derived from the original intent at the anchor.
- **semantic** — an A1 achieve-vs-characterize judgment on the covered (fragment,node) pairs.

## 1. Emit the briefs — no model call

```bash
ditto prism opponent-briefs --wi <wi>
```

Emits three groups (`critique_targets`, `dissent_anchor`, `semantic_targets`), each
target carrying node id + label + intent. **Done when** the briefs are printed.

## 2. Spawn one opponent agent per concern (host layer, ADR-0001)

The main agent spawns one opponent agent per concern to produce the judgment text
against each brief, and assembles the verdicts as JSON:

```jsonc
{ "verdicts": [
  { "concern": "critique", "node_id": "<flagged node>", "text": "…critique + refutation…" },
  { "concern": "dissent",  "node_id": "<anchor>",       "text": "…independent 2nd view…" },
  { "concern": "semantic", "node_id": "<covered node>", "text": "…achieved / only characterized…" }
] }
```

**Done when** each briefed concern has a verdict with node-scoped text.

## 3. Record the verdicts — validated, fail-closed, one write

```bash
ditto prism opponent-record --wi <wi> --json '<verdicts>' --briefed "<id>,<id>,…"
```

**Done when** the verdicts persist in one write and `--briefed` reports no briefed
concern left unanswered.

## Invariants

- **No model call in the CLI.** `opponent-briefs` and `opponent-record` never invoke a
  provider; the judgment lives in the spawned host agents (ADR-0001).
- **Fail-closed on foreign nodes.** A verdict whose `node_id` is not in the tree is
  **rejected** — never recorded as an orphan evaluation the tree render can't show
  (ADR-0018 never-silent). A malformed payload is a usage error and leaves the map
  unchanged; an empty verdict text degrades to `host_absent`, never a false `engaged`.
- **`--briefed` closes the loop.** Passing the briefed node ids surfaces any briefed
  concern that came back unanswered, so a dropped opponent judgment is visible.
- The bare `ditto prism opponent` command stays the no-host degrade path (it stamps
  `host_absent` when no delegate is wired); `opponent-briefs` / `opponent-record` are the
  additive host-delegated path beside it.
