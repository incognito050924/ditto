# Writing great prompt-context artifacts

The authoring craft for a **prompt-context artifact** — text loaded into an agent's
context to steer it. A skill and an autopilot owner subagent are the same kind of
thing, so the same principles govern both (the artifacts we ship should obey the
rule they teach). Surface-specific rules stay in this skill's own
`*-conventions.md`; this file is the shared craft they build on.

Contents: Precedence · Predictability · Information hierarchy · Completion criteria
· Leading words · When to split · Pruning · Failure modes · Co-location.

## Precedence

When a ditto authoring convention (in this skill's `*-conventions.md`, or an old
habit baked into an existing skill) conflicts with a principle here — or dilutes
its effect — **this craft wins**. The
artifacts we ship should exemplify the rule they teach, so a convention that keeps
sprawl or restates a reference doesn't get grandfathered.

The one exception is a **functional contract** — the owner-return envelope,
least-privilege tools, the dual-host build, the contract tests. Those are not style:
the craft governs *how you write* them (checkable, co-located, not restated three
times), never *whether they exist*.

## Predictability — the root virtue

An artifact exists to wrangle determinism out of a stochastic model. The thing it
makes predictable is the **process** — the agent taking the same *way* every run —
not the output. Every lever below serves that one goal; when a choice is unclear,
ask which option makes the run more repeatable.

## Information hierarchy — the ladder

An artifact is built from two content types that mix freely: **steps** (ordered
actions the agent performs) and **reference** (definitions, rules, facts consulted
on demand). The design question is where each sits on a ladder ranked by how
immediately the agent needs it:

1. **In-body step** — an ordered action in the artifact body; the primary tier.
2. **In-body reference** — a rule or fact in the body, read on demand. A flat
   peer-set (every rule on one rung) is a legitimate shape, not a smell.
3. **External reference** — pushed into a linked file, reached by a *pointer*, and
   loaded only when the pointer fires.

**Progressive disclosure** is the move down the ladder — out of the body into a
linked file — so the top stays legible. The cleanest test for what to disclose is
the **branch**: a distinct way the artifact gets used, taking a different path
through it. Inline what *every* branch needs; push behind a pointer what only *some*
branches reach. A pointer's *wording*, not its target, decides how reliably the
agent follows it — so name the file for what it holds and state when to open it.

Push too little down and the top bloats; push too much and you hide material the
agent needs. That tension is the whole decision.

## Completion criteria

Each step ends on a **completion criterion** — the condition that tells the agent
the work is done. Make it *checkable* (can the agent tell done from not-done?) and,
where it matters, *exhaustive* — "every modified model accounted for", not "produce
a change list". A vague criterion invites **premature completion**: the agent's
attention slips to *being done* and it stops short. A demanding criterion instead
drives thorough legwork — the digging the agent does *within* a step, never written
as its own step.

## Leading words

A **leading word** is a compact concept already living in the model's pretraining
that the agent thinks with while running the artifact (*tracer bullet*, *red*,
*tight*, *fog of war*). Repeated across the text, it accumulates a distributed
definition and anchors a whole region of behaviour in the fewest tokens by
recruiting priors the model already holds. It pays off twice:

- In the **body** it anchors *execution* — the agent reaches for the same behaviour
  every time the word appears.
- In the **description/trigger** it anchors *invocation* — when the same word lives
  in the user's prompts, docs, and code, the agent links that shared language to the
  artifact and fires it more reliably.

Hunt for restatements a leading word retires: "fast, deterministic, low-overhead" →
a *tight* loop; "a loop you believe in" → the loop goes *red* or it doesn't. Fewer
tokens *and* a sharper hook. Assume every draft is carrying some.

## When to split

Each split spends context (another always-loaded description) or attention, so split
only when the cut earns it:

- **By invocation** — carve off a separately-triggerable artifact only when it has a
  distinct leading word that should fire it on its own, or another artifact must
  reach it.
- **By sequence** — split a run of steps when the steps still ahead tempt the agent
  to rush the one in front of it. Keeping the later steps out of view buys more
  legwork on the current one.

## Pruning

Keep each meaning in a **single source of truth** — one authoritative place, so
changing the behaviour is a one-place edit. Then, sentence by sentence:

- **Relevance** — does this line still bear on what the artifact does? If not, cut.
- **No-op test** — does this line change behaviour versus the model's default? A
  line the model already obeys ("be thorough" when it is already thorough-ish) is a
  **no-op**: you pay context load to say nothing. Fix a weak leading word with a
  stronger one (*relentless*), not more words. When a sentence fails, delete the
  whole sentence — don't trim it. Be aggressive; most failing prose should go.

## Failure modes

Use these to diagnose a misbehaving artifact:

- **Premature completion** — a step ends before it is genuinely done. Defence, in
  order: sharpen the completion criterion (cheap, local); only if it is irreducibly
  fuzzy *and* you observe the rush, hide the later steps by splitting.
- **Duplication** — the same meaning in two places; costs maintenance and tokens and
  inflates the meaning's rank on the ladder.
- **Sediment** — stale layers that settle because adding feels safe and removing
  feels risky. The default fate of any artifact without a pruning discipline.
- **Sprawl** — simply too long, even when every line is live. The cure is the
  ladder: disclose reference behind pointers and split by branch or sequence.
- **No-op** — a line the model already obeys by default (see the no-op test).
- **Negation** — steering by prohibition backfires: *don't think of an elephant*
  names the elephant. Prompt the **positive** — state the target behaviour so the
  banned one is never spoken. Keep a prohibition only as a hard guardrail you can't
  phrase positively, and even then pair it with what to do instead.

## Co-location

Where the ladder decides *how far down* a piece sits, co-location decides *what sits
beside it*: keep a concept's definition, rules, and caveats under one heading rather
than scattered, so reading one part brings its neighbours with it.

## Source

Adapted (not copied) from Matt Pocock's `writing-great-skills` skill —
`mattpocock/skills` (`skills/productivity/writing-great-skills`), reworded for
ditto's dual-host artifacts and cross-checked against the Anthropic Agent Skills
best-practices doc cited in the sibling `*-conventions.md`. Authority for ditto
behaviour is the code and these living conventions (charter §4-11), not this note.
