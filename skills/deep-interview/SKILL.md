---
name: deep-interview
description: Resolve intent ambiguity with unbiased Socratic questions and a pre-mortem before planning. Use when acceptance criteria cannot be written, the request depends on product/domain meaning, there are two or more materially different implementations, or a pre-mortem surfaces hard-to-reverse risk.
argument-hint: "[work-item-id]"
---

# Deep Interview

Resolve the *intent-level* ambiguity of a request to the degree needed — no more — and surface hard-to-reverse risk early with a pre-mortem. Plan-level adversarial checking is `/ditto:dialectic`, not here.

The contract (thresholds, schema, gate) is owned by `reports/design/contracts/deep-interview-contract.md` and `src/schemas/interview-state.ts`. Mechanism is in code: `ditto deep-interview {start,record-turn,check-readiness,finalize}` enforces the schema and the state machine.

Detail for the three optional host-delegated adversarial passes (§4 pre-mortem opponent, §5.5 intent-dissent, §5.6 semantic critic) lives in `references/adversarial-seams.md` — open it when you reach those steps.

## When to enter

Enter when ANY of these holds:

- Charter projection shows `▶ Run /ditto:deep-interview now …` — placeholder-only acceptance criteria coincide with an execution-intent prompt (auto-detected by UserPromptSubmit, §AC-1).
- Charter projection shows `⚠ acceptance criteria are placeholders …` and the user is asking for action.
- You cannot draft a single observable acceptance criterion without making a domain decision.
- Two or more materially different implementations are plausible and the difference is product-visible.
- A pre-mortem would surface a hard-to-reverse risk the request doesn't already constrain.

