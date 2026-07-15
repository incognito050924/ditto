---
name: handoff
description: Carry forward the minimal context for another session/agent/author to pick up the SAME work, and — at resume — DISCOVER and CONSUME pending handoffs explicitly. Produce with `ditto handoff write` (session scope) or `ditto work handoff <id>` (work item). Resume by pulling — run `ditto handoff list` then `ditto handoff consume <id>`. Nothing is auto-injected. Use at context pressure, session end, agent switch, a long-task checkpoint, or the start of a resumed session.
argument-hint: "resume → list then consume <id>; produce → write or work handoff <id>"
---

# Handoff

Produce the minimal, sufficient context for whoever continues the work next, without re-deriving intent. A handoff is a context carry-forward, orthogonal to the completion contract — handing off and completing are separate acts.

Discovery and consumption are **explicit pull, always**. No hook injects a handoff body into context, and none notifies you that one is waiting. A handoff you don't `list` is a handoff you never see.

## At resume: pull pending handoffs FIRST (do this, every resumed session)

**RUN `ditto handoff list` at the start of any resumed session. Then `ditto handoff consume <id>` the one(s) you continue.** This is a required step, not a suggestion: nothing auto-injects a prior handoff, so if you skip `ditto handoff list` you resume blind and re-derive intent you were handed. (This is exactly what invoking `/ditto:handoff` at resume does — list, then consume what you pick up.)

1. `ditto handoff list` — every pending LOCAL handoff, plus any file that failed to parse (surfaced, never silently dropped). Each row's **id** is what you pass to `consume`/`show`.
2. `ditto handoff consume <id>` — load that handoff's body on-demand and record a consumed-marker. Consume ONLY the ones you actually continue; a body pulled is a body you are expected to act on.
3. `ditto handoff show <id>` — a read-only view (no marker) when you only want to look.

Consume is **soft**: it returns the body and writes a per-recipient consumed-marker but does NOT move or delete the file (`ditto handoff consume` is safe to lose — a failed resume never drops the handoff). The only hard local cleanup is the age-sweep (below).

## Produce a handoff

Capture the same minimal context regardless of scope:
1. Original user intent, current state, decisions already made, and changed files. **Done when** all four are recorded.
2. Verification evidence rendered inline (summary / hash / command / exit code) so it travels without the raw artifacts; if raw artifacts are absent from this clone, set `artifact_available: false`. **Done when** each evidence claim reads standalone from the body.
3. Failed/unverified items, open threads, and the single first thing the next agent should check. **Done when** the first-check is named explicitly.
4. The scope creep to forbid. **Done when** the resume target keeps the same `autopilot_id` and the full scope, even though this turn ran out.

Two producers, by whether the work is anchored to a work item:

- **Session / author scope (no work item):** `ditto handoff write --session <id> --intent <original intent> --from <where written> --state <where things stand> --next <first thing to check>` (add `--autopilot <id>` when resuming a run; omit `--session` to generate one). This fills the gap where you have context to carry but no work item to hang it on.
- **Work item scope:** `ditto work handoff <id>` — unchanged. It writes an active handoff on a non-pass item; a pass item goes straight to archive (keeping `list` quiet). PreCompact also writes a work-item handoff automatically before compaction. Both land in the same store `ditto handoff list` reads.

## Storage: two tiers by where the handoff travels

`.ditto/local/` is gitignored and does not cross machines; git-tracked paths do. The handoff store splits on exactly that:

| Tier | Location | Reaches | Written by |
|------|----------|---------|------------|
| **Local** (personal) | `.ditto/local/handoff/<id>.md` (work item) or `.ditto/local/handoff/session__<sid>.md` (session) | **This machine**, the next session/agent | `ditto handoff write`, `ditto work handoff <id>`, PreCompact |
| **Remote** (committed) | `.ditto/handoff/<scope>__<author>.md`, **committed to the work branch** | Whoever `git fetch`/`checkout`s that branch (another machine/author, same-branch continuation) | committed on the work branch — one file per scope AND author, so concurrent authors never share (and never overwrite) a single doc |

The format is a one-line JSON frontmatter (machine round-trip) + a human-readable body.

The remote tier replaces the old single root `HANDOFF.md`-overwrite habit: instead of every author clobbering one shared file, each writes a **separate per-scope, per-author file** on the work branch, so nothing is mixed or lost. A remote handoff is **never auto-pushed** — producing it is a local commit only; pushing the branch (a user-gated act) is what actually delivers it. Frame a remote handoff against the **code** (charter §4-11), not against local record state that will not exist on the other clone; secrets are token-scrubbed before commit because git history is irreversible.

## Cleanup: soft consume now, hard cleanup separately

- **Consume never hard-cleans.** It records a marker only. So a resume that consumes and then fails does not lose the handoff.
- **Local hard cleanup = the age-sweep.** An active local handoff older than 7 days is **moved into `archive/` (move-not-delete)** — out of `list` so it stops lingering, yet kept for audit. This is the sole hard local path.
- **Remote cleanup = a per-recipient local marker only.** Consuming a committed remote handoff writes a marker under `.ditto/local/handoff/consumed/` so YOUR future `list` excludes it. It never git-deletes, commits, or pushes — the committed file stays in history for other recipients (§4-8: no auto-push, no team-wide delete).

## Output contract

- A `handoff` artifact conforming to the handoff schema (§6.10), written through `HandoffStore` (never a hand-authored doc).
- The resume target keeps the same `autopilot_id`; scope stays as agreed even when this turn ran out.
- Discovery and consumption stay explicit: `ditto handoff list` → `ditto handoff consume <id>` (or `/ditto:handoff`). No hook injects or announces a handoff.
