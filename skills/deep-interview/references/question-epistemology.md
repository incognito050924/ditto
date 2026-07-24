# Question epistemology (why the interview surfaces are shaped this way)

The living reference for question/choice surface design decisions in deep-interview.
When a SKILL or agent design decision touches how a question is structured, how a
choice is presented, how the original intent is protected, when the interview may
end, or which questions may reach the user at all — cite the relevant principle
here instead of re-deriving it. Each principle carries its primary source (URL)
and the concrete surface contract it justifies.

Contents: Question = choice-situation · Framing effects · Memory reconstruction ·
Informed consent · Answerhood and termination · Is–ought and decision ownership ·
Principle→contract map.

## 1. A question is a choice-situation among answer propositions

**Principle.** In erotetic logic, a question is not a sentence with a gap — it is a
*choice-situation*: it lays out a set of answer propositions and asks the answerer
to select among them. A question is answered when the *issue* it raises is resolved,
i.e. when the answerer can locate the true (or chosen) proposition among the
alternatives. Source: SEP "Questions" — https://plato.stanford.edu/entries/questions/

**Contract it justifies — the 4-element question surface.** A user-reaching question
with options must carry, as required structure (schema field + pre-fire gate +
surface generated from the validated structure, never free-handed):

1. **Background** — the knowledge needed to even understand the alternatives.
2. **Intent of the question / what it resolves** — the issue being raised, explicitly.
3. **Options + recommendation** — the answer propositions, enumerated.
4. **Per-option expected effects, ripple, and root-cause approach** — what selecting
   each proposition commits to.

**Why.** If a question is a choice-situation, then a question surface that hides the
alternatives, the issue, or the consequences of each alternative is not an
under-decorated question — it is *not a well-posed question at all*: the answerer
cannot locate a proposition they cannot evaluate. The 4 elements are the minimal
rendering of the choice-situation itself: (2) is the issue, (3) is the proposition
set, (1) and (4) are what makes each proposition evaluable. That is why the gate
blocks firing on a structurally incomplete question rather than merely styling it.

## 2. Framing effects: description alone reverses preference

**Principle.** Tversky & Kahneman showed that logically equivalent choice problems
produce *reversed* preferences depending only on how the options are described
(gains vs losses framing). The wording of the surface is not neutral packaging; it
is itself a causal input to the decision. Source: Tversky & Kahneman 1981, "The
Framing of Decisions and the Psychology of Choice" —
https://stanford.edu/class/psych205/papers/Tversky-Kahneman-1981.pdf

**Contracts it justifies.**

- **Self-sufficient decision surface.** Because the description in front of the user
  at the decision moment *is* the decision input, the surface read inside the choice
  window must be complete and even-handed on its own. A briefing delivered earlier
  in the conversation does not neutralize a skewed choice window — the window's own
  framing dominates.
- **Bias-injection fire-blocking.** If wording alone can reverse a preference, then a
  question whose phrasing tilts toward one option is not a stylistic flaw but a
  manipulation of the outcome. Such questions are blocked at the fire gate, not
  merely discouraged.

## 3. Question wording reconstructs the answerer's memory

**Principle.** Loftus & Palmer showed that changing a single verb in a question
("smashed" vs "hit") changed what subjects *remembered* about an event — including
false memories of details that were never there. A question does not just probe a
stored intent; it can rewrite it. Source: Loftus & Palmer 1974, "Reconstruction of
Automobile Destruction" —
https://app.nova.edu/toolbox/instructionalproducts/edd8124/articles/1975-Loftus.pdf

**Contract it justifies — verbatim re-anchoring + distortion blocking (2 layers).**

- **Layer 1: mandatory verbatim re-anchor.** Every question-generation packet must
  carry the user's ORIGINAL utterance verbatim — not a paraphrase. Each paraphrase
  hop is a Loftus–Palmer opportunity: the generator's restatement becomes the new
  "memory" of the intent, and drift compounds silently across rounds. Re-anchoring
  on the verbatim text every round resets that drift to zero.
- **Layer 2: fire-blocking of intent-distorting questions.** Independently of good
  anchoring, a generated question that would distort, shrink, or bias-load the
  original intent is blocked before it reaches the user — because once asked, the
  question itself reconstructs what the user believes they meant. Post-hoc
  correction cannot un-ask it.

