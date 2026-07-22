---
name: handoff
description: Hand the SAME work to the next session/agent/PC as a user-initiated 1:1 ephemeral baton — compressed context + destination + current state. Produce with `ditto handoff write` (required --intent/--from/--state/--next plus rich repeatable flags); pick up at resume with `ditto handoff consume [id]`, which returns the body exactly once and DELETES the baton (first-consumer-wins). Batons live as commits on the hidden ref `refs/ditto/handoffs` and auto-sync with origin (refs/ditto/* only). NEVER automatic — no hook writes or injects one. Use only when the user hands work off: context pressure, session end, agent switch, long-task checkpoint.
argument-hint: "resume → consume [id]; produce → write --intent … --from … --state … --next …"
---

# Handoff

A handoff is a **user-initiated 1:1 ephemeral baton**: the minimal sufficient context (original intent + current state + destination's first check) for whoever continues the SAME work, without re-deriving intent. It is orthogonal to completion — handing off and completing are separate acts, and scoring/status transition is exclusively `ditto work done`'s job (the baton carries context, never verdicts).

**A handoff is NEVER automatic.** Only an explicit user act produces one. PreCompact writes nothing (`src/hooks/pre-compact.ts` is an intentional no-op), and a non-pass close does NOT auto-issue a baton. An automatically produced handoff is, by definition, not a handoff (ADR-20260722-handoff-hidden-ref-baton).

## At resume: consume when you resume (do this, every resumed session)

**RUN `ditto handoff consume` at the start of any resumed session.** This is a required step, not a suggestion: nothing auto-injects a prior baton, so if you skip consume you resume blind and re-derive intent you were handed. There is no inbox and no listing step — the flow is "consume when you resume", not "browse then pick":

1. `ditto handoff consume` (no id) — exactly one pending baton auto-resolves and is delivered; zero prints a clean "No pending handoff batons."; several prints the pending set and exits 65 so you re-run naming one (`ditto handoff consume <id>`) — a disambiguation, never a prompt.
2. **Consume ONLY the baton whose work you actually continue.** Consume is destructive: the body is returned exactly once, gated on a deletion commit (first-consumer-wins, gone for every worktree of this repo, propagated cross-PC by auto ref sync). A body consumed is a body you are expected to act on — there is no re-consume.
3. `ditto handoff show [id]` — read-only peek when you only want to look (no deletion, no sync).

A racing second consumer gets a distinct `already_consumed` refusal ("another session/worktree won"), not an error — that is the 1:1 semantics working, not a fault.

**Explicit pull, always.** No hook injects a baton body or a "baton waiting" notice into context. The only injected hint is the active work item's `re_entry.command` resume hint (a work-item field set by parking `work done --status partial|blocked`, unrelated to batons — `src/hooks/user-prompt-submit.ts:259-261,317-318`). Discovery is you running consume/show.

## Produce a baton

```
ditto handoff write --intent "<original user intent>" --from "<where this is written>" \
  --state "<where things stand>" --next "<single first thing to check>"
```

All four are required (missing → exit 65). Scope with `--work-item <id>`, or session scope via `--session <id>` (omitted → a safe generated id). Add `--autopilot <id>` when the next session resumes a run — the resume target keeps the same autopilot_id and the full agreed scope, even though this turn ran out.

Carry the decisive context inline with the repeatable rich flags — the baton is rich free text, not a summary+pointer:

- `--decision "<made this session>"` — decisions_made
- `--critical "decision::rationale"` — non-rederivable decisions, rationale INLINE
- `--risk "risk::why"` — irreversible risks, why INLINE
- `--open "<open thread>"` / `--next` — uncertainty and the first check
- `--forbid "<scope creep to forbid>"` — the resume keeps the agreed scope
- `--evidence "<inline note>"` / `--changed <path>` — verification evidence rendered standalone, changed files

Done when intent, decisions (critical ones with rationale), irreversible risks, and open threads/uncertainty are all in the body. Frame the baton against the **code** (charter §4-11), not against local state that will not exist on the other clone.

## Transport: one hidden ref, auto-synced

- **Single store = `refs/ditto/handoffs`.** A baton is a commit on that hidden ref — no working-tree file, no branch commit, invisible to `git branch`. Refs are per-repo, so every linked worktree shares the same batons.
- **Auto-sync under the standing grant.** `write` pushes the baton and `consume` pushes the deletion to origin without asking — covered by the durable standing push grant in ADR-20260722-handoff-hidden-ref-baton, scoped to **refs/ditto/* only, origin only** (baton push, deletion push, retention lease-push — nothing else). No code branch or tag is ever covered. Remote contact fires only from explicit handoff commands, never from hooks or the autopilot tick.
- **Visibility gate is FAIL-CLOSED.** Auto-push is refused unless the repo is proven private ('unknown' counts as public — pushed history cannot be un-published). `--push-public` is the explicit opt-in for a public/unknown remote.
- **Secret scrub is fail-closed, twice.** The body is token-scrubbed before any git object exists, and the push gate additionally DETECT-AND-REFUSES secret-shaped content in anything it would transmit (never scrub-and-proceed) — a refusal names the offending baton; rewrite or consume it, or run the purge recall if it already sits in local ref history.

## 1:1, honestly

- **Within one repo (all its worktrees): atomic.** The update-ref CAS lets exactly one consumer win; losers get `already_consumed`.
- **Cross-PC: online-first-push-wins.** An ONLINE consume is finalized by pushing the deletion commit BEFORE the body is emitted. An OFFLINE consume succeeds locally but warns loudly: the remote baton still exists, another PC may consume it too until the deletion syncs — **at-most-duplicated, never lost**. Across an offline window the guarantee is delivery without loss, not strict 1:1; the warning surfaces the open re-consume window.

## Offline semantics

Local operations always succeed. A failed push/fetch degrades to local success + a loud class-preserved warning (offline vs a DISTINCT persistent-auth warning) + a durable jsonl log, and is retried on the NEXT handoff command. Every handoff command re-surfaces a pending-unpushed warning until origin has your baton state — an unsynced baton can never silently scroll away.

## Retention and recall

Ref history is truncated at push time to max(7 days, 50 commits); truncation never touches the tip TREE, so pending batons always survive. For an undetected secret that already synced, the recall path (`purgeHandoffHistory`) rewrites history to a single root carrying the current tip tree and lease-pushes it, cutting the leaked blob out of remote history.

## Output contract

- The baton conforms to the handoff schema and is written through `ditto handoff write` (never a hand-authored file or ref surgery).
- Consumption stays explicit and destructive: consume only what you continue; `show` for looking.
- The resume target keeps the same autopilot_id and the full agreed scope.
