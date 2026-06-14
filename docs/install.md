# Installing DITTO

> 한국어 안내는 [install.ko.md](install.ko.md)를 참고하세요.

DITTO installs as a local Claude Code plugin. One orchestrator script registers
the plugin, builds the self-contained CLI/hook binary, puts it on your `PATH`,
and scaffolds whichever project you point it at. Everything is idempotent — you
can safely re-run it.

## Prerequisites

| Requirement | Why | Notes |
|-------------|-----|-------|
| **bun ≥ 1.3** | Builds the self-contained `ditto` binary (`bun --compile`). | `node` alone can drive the installer, but the binary build needs bun. Install from <https://bun.sh>. |
| **Claude Code** | DITTO is a Claude Code plugin. | The plugin is registered into `~/.claude/settings.json`. |
| **git** | DITTO reads repo state. | Already present in any dev environment. |
| curl + unzip *(optional)* | Auto-installs the CodeQL CLI. | Used by `ditto impact` / `boundary` / `acg-review`. The step is graceful — it never fails the install. |

CodeQL and Playwright/Chromium are installed automatically when possible. Both
degrade gracefully: if a download fails, the installer prints the exact manual
step and continues. See [Dependency model](#dependency-model-codeql--playwright)
below for the details.

## Dependency model: CodeQL / Playwright

The DITTO **runtime never auto-installs heavy external tools mid-analysis.** When
one is missing it degrades honestly — this is by design (it prevents false passes).

| Tool | Used by | Runtime behavior when absent |
|------|---------|------------------------------|
| CodeQL CLI | `ditto codeql review` (ACG gate) | `doctor codeql` fail-closes and blocks analysis |
| CodeQL query packs | analysis queries | auto-downloaded at analysis time (no separate install) |
| Playwright/Chromium | `/ditto:e2e` real-browser journey | degrades to `result=blocked` (never a fake pass) |

There are **two paths** that pre-seed these tools:

1. **Install-script path** — `scripts/install.sh` pre-seeds CodeQL and
   Playwright/Chromium gracefully in steps 3b/3c. Skip with `--no-codeql` /
   `--no-playwright`.
2. **Marketplace path** — installing via `claude plugin install
   <plugin>@<marketplace>` does **not** run install.sh, so the pre-seed above
   does **not** happen. Bootstrap CodeQL with the opt-in command below.

### Install the CodeQL CLI (opt-in)

```bash
ditto doctor codeql --install
```

- **If already present**, it does nothing and returns `already-present`
  (detection order: `CODEQL_BIN` → PATH → gh extension → ditto-managed).
- **If absent**, it downloads the official CLI bundle (github/codeql-cli-binaries)
  into `~/.local/share/ditto/codeql` and symlinks `~/.local/bin/codeql`. Query
  packs are fetched on first analysis.
- **Never hard-fails**: on error it returns `failed` plus copy-paste manual
  commands (gh extension / direct bundle). It also tells you when `~/.local/bin`
  is not on your PATH. Windows advises adding the dir to PATH instead of symlinking.

> When CodeQL is missing, `doctor codeql`'s message also points at this command.
> This installer uses the **same bundle source, location, and detection** as the
> install script (step 3b) — there is only ever one ditto-managed CodeQL.

### Install Playwright / Chromium

The runtime **never auto-installs a browser** (`/ditto:e2e` returns `blocked`
when absent). To pre-seed, use install.sh (step 3c) or run it directly:

```bash
bunx playwright install chromium
```

This provides both inputs the runtime probe requires (`playwright-core` in bun's
cache + a full Chromium build in the ms-playwright cache).

## Quick start

Clone the repo, then install DITTO **into the project you want it to manage**:

```bash
git clone <ditto-repo-url> ditto
cd /path/to/your/project          # the project DITTO should manage
/path/to/ditto/scripts/install.sh # install into the current directory
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

## What the installer does

| Step | Scope | Action |
|------|-------|--------|
| 1. register | global | Patches `~/.claude/settings.json` so the local plugin loads. |
| 2. build | repo | `bun run build:plugin` → `dist/plugin/` (the deploy unit, incl. `bin/ditto`). |
| 3. place | global | Symlinks the binary onto `PATH` (`~/.local/bin/ditto`) so bare `ditto …` works. **On Windows the binary is NOT symlinked** — see the note below. |
| 3b. codeql | host | Reuses an existing CodeQL CLI or downloads it (graceful). |
| 3c. playwright | host | Pre-seeds Playwright + Chromium for `/ditto:e2e` (graceful). |
| 4. init | project | `ditto init` scaffolds the target's `.ditto/`. |
| 5. allowlist | project | Adds `Bash(ditto:*)` to the target's `.claude/settings.json` so `ditto …` never prompts. |

> When the target **is** the DITTO repo itself (self-host), the project steps
> (init / allowlist) are skipped — the repo must not be its own managed target.

### Windows note

Symlink placement (step 3) is POSIX-only. On Windows the installer builds the
binary but does **not** put it on `PATH` automatically. After installing, add
these directories to your `PATH` so `ditto` (and CodeQL) resolve:

- `<ditto-repo>\dist\plugin\bin` — the `ditto.exe` binary
- the CodeQL directory the installer reports (if CodeQL was downloaded)

The installer prints the exact directories to add. Until they are on `PATH`,
hooks and bare `ditto …` commands will not resolve.

### Options

| Flag | Effect |
|------|--------|
| `--target <dir>` (`-Target` on Windows) | Project to install into. Defaults to the current directory. |
| `--no-build` (`-NoBuild`) | Skip the binary build (reuse an existing one). |
| `--no-codeql` (`-NoCodeql`) | Skip CodeQL installation. |
| `--no-playwright` (`-NoPlaywright`) | Skip Playwright/Chromium installation. |

If the DITTO repo can't be auto-detected, set `DITTO_HOME` to the repo root
(the directory containing `.claude-plugin/plugin.json`).

## Loading the behavior rules — `ditto setup` (a step the installer does NOT run)

The installer's step 4 is `ditto init` (scaffolds `.ditto/`), not `ditto setup`.
**The behavior rules only land when you run `ditto setup`** — after install alone
the plugin surfaces (skills/agents/hooks) work, but these managed blocks are
absent:

| File | Scope | Content |
|------|-------|---------|
| `~/.claude/CLAUDE.md` · `~/.claude/AGENTS.md` | global | Global behavior rules (completion gate, fact gate, output rules, …). Applies to every project. |
| `<target>/CLAUDE.md` · `<target>/AGENTS.md` | project | The Agent Behavior Charter. |

Run it inside the target project:

```bash
cd /path/to/your/project
ditto setup
```

Host-specific setup is explicit:

```bash
ditto setup --host claude-code   # default; existing Claude Code behavior
ditto setup --host codex         # installs Codex AGENTS, marketplace, and agents
ditto setup --host both
```

For Codex, build the Codex plugin surface first:

```bash
bun run build:codex-plugin
ditto setup --host codex
```

The Codex branch copies the built plugin into
`<target>/.agents/plugins/ditto/`, writes
`<target>/.agents/plugins/marketplace.json`, and installs generated custom
agents into `<target>/.codex/agents/`. This is a **prepared** state, not an
enabled Codex plugin. `ditto setup --host codex` prints the exact follow-up
commands:

```bash
codex plugin marketplace add /path/to/your/project
codex plugin add ditto@ditto-local
```

Run those commands in the Codex home you intend to use, then start a new Codex
session. Until then, `ditto doctor capability --host codex` reports
`codex_plugin_needs_user_action` instead of rounding prepared files up to loaded
hooks/skills.

Behavior (verified by direct runs):

- **Preserves existing content**: anything already in the file stays outside the
  managed block (`<!-- ditto:managed:start … -->`), and the first application
  creates a `<file>.ditto_bak` backup.
- **Idempotent**: re-running updates the block in place, never duplicates it.
- **Removal**: `ditto teardown` strips only the managed blocks and keeps user
  content.
- The loaded rules take effect from the **next** host session.

> Under self-host (target = the DITTO repo itself) setup is skipped entirely.
> When dogfooding inside the DITTO repo and you only need the **global** blocks,
> run `ditto setup` once in any other project (a scratch directory works) — the
> global files land in the same place regardless of the target.

## Marketplace install/update path

Instead of install.sh you can install through the Claude Code plugin
marketplace (GitHub source or a local `dist/plugin` directory source):

```bash
claude plugin marketplace add <owner>/<repo>     # or a local dist/plugin path
claude plugin install ditto@ditto-local
```

Two traps on this path (both reproduced directly):

1. **Updates require `marketplace update`.** The installed plugin is a **copied
   cache** (`~/.claude/plugins/cache/…`). After the source changes
   (push/rebuild) it stays stale until you run
   `claude plugin marketplace update ditto-local`. The version is pinned
   (0.0.0), so `claude plugin update` is a no-op.
2. **`install` on an already-installed plugin is a no-op.** It ends with
   "already installed" without refreshing the cache. To refresh, run
   `claude plugin uninstall ditto@ditto-local`, then `claude plugin install`
   again.

This path also skips the installer's steps 3b/3c (CodeQL/Playwright pre-seed)
and `PATH` placement — use the opt-in commands from the
[dependency model](#dependency-model-codeql--playwright) above.

## Verify

Start a **new** Claude Code session in the target project, then:

```text
/plugin            # ditto@ditto-local listed and enabled
```

```bash
ditto doctor       # binary on PATH, runtime reachable
```

A healthy install reports `ok` for `distribution`, `capability`, and `surface`.
`permissions` / `mcp` may report `missing` / `unverified` when run inside the
DITTO repo itself — that is expected, since the repo is not a managed target.

## Per-session wrapper (no persistent settings)

If you'd rather not patch `settings.json` persistently, load DITTO for a single
session via the assembled product surface:

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

Then `ditto-claude` launches Claude Code with DITTO loaded for that session
only. Run `bun run build:plugin` first if `dist/plugin` is absent. The
`--plugin-dir` points at `dist/plugin` (the assembled product surface), never
the repo root, so source and dogfooding state never leak in.

## Updating & dogfooding

The installed plugin reads `dist/plugin/` — a **copy** of the source assembled
by `build:plugin`, not the source tree itself. And Claude Code loads plugins
only at **session start** (no hot reload). So two things are always true:

1. After changing source, `dist/plugin` must be **rebuilt**.
2. A **new Claude Code session** is needed to pick up the rebuild.

DITTO automates step 1 so you rarely run it by hand:

- **Git hooks (multi-PC sync).** `post-merge` and `post-checkout` rebuild
  `dist/plugin` automatically after `git pull` / merge / branch switch. They are
  graceful (a build failure never blocks git) and activate via `bun install`
  (the `prepare` script points `core.hooksPath` at `.githooks/`). So on any PC:
  `git pull` → auto-rebuild → start a new session.
- **Dev launcher (local loop).** `bun run dev:plugin` rebuilds and launches
  Claude Code with the fresh `dist/plugin` in one step. The optional
  `ditto-claude` wrapper (below) does the same as a shell function.

Either way the rebuild lands at session start — there is no in-session reload.
If you ever need it manually: `bun run build:plugin`.

> **Verified.** The auto-rebuild firing on real `git merge` and `git checkout`
> (and the skip guard for file checkouts / same-commit switches) was confirmed
> by running them. Not yet verified on Windows (`install.ps1`); and a new
> session is still required to actually load the rebuilt plugin.

## Status & uninstall

```bash
/path/to/ditto/scripts/install.sh status                       # JSON health report
/path/to/ditto/scripts/install.sh uninstall                    # current directory
/path/to/ditto/scripts/install.sh uninstall --target /the/project
```

Uninstall reverses registration, binary placement, and the allowlist. It leaves
the target's `.ditto/` runtime data intact — that is your work-item history;
remove it manually to purge.
