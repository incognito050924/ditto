---
name: tech-spec
description: Co-author a structured tech-spec document with the user — the agent drafts sections from codebase/memory/ACG evidence and the user reviews increments — producing an agreed spec (change boundaries, observable acceptance criteria, risks) that later compiles into intent.json. Use for PATTERN-1-style work where a briefing/spec document should be agreed before implementation. Complement to deep-interview (same surface layer, not a replacement); do not force it on small reversible requests.
argument-hint: "[--mode=stepwise|oneshot] [topic]"
---

# Tech Spec

Co-author the briefing document a PATTERN-1 user would otherwise write alone. The agent fills sections from codebase / memory / ACG investigation; the user spends effort on *review and value decisions*, not on writing. The document is the **single source**; `intent.json` is a compile artifact produced only at finalize — one-way, never synced back.

Design source: `reports/design/tech-spec-surface-design.md` (§2 flow, §5 non-goals, §8 hints). Template: `"${CLAUDE_PLUGIN_ROOT}/skills/tech-spec/TEMPLATE.md"`. Mechanism is in code: `ditto tech-spec {start,record-section,finalize}` enforces the schema, the evidence gate, and the compile.

## When to enter

- The user wants a spec / briefing / scope document before implementation, or asks a consulting question that should end as an agreed spec.
- The work is large or risky enough that change boundaries (비목표), observable acceptance criteria, and risks deserve explicit agreement.

Do NOT enter for small reversible requests (same principle as deep-interview — never promote light work into a heavy workflow). Intent is allowed to be clear: unlike deep-interview, no ambiguity is required to enter.

## Document location & start

Instantiate the template at `.ditto/specs/<slug>.md` (`<slug>` = short kebab-case of the feature name). This is the project-global, git-tracked tier (ADR-0012 tier ②) — the doc is a team consensus medium, so it is committed and shared, unlike `.ditto/local/` personal trails.

Then register the machine state (for `<wi>` = the active work item id):

```
"${CLAUDE_PLUGIN_ROOT}/bin/ditto" tech-spec start --work-item <wi> --doc .ditto/specs/<slug>.md --mode stepwise --output json
```

## Mode

`--mode=stepwise` (default) | `--mode=oneshot`. The mode changes the writing/review **rhythm only** — pre-mortem triggers, deep-interview entry conditions, and finalize gates are mode-invariant.

- **stepwise (default)**: one section at a time, in template order — draft → user review/feedback → revise (repeat as needed) → user confirms → next section. Never run ahead of an unconfirmed section.
- **oneshot (explicit opt-in only)**: draft the full document at once, then propose ONE integrated review; the user may skip it. Skipping is the user's decision — record it, never present a skipped review as agreement.
- Mixed use is allowed: after a oneshot draft, revisions of specific sections follow the stepwise rhythm (mode applies per revision request).
- Track per-section review state (`reviewed`/`skipped`) as you go; finalize records this coverage, and the "agreed source" claim only holds for reviewed sections.

## Consulting discipline (QuestionGate)

- Spec questions ("which table? which field? what does the current code do?") are answered by the agent from code / docs / `ditto memory query` / ACG artifacts — never bounced to the user. The user is asked only to **review increments** and to decide what only the user can decide (product value, domain meaning, irreversible trade-offs).
- Exploration, investigation, and bulk analysis go to a `ditto:researcher` subagent; take back conclusions + evidence only. The drafting/review loop itself stays in the main session — it shares the consensus context with the user and must not be split.
- Sections carrying codebase/project facts (배경, 영향도 등) cite their evidence inline: memory query `projection_id` (+freshness), ACG artifact path, or `file:line`. Do not treat a `stale` memory answer as settled — re-project or fall back to direct exploration.
- Record every section increment with `record-section`. For the factual sections (`background`, `impact`) the grounding evidence is **schema-required** — the call is rejected without it (fail-closed pull gate, ac-9):

