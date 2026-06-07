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
step and continues.

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

## Status & uninstall

```bash
/path/to/ditto/scripts/install.sh status                       # JSON health report
/path/to/ditto/scripts/install.sh uninstall                    # current directory
/path/to/ditto/scripts/install.sh uninstall --target /the/project
```

Uninstall reverses registration, binary placement, and the allowlist. It leaves
the target's `.ditto/` runtime data intact — that is your work-item history;
remove it manually to purge.