Two layers because they fail independently: a well-anchored generator can still emit
a distorting question, and a gate cannot repair a generator that lost the original
text. The existing pre-ask contract enforcement lives in
`src/core/question-context.ts` (`validateQuestionContext`), applied on both the
deep-interview pre-ask path and the prism-equivalent write path
(`src/core/question-round.ts`).

## 4. Informed consent: no meaningful choice without adequate understanding

**Principle.** The informed-consent literature holds that a choice is morally and
epistemically *valid* only when the chooser adequately understands what they are
choosing between; securing that understanding is a *disclosure duty on the party
posing the choice*, not on the chooser. Consent given without adequate disclosure
is not meaningful consent. Source: SEP "Informed Consent" —
https://plato.stanford.edu/entries/informed-consent/

**Contract it justifies — self-sufficiency as a disclosure duty + the fallback
shape.** The judgment criterion for a decision surface is: *can it be read, in
full, inside the choice window at the decision moment?* If the option set exceeds
the window limit, the only accepted fallback is per-option explicit corresponding
prose presented immediately before the choice — a general briefing elsewhere does
NOT qualify. Rationale: disclosure discharges the duty only when it reaches the
chooser *at the point of choice*, per option; anything else asks the user to
reconstruct the disclosure from memory, which is exactly what §2 and §3 show they
cannot reliably do.

## 5. Answerhood: an issue closes by resolution, not by count

**Principle.** From the same erotetic analysis (SEP "Questions", §1 above):
answerhood is defined by *resolution of the raised issue*. There is no notion under
which an issue closes because some number of other issues were processed — a count
is not an epistemic quantity.

**Contract it justifies — resolution-based termination.** The interview's
termination criterion is "have ALL raised questions (unresolved ambiguities) been
resolved?", not "has the question count reached N?". A question-count cap may bound
*effort*, but it cannot stand in for answerhood: terminating on a count while
unresolved issues remain is closing issues no one resolved. When no further
question can fire, the correct surface is a NON-terminated state that exposes the
unresolved set — never a mechanical close over open issues.

## 6. Is–ought: effect analysis cannot decide who owns the decision

**Principle.** Hume's is–ought gap: no set of descriptive facts (*is*) entails a
normative conclusion (*ought*) by itself. An analysis of what each option would
*do* is descriptive; the judgment of who *should* decide is normative — the former
cannot ground the latter. Source: SEP "Hume's Moral Philosophy" —
https://plato.stanford.edu/entries/hume-moral/

**Contract it justifies — admission = decision-ownership axis.** Whether a question
is admitted to fire at the user is judged on ONE axis: *is this a decision only the
user can make* (values, domain meaning, hard-to-reverse commitments)? Procedural
and record-keeping decisions are agent-owned and disclosed, not asked.
Consequently, per-option effect-difference analysis (an *is*-level artifact) must
NOT be mechanized into the admission judgment (an *ought*-level judgment about
ownership) — deriving "the effects differ a lot, so ask the user" crosses the gap.
Effect analysis belongs exclusively to the user-facing decision surface (§1
element 4), where it informs a choice the ownership axis has already routed to
the user.

## Principle→contract map

| Principle (source) | Surface contract it justifies |
| --- | --- |
| Question = choice-situation among answer propositions (SEP Questions) | 4-element question surface: background / question intent + issue / options + recommendation / per-option effects·ripple·root-cause — schema-required, fire-gated, surface generated from validated structure |
| Framing reverses preference by description alone (Tversky & Kahneman 1981) | Decision-surface self-sufficiency inside the choice window; fire-blocking of bias-injecting phrasings |
| Question wording reconstructs memory (Loftus & Palmer 1974) | Mandatory verbatim re-anchor of the original utterance every round + fire-blocking of intent-distorting/shrinking questions (2 independent layers) |
| Meaningful choice requires adequate disclosure at the point of choice (SEP Informed Consent) | Self-sufficiency as a disclosure duty; over-limit fallback = per-option explicit prose immediately before choice only |
| Answerhood = issue resolution, never a count (SEP Questions) | Termination = "all raised questions resolved"; no count-cap close; no-fire ⇒ surfaced non-terminated state over the unresolved set |
| Is–ought gap (SEP Hume's Moral Philosophy) | Admission judged on decision ownership only (user-only decisions fire; procedural decisions agent-owned + disclosed); effect-difference analysis is decision-surface-only, never an admission criterion |