```
"${CLAUDE_PLUGIN_ROOT}/bin/ditto" tech-spec record-section --work-item <wi> --json '{
  "section": {"id": "background", "review": "reviewed",
    "evidence": [{"kind": "memory", "projection_id": "…", "freshness": "fresh"}]}
}' --output json
```

  `review` is `reviewed` only after the user actually confirmed the section; `skipped` when the user chose to skip (oneshot); otherwise `pending`. This coverage feeds finalize's honest review record.

## Pre-mortem (three fixed points)

1. **Right after the 배경·목표 draft**: "If this understanding is wrong, where is it wrong?" — fix the draft or record the doubt in §7.
2. **On every 비목표/AC increment**: "Shipped and broke in 3 days — what was the cause?" Each answer is promoted to an AC (§6), pushed to 비목표 (§5), or left in §7 as an unknown; flag irreversible / blast-radius risks explicitly. Results accumulate in §7 위험 — this is per-increment, not a one-time ceremony.
3. **Before finalize**: deep-interview's own pre-mortem converges on the accumulated §7 — it consumes the ledger, it does not duplicate it.

## Deep-interview synthesis

When intent-level ambiguity meets the **existing** deep-interview entry conditions (`skills/deep-interview/SKILL.md` "When to enter"), call deep-interview internally — unchanged: same gates, same question budget, same finalize contract (zero diff). Record the process and result as a summary + link in §12 인터뷰 기록 (original stays in `interview-state.json`). If an interview happened, its readiness gate must pass before finalize — never bypass it. If no ambiguity is detected, no interview happens; do not force entry.

## Finalize

When the document is agreed (and the pre-mortem ledger is converged), compile it:

```
"${CLAUDE_PLUGIN_ROOT}/bin/ditto" tech-spec finalize --work-item <wi> --json '{
  "risk": {"non_local": false, "irreversible": false, "unaudited": false},
  "user_confirmation": {"confirmed": true, "statement": "<the user's own words confirming the spec matches their intent>"}
}' --output json
```

This single call, fail-closed at every gate:

1. Compiles `intent.json` from the document (요약→`goal`, 목표→`in_scope`, 비목표→`out_of_scope`, AC 표→`acceptance_criteria`, 위험의 unknown 행→`unknowns`). Missing required sections, duplicate AC ids, or evidence kinds outside `test|diff|doc|browser|log` reject the compile with the defect location — fix the document, never bypass.
2. If an interview happened, its readiness gate must already pass (`interview_not_ready` otherwise — never bypass it). No interview at all is fine (no forced entry).
3. Requires the user confirmation (2차 게이트, mode-invariant): `confirmed=true` with the user's own words, else `not_confirmed` and nothing is written.
4. Stamps `source_digest` (sha256 over the compile-input sections 요약·목표·비목표·AC·위험) into `intent.json`, records per-section review coverage into `tech-spec-state.json`, mirrors the AC into the work item, and bootstraps autopilot.

After finalize, editing a compile-input section of the document makes `ditto autopilot next-node` return `blocked` (digest mismatch) until you re-run finalize — content fields derive from the doc, so the doc and the contract never silently diverge. Risk axes (`risk.*`) are your judgment from §7/§9 of the doc; any `true` routes autopilot through its approval gate.

## Hard rules

- Default mode is stepwise; oneshot only via explicit parameter. Never default to oneshot.
- Never ask the user a spec question answerable from code/docs/memory — the user reviews, the agent researches.
- Never modify deep-interview's contract, gates, budget, or finalize (zero diff — guarded by its contract tests).
- Never hand-edit `intent.json` or build any document↔intent sync path.
- Never skip pre-mortem or the finalize intent confirmation, in any mode.
- Never present a skipped review as agreement — coverage is recorded honestly.
- Keep the user-facing surface capped: this one skill + one template. Propose new mechanisms in the design doc, not as new surfaces.
