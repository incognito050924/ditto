# Installing DITTO

> 한국어 안내는 [install.ko.md](install.ko.md)를 참고하세요.

DITTO installs as a local Claude Code (or Codex) plugin. The install script is a
**thin bootstrap**: it bundles the `ditto` JS launcher (run by `bun`) and puts it
on your `PATH` — the two steps that must happen before `ditto` exists — and then
**delegates everything else to the launcher itself** (`ditto setup`). Everything is
idempotent; you can safely re-run it.

> `ditto` is a **portable JS bundle executed by `bun`**, not a native compiled
> binary. `bun` must stay on `PATH` for the CLI and hooks to work. The same bundle
> runs on macOS, Linux, and Windows; only the launcher differs — a `#!/usr/bin/env
> bun` shebang on POSIX, a `bin/ditto.cmd` shim on Windows. Hooks invoke it as
> `bun "${CLAUDE_PLUGIN_ROOT}/bin/ditto"`, which is why no per-OS `.exe` is shipped.

## Prerequisites

Install these first. Both are quick, one-command installs.

| Requirement | Why | How to install |
|-------------|-----|----------------|
| **bun ≥ 1.3** | Bundles the `ditto` JS launcher (`bun build --target=bun`) **and runs it at runtime** — `ditto` is portable JS, not a native binary, so bun must stay on `PATH`. Also runs the install orchestrator. | Official guide: <https://bun.sh/docs/installation> (`curl -fsSL https://bun.sh/install \| bash`). |
| **git** | DITTO reads repo state and memory lives in git. | Official downloads: <https://git-scm.com/downloads>. macOS: `xcode-select --install` or `brew install git`; Debian/Ubuntu: `sudo apt-get install git`; Windows: the installer from git-scm. |
| **Claude Code** *(or Codex)* | DITTO is a host plugin. | The host you intend to run DITTO under. See <https://docs.claude.com/claude-code>. |

That is all you need to install. The heavier analysis tools below are **optional**
and provisioned later by the wizard — never required to get DITTO running.

| Optional tool | Provisioned by | Used by |
|---------------|----------------|---------|
| CodeQL CLI | `ditto setup` (with tools) or `ditto doctor codeql --install` | `ditto codeql review`, `impact`, `boundary` (ACG gate) |
| Playwright / Chromium | `ditto setup` (with tools) or `bunx playwright install chromium` | `/ditto:e2e` real-browser journeys |
| Language servers (LSP) | `ditto setup` (with tools) | per-language servers for detected languages |

All three are **graceful**: if a download or prerequisite is missing, the wizard
prints the exact manual command and continues — it never fails the install.

## Quick start

Clone the repo, then install DITTO **into the project you want it to manage**:

```bash
git clone <ditto-repo-url> ditto
cd /path/to/your/project           # the project DITTO should manage
/path/to/ditto/scripts/install.sh  # bootstrap, then run the setup wizard
```

Or target a project explicitly without changing directories:

```bash
/path/to/ditto/scripts/install.sh install --target /path/to/your/project
```

On **Windows (PowerShell 5+)** use the `.ps1` entry point:

```powershell
\path\to\ditto\scripts\install.ps1
\path\to\ditto\scripts\install.ps1 install -Target C:\path\to\your\project
```

