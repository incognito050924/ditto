---
name: deep-interview
description: Resolve intent ambiguity with unbiased Socratic questions and a pre-mortem before planning. Use when acceptance criteria cannot be written, the request depends on product/domain meaning, there are two or more materially different implementations, or a pre-mortem surfaces hard-to-reverse risk.
argument-hint: "[work-item-id]"
---

# Deep Interview

Resolve the *intent-level* ambiguity of a request to the degree needed — no more — and surface hard-to-reverse risk early with a pre-mortem. Plan-level adversarial checking is NOT done here; that is `/ditto:dialectic` (§6.6).

The contract (thresholds, schema, gate) is owned by `reports/design/contracts/deep-interview-contract.md` and `src/schemas/interview-state.ts`. Mechanism is now in code: `ditto deep-interview {start,record-turn,check-readiness,finalize}` enforces the schema and the state machine.

## When to enter

Enter when ANY of the following is true:

- Charter projection shows `▶ Run /ditto:deep-interview now …` — placeholder-only acceptance criteria coincide with execution-intent prompt (auto-detected by UserPromptSubmit, §AC-1).
- Charter projection shows `⚠ acceptance criteria are placeholders …` and the user is asking for action.
- You cannot draft a single observable acceptance criterion for the request without making a domain decision.
- Two or more materially different implementations are plausible and the difference is product-visible.
- A pre-mortem would surface a hard-to-reverse risk that the request doesn't already constrain.

