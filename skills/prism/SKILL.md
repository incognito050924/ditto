---
name: prism
description: Refine a code-change request into shared intent before any code is written — interview the ambiguity, emit a plain-language design document, split it into approved work items, then compile it into intent. Use when a request is fuzzy, spans several changes, needs a design doc, or the user says "let's think this through / 정리하자 / 설계부터" before building.
---

# Prism

Prism is the **understand-first** front door for a code-change request. It turns a
raw utterance ("이거 좀 고쳐줘", "이 기능 다시 설계하자") into shared, verifiable
intent — *before* implementation — through one loop:

1. **Interview the ambiguity** into a small issue map (what actually has to be decided).
2. **Emit a human-readable design document** (isomorphic to `.ditto/specs`) that a
   person and DITTO can both read.
3. **Split** the confirmed design into per-item work-item drafts — only on the user's
   explicit approval.
4. **Compile** the confirmed document into `intent.json` **through deep-interview's
   single writer**, digest-bound so a later edit of a decision section is caught.

The mechanism lives in code: `src/core/prism/*` and `ditto prism …` /
`ditto deep-interview finalize-from-doc`. This skill is the user-facing contract over
it. Prism refines intent; it does not implement or review code — that is autopilot /
`/ditto:verify` downstream.

## When to enter

Reach for prism when a **code change** is on the table but the *intent* is not yet
sharp enough to build:

- The request is fuzzy and you cannot yet write a single observable acceptance criterion.
- One request clearly hides several changes that should become separate work items.
- The user wants a **design document** before code, or says "설계부터 / 정리하고 가자 /
  think this through first".
- Two or more materially different implementations are plausible and the difference
  is product-visible.

For a small, reversible, already-clear request, take the lightweight path instead
(`ditto work set-criteria` → `ditto verify` → `ditto work done`). Prism is for
refinement, not ceremony.

## The loop, stage by stage

### 1. Grow the issue map (interview rounds)

Each interview round adds **one** plain-language issue to the map. An issue is
something that has to be decided; mark it **critical** when minimal launch must not
proceed until it is resolved.

```bash
ditto prism seed --wi <wi> --label "로그인 실패 시 잠금 정책" --critical
ditto prism seed --wi <wi> --label "비밀번호 재설정 메일 문구"
```

Resolve or defer an issue through the close gate:

```bash
ditto prism close --wi <wi> --node <node> --state resolved --reason "…"
# a "모름-닫기" (out_of_scope | user_owned) of a CRITICAL issue MUST record a residual:
ditto prism close --wi <wi> --node <node> --state user_owned \
  --reason "…" --residual "이 위험은 사용자가 나중에 결정"
```

A no-residual "모름-닫기" of a critical issue is **rejected** — it must not silently
count as critical resolution. Growth is cap-enforced (see *Divergence discipline*).

> `close` takes a node reference, so it is a driver/operator command — its node
> references never reach the user's screen. The two views the *user* reads are
> `summary` and `status`, and those are label-only (below).

**Done when** every launch-gating issue is on the map and each is resolved/deferred
through the close gate — or a cap HIT has stopped the loop for escalation (a cap is
never "done").

### 2. Read the remaining scope — everyday language, no internal identifiers (ac-3)

`ditto prism summary` is the user-facing progress view. It prints **only** the
plain-language titles of what is still open — never a node id, severity enum, coverage
axis name, or schema field. The user reads scope, not internals.

```bash
ditto prism summary --wi <wi>
```

A user-facing sample (exactly the shape the skill promises — plain titles only):

```
아직 정할 항목:
  - 로그인 실패 시 잠금 정책
  - 비밀번호 재설정 메일 문구
```

When nothing is open it prints `남은 항목이 없어요.` — still no internals. Any
user-facing line you write yourself obeys the same rule: describe the *thing*, never
its id. (Enforced in code by `renderProgressSummary`, which emits labels only, and by
the second-defense identifier scan.)

**Done when** `summary` shows the open plain-language titles (or `남은 항목이 없어요.`)
with zero internals leaked.

### 3. Minimal-launch notice — one-shot console, never a question hook (ac-4)

When **every critical** issue is resolved and only **non-critical** issues remain, the
user can start now. `ditto prism status` announces this **once**, as a plain console
line — a notification, not an interactive question hook, and never re-announced (a
durable one-shot):

```bash
ditto prism status --wi <wi>
```

The one-time user-facing line is:

```
핵심으로 꼭 정해야 할 것은 모두 정리됐어요. 지금 최소한으로 착수할 수 있어요. (남은 항목은 착수하면서 정해도 됩니다.)
```

Discipline (co-located rules for the notice):

- **Console, not a prompt.** The notice informs the user that launch is reachable; it
  does not block, ask, or use any AskUserQuestion / interactive hook.
- **Once, then silent.** After the announcement it is not repeated on the next `status`.
- **Retract on regression.** A new or reopened critical issue retracts the prior notice,
  so re-reaching minimal launch announces again. A 0-critical or empty map never fires
  the notice (vacuous-truth guard).

