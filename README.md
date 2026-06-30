# DITTO

Doing It, Tolerably, Through Orchestration

DITTO is another coding harness.

It does not claim to be autonomous, revolutionary, or particularly intelligent.
It merely attempts to make terminal-driven development slightly more tolerable
through orchestration, tooling, and a questionable amount of glue code.

Like most systems in this space, DITTO is ultimately composed of:

- shell commands
- prompts
- retries
- subprocesses
- session state
- accumulated workarounds
- optimism

The difference is that DITTO does not pretend otherwise.

If it helps you ship faster, break things less often, or spend fewer hours
fighting your tooling, then it has already exceeded its design goals.

## Get Started

```bash
npx github:incognito050924/ditto install
```

Update with `npx github:incognito050924/ditto update`, remove with
`npx github:incognito050924/ditto uninstall`. Full guide below — see
[Installing](#installing).

## What It Is

DITTO is a coding agent harness for running development work through a terminal
with enough structure to be useful and enough honesty to remain bearable.

It is intended to coordinate:

- command execution
- workspace inspection
- prompt and context assembly
- tool calls
- subprocess lifecycle
- retry policy
- session persistence
- human handoff

None of this is magic. That is probably for the best.

## Design Posture

DITTO should be:

- boring where possible
- explicit where it matters
- composable before it is clever
- recoverable after failure
- useful before it is impressive

It should avoid:

- pretending shell commands are a personality
- hiding important state behind vibes
- turning retries into denial
- requiring belief as a dependency

## Installing

No clone, no npm publish — `npx` pulls the source straight from GitHub. One line
per lifecycle step. Prerequisites: **bun ≥ 1.3**, **git**, and **Claude Code** on
your `PATH`.

### Install

Run it **from the project you want DITTO to manage** (a git repo): it installs the
Claude Code plugin + a global `ditto` CLI and scaffolds that project's `.ditto/`
in the same step.

```bash
npx github:incognito050924/ditto install
```

> Run from outside a git repo and it installs the global plugin only — then `cd`
> into your project and run `ditto setup`. Optional analysis tools
> (CodeQL/Playwright/LSP) aren't provisioned by npx; add them with `ditto setup --tools`.

### Update

Pull the latest published version (refreshes the plugin + CLI, re-runs setup; idempotent):

```bash
npx github:incognito050924/ditto update
```

### Uninstall — two layers

```bash
# from one project only (the global install stays):
ditto uninstall            # remove DITTO's managed blocks + allowlist; keep .ditto/
ditto uninstall --purge    # also delete .ditto/ (work-item history + memory)

# the whole global host install:
npx github:incognito050924/ditto uninstall   # remove plugin + global CLI; each project's .ditto/ stays
```

Maintainers publish a new version with `bun run release <patch|minor|major>` then
`git push && git push origin v<version>`. Full guide — options, the setup wizard,
the local-repo path for contributors, verification, and troubleshooting:

- English: [docs/install.md](docs/install.md)
- 한국어: [docs/install.ko.md](docs/install.ko.md)

## Configuring agent variants

By default one agent runs each role — a single `implementer` for all
implementation, and so on. If you want a role specialized per area (a frontend
implementer, a backend implementer), drop subagent definitions under
`.ditto/agents/` and DITTO routes to them by role and file scope, letting the
driver pick among candidates by description. No `.ditto/agents/` directory means
nothing changes.

See [docs/agent-variants.md](docs/agent-variants.md) for the frontmatter fields
and routing rules.

## Authoring a tech-spec

`ditto:tech-spec` co-authors a structured spec document with you and compiles it
into a work intent — useful when you want to agree on *what* to build, in writing,
before implementation starts. For the usage flow, the question-elicitation
options, how to choose among them, and per-developer defaults, see:

- [skills/tech-spec/GUIDE.md](skills/tech-spec/GUIDE.md)

## Authoring user journeys & stories

`ditto:journey-author` co-authors product user journeys — and the user stories
behind them — with you, then on finalize compiles them into a journey DSL plus a
per-entity journey catalog: the same DSL the E2E tooling consumes. Two entry
points, chosen by where you start:

- **story → journey → E2E** (`--kind story`): design the user *value* (story)
  first, then the journeys that realize it.
- **journey → E2E** (`--kind journey`): value already settled — author the
  journey directly.

```bash
# start an authoring buffer (story-first or journey-first)
ditto journey-author start --workItem <wi> --kind story
ditto journey-author start --workItem <wi> --kind journey

# propose journey steps from a one-line intent — review-only, writes nothing
ditto journey-author decompose --intent "<one-line intent>"

# record drafts, then finalize
ditto journey-author record-journey --json '<journey draft>'
ditto journey-author record-story   --json '<story draft>'
ditto journey-author finalize --workItem <wi>
```

Finalize writes per-entity journey/story files under
`.ditto/local/{journeys,stories}/` and a journey DSL under `e2e/journeys/` (the
catalog is a read-side projection, never hand-edited). Step decomposition is a
*proposal* you confirm — nothing is authored without your WHAT. Journeys for
not-yet-built screens are kept `spec_first`. Turning the DSL into runnable
Playwright stays with `ditto:e2e-author`. Full flow, the spec-first vs
implemented status model, and the authoring rules:

- [skills/journey-author/SKILL.md](skills/journey-author/SKILL.md)

## Concurrent development with worktrees

Develop several independent features at once on one machine. DITTO can give each
work item its own git worktree — an isolated checkout on its own branch under
`.ditto/local/worktrees/<wi>` — so two efforts (and their autopilots) run side by
side without colliding in the working tree. DITTO owns the worktree lifecycle.

```bash
# create a work item and its worktree in one step
ditto work start "<goal>" --request "<verbatim request>" --worktree

# or manage worktrees for existing work items
ditto worktree create <wi>
ditto worktree list
ditto worktree remove <wi>     # blocks dirty/unmerged; --force to discard anyway

ditto work status <wi>         # shows a work item's linked worktree(s)
```

Flow: create → `cd` to the printed path → opening a session there auto-binds to
that work item (it shares the main workspace's `.ditto/local` state) → `list` /
`status` for what is in flight → `remove` when done. Full guide, edge behavior,
and known limits:

- [skills/worktree/SKILL.md](skills/worktree/SKILL.md)

## Status

This repository is just beginning.

The glue code has not yet accumulated, but statistically speaking, it will.
