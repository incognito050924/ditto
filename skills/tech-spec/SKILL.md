---
name: tech-spec
description: Co-author a structured tech-spec document with the user — the agent drafts sections from codebase/memory/ACG evidence and the user reviews increments — producing an agreed spec (change boundaries, observable acceptance criteria, risks) that later compiles into intent.json. Use for PATTERN-1-style work where a briefing/spec document should be agreed before implementation. Complement to deep-interview (same surface layer, not a replacement); do not force it on small reversible requests.
argument-hint: "[--mode=stepwise|oneshot] [topic]"
---

# Tech Spec

Co-author the briefing document a PATTERN-1 user would otherwise write alone. The agent fills sections from codebase / memory / ACG investigation; the user spends effort on *review and value decisions*, not on writing. The document is the **single source**; `intent.json` is a compile artifact produced only at finalize — one-way, never synced back.

Template: `"${CLAUDE_PLUGIN_ROOT}/skills/tech-spec/TEMPLATE.md"`. Mechanism is in code: `ditto tech-spec {start,record-section,finalize}` enforces the schema, the evidence gate, and the compile — the code and this SKILL are the source of truth (no separate design doc to drift from).

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

## Expert elicitation — good questions (always on)

The agent does the expert's legwork: bring the considerations a seasoned practitioner of *this* task would raise, with evidence, so the user sees what they would have missed. This is core behavior, not an opt-in mode — it runs whenever you draft, so output quality does not depend on the author's expertise. "Reduce the user's cognitive cost" means the agent carries the legwork (surfacing grounded considerations), never that the agent decides intent or value.

- **Characterize the task first.** Work out what the user is actually doing and in which domain (codebase, `ditto memory query`, domain knowledge), then **generate that domain's expert considerations on the spot** — abstraction level, tech-stack choice, deployment, versioning, UI/UX, security, and beyond. No fixed checklist: considerations are generated per task (the task may not even be software).
- **A good question has three properties:**
  1. **Blind-spot** — never ask what the user already decided; fire where an expert would have looked but the spec is silent.
  2. **Perspective-shift / expansion** — go beyond filling a missing slot: open a different angle that widens the problem/solution space and lets the answerer see what they could not. A question that only fills gaps has decayed into a checklist. ("Make them see what they don't see" = surfacing omissions **and** opening new perspectives.)
  3. **Orientation** — anchor to the goal so direction is never lost. Paired with #2: the standard is "expand without scattering," not "always narrow to a decision." The question carries "what changes depending on the answer."
- **Separate facts from decisions.** Facts (which considerations apply) the agent self-answers from code/domain; the user gets only the **decision**, as an oriented question — e.g. "Path X goes through JWT; does this feature enforce that too, or is public access intended?"
- **Boundary:** expansion is *intellectual reframing within the goal*, not business ambition. No "what's the 10x version?" — expansion makes the user *see* farther, it does not inflate the goal.

*How* these questions are produced — fanned out to fresh generators and chosen by a scoring gate, not generated inline in your accumulated context — is the next section.

## Question generation workflow (multi-agent)

The three properties above define *what* a good question is; this defines *who makes and picks them*. Generating questions inside the driver's long, accumulated context fails two ways at once (the two failure modes the charter §4-9 separates): **bias** — your narrative acts as a prior — and **context rot** — quality degrades non-uniformly as the transcript grows. So generation is pulled out of the driver into fresh, minimal-context subagents.

**Three roles**:

1. **driver (you)** — orchestrate the loop. Keep your own context bound: work from the compressed source (the spec doc + the fixed facts/decisions ledger + the §12 summary), not the growing transcript; reset a long session via handoff. Rot discipline is for the driver too, not only the generators.
2. **`ditto:question-generator` × N (parallel, fresh each round)** — fan out N generators (N = the resolved `--generators`, default 2, range 1..6), each with **only** the minimal packet `{fixed facts & decisions, project status/environment, current draft / target empty section}`. Excluded: the interview narrative and your own guesses — that exclusion is the anti-bias mechanism. Independent generators cover each other's blind spots.
3. **`ditto:question-gate` (fan-in)** — one gate over the pooled candidates; it scores (consensus / quality / necessity / answer_value) and selects, or signals dry.

**Mechanical constraint**: ditto subagents cannot spawn sub-subagents (single-level delegation). So the gate does not call the generators — **you** fan out the generators, collect candidates, then hand the pool to the gate. The logical roles are as above; only the caller is the driver.

