# Installing DITTO

> 한국어 안내는 [install.ko.md](install.ko.md)를 참고하세요.

DITTO installs as a Claude Code (or Codex) plugin. **One command installs it** —
the plugin, the global `ditto` CLI, and your project's `.ditto/` workspace.
Everything is idempotent, so you can safely re-run it.

> `ditto` is a **portable JS bundle run by `bun`**, not a native binary, so `bun`
> must stay on your `PATH`. The same bundle runs on macOS, Linux, and Windows.

## Prerequisites

Install these first — both are one-command installs.

| Requirement | Why | How |
|-------------|-----|-----|
| **bun ≥ 1.3** | Runs the `ditto` CLI and hooks (portable JS, not a native binary). | <https://bun.sh/docs/installation> (`curl -fsSL https://bun.sh/install \| bash`) |
| **git** | DITTO reads repo state; memory lives in git. | <https://git-scm.com/downloads> · macOS `brew install git` · Ubuntu `sudo apt-get install git` |
| **Claude Code** *(or Codex)* | DITTO is a host plugin. | <https://docs.claude.com/claude-code> |

The heavier analysis tools (CodeQL / Playwright / LSP) are **optional** and added
later — never required to get DITTO running. See [Optional tools](#optional-tools).

## Install

From the project you want DITTO to manage (a git repo), run **one line** — `npx`
pulls the source straight from GitHub (no clone, no npm publish):

```bash
npx github:incognito050924/ditto install
```

This installs the Claude Code plugin + the global `ditto` CLI and scaffolds the
project's `.ditto/`. Run it **outside** a git repo and it installs the global
plugin only — then `cd` into your project and run `ditto setup`.

### Alternative: Claude Code marketplace

Prefer the plugin marketplace? Install from the GitHub source instead:

```bash
claude plugin marketplace add incognito050924/ditto
claude plugin install ditto@ditto-local
```

Two things to know on this path:

- **Updating needs a marketplace refresh first.** The installed plugin is a
  cached copy; Claude Code only sees a new version when the plugin's `version`
  changes. Run `claude plugin marketplace update ditto-local`, then `/plugin update`.
- It **skips** the `PATH` placement of the `ditto` CLI **and** tool provisioning —
  run `ditto setup --tools` yourself afterward.

### Codex host

Codex is a supported host, but its plugin surface is built from a repo checkout:
`bun run build:codex-plugin`, then `ditto setup --host codex` and the
`codex plugin add ditto@ditto-local` command it prints (then a new Codex session).

## The setup wizard

`ditto setup` installs DITTO into one project. In a terminal it runs an
**interactive wizard**; with `--yes` (or no TTY — scripts, agents) it uses safe
defaults. The npx install runs `ditto setup` for you; run it directly when you
installed the global plugin only, or to re-apply.

```bash
cd /path/to/your/project
ditto setup                 # interactive
ditto setup --yes           # non-interactive defaults (no tool install)
ditto setup --yes --tools   # + provision detected tools
```

It asks three questions (defaults first): **Host** (`claude-code` / `codex` /
`both`) · **Analysis tools** (multi-select over *detected* CodeQL / Playwright /
LSP) · **Memory storage** (`in-project` / `separate repo`).

What it writes:

| File | Scope | Content |
|------|-------|---------|
| `~/.claude/CLAUDE.md` · `~/.claude/AGENTS.md` | global | Global behavior rules (applies to every project). |
| `<project>/CLAUDE.md` · `<project>/AGENTS.md` | project | The Agent Behavior Charter. |

It also allowlists `Bash(ditto:*)` for the project. Your existing content is
**preserved** — DITTO writes inside a `<!-- ditto:managed:start … -->` block and
backs the file up once as `<file>.ditto_bak`. Re-running **updates the block in
place** (never duplicates). Rules take effect from the **next** host session.

## Optional tools

CodeQL, Playwright/Chromium, and language servers are **opt-in** — provisioned by
the wizard's tool question or `--tools`. DITTO never auto-installs them
mid-analysis; when one is missing it **degrades honestly** instead of faking a pass:

| Tool | Used by | When absent |
|------|---------|-------------|
| CodeQL CLI | `ditto codeql review` (ACG gate) | fail-closes, blocks analysis |
| Playwright / Chromium | `/ditto:e2e` browser journeys | `result=blocked` |
| Language servers (LSP) | language-aware features | language reported unserviced (no block) |

Add them anytime: `ditto setup --tools`, or directly with
`ditto doctor codeql --install` / `bunx playwright install chromium`.

## Verify

Start a **new** Claude Code session in the project, then:

```text
/plugin            # ditto@ditto-local listed and enabled
```

```bash
ditto doctor       # binary on PATH, runtime reachable, drift check
```

A healthy install reports `ok` for `distribution`, `capability`, and `surface`.
(`permissions` / `mcp` may read `missing` / `unverified` when run inside the DITTO
repo itself — expected, since the repo is not a managed target.) `ditto doctor` is
advisory; to repair drift, re-run `ditto setup`.

## Update

```bash
npx github:incognito050924/ditto update      # plugin + global CLI + re-run setup
```

On the marketplace path instead: `claude plugin marketplace update ditto-local`,
then `/plugin update`.

## Uninstall

Removal has **two layers** — pick how far to go:

```bash
# one project only (the global plugin + CLI stay):
ditto uninstall            # strip managed blocks + allowlist; keep .ditto/
ditto uninstall --purge    # also delete .ditto/ — work-item history + memory (irreversible)

# the global host install (plugin + global ditto CLI):
npx github:incognito050924/ditto uninstall   # leaves every project's .ditto/ intact
```

`--purge` must be explicit; in a terminal `ditto uninstall` asks for confirmation
first (default: keep).

## Contributors & maintainers

Working on DITTO itself, running it from a local clone, or publishing a new
version? Those workflows live in **[DEVELOPMENT.md](../DEVELOPMENT.md)**.
