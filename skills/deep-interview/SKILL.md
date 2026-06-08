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

Initializes `.ditto/local/work-items/<wi>/interview-state.json` with `readiness.threshold=0.7` and `exit.question_cap=8` (override with `--threshold` and `--question-cap` if the request justifies it; do not lower the threshold to escape the gate).

### 2. Identify ambiguity dimensions

List every dimension where the answer would change what is built:

- product/domain meaning (what "success" means in user terms)
- response shape, edge cases, error contract
- non-functional bars (latency, throughput, persistence, compatibility)
- integration boundary (which existing surfaces are in/out of scope)
- irreversibility (data loss, schema migration, public API)

Mark each as `critical` when the gate must resolve it before finalize.

### 3. Ask one question per turn

Before asking, run the QuestionGate self-answer check (`⚠ self-answer from code/docs/web first …` is the hint surface):

1. Search the codebase, docs, and prior work items.
2. Read web sources if the question is about an external standard / API.
3. Only if NONE of the above answers, ask the user — and include "what changes depending on the answer".

Record every turn with:

```
"${CLAUDE_PLUGIN_ROOT}/bin/ditto" deep-interview record-turn --work-item <wi> --json '{
  "dimension": {"id": "d-<short-id>", "critical": true, "state": "partial", "ambiguity": 0.6, "notes": ""},
  "question": {"text": "…?", "why_matters": "…", "info_gain_estimate": "high"},
  "answer": {"text": "…", "kind": "user"},
  "readiness_score": 0.55
}' --output json
```

- `dimension.id` is upserted: same id on a later turn updates the existing dimension in place (no duplicates).
- `dimension.state` flips to `"resolved"` when the answer closes it; the gate will then drop it from `critical_unresolved`.
- `answer.kind` is `"user"` when the user answered, `"assumption"` when you record an explicit `hypothesis`-labelled assumption because the user deferred / cannot answer now. Assumptions land in `assumptions[]` ledger; they do not pretend to be answers.
- `readiness_score` is your honest estimate after the turn; the deterministic floor caps it so high self-reports cannot escape unresolved-critical reality.

### 4. Pre-mortem (before finalize, not in record-turn)

For each candidate acceptance criterion, ask: "If this shipped and broke in 3 days, what would the cause be?" Promote irreversible / blast-radius risks to:

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