Otherwise do NOT enter (§2 #3: small reversible requests should not be promoted into heavy workflows).

## Procedure

For `<wi>` = the active work item id (see charter `Active work item:` line).

### 1. Start

```
"${CLAUDE_PLUGIN_ROOT}/bin/ditto" deep-interview start --work-item <wi> --output json
```

Initializes `.ditto/local/work-items/<wi>/interview-state.json` with `readiness.threshold=0.7` and `exit.question_cap=8` (override with `--threshold` and `--question-cap` if the request justifies it; do not lower the threshold to escape the gate). `--generators <N>` (default 1) sets the per-round fan-out for §3 — `N=1` is serial-equivalent (a small request stays lightweight); raise it for an ambiguous request so independent generators cover each other's blind spots. **But if the user set a `deep_interview.generators` config default (§config), that IS their preference — run `start` without `--generators` and let config drive the fan-out; pass `--generators` only to deviate from their config for a stated reason. Read the resolved count from the `start` output, never assume.**

**Per-user defaults (config).** A developer can set permanent defaults for `threshold` / `question_cap` / `generators` in `.ditto/local/config.json` under a `deep_interview` block (gitignored, tier ③) — e.g. `{"deep_interview": {"generators": 3}}` to always fan out 3 generators. Resolution is **CLI flag > config > code default**; a broken config fails open to defaults and warns on stderr. Always read the resolved values from the `start` output (it reports `threshold` / `question_cap` / `generators`) rather than assuming the code defaults — those are what config/flags actually produced.

### 2. Identify ambiguity dimensions

List every dimension where the answer would change what is built:

- product/domain meaning (what "success" means in user terms)
- response shape, edge cases, error contract
- non-functional bars (latency, throughput, persistence, compatibility)
- integration boundary (which existing surfaces are in/out of scope)
- irreversibility (data loss, schema migration, public API)

Mark each as `critical` when the gate must resolve it before finalize.

### 3. Ask questions — fan out to fresh generators, fan in through the gate

Do NOT generate questions inline in your accumulated context: your interview narrative acts as a prior (bias) and quality degrades non-uniformly as the transcript grows (context rot) — the two failure modes the charter §4-9 separates. Generation is pulled out of the driver into fresh, minimal-context subagents (same pattern as `skills/tech-spec/SKILL.md` "Question generation workflow (multi-agent)", adapted to deep-interview's intent dimensions).

**Per-round loop** (`N` = the resolved generators count that `start` reported — a CLI `--generators` flag if given, else the `deep_interview.generators` config default, else 1):

1. **Self-answer first (the anti-ask gate, per dimension).** Before any dimension reaches a generator, run the QuestionGate self-answer check (`⚠ self-answer from code/docs/web first …` is the hint surface):
   1. Search the codebase, docs, and prior work items.
   2. Read web sources if the question is about an external standard / API.
   3. **Check recorded decisions (ADR-0020).** Part of self-answering is `"${CLAUDE_PLUGIN_ROOT}/bin/ditto" memory query` over the governing ADRs (decision, rejected alternatives, change conditions are indexed). If the request's *intent* conflicts with a recorded decision — the user is asking for what an ADR forbids — that is a user-owned decision, not something to silently plan around: surface it as a question (follow the ADR / deliberately supersede it / re-scope). An intent conflict caught here is the cheapest to resolve, because the user is present (no autopilot fail-closed needed).
   4. Only the dimensions that survive self-answering (NONE of the above resolved them) go to the generators.

2. **Fan out `N` generators (parallel, fresh each round).** Spawn `ditto:question-generator` × `N` in one parallel batch, each with **only** a minimal packet — you are the adapter that maps the interview's unresolved ambiguity dimensions into the generator's `target`:
   - **Fixed facts & decisions** — what is already settled (resolved dimensions, recorded answers, the governing ADR decisions). Blind-spot guard: a generator must never re-ask a settled dimension.
   - **Project status & environment** — codebase/domain facts to ground questions (paths, stack, constraints).
   - **Target** — the unresolved (`critical`, `unknown`/`partial`) ambiguity dimensions this round must fill, expressed as the open intent decisions.
   - **Excluded (the anti-bias mechanism):** the interview narrative/transcript and your own guesses. Do NOT pass them. `N=1` makes this a single serial generator (lightweight); `N>1` lets independent generators cover each other's blind spots.

3. **Fan in through the gate.** Hand the pooled candidates to one `ditto:question-gate` with the readiness `threshold` as the meaningfulness anchor → it returns `{selected, dry, all_scored}`. Single-level delegation: **you** fan out the generators and pool the candidates; the gate does not call the generators.

4. **Gate, present, then record each selected question as one turn.** For every selected candidate:

   1. **Gate the context (hard, before asking).** Run `"${CLAUDE_PLUGIN_ROOT}/bin/ditto" deep-interview check-question --json '{…candidate…}'`. It rejects (non-zero exit) a candidate that lacks a plain-language `user_explanation` — do **not** ask a rejected question; send the dimension back to the generators with the gap noted. This is the structural half of the success bar: a question reaches the user only with the context to act on it.

   2. **Present with the presentation contract (comprehensible + sufficient).** Ask the user in *their* language, not the code's:
      - **Default view** = the question + its `user_explanation` (plain *why we ask + what your answer decides*). This must be enough to decide on its own, yet free of raw code, `file:line`, schema fields, axis names, or `[from-code]`-style tags. Translating the agent's reasoning into the user's language IS the work — a correct but unreadable explanation is a failure (curse of knowledge).
      - **Progressive disclosure** = offer the deeper `background` and the `grounding` evidence as an opt-in ("필요하면 근거/배경 더 보여줄게"). Keep the default short by moving depth here, never by dropping it — the user decides how far to drill.
      - **Sufficiency** = if the user can't decide from the default, that is a context gap, not a user failure: expand `background`, or record the unknown — do not push them to answer blind.

   3. **Record the turn** with `record-turn`, carrying the full context: `question.user_explanation`, `question.background`/`question.grounding` (when present), and `question.self_answer_attempts` (the sources you checked in step 1 — so "why we ask you" is backed by "what we already checked"). Fold the answer back via the same turn's `answer`, and capture the user's decision-ability via `answer.self_report` (`confident`|`partial`|`unsure`) — the self-report half of the success bar. Set `question.marginal_gain` to the round's score-gated marginal information gain.

5. **Dry → propose ending.** If the round is `dry` (no candidate cleared the threshold) — equivalently, the recorded `marginal_gain` falls below the dry floor — the driver records `exit.reason=diminishing_returns` and you propose ending the interview. Ending is a *proposal*, not a close: finalize (§6) still requires the readiness gate ∧ user confirmation to pass — never bypass the gate just because a round went dry.

Record each turn with:

```
"${CLAUDE_PLUGIN_ROOT}/bin/ditto" deep-interview record-turn --work-item <wi> --json '{
  "dimension": {"id": "d-<short-id>", "critical": true, "state": "partial", "ambiguity": 0.6, "notes": ""},
  "question": {"text": "…?", "why_matters": "…", "info_gain_estimate": "high", "marginal_gain": 0.4,
    "user_explanation": "<plain why-we-ask + what-your-answer-decides, user language>",
    "background": "<optional deeper context for 더 보기>",
    "grounding": "<file:line | doc — evidence behind the question>",
    "self_answer_attempts": [{"source": "code", "result": "<what you checked and why it did not resolve it>"}]},
  "answer": {"text": "…", "kind": "user", "self_report": "confident"},
  "readiness_score": 0.55
}' --output json
```

- `dimension.id` is upserted: same id on a later turn updates the existing dimension in place (no duplicates).
- `dimension.state` flips to `"resolved"` when the answer closes it; the gate will then drop it from `critical_unresolved`.
- `answer.kind` is `"user"` when the user answered, `"assumption"` when you record an explicit `hypothesis`-labelled assumption because the user deferred / cannot answer now. Assumptions land in `assumptions[]` ledger; they do not pretend to be answers.
- **A `critical` dimension cannot be closed by your own assumption.** If `answer.kind="assumption"` on a critical dimension, the gate keeps it unresolved (the state is demoted to `partial`) — an agent's guess must not pass as the user's answer. The only exception is an *explicit user delegation* ("you decide"): record it as `{"kind": "assumption", "delegated": true}`, which is allowed to resolve the critical dimension. Default (`delegated` absent) = your guess = cannot close a critical.
- `marginal_gain` (optional, 0..1) is the round's score-gated marginal information gain from the gate. A round whose value falls below the dry floor flips `exit.reason` to `diminishing_returns` (ending becomes a proposal; the finalize gate still applies).
- `readiness_score` is your honest estimate after the turn; the deterministic floor caps it so high self-reports cannot escape unresolved-critical reality.
- `question.user_explanation` / `background` / `grounding` are the presentation-contract context (carried from the gate-selected candidate); `question.self_answer_attempts` is the §6.2 ledger of sources you checked before asking. `answer.self_report` (`confident`|`partial`|`unsure`) records whether the user had enough context to decide — the observable sufficiency signal. All optional in the schema (old state parses unchanged), but `user_explanation` is required to clear `check-question`.

### 4. Pre-mortem (before finalize, not in record-turn)

For each candidate acceptance criterion, run a pre-mortem **internally** (your own reasoning, **not surfaced to the user**): assume it shipped and later failed in real use — what is the most likely cause? **Output discipline:** surface only the *result* — a specific risk, a plain-language question about that risk, or a flagged unknown — **never the pre-mortem prompt itself**, and never an arbitrary time anchor (no "breaks in N days" framing). Promote irreversible / blast-radius risks to:

- An additional acceptance criterion (constrain the implementation), or
- `out_of_scope` (we are NOT going to do this), or
- `unknowns` (we cannot decide yet — block on it), or
- A user-owned decision (charter `⚠` advisory if surfaced via QuestionGate).

### 5. Check readiness

```
"${CLAUDE_PLUGIN_ROOT}/bin/ditto" deep-interview check-readiness --work-item <wi> --output json
```

`gate.pass=true` requires:

- Every `critical=true` dimension has `state=resolved`, AND
- `readiness.score` (after the deterministic floor) ≥ `readiness.threshold`.

If `cap_reached=true` but the gate is still blocked, do NOT pretend success. Record the remaining ambiguity as `hypothesis`-labelled assumptions and either continue past the cap (with explicit justification) or hand off (`/ditto:handoff`) and stop.

### 6. Finalize

Synthesize the intent fields and lock the interview:

```
"${CLAUDE_PLUGIN_ROOT}/bin/ditto" deep-interview finalize --work-item <wi> --json '{
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

축1 종료 게이트는 **AND 두 조건**이다: readiness 게이트(1차, 시스템) ∧ 사용자 확인(2차, 휴먼). `user_confirmation.confirmed`는 빈 boolean이 아니라 사용자가 직접 말한 확인 문구(`statement`)를 증거로 들고 와야 한다 — 사용자가 의도가 맞다고 확인하지 않았다면 `confirmed: false`로 두고, finalize는 `not_confirmed`로 닫히며 어떤 산출물도 쓰지 않는다(의도를 사용자 대신 단정하지 말 것).

This single call (atomic, per AC-2 + AC-3):

1. Enforces the **축1 종료 AND**: the readiness gate (1차) AND the user confirmation (2차). Rejects with `not_ready` when the readiness gate fails, or `not_confirmed` when the gate passed but `user_confirmation.confirmed` is not true — fix the interview / capture the confirmation, never bypass either.
2. Writes `.ditto/local/work-items/<wi>/intent.json` (IntentContract).
3. Mirrors `acceptance_criteria` and `goal` into the work item itself.
4. Calls `bootstrapAutopilot`, producing `.ditto/local/work-items/<wi>/autopilot.json` with a `design → implement → verify` graph for each criterion.
5. Returns `autopilot_id`, `approval_gate.status`, and `node_ids`.

If `approval_gate.status === 'pending'` (any `risk.*` flag set), the autopilot pauses on the approval node and the driver surfaces the pending plan to the user for approval. If `not_required`, autopilot proceeds.

## Output contract

- `interview-state.json` — schema-validated, always carries an explicit `exit.reason` (`readiness_met` / `diminishing_returns` / `user_deferred` / `user_owned_decision` / `cap_reached`).
- `intent.json` (IntentContract) — narrowed goal, in_scope/out_of_scope, acceptance_criteria with `evidence_required`, unknowns, follow_up_candidates.
- Work item `acceptance_criteria` and `goal` mirrored from intent.
- `autopilot.json` with the initial graph.

## User-facing summary (after finalize)

Report to the user in one short block:

- Narrowed goal.
- Added / removed scope.
- Remaining assumptions (`hypothesis`-labelled).
- Blocked user-owned decisions (if any).
- Autopilot status: `approval_gate` value + node ids.

Do not echo the full payload. The artifacts are authoritative.

## Hard rules

- Never silently exit. Always set `exit.reason`.
- Never finalize past `not_ready` — fix the gate or hand off.
- Never lower the readiness threshold to escape the gate.
- Never paste raw command output into the chat — the artifacts in `.ditto/local/work-items/<wi>/` are the record.
- Never invent acceptance criteria the user did not validate; if you must, label them `assumption` answers in the interview, not as a finalize statement.
