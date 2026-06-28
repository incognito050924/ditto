---
name: handoff
description: Write the minimal context for another session or agent to pick up the same work. Two modes — `--local` (default; same machine, next session) and `--remote` (different machine; commits a git-tracked HANDOFF.md). Use at context pressure, session end, agent switch, or a long-task checkpoint.
argument-hint: "[--local | --remote] [work-item-id]"
---

# Handoff

Produce the minimal, sufficient context for whoever continues the work next, without re-deriving intent. A handoff is not completion — it is orthogonal to the completion contract.

## Pick the mode first

The two modes differ by **where the handoff travels**, because `.ditto/local/` is gitignored and does not propagate across machines.

| Flag | Target | Reaches | Use when |
|------|--------|---------|----------|
| `--local` (default) | `.ditto/local/handoff/<id>.md` | **Same machine**, next session/agent | Continuing on this PC — context pressure, session end, agent switch, checkpoint |
| `--remote` | git-tracked `HANDOFF.md` at repo root, **committed + pushed** | **Another machine** (via `git fetch`) | Switching PCs / clones — `.ditto/local` will NOT come along |

Rules for choosing:
- No flag → `--local`.
- The user said "다른 PC / cross-PC / another machine / 컴퓨터 바꿔" → `--remote`.
- The user said "로컬 / 이 세션 / same PC / 다음 세션" → `--local`.
- If still ambiguous, ask which machine picks this up — the two modes write to different places and only one propagates.

---

## Mode: `--local` (default) — same machine

The next session on **this** machine continues the SAME work item (same `autopilot_id`).

### Procedure
1. Capture: original user intent, current state, decisions already made, changed files.
2. Render verification evidence inline (summary / hash / command / exit code) — never assume raw artifacts travel. If raw artifacts are absent from this clone, set `artifact_available: false`.
3. List failed/unverified items, open threads, and the single first thing the next agent should check.
4. State the scope creep to forbid.

### Storage, auto-read, auto-cleanup
Handoffs live in a single work-item-independent location, **not** under each work item:
- `.ditto/local/handoff/<work-item-id>.md` — **active**, waiting to be picked up.
- `.ditto/local/handoff/archive/<id>__<ts>.md` — consumed, or a completed (pass) handoff that needs no pickup.

The format is a one-line JSON frontmatter (machine round-trip) + a human-readable body. The CLI writes through this store: `ditto work handoff <id>` writes an active handoff on a non-pass item, and a pass item goes straight to archive (no active noise). PreCompact writes an active handoff automatically before compaction.

**Auto-read**: the next session does NOT need to be told a filename. The UserPromptSubmit hook reads every active handoff in `.ditto/local/handoff/`, injects its body into context, then moves it to archive — so a handoff is picked up exactly once and `active` never accumulates. Do not paste handoff paths into prompts; just continue.

**Stale sweep**: a handoff that no session ever picks up would otherwise re-inject into an unrelated session's context forever. So on both prompt (consume) and work-done, any active handoff older than 7 days is **moved into `archive/` (move-not-delete, never pruned)** — out of `active`, so it can never re-inject, but preserved for audit.

### Output contract
- `handoff` artifact conforming to the handoff schema (§6.10), written through `HandoffStore`.
- Resume target keeps the same `autopilot_id`; scope is never narrowed because "this turn ran out".

---

## Mode: `--remote` — different machine

`.ditto/local/` (host memory, work-item records, runtime state) is gitignored and will **not** exist on another PC. The only thing that crosses machines is what git tracks. So a cross-PC handoff is a git-tracked document, and it is **committed and pushed** — otherwise it never reaches the other machine.

Because the records don't travel, frame the handoff against the **code** (charter §4-11: code is the authority), not against work-item record state. "Close this WI record" is meaningless on a fresh clone; restate remaining work in code terms.

### Procedure
1. Write/refresh `HANDOFF.md` at the repo root. Keep it as the single living cross-PC handoff (overwrite the stale one; do not accumulate dated copies). Include:
   - **Propagation state first** — branch/SHA to resume from, any history rewrite (`git reset --hard origin/main` vs plain pull), what does NOT travel (`.ditto/local`: which records are absent on the new PC).
   - **Landed this session** (pushed commits, one line each with SHA).
   - **Next candidates, in code terms** — each must be re-confirmed fresh (grep/test) on the new PC; mark the handoff body as non-authoritative.
   - **Gotchas** — build/invoke (`bun run build:bin` → `./bin/ditto`, `DITTO_SKIP_HOOKS=1` prefix, `.githooks` commit gate), and any trap that bit this session.
2. Stage and commit: `git add HANDOFF.md` then commit with `docs(handoff): <one-line> (비코드)`. Keep it a standalone commit — do not let unrelated working-tree changes leak in.
3. Push: `git push origin <branch>`. The fetch on the other PC is the actual handoff.

### Guards
- The commit/push lands on the current branch (usually `main`); confirm you are on the intended branch before pushing.
- A normal `git push` is fine; **force-push to the default branch is blocked** by the DITTO PreToolUse hook — if history was rewritten, say so in HANDOFF.md and let the user run it.
- `--remote` writes a human-readable doc, NOT the handoff schema artifact. It is a complement to `--local`, not a replacement: use `--local` for same-PC pickup and `--remote` to cross machines.

### Output contract
- Updated, committed, and pushed `HANDOFF.md` reachable by `git fetch` on another machine.
- Remaining work stated in code terms (re-confirm fresh), since `.ditto/local` records do not propagate.