`install.sh` runs non-interactively (`ditto setup --yes --tools`). To answer the
wizard questions yourself instead, run `ditto setup` directly in a terminal after
the bootstrap (see [The setup wizard](#the-setup-wizard)).

## What `install.sh` does

The script bootstraps the binary, then hands the rest to `ditto setup`:

| Step | Scope | Action |
|------|-------|--------|
| 1. build | repo | `bun run build:plugin` → `dist/plugin/` (the deploy unit, incl. the `bin/ditto` JS bundle + the `bin/ditto.cmd` Windows launcher). |
| 2. place | global | Symlinks the binary onto `PATH` (`~/.local/bin/ditto`) so bare `ditto …` works. **On Windows the binary is NOT symlinked** — see the note below. |
| 3. delegate | project | Runs `ditto setup --dir <target> --yes --tools`, which installs the host instruction blocks, scaffolds `.ditto/`, allowlists `Bash(ditto:*)`, and provisions detected tools. |

There is **no marketplace registration step** — the GitHub/source plugin and the
local `dist/plugin` dev path do not need a persistent marketplace entry.

> When the target **is** the DITTO repo itself (self-host), `ditto setup` no-ops
> its project steps — the repo must not be its own managed target.

### Windows note

Symlink placement (step 2) is POSIX-only. On Windows the installer bundles the
launcher but does **not** put it on `PATH` automatically. After installing, add
`<ditto-repo>\dist\plugin\bin` to your `PATH`; the bare `ditto` command resolves
there through the `ditto.cmd` shim (which runs `bun "…\bin\ditto"`). The installer
prints the exact directory. Hooks invoke the bundle the same way — `bun
"${CLAUDE_PLUGIN_ROOT}/bin/ditto"` — so **bun must be on `PATH`**; there is no
native `.exe` (the previous `ditto.exe` was a non-executable shebang text file and
never ran on Windows).

### Options

| Flag | Effect |
|------|--------|
| `--target <dir>` (`-Target` on Windows) | Project to install into. Defaults to the current directory. |
| `--no-build` (`-NoBuild`) | Skip the binary build (reuse an existing one). |
| `--no-tools` (`-NoTools`) | Skip tool provisioning (CodeQL / Playwright / LSP). |

If the DITTO repo can't be auto-detected, set `DITTO_HOME` to the repo root
(the directory containing `.claude-plugin/plugin.json`).

## The setup wizard

`ditto setup` is the single surface for installing DITTO into a project. When you
run it **in a terminal (TTY)**, it is interactive; when run by a script, CI, or an
agent (no TTY), or with `--yes`, it runs non-interactively with safe defaults.

```bash
cd /path/to/your/project
ditto setup                 # interactive wizard
ditto setup --yes           # non-interactive, defaults, no tool install
ditto setup --yes --tools   # non-interactive + provision detected tools (what install.sh uses)
```

### Wizard questions

| # | Question | Options (default first) | What it does |
|---|----------|-------------------------|--------------|
| 1 | **Host** | `claude-code` / `codex` / `both` | Which host's instruction blocks, surfaces, and agents to install. |
| 2 | **Analysis / language tools** | multi-select over **detected** tools | DITTO walks the source tree, infers languages, and pre-checks the missing tools (CodeQL, Playwright, and the LSP servers for each detected language). You confirm or toggle; only the selected, missing ones are installed. Skipping is safe — the feature degrades, it does not break. |
| 3 | **Memory storage** | `in-project` / `separate repo` | Where the memory SoT (`.ditto/memory/`) lives. Default keeps it in the project's git. Choosing **separate repo** offers `gitignore-standalone` (default: `git init` in `.ditto/memory/` + add it to the parent `.gitignore`) or `submodule` (opt-in; needs a remote, so it prints manual steps). |

Non-interactive runs take Host from `--host` (default `claude-code`), provision
tools only with `--tools`, and keep memory in-project.

After the questions the wizard prints a one-line note: the **PreToolUse safety
hook** is active plugin-wide (it blocks a conservative set of destructive /
secret-touching tool calls; default is allow). It is not a per-project toggle —
if it false-positives on a legitimate command, prefix it with `DITTO_SKIP_HOOKS=1`.

### What `ditto setup` installs

| File | Scope | Content |
|------|-------|---------|
| `~/.claude/CLAUDE.md` · `~/.claude/AGENTS.md` | global | Global behavior rules (completion gate, fact gate, output rules). Applies to every project. |
| `<target>/CLAUDE.md` · `<target>/AGENTS.md` | project | The Agent Behavior Charter. |

Behavior (verified by direct runs):

- **Preserves existing content**: anything already in the file stays outside the
  managed block (`<!-- ditto:managed:start … -->`); the first application creates
  a `<file>.ditto_bak` backup.
- **Idempotent**: re-running updates the block in place, never duplicates it.
- **Removal**: `ditto uninstall` strips only the managed blocks and keeps user content.
- The loaded rules take effect from the **next** host session.

### Codex host

For Codex, build the Codex plugin surface first:

```bash
bun run build:codex-plugin
ditto setup --host codex
```

The Codex branch copies the built plugin into `<target>/.agents/plugins/ditto/`,
writes `<target>/.agents/plugins/marketplace.json`, and installs generated agents
into `<target>/.codex/agents/`. This is a **prepared** state, not an enabled
plugin. `ditto setup --host codex` prints the follow-up commands:

```bash
codex plugin marketplace add /path/to/your/project
codex plugin add ditto@ditto-local
```

Run those in the Codex home you intend to use, then start a new Codex session.
Until then, `ditto doctor capability --host codex` reports
`codex_plugin_needs_user_action`.

## Tools: CodeQL / Playwright / LSP

The DITTO **runtime never auto-installs heavy external tools mid-analysis.** When
one is missing it degrades honestly — this prevents false passes.

| Tool | Used by | Runtime behavior when absent |
|------|---------|------------------------------|
| CodeQL CLI | `ditto codeql review` (ACG gate) | `doctor codeql` fail-closes and blocks analysis |
| CodeQL query packs | analysis queries | auto-downloaded at analysis time (no separate install) |
| Playwright/Chromium | `/ditto:e2e` real-browser journey | degrades to `result=blocked` (never a fake pass) |
| Language servers (LSP) | language-aware features | the language is reported as unserviced; no block |

These are provisioned **opt-in** by `ditto setup` (the wizard's tool question, or
`--tools` non-interactively), all behind one provisioner with a shared detection
probe (`<TOOL>_BIN` env → `PATH` → ditto-managed under `~/.local/share/ditto/…`).

CodeQL also has a standalone opt-in installer (e.g. for the marketplace path that
skips the wizard):

```bash
ditto doctor codeql --install
```

- **If present**, it returns `already-present` (detection: `CODEQL_BIN` → PATH →
  gh extension → ditto-managed).
- **If absent**, it downloads the official CLI bundle (github/codeql-cli-binaries)
  into `~/.local/share/ditto/codeql` and symlinks `~/.local/bin/codeql`.
- **Never hard-fails**: on error it returns `failed` plus copy-paste manual commands.

LSP servers are provisioned only through `ditto setup --tools` today (auto for
ts/js, python, go, rust; manual instructions for heavier servers like Java/Kotlin).
Playwright can also be pre-seeded directly with `bunx playwright install chromium`.

## Marketplace install/update path

Instead of `install.sh` you can install through the Claude Code plugin
marketplace (GitHub source or a local `dist/plugin` directory source):

```bash
claude plugin marketplace add <owner>/<repo>     # or a local dist/plugin path
claude plugin install ditto@ditto-local
```

Two traps on this path (both reproduced directly):

1. **Updates require `marketplace update`.** The installed plugin is a **copied
   cache** (`~/.claude/plugins/cache/…`). After the source changes it stays stale
   until you run `claude plugin marketplace update ditto-local`. Claude Code detects
   a new version only when the plugin's `version` **changes**, so updates are driven
   by **releases** (see below) — `claude plugin update` picks up the new version once
   the marketplace has refreshed.
2. **`install` on an already-installed plugin is a no-op.** To refresh, run
   `claude plugin uninstall ditto@ditto-local`, then `install` again.

This path skips the bootstrap's `PATH` placement **and** the tool provisioning —
run `ditto setup --tools` (or the opt-in commands above) yourself afterward.

## Verify

Start a **new** Claude Code session in the target project, then:

```text
/plugin            # ditto@ditto-local listed and enabled
```

```bash
ditto doctor       # binary on PATH, runtime reachable, drift check
```

A healthy install reports `ok` for `distribution`, `capability`, and `surface`.
`permissions` / `mcp` may report `missing` / `unverified` when run inside the
DITTO repo itself — expected, since the repo is not a managed target.

`ditto doctor` is the **diagnose** surface (instructions, permissions, MCP,
surface, capability, distribution drift). It is advisory — it reports drift but
does not auto-repair; to repair, re-run `ditto setup` (idempotent re-projection).

## Per-session wrapper (no persistent settings)

To load DITTO for a single session via the assembled product surface:

```bash
# bash/zsh — add to ~/.bashrc or ~/.zshrc
export DITTO_HOME="/path/to/ditto"
alias ditto-claude='claude --plugin-dir "$DITTO_HOME/dist/plugin"'
```

```powershell
# PowerShell profile ($PROFILE)
$env:DITTO_HOME = 'C:\path\to\ditto'
function ditto-claude { claude --plugin-dir $env:DITTO_HOME\dist\plugin $args }
```

Then `ditto-claude` launches Claude Code with DITTO loaded for that session only.
Run `bun run build:plugin` first if `dist/plugin` is absent. `--plugin-dir` points
at `dist/plugin` (the assembled surface), never the repo root, so source and
dogfooding state never leak in.

## Updating & dogfooding

There is no dedicated `ditto update` command — **updating is re-running the
bootstrap** (`install.sh` is idempotent: rebuild + idempotent `ditto setup`), plus
the automatic `dist/plugin` rebuild below. The installed plugin reads
`dist/plugin/` — a **copy** assembled by `build:plugin`, not the source tree — and
Claude Code loads plugins only at **session start** (no hot reload). So:

1. After changing source, `dist/plugin` must be **rebuilt**.
2. A **new Claude Code session** is needed to pick up the rebuild.

DITTO automates step 1:

- **Git hooks (multi-PC sync).** `post-merge` / `post-checkout` rebuild
  `dist/plugin` after `git pull` / merge / branch switch (graceful; a build
  failure never blocks git). Activated via `bun install` (the `prepare` script
  points `core.hooksPath` at `.githooks/`).
- **Dev launcher.** `bun run dev:plugin` rebuilds and launches Claude Code with
  the fresh `dist/plugin` in one step.

If you ever need it manually: `bun run build:plugin`.

## Releasing a version (maintainers)

DITTO ships as a **committed JS bundle** served by the github-source marketplace.
The Claude Code plugin host copies files from the repo tree and has **no mechanism
to fetch GitHub-Release assets**, so the bundle lives in the repo (`bin/ditto`, a
~1.4MB JS file run by `bun` — not a native binary). Distribution versions are plain
**semver**, and cutting one is a single command:

```bash
bun run release minor              # major | minor | patch | or an explicit X.Y.Z
bun run release minor --dry-run    # preview the bump + touched files, write nothing
```

It bumps the version in lockstep everywhere the host and CLI read it
(`package.json`, `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`, the CLI
`--version`), rebuilds the committed bundle so `bin/ditto` carries the new version +
a fresh source stamp, commits those files, and tags `vX.Y.Z`. It **never pushes** —
publish with `git push && git push origin vX.Y.Z`.

Claude Code detects a new plugin version only when the `version` field **changes**,
so bumping it is exactly what makes `claude plugin update` meaningful: consumers run
`claude plugin marketplace update ditto-local`, then `/plugin update`.

## Status & uninstall

```bash
/path/to/ditto/scripts/install.sh status                       # JSON health report
/path/to/ditto/scripts/install.sh uninstall                    # current directory
/path/to/ditto/scripts/install.sh uninstall --target /the/project
```

Uninstall removes the binary symlink and delegates to `ditto uninstall` (alias: `teardown`), which
strips the managed instruction blocks and the allowlist rule while **keeping** the
target's `.ditto/` runtime data — that is your work-item history and memory.

To also delete `.ditto/` (irreversible — purges work-item history and memory):

```bash
ditto uninstall --purge                 # in the target project
```

`--purge` is required explicitly; in a terminal `ditto uninstall` first asks for
confirmation (default: keep).
