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

## Status

This repository is just beginning.

The glue code has not yet accumulated, but statistically speaking, it will.