For a small/reversible request that meets none of these, take the **lightweight path** — no deep-interview, no autopilot (§2 #3: small reversible requests should not be promoted into heavy workflows):

```
ditto work set-criteria <wi> --criteria "<observable criterion>; <criterion>; …"
ditto verify <wi> --criterion <ac> -- <command>   # fresh evidence per criterion
ditto work done <wi>                                # evidence-gated close
```

## Procedure

`<wi>` = the active work item id (see charter `Active work item:` line).

### 1. Start

```
ditto deep-interview start --work-item <wi> --output json
```

Initializes `.ditto/local/work-items/<wi>/interview-state.json` with `readiness.threshold=0.7` and `exit.question_cap=8`. `--generators <N>` (default 1) sets the per-round fan-out for §3: `N=1` is serial-equivalent (a small request stays lightweight); raise it for an ambiguous request so independent generators cover each other's blind spots.

**Config defaults.** A developer can set permanent `threshold` / `question_cap` / `generators` defaults in `.ditto/local/config.json` under a `deep_interview` block (gitignored, tier ③) — e.g. `{"deep_interview": {"generators": 3}}` makes `deep_interview.generators` always fan out 3. Resolution is **CLI flag > config > code default**; a broken config fails open to defaults and warns on stderr. When config sets a default, run `start` without `--generators` and let config drive it — pass a flag only to deviate for a stated reason. Raising `--threshold` is allowed; lowering it to escape the gate is not.

**Done when:** `interview-state.json` exists and you have read the resolved `threshold` / `question_cap` / `generators` from the `start` output (never assume the code defaults — read what config/flags actually produced).

### 2. Identify ambiguity dimensions

List every dimension where the answer would change what is built:

- product/domain meaning (what "success" means in user terms)
- response shape, edge cases, error contract
- non-functional bars (latency, throughput, persistence, compatibility)
- integration boundary (which existing surfaces are in/out of scope)
- irreversibility (data loss, schema migration, public API)

**Done when:** every build-changing dimension is listed and each one the gate must resolve before finalize is marked `critical`.

### 3. Ask questions — fan out to fresh generators, fan in through the gate

Generate questions in fresh, minimal-context subagents (the `ditto:question-generator` fan-out + `ditto:question-gate` fan-in), **never in your accumulated context**: the interview narrative acts as a prior (bias) and quality degrades non-uniformly as the transcript grows (context rot) — the two failure modes charter §4-9 separates.

**Per-round loop** (`N` = the resolved generators count from §1):

1. **Self-answer first (the anti-ask gate, per dimension).** Before any dimension reaches a generator, resolve it yourself if you can (`⚠ self-answer from code/docs/web first …` is the hint surface):
   1. Search the codebase, docs, and prior work items.
   2. Read web sources if the question is about an external standard / API.
   3. **Check recorded decisions (ADR-0020)** with `ditto memory query` over the governing ADRs (decision, rejected alternatives, change conditions are indexed). If the request's *intent* conflicts with a recorded decision — the user is asking for what an ADR forbids — surface it as a user-owned question (follow the ADR / deliberately supersede it / re-scope), the cheapest place to resolve it because the user is present.
   4. Only dimensions that survive self-answering (nothing above resolved them) go to the generators.

2. **Fan out `N` generators (parallel, fresh each round).** Spawn `ditto:question-generator` × `N` in **one parallel batch — a SINGLE message carrying all `N` Task calls** (sequential spawns serialize the round latency `N`-fold; the fan-out is a speed-up only when the calls run concurrently). You are the adapter mapping unresolved ambiguity dimensions into each generator's `target`; pass **only** a minimal packet:
   - **Fixed facts & decisions** — what is settled (resolved dimensions, recorded answers, the governing ADR decisions), so a generator never re-asks a settled dimension.
   - **Project status & environment** — codebase/domain facts to ground questions (paths, stack, constraints).
   - **Target** — the unresolved (`critical`, `unknown`/`partial`) dimensions this round must fill, expressed as the open intent decisions.
   - The anti-bias mechanism is what you *withhold*: the interview narrative/transcript and your own guesses stay out of the packet. `N=1` is a single serial generator; `N>1` lets independent generators cover each other's blind spots.

3. **Fan in through the gate.** Hand the pooled candidates to one `ditto:question-gate` with the readiness `threshold` as the meaningfulness anchor → it returns `{selected, dry, all_scored}`. Single-level delegation: **you** fan out and pool; the gate does not call the generators. **When `N=1`** the gate's *consensus* axis is moot (nothing to agree across), so you MAY score the one candidate against the `threshold` yourself and skip the separate gate spawn — but still run `check-question` (the deterministic context gate) and still set `marginal_gain` honestly so the dry-floor termination stays objective. For `N≥2` always fan in through the gate (consensus is load-bearing).

4. **Gate, present, then record each selected question as one turn.** For every selected candidate:

   1. **Gate the context (hard, before asking).** Run `ditto deep-interview check-question --json '{…candidate…}'`. It rejects (non-zero exit) a candidate lacking a plain-language `user_explanation`; send a rejected dimension back to the generators with the gap noted, and only ask questions that clear the gate. This is the structural half of the success bar: a question reaches the user only with the context to act on it.

   2. **Session-blind review of critical questions (ac-4).** A `critical` dimension's question reaches the user only after the **session-blind** `ditto:context-reviewer` clears it (`routeForReview`: only `critical` candidates route here). `check-question` proved the context *fields exist*; this proves a context-less user could actually *decide* from them — the curse-of-knowledge catch the grounded generator/gate structurally cannot make.
      - **Spawn** `ditto:context-reviewer` (Task, one level deep) with ONLY the user-reaching surface — `text` + `user_explanation` + any option labels — and never the transcript / fixed facts / grounding (session-blind *is* the check). It returns `{verdict, reason}` and is read-only.
      - **On `reject`, regenerate within the cap.** Send the dimension back to the generators with the reviewer's `reason`, up to `REVIEW_REGENERATE_CAP = 2` (fixed and small — NOT the §3 `question_cap` total). A pass within the cap records `question.review_status="reviewed"`.
      - **Terminal fallback — honesty over silence (ADR-0018 D2).** When the host cannot spawn the reviewer OR the cap is exhausted with no pass, keep the interview moving: record `question.review_status="unverified-degraded"` and present the question **flagged** as not-yet-verified context, so the user sees the degradation.
      - **Single writer.** The reviewer records nothing; YOU (the driver) are the sole writer of `review_status` via `record-turn`. Fold parallel critical-question verdicts back **sequentially** so no two writes clobber the state.

   3. **Present with the presentation contract (comprehensible + sufficient).** Ask the user in *their* language, not the code's:
      - **Briefing first when the context overflows (ac-5).** Test the rendered option text (`user_explanation`, else `text`) against `needsBriefing` (the shared `OPTION_DESCRIPTION_BUDGET` threshold in `src/core/question-context.ts`). When it overflows the compact AskUserQuestion option UI, present that context as a short **briefing in the conversation body FIRST**, then ask — rather than cramming a long explanation into an option `description` where the host truncates it.
      - **Default view** = the question + its `user_explanation` (plain *why we ask + what your answer decides*). This alone must be enough to decide, yet free of raw code, `file:line`, schema fields, axis names, or `[from-code]`-style tags. Translating the agent's reasoning into the user's language IS the work — a correct but unreadable explanation is a failure (curse of knowledge).
      - **Progressive disclosure** = offer the deeper `background` and the `grounding` evidence as an opt-in ("필요하면 근거/배경 더 보여줄게"). Keep the default short by moving depth here, never by dropping it.
      - **Sufficiency** = if the user can't decide from the default, that is a context gap: expand `background`, or record the unknown — rather than pushing them to answer blind.

   4. **Record the turn** with `record-turn`, carrying the full context (§ record-turn below).

5. **Dry → propose ending.** A round is dry on EITHER axis (OR): **value-dry** — the recorded `marginal_gain` falls below the dry floor; or **angle-dry** — `novelty` exhausted, i.e. K consecutive rounds (K=2) added no admissible novelty. When either fires and the gate is still blocked, record `exit.reason=diminishing_returns` and propose ending. Ending is a *proposal*: finalize (§6) still requires the readiness gate ∧ user confirmation — keep the gate rather than bypassing it because a round went dry.

**Done when:** the readiness gate has no `critical_unresolved` dimension, OR a round went dry and you have recorded `exit.reason`.

#### record-turn

```
ditto deep-interview record-turn --work-item <wi> --json '{
  "dimension": {"id": "d-<short-id>", "critical": true, "state": "partial", "ambiguity": 0.6, "notes": ""},
  "question": {"text": "…?", "why_matters": "…", "info_gain_estimate": "high", "marginal_gain": 0.4, "novelty": true,
    "user_explanation": "<plain why-we-ask + what-your-answer-decides, user language>",
    "background": "<optional deeper context for 더 보기>",
    "grounding": "<file:line | doc — evidence behind the question>",
    "self_answer_attempts": [{"source": "code", "result": "<what you checked and why it did not resolve it>"}],
    "review_status": "reviewed"},
  "answer": {"text": "…", "kind": "user", "self_report": "confident"},
  "readiness_score": 0.55
}' --output json
```

- `dimension.id` is upserted — the same id on a later turn updates that dimension in place (no duplicates). `dimension.state` flips to `"resolved"` when the answer closes it, and the gate drops it from `critical_unresolved`.
- `answer.kind` is `"user"` when the user answered, `"assumption"` when you record an explicit `hypothesis`-labelled assumption because the user deferred; assumptions land in the `assumptions[]` ledger and do not pretend to be answers. **A `critical` dimension cannot be closed by your own assumption** — an assumption on a critical dimension is demoted to `partial` and stays unresolved. The only exception is explicit user delegation ("you decide"): record `{"kind": "assumption", "delegated": true}`, which may resolve the critical dimension.
- `marginal_gain` (0..1, optional) is the round's score-gated marginal information gain from the gate — the value dry axis. `novelty` (boolean, optional) is whether the round added admissible novelty — the same signal the gate records as `questionRound.novelty` (derived from the prism divergence verdict); K consecutive `false` rounds is the angle-exhaustion dry axis, complementary to `marginal_gain` (`novelty:true` or an absent field resets the counter, so unmeasured rounds never force an early close).
- `readiness_score` is your honest post-turn estimate; the deterministic floor caps it so high self-reports cannot escape unresolved-critical reality.
- Presentation-contract context carried from the gate-selected candidate: `user_explanation` (required to clear `check-question`) / `background` / `grounding`; `self_answer_attempts` is the sources you checked in step 1 (backs "why we ask you"); `review_status` (`reviewed` | `unverified-degraded`, critical only) is step 2's outcome, absent on non-critical; `answer.self_report` (`confident`|`partial`|`unsure`) records whether the user had enough context to decide. All optional in the schema (old state parses unchanged).

### 4. Pre-mortem (before finalize, not in record-turn)

For each candidate acceptance criterion, run a pre-mortem **internally** (your own reasoning, **not surfaced to the user**): assume it shipped and later failed in real use — what is the most likely cause? Surface only the *result* — a specific risk, a plain-language question about that risk, or a flagged unknown — never the pre-mortem prompt itself, and keep any time anchor ("breaks in N days") out of the user's view. Promote irreversible / blast-radius risks to one of:

- An additional acceptance criterion (constrain the implementation), or
- `out_of_scope` (we are NOT going to do this), or
- `unknowns` (we cannot decide yet — block on it), or
- A user-owned decision (charter `⚠` advisory if surfaced via QuestionGate).

Record the promoted items:

```
ditto deep-interview premortem --work-item <wi> --json '{"items":[…]}'
```

The `§5` gate fails closed if an irreversible / high-blast item is left `promoted_to:"none"`.

**Oracle-link (optional, `maps_to`).** When a promoted item's risk binds to concrete evidence, carry it in `maps_to`: an original-intent fragment id, a `file:line`, or an `ADR-…` — a scaled-down coverage anti-SLOP axis (a risk with no oracle is taste). Never forced: if the risk cannot honestly bind to an oracle, leave `maps_to` off and keep it prose. The `§5` promotion rule is unchanged either way.

**Lightweight opponent on `blast_radius>=high` items only.** After promotion, put each recorded `high`/`critical` blast item under ONE independent adversarial pass via `premortem-refute-record`. This is a cheap hardening, not a gate — see `references/adversarial-seams.md` (Pre-mortem opponent) for the CLI and discipline.

**Done when:** every irreversible / high-blast risk is promoted (none left `promoted_to:"none"`) and recorded via `premortem`.

### 5. Check readiness

```
ditto deep-interview check-readiness --work-item <wi> --output json
```

`gate.pass=true` requires: every `critical=true` dimension has `state=resolved`, AND `readiness.score` (after the deterministic floor) ≥ `readiness.threshold`.

**Done when:** `gate.pass=true`. If `cap_reached=true` while the gate is still blocked, record the remaining ambiguity as `hypothesis`-labelled assumptions and either continue past the cap (with explicit justification) or hand off (`/ditto:handoff`) and stop — rather than pretending success.

### 5.5 Intent-dissent opponent seam (before finalize, host-delegated)

Before locking, put each **critical** dimension's intent under independent adversarial pressure — an opponent re-derives the ORIGINAL intent and judges whether the user's stated intent is mis-stated, returning a sharper (never bigger) reading. A recorded `revise`/`reject` **gates finalize** (`blocked_by_dissent`) until the user acknowledges it (`acknowledge-dissent`), then re-run finalize.

CLI (`dissent-briefs` → spawn `intent-dissent-opponent` → `dissent-record`), the `INTENT_DISSENT_CONSTRAINT` anti-inflation rule, fail-closed handling, and honest degrade: `references/adversarial-seams.md` (Intent-dissent seam).

**Done when:** every critical dimension has been briefed, and any recorded dissent is either acknowledged or (host-absent) skipped with the degradation noted.

### 5.6 Semantic critic (advisory, NON-blocking)

Optionally check whether each `resolved` critical dimension **achieves** the intent's HOW versus only **characterizing** it. It writes a separate `dimension.semantic_*` pair the readiness gate and `finalize` never read, so it can never block — do NOT gate on it. CLI (`semantic-targets` → spawn semantic critic → `semantic-record`) and discipline: `references/adversarial-seams.md` (Semantic critic).

**Done when:** skipped, or the covered pairs are critiqued and any `characterize` verdicts recorded (advisory only).

### 6. Finalize

Synthesize the intent fields and lock the interview:

```
ditto deep-interview finalize --work-item <wi> --json '{
  "goal": "<verifiable goal in project terms>",
  "in_scope": ["<concrete in-scope item>", "…"],
  "out_of_scope": ["<concrete excluded item>", "…"],
  "acceptance_criteria": [
    {"id": "ac-1", "statement": "<observable predicate>", "verdict": "unverified", "evidence": [], "evidence_required": ["test"]}
  ],
  "unknowns": ["<remaining unknown>"],
  "follow_up_candidates": ["<post-ship idea>"],
  "question_policy": "ask_only_if_user_only_can_answer",
  "risk": {"non_local": false, "irreversible": false, "unaudited": false},
  "user_confirmation": {"confirmed": true, "statement": "<the user's own words confirming the intent matches their understanding>"}
}' --output json
```

The 축1 종료 게이트 is **AND of two conditions**: the readiness gate (1차, system) ∧ user confirmation (2차, human). `user_confirmation.confirmed` must carry the user's own confirming words (`statement`) as evidence, not a bare boolean. If the user has not confirmed the intent matches their understanding, leave `confirmed: false` — finalize closes with `not_confirmed`, writes nothing, and the intent is never asserted on the user's behalf.

This single atomic call (per AC-2 + AC-3):

1. Enforces the 축1 종료 AND — rejects with `not_ready` when the readiness gate fails, or `not_confirmed` when it passed but `user_confirmation.confirmed` is not true. Fix the interview / capture the confirmation rather than bypassing either.
2. Writes `.ditto/local/work-items/<wi>/intent.json` (IntentContract).
3. Mirrors `acceptance_criteria` and `goal` into the work item.
4. Calls `bootstrapAutopilot`, producing `.ditto/local/work-items/<wi>/autopilot.json` with a `design → implement → verify` graph per criterion.
5. Returns `autopilot_id`, `approval_gate.status`, and `node_ids`.

If `approval_gate.status === 'pending'` (any `risk.*` flag set), the autopilot pauses on the approval node and you surface the pending plan to the user for approval. If `not_required`, autopilot proceeds.

**Done when:** `intent.json` and `autopilot.json` are written and `finalize` returns `autopilot_id` + `approval_gate.status` + `node_ids`.

## Output contract

- `interview-state.json` — schema-validated, always carries an explicit `exit.reason` (`readiness_met` / `diminishing_returns` / `user_deferred` / `user_owned_decision` / `cap_reached`).
- `intent.json` (IntentContract) — narrowed goal, in_scope/out_of_scope, acceptance_criteria with `evidence_required`, unknowns, follow_up_candidates.
- Work item `acceptance_criteria` and `goal` mirrored from intent.
- `autopilot.json` with the initial graph.

## User-facing summary (after finalize)

Report to the user in one short block — narrowed goal; added / removed scope; remaining `hypothesis`-labelled assumptions; blocked user-owned decisions (if any); autopilot status (`approval_gate` value + node ids). Do not echo the full payload — the artifacts are authoritative.

## Hard rules

- Always set `exit.reason` — never silently exit.
- A critical question is asked as reviewed only when the session-blind reviewer cleared it; a reviewer-absent or cap-exhausted question is asked only with `review_status="unverified-degraded"` shown — never a silent ask, silent drop, or stall (ADR-0018 D2). The reviewer is read-only; only the driver writes `review_status`.
- Fix the gate or hand off rather than finalizing past `not_ready`.
- Never lower the readiness threshold to escape the gate.
- The artifacts in `.ditto/local/work-items/<wi>/` are the record — do not paste raw command output into the chat.
- Every acceptance criterion is one the user validated; an unvalidated one is labelled an `assumption` answer in the interview, never a finalize `statement`.
</content>