**Done when** all critical issues are resolved and `status` has emitted the one-time
line (or correctly stayed silent under the vacuous-truth guard).

### 4. Emit the design document

Once the map is refined, emit the human-readable design document from a refined
payload. It ships through a fail-closed gate: the output path is contained to the repo,
every factual claim carries grounding (a `file:line`, a link, an ADR id, or a memory
pointer) or the emit is rejected, and raw code/transcript blocks are refused —
**summary + link only, never transcription**.

```bash
ditto prism doc --wi <wi> --input <payload.json>
# emit even with an ungrounded factual claim (an explicit decision — the claim ships
# marked unresolved):
ditto prism doc --wi <wi> --input <payload.json> --allow-ungrounded
```

Default output path is `.ditto/specs/<wi>-design.md`. For the section list and the
digest-bound compile-input sections, see `references/design-doc-template.md`.

**Done when** `doc` writes `.ditto/specs/<wi>-design.md` past the gate — every factual
claim grounded (or explicitly `--allow-ungrounded`), no raw blocks.

### 5. Split into work items — approval-gated

From the confirmed design, propose a split. **Proposing materializes nothing** — it
presents a plan; materialization waits for the user's own approval words.

```bash
# present a split proposal (writes only the proposal, no work items):
ditto prism backlog propose --wi <wi> --input <split-payload.json>

# materialize the proposal into per-item work-item DRAFTS — ONLY with the user's
# verbatim approval statement. A bare call (no --statement) is NOT approval:
ditto prism backlog materialize --wi <wi> --statement "<사용자 원문 승인>"
```

**Done when** the proposal is presented and, only on the user's verbatim `--statement`,
materialized into per-item drafts — no intent, no auto-start (the user picks what to
run next).

### 6. Compile the confirmed design into intent

Confirmation compiles the design document into `intent.json` **through deep-interview's
single writer** (`finalize-from-doc` delegates to `finalizeInterview` — it never writes
intent itself), and binds the result to the document by digest. A later edit of a
decision section (요약·목표·비목표·완료 조건·위험) then trips the autopilot freshness gate.

```bash
ditto deep-interview finalize-from-doc --work-item <wi> --statement "<사용자 원문 확정>"
# optional explicit doc path (default .ditto/specs/<wi>-design.md):
ditto deep-interview finalize-from-doc --work-item <wi> --doc <path> --statement "<확정>"
```

The confirmation gate is an **AND**: the readiness gate (system) ∧ the user's own
confirmation statement (human). A bare call without `--statement` is rejected. Still-open
issues survive into the pre-mortem seed (carried into `intent.unknowns`), so plan-stage
coverage sees them.

**Done when** the AND-gate passes and `intent.json` is written via the single writer,
digest-bound to the confirmed document.

### Optional — sharpen with an opponent (host-delegated)

To pressure-test the map with a devil's-advocate **critique**, an independent
**dissent**, and an achieve-vs-characterize **semantic** judgment, run the host-delegated
opponent seam: `references/opponent-seam.md`. The bare `ditto prism opponent` stays the
no-host degrade path beside it.

## Divergence discipline (ac-10)

The interview must converge, not spin. Three meaningless-divergence shapes are detected
**deterministically** (no model call) and recorded as decision-grade events
(`early_exit` / `challenge_admit`) — never silently suppressed:

- **쳇바퀴 (`repeat_question`)** — a near-duplicate of an earlier question (no new signal).
- **Trivial streak** — three consecutive trivial questions.
- **Decided-conflict without evidence** — re-challenging an already-decided item with no
  new grounding.

A re-challenge that DOES bring new evidence is admitted **once**, as a visible
`challenge_admit` item (not dropped). Before each round the loop also invokes the real
caps (calls-per-node, tree-node count, total rounds); a cap HIT **stops and escalates** —
never "converged" or "success".

## Hard rules (the invariants)

- **User output is everyday language.** Never surface a node id, severity enum, coverage
  axis name, or schema field to the user — describe the thing, not its identifier (ac-3).
- **Launch is announced, not asked.** The minimal-launch notice is a one-time console line;
  never an interactive question hook, never repeated, retracted on regression (ac-4).
- **A cap is not success.** A node/round/tree cap or a flagged divergence STOPS and
  escalates; it is never reported as converged (ac-10).
- **Nothing materializes without the user's words.** A split proposal and the intent
  compile both require the user's own verbatim `--statement`; a bare call is not
  approval/confirmation.
- **Facts are grounded, never transcribed.** A factual claim in the design document needs a
  grounding reference; raw code/transcript blocks are refused (summary + link).
- **One writer for intent.** The compile goes through `finalize-from-doc` →
  `finalizeInterview`; prism never writes `intent.json` on a second path.

## Host scope

v1 ships the **Claude Code** host surface only. The Codex host surface for prism is a
deliberate follow-up, kept separate from the Claude surface (ADR-0025 separation /
ADR-0016 dual-host) — do not author it here.