The loop is tuned by the **resolved question-config** persisted at `tech-spec start` (`question_config` in `tech-spec-state.json`): `intensity` (the unified dial — derives the gate `threshold`, `granularity`, and per-round count hint), `generators` (fan-out N), `gate_mode` (`confirm` default, or `draft`), `generator_effort`, and the opt-in caps `max_questions`/`max_rounds`. The `--performance` presets (glance/quick/standard/deep/exhaustive) just expand to these. **Get this round's resolved values from `ditto tech-spec next-round --work-item <wi>`** — don't re-derive tuning in your accumulated context — and obey them. Defaults reproduce current behavior.

A developer can set per-option defaults in their own `.ditto/local/config.json` under `tech_spec.question` (a `RawQuestionConfig`-shaped block: any of `performance`, `intensity`, `generators`, `generator_effort`, `gate_mode`, `max_questions`, `max_rounds`, `threshold`, `granularity`). These defaults apply when the matching CLI flag is absent; an explicit CLI flag still wins. So you normally just run `tech-spec start` (no flags) and obey the resolved `question_config` — it is config-driven and **authoritative** (generators count, intensity-derived threshold, opt-in cap, gate mode). This file is per-developer (`.ditto/local/` is gitignored), not team-shared; a missing or malformed config falls back to built-in defaults (fail-open).

**Control loop (per round, score-based termination)**:

