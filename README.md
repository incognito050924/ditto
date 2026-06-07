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

DITTO installs as a local Claude Code plugin via one idempotent script. See the
install guide for prerequisites, commands, options, verification, and uninstall:

- English: [docs/install.md](docs/install.md)
- 한국어: [docs/install.ko.md](docs/install.ko.md)

```bash
# install into the project you want DITTO to manage
/path/to/ditto/scripts/install.sh --target /path/to/your/project
```

## Configuring agent variants

By default one agent runs each role — a single `implementer` for all
implementation, and so on. If you want a role specialized per area (a frontend
implementer, a backend implementer), drop subagent definitions under
`.ditto/agents/` and DITTO routes to them by role and file scope, letting the
driver pick among candidates by description. No `.ditto/agents/` directory means
nothing changes.

See [docs/agent-variants.md](docs/agent-variants.md) for the frontmatter fields
and routing rules.

## Status

This repository is just beginning.

The glue code has not yet accumulated, but statistically speaking, it will.