0. **Get this round's levers + cap signal**: `"${CLAUDE_PLUGIN_ROOT}/bin/ditto" tech-spec next-round --work-item <wi>` → `{round, generators, threshold, granularity, count_hint, gate_mode, generator_effort, rounds_so_far, questions_so_far, cap_reached, cap_reason}`. **If `cap_reached` is true, stop the loop now** — the user-set `max_rounds`/`max_questions` ceiling is hit. Otherwise use the returned levers for the steps below.
1. Fan out N generators (N = the returned `generators`, default 2), passing each the current minimal packet **plus the returned `generator_effort` and `granularity`** — each generator obeys those two dials per `agents/question-generator.md` (effort = grounding depth, granularity = how finely the section splits into questions) → collect candidates.
2. Spawn the gate with the pool, handing it the returned `threshold` + `count_hint` → it returns `{selected, dry, all_scored}`.
3. Record the round: `"${CLAUDE_PLUGIN_ROOT}/bin/ditto" tech-spec record-round --work-item <wi> --json '{"round": <n>, "dry": <bool>, "selected": [...], "all_scored": [...]}'` — appends the gate's scores to the durable trail (`tech-spec-rounds.jsonl`), which is also what `next-round` counts for the cap. `ditto doctor intent-quality` reads them as the question-VALUE signal (next to the deep-interview question-COUNT signal).
4. If `selected` is non-empty, handle it per the resolved `gate_mode` (the gate itself never asks the user — this is the driver's step):
   - **`confirm` (default)** — ask the user those questions **in the main session** → fold their answers into the fixed-facts ledger.
   - **`draft`** — for each selected question, if you can answer it confidently from code/domain grounding, write that **provisional answer with its evidence** into the fixed-facts ledger and proceed unattended. But any question whose answer is an **irreversible, product-value, or domain-meaning** call still goes to the user — `draft` cuts interaction, it does **not** hand value judgments to the agent (charter §4-2/§4-8).

   Then → back to step 0 with a refreshed packet.
5. End the round/interview when `dry` (no candidate cleared the `threshold`) **or** when step 0 reports `cap_reached`. `dry` is the **primary** terminator — caps are opt-in (default 0 = unlimited), so by default termination stays purely score-based. Termination is **score-based, not a fixed question count** — it sits where deep-interview's readiness termination sits, but on value-score, while deep-interview itself stays zero-diff.

**What code enforces vs. what you judge** (do not collapse the two): `next-round`'s `cap_reached` is the *only* deterministic gate — a count of rounds/questions, obeyed mechanically. The **quality dial** (`threshold`, `granularity`, `count_hint`, and the `intensity` behind them) is *not* mechanically quantifiable, so `next-round` only **relays** it and the gate honors it with **judgment**: use the `threshold` as an anchor for "is this question meaningful at this intensity," never as a hard score cut that discards a genuinely good question, and never let a cap truncate a round that still has un-exhausted (`dry=false`) value before its ceiling. Forcing quality into a deterministic score would degrade the elicitation — that split is deliberate.

N (fan-out) and the selection threshold are now **resolved from the question-config** — `--generators` defaults to 2 (range 1..6) and the threshold is intensity-derived (`--threshold` overrides). The defaults preserve current behavior; adaptive thresholds and budget-linked N beyond this dial are later increments. Output discipline still applies — generators emit raw question text as internal tooling, but only resolved conclusions reach the document.

## Critique axis — continuous pre-mortem

A standing critique runs the whole time, so the skill never decays into a form to fill in. It targets two things, **every increment** — not a one-time finalize ritual:

1. **The user's answers** — wrong, ambiguous, or incomplete? An answer arriving does not end the loop; the critique re-checks it for consistency and sufficiency (fill ↔ doubt alternate each increment).
2. **The whole artifact** — cross-section contradictions, gaps, acceptance criteria that cannot be verified.

A critique result surfaces as a *new good question* or a *flagged unknown/gap* — never as raw question phrasing in the document. Concrete triggers stay:

1. **Right after the 배경·목표 draft**: "If this understanding is wrong, where is it wrong?" — fix the draft or record the doubt in §7.
2. **On every 비목표/AC increment**: "Shipped, then failed in real use — what was the cause?" Each answer is promoted to an AC (§6), pushed to 비목표 (§5), or left in §7 as an unknown; flag irreversible / blast-radius risks explicitly. Results accumulate in §7 위험.
3. **Before finalize**: deep-interview's own pre-mortem converges on the accumulated §7 — it consumes the ledger, it does not duplicate it.

## Deep-interview synthesis

When intent-level ambiguity meets the **existing** deep-interview entry conditions (`skills/deep-interview/SKILL.md` "When to enter"), call deep-interview internally — unchanged: same gates, same question budget, same finalize contract (zero diff). Record the process and result as a summary + link in §12 인터뷰 기록 (original stays in `interview-state.json`). If an interview happened, its readiness gate must pass before finalize — never bypass it. If no ambiguity is detected, no interview happens; do not force entry.

## Help ladder — when the user can't answer

A good question can still stump the user (they miss the question or the intent, or lack the knowledge to answer). Don't stall — help, but know that **stronger help locks the user into that frame** (especially a non-expert), so help is ordered by bias cost and the upper rungs are opt-in:

1. **Explain the question** (least bias, default): say plainly what is asked and why. Make the question understood — do not hand over an answer.
2. **Offer a reference / consideration map**: not conclusions — a map of the territory the user explores and judges for themselves.
3. **Research it for them** (opt-in, highest bias): only when the user asks. Return **≥2 viable options + trade-offs**, never a single answer (anti-anchoring).

The agent does not treat "giving the answer" as the default. When it does answer, only because the user chose it, and in a form that widens rather than narrows their view.

## Output discipline

Questions ("shipped, then failed — why?") are internal elicitation tools. The document carries only the **resolved conclusions**, as clean professional sections (e.g. "Technical choice and trade-offs: …", "Edge cases / caveats: …"). Never leak question phrasing into a spec section title or body — the pre-mortem prompt and the good questions shape the content, they do not appear in it.

The one home for the *process* is **§12 인터뷰 기록**, the provenance section: record a **summary** of how the document was shaped — which good questions surfaced what (blind-spots, new perspectives) and which decisions followed — so a reader understands the authoring path. Summary, never a raw transcript; fill it from the always-on elicitation loop too, not only when a formal deep-interview ran. This keeps the process visible without the spec body carrying question phrasing.

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
- Expert elicitation (good questions) and the critique axis are always-on core behavior, never an opt-in mode — the quality floor must hold even when the author is a novice.
- Question generation is delegated to fresh `ditto:question-generator` subagents (minimal packet — no interview narrative, no driver guesses) and selected by `ditto:question-gate` on score; the round/interview ends when the gate finds no question above the threshold. Never generate the final question set inline in the driver's accumulated (biased) context.
- Never leak elicitation or pre-mortem question phrasing into the document — sections carry resolved conclusions only.
- Never modify deep-interview's contract, gates, budget, or finalize (zero diff — guarded by its contract tests).
- Never hand-edit `intent.json` or build any document↔intent sync path.
- Never skip pre-mortem or the finalize intent confirmation, in any mode.
- Never present a skipped review as agreement — coverage is recorded honestly.
- Keep the user-facing surface capped: this one skill + one template. Propose new mechanisms in the design doc, not as new surfaces.
