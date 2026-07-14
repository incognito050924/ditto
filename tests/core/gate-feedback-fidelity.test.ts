import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type IntentChainArtifacts,
  acceptanceTestable,
  completionEvidenceGate,
  completionGate,
  convergenceGate,
  directionForkGate,
  intentDriftGate,
  interfaceBaselineDriftGate,
  interviewReadinessGate,
  knowledgeUpdateGate,
  landGate,
  nonPassTerminationGate,
  passCloseResidualBlockers,
} from '~/core/gates';
import {
  MINIMAL_LAUNCH_MESSAGE,
  REANCHOR_PROMPT,
  renderProgressSummary,
} from '~/core/prism/engine';
import { findUnexplainedIdentifiers } from '~/core/question-context';
import { type SemanticNudgeInput, semanticScanNudge } from '~/hooks/semantic-nudge';
import {
  acgReviewForcesContinuation,
  assuranceSnapshotForcesContinuation,
  autopilotBypassForcesContinuation,
  decisionConflictForcesContinuation,
  dialecticForcesContinuation,
  impactForcesContinuation,
  knowledgeForcesContinuation,
  residualResolvabilityForcesContinuation,
  riskRecordForcesContinuation,
  semanticForcesContinuation,
} from '~/hooks/stop';
import type { CompletionContract } from '~/schemas/completion-contract';
import type { Convergence } from '~/schemas/convergence';
import type { PrismIssueMap } from '~/schemas/prism';

// ─────────────────────────────────────────────────────────────────────────────
// Directive-fidelity + leak-0 lock for wi_260714z16 (#30): the large plain-Korean
// REWRITE of the runtime user-read Stop/gate/question-surface strings. This file
// is authored RED-FIRST — the rewrite nodes turn the RED-FIRST specs GREEN by
// de-jargoning the strings; the COMPLETENESS-BACKSTOP guards are GREEN now and
// TRIP RED if a rewrite silently drops a stable operative token.
//
// Extends the existing charter.test.ts patterns (cue-ENUMERATION @152-183,
// snapshot-PIN @187+) onto the gate/Stop/question surfaces, and reuses the
// read-only leak detector `findUnexplainedIdentifiers` + `OPAQUE_VOCAB_FLOOR`
// (src/core/question-context.ts). No source string is edited here and the
// detector / floor are NOT modified.
//
// Strings are exercised by CALLING the real pure builders (no copied literals);
// the two inline stopHandler strings that cannot be imported (they are template
// literals inside the handler body, not exported) are guarded against the real
// module source text — see block C2.
// ─────────────────────────────────────────────────────────────────────────────

/** A Korean (Hangul) run — presence proves the string was actually plain-Korean-ized. */
const HANGUL = /[가-힣]/;

const REPO_ROOT = join(import.meta.dir, '..', '..');
const stopSrc = readFileSync(join(REPO_ROOT, 'src/hooks/stop.ts'), 'utf8');
const backlogSrc = readFileSync(join(REPO_ROOT, 'src/core/prism/backlog.ts'), 'utf8');

// ── Minimal fixtures for the pure builders. The builders only READ fields (no
// zod re-validation), so partial literals cast to the schema type are sufficient
// and keep the fixtures legible. ─────────────────────────────────────────────

/** A non-pass completion that PARKS an in-scope criterion at unverified with no honest declaration. */
const parkedCompletion = {
  final_verdict: 'partial',
  acceptance: [{ criterion_id: 'ac-1', verdict: 'unverified' }],
  non_pass_status: undefined,
} as unknown as CompletionContract;

/** A convergence record whose selected version is NOT the max score, and whose open-admissible count is wrong. */
const nonArgmaxConvergence = {
  versions: [
    { version: 'a', score: 1 },
    { version: 'b', score: 2 },
  ],
  selected_version: 'a',
  decision_ledger: [],
  open_admissible_count: 5,
  gate: { completion_gate: 'pass', converged: true },
} as unknown as Convergence;

/** A completion whose `unverified[]` carries one blocker of each resolvability class. */
const residualCompletion = {
  unverified: [
    { item: '항목A', reason: '사유A', resolvability: 'agent_resolvable' },
    { item: '항목B', reason: '사유B', resolvability: 'blocked_external' },
    { item: '항목C', reason: '사유C', resolvability: 'user_decision' },
  ],
  remaining_risk_records: [],
} as unknown as CompletionContract;

/** intent→work-item→autopilot→completion chain rigged to fire every drift hop (H1/H2/H3). */
const driftAll = {
  intent: {
    goal: 'G',
    source_request: 'SR-i',
    acceptance_criteria: [{ id: 'ac-1' }, { id: 'ac-2' }],
  },
  workItem: {
    goal: 'G2',
    source_request: 'SR-w',
    acceptance_criteria: [{ id: 'ac-1' }, { id: 'ac-3' }],
  },
  graph: { root_goal: 'G3', nodes: [{ acceptance_refs: ['ac-1', 'ac-4'] }] },
  completion: { final_verdict: 'partial', acceptance: [{ criterion_id: 'ac-1' }] },
} as unknown as IntentChainArtifacts;

/** intent chain rigged so ONLY the H1 source_request advisory fires — nothing else. */
const driftSourceRequestOnly = {
  intent: { goal: 'G', source_request: 'orig', acceptance_criteria: [{ id: 'ac-1' }] },
  workItem: { goal: 'G', source_request: 'changed', acceptance_criteria: [{ id: 'ac-1' }] },
  graph: { root_goal: 'G', nodes: [{ acceptance_refs: ['ac-1'] }] },
} as unknown as IntentChainArtifacts;

const bypassArgs = () => {
  type Args = Parameters<typeof autopilotBypassForcesContinuation>;
  const workItem = {
    id: 'wi_bypass01',
    status: 'in_progress',
    autopilot_exempt: false,
    changed_files: ['src/x.ts'],
    acceptance_criteria: [],
  } as unknown as Args[0];
  const completion = { status: 'ok', data: { changed_files: ['src/x.ts'] } } as unknown as Args[1];
  const pilot = { status: 'absent' } as unknown as Args[2];
  return autopilotBypassForcesContinuation(workItem, completion, pilot, true);
};

const nudgeObserve: SemanticNudgeInput = {
  workItemId: 'wi_x',
  isNonTerminal: true,
  semanticPresent: false,
  base: 'main',
  changedSourceFiles: ['src/a.ts'],
  observationChangeCount: null,
};
const nudgeDetect: SemanticNudgeInput = { ...nudgeObserve, observationChangeCount: 3 };

const progressPrism = {
  tree: { root_id: 'root', nodes: [{ id: 'n1', state: 'open', label: '남은 항목 하나' }] },
} as unknown as PrismIssueMap;

// ═════════════════════════════════════════════════════════════════════════════
// BLOCK A — RED-FIRST de-jargon: the operative gate/Stop feedback strings must
// SHED their internal schema-field / alias jargon and carry concept-Korean.
// WHY red now: every one of these strings is currently English + raw schema
// tokens; the #30 rewrite (reader = a user who does NOT know the glossary;
// operative surface = force-preserve + de-jargon) is what turns them green.
// Each asserts (1) the specific jargon token(s) are GONE and (2) Korean is present.
// ═════════════════════════════════════════════════════════════════════════════
describe('RED-FIRST — operative gate/Stop feedback is de-jargoned to concept-Korean (#30)', () => {
  // AC clause: non-pass termination reason. Edge it pins: the reason must still
  // tell the agent WHICH criteria are parked and WHAT to do, but the schema field
  // name `non_pass_status` (an internal alias) must not leak on the operative face.
  test('nonPassTerminationGate reason drops `non_pass_status`, gains Korean', () => {
    const [reason] = nonPassTerminationGate(parkedCompletion).reasons;
    expect(reason).toBeDefined();
    expect(reason).not.toContain('non_pass_status');
    expect(HANGUL.test(reason ?? '')).toBe(true);
  });

  // AC clause: convergence gate reasons. Pins the argmax / selected_version /
  // open_admissible_count schema-jargon triple — all three must become concept-Korean.
  test('convergenceGate reasons drop argmax/selected_version/open_admissible_count, gain Korean', () => {
    const text = convergenceGate(nonArgmaxConvergence).reasons.join('\n');
    expect(text).not.toContain('argmax');
    expect(text).not.toContain('selected_version');
    expect(text).not.toContain('open_admissible_count');
    expect(HANGUL.test(text)).toBe(true);
  });

  // AC clause: intent-drift reasons/advisories. Pins the schema-field leaks
  // source_request / acceptance_refs / root_goal. The H1/H2/H3 hop markers are
  // NOT jargon (they are string-matched by driftHops) — their survival is guarded
  // separately in block C3, so this test must NOT forbid them.
  test('intentDriftGate text drops source_request/acceptance_refs/root_goal, gains Korean', () => {
    const g = intentDriftGate(driftAll);
    const text = [...g.reasons, ...g.advisories].join('\n');
    expect(text).not.toContain('source_request');
    expect(text).not.toContain('acceptance_refs');
    expect(text).not.toContain('root_goal');
    expect(HANGUL.test(text)).toBe(true);
  });

  // AC clause: residual resolvability reasons (the ONE label space shared by the
  // Stop hook's unverified[] + remaining_risk_records gates). Pins the four
  // resolvability aliases. `pass-close` polarity is preserved (guarded in C4).
  test('passCloseResidualBlockers reasons drop resolvability aliases, gain Korean', () => {
    const text = passCloseResidualBlockers(residualCompletion, []).join('\n');
    expect(text).not.toContain('agent_resolvable');
    expect(text).not.toContain('blocked_external');
    expect(text).not.toContain('user_decision');
    expect(text).not.toContain('deferred_needs_user_ok');
    expect(HANGUL.test(text)).toBe(true);
  });

  // AC clause: the Stop-time semantic-scan nudge (both branches). Currently fully
  // English; must become Korean while keeping the `ditto semantic …` commands
  // (command survival guarded in C1). Edge: both the observe branch and the
  // detect/verdict branch are separately rewritten.
  test('semanticScanNudge gains Korean on both branches', () => {
    const observe = semanticScanNudge(nudgeObserve) ?? '';
    const detect = semanticScanNudge(nudgeDetect) ?? '';
    expect(HANGUL.test(observe)).toBe(true);
    expect(HANGUL.test(detect)).toBe(true);
  });

  // AC clause: the autopilot-bypass Stop reason. Currently English prose; must
  // become Korean while preserving the `ditto autopilot …` commands (C1).
  test('autopilotBypassForcesContinuation reason gains Korean', () => {
    const text = bypassArgs().join('\n');
    expect(text.length).toBeGreaterThan(0);
    expect(HANGUL.test(text)).toBe(true);
  });

  // AC clause (glossary term, NOT removal): `물화` (follow-up materialization) is an
  // agreed glossary term, so the reader model KEEPS it as the anchor and adds a
  // one-line first-use gloss — it must NOT be surfaced bare. Red now: backlog.ts
  // line ~219 uses `물화에는 …` with no adjacent parenthetical gloss. Green after the
  // rewrite adds `물화(…)`. (Coarse: scans the module source, since the bare-term
  // string is a validation reason built inside a function; the ONLY `물화` in the
  // file is that line, so the file-level gloss check is exact enough here.)
  test('prism backlog surfaces `물화` WITH a first-use gloss, not bare', () => {
    expect(/물화\s*[（(]/.test(backlogSrc)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLOCK B — RED-FIRST leak-0: user-reaching feedback that currently leaks a
// detector-caught opaque token must reach `findUnexplainedIdentifiers == 0`.
// Only tokens the read-only detector actually catches (IDENTIFIER_PATTERNS +
// OPAQUE_VOCAB_FLOOR) can be red here; `source_request` IS in the floor, so the
// H1 advisory leaks it now. Turnable: the rewrite replaces `source_request` with
// concept-Korean, and the detector then reports 0.
// ═════════════════════════════════════════════════════════════════════════════
describe('RED-FIRST — leak-0 over user-reaching feedback (findUnexplainedIdentifiers)', () => {
  // WHY red now: intentDriftGate's H1 advisory is exactly
  //   'H1: work-item source_request diverges from intent (review)'
  // and `source_request` is an OPAQUE_VOCAB_FLOOR entry surfaced un-glossed, so
  // the detector returns ['source_request']. The fixture is rigged so ONLY this
  // one advisory fires (no interpolated ac-id shapes), keeping the red turnable:
  // de-jargoning `source_request` alone drives the detector to [].
  test('intentDriftGate H1 source_request advisory reaches leak-0', () => {
    const g = intentDriftGate(driftSourceRequestOnly);
    expect(g.advisories.join('\n')).toContain('H1:'); // sanity: the advisory fired
    expect(findUnexplainedIdentifiers(g.advisories.join('\n'))).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLOCK C — COMPLETENESS-BACKSTOP (green now, MUST STAY green): the sweep's
// admissible-HIGH fix. A pure cue-ENUMERATION lock can't catch a cue it never
// enumerated — a rewrite could silently DROP an operative command literal and stay
// green. These guards pin the STABLE operative tokens that must SURVIVE the rewrite
// verbatim; each trips RED if a rewrite drops it.
// ═════════════════════════════════════════════════════════════════════════════
describe('COMPLETENESS-BACKSTOP — stable operative tokens survive the rewrite', () => {
  // C1: CLI command literals the Stop/nudge strings tell the agent to run — via
  // the importable builders that emit them. Koreanizing the prose must not drop
  // the commands.
  test('C1: autopilot-bypass reason keeps `ditto autopilot bootstrap` + `ditto autopilot exempt`', () => {
    const text = bypassArgs().join('\n');
    expect(text).toContain('ditto autopilot bootstrap');
    expect(text).toContain('ditto autopilot exempt');
  });

  test('C1: semantic nudge keeps `ditto semantic observe` / `detect` / `verdict`', () => {
    expect(semanticScanNudge(nudgeObserve) ?? '').toContain('ditto semantic observe');
    const detect = semanticScanNudge(nudgeDetect) ?? '';
    expect(detect).toContain('ditto semantic detect');
    expect(detect).toContain('ditto semantic verdict');
  });

  // C2: CLI literals in the two INLINE stopHandler strings (P6 approve reason
  // @stop.ts:~859; strong-block @stop.ts:~1057). They are template literals inside
  // the handler body — not exported, not callable without a full session/store
  // fixture — so they are guarded against the real module source text. Coarse
  // (matches the whole file, including a comment reference to `/ditto:verify`), so
  // this asserts only that the command literal is not DELETED from stop.ts; the
  // durable per-string lock is the snapshot-pin the rewrite node adds (block E).
  test('C2: stop.ts source keeps the inline CLI literals `ditto autopilot approve` + `/ditto:verify`', () => {
    expect(stopSrc).toContain('ditto autopilot approve');
    expect(stopSrc).toContain('/ditto:verify');
  });

  // C3: the drift-hop markers H1:/H2:/H3: (gates.ts ~900-957). driftHops
  // (stop.ts:572-575) string-matches `${h}:`, so a rewrite that drops or renames a
  // marker silently breaks the intent-drift metric hop attribution — AC-4. These
  // MUST survive verbatim even as the surrounding reason text is Koreanized.
  test('C3: intentDriftGate keeps the H1:/H2:/H3: drift markers (AC-4)', () => {
    const g = intentDriftGate(driftAll);
    const text = [...g.reasons, ...g.advisories].join('\n');
    expect(text).toContain('H1:');
    expect(text).toContain('H2:');
    expect(text).toContain('H3:');
  });

  // C4: the `pass-close` polarity anchor of the residual gate — the shared label
  // space names the block as a "pass-close" block. Kept as the operative anchor so
  // the rewrite's Korean prose still identifies the polarity. (Softer than a
  // command literal; if a rewrite deliberately Koreanizes the anchor it updates
  // this guard consciously — that conscious touch is the point of the backstop.)
  test('C4: passCloseResidualBlockers keeps the `pass-close` polarity anchor', () => {
    const text = passCloseResidualBlockers(residualCompletion, []).join('\n');
    expect(text).toContain('pass-close');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLOCK D — COMPLETENESS-BACKSTOP leak-0 regression guards (green now). These
// user-facing prism/interview surfaces are ALREADY plain-Korean and leak nothing;
// the guard trips if a future edit surfaces an un-glossed id / floor term on them.
// ═════════════════════════════════════════════════════════════════════════════
describe('COMPLETENESS-BACKSTOP — clean user faces stay leak-0', () => {
  test('prism launch/reanchor/progress surfaces leak no unexplained identifier', () => {
    const surfaces = [
      MINIMAL_LAUNCH_MESSAGE,
      REANCHOR_PROMPT,
      ...renderProgressSummary(progressPrism),
    ];
    for (const s of surfaces) expect(findUnexplainedIdentifiers(s)).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLOCK E — snapshot-PIN backlog (for the rewrite nodes; NOT a test yet). A
// full-string snapshot of a NOT-YET-rewritten string can't be red-first, so the
// DURABLE per-string regression lock is added by the rewrite node AFTER it
// produces the final Korean string. This is where the completion-gate
// verdict/polarity strings — whose operative FORCE survives but whose surface is
// Koreanized (so they are NOT literal-token-guardable in blocks C/D) — get their
// durable lock. Mirror charter.test.ts:187 "reworded strings are pinned": after
// rewriting, add `expect(<builder>(<fixture>)…).toContain('<final Korean string>')`
// for EACH of the builders below (call the builder — do NOT copy a source literal):
//
//   1. nonPassTerminationGate(parkedCompletion).reasons[0]
//   2. convergenceGate(nonArgmaxConvergence).reasons  (argmax + open_admissible + not-converged)
//   3. intentDriftGate(driftAll)  reasons + advisories (H1/H2/H3, markers preserved)
//   4. passCloseResidualBlockers(residualCompletion, [])  (the four resolvability reasons)
//   5. completionGate  `final_verdict=pass but not-pass criteria …` reason
//   6. completionEvidenceGate  `final_verdict=pass with no runnable verification …` reason
//   7. landGate('done','pass',[f])  reason (final_verdict / "before terminating" polarity)
//   8. semanticScanNudge  observe + detect/verdict strings
//   9. autopilotBypassForcesContinuation reason
//  10. stop.ts inline P6 approve reason + strong-block `/ditto:verify` string
//      ("before stopping" polarity) — these are inline template literals; pin them
//      once they can be reached (or keep the block-C2 command-literal source guard).
// ═════════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
// BLOCK F — the SURFACE-COMPLETENESS residual (#30, wi_260714z16): the last six
// English gate/Stop reason strings the earlier rewrite left. Each is now plain-
// Korean-ized (de-jargon + force/polarity preserved). These assertions were RED
// against the pre-rewrite English source (no Hangul / jargon still present) and go
// GREEN after the Koreanization — a durable per-string lock against regression,
// AND a survival guard for every operative token/threshold that had to be KEPT.
//
// KEPT-ANCHOR NOTE: several substrings are string-matched by OUT-OF-SCOPE tests
// (gates.test.ts `r.includes('critical'|'vague'|'observable'|'grow'|'shrink'|
// '<field>')`, knowledge-cli.test.ts / stop.test.ts / semantic-pipeline-e2e.test.ts
// `toContain('over-recording'|'under-recording'|'semantic: meaning compatibility
// unverified'|'semantic: unintended meaning break')`). Those substrings CANNOT be
// deleted without breaking a test this node may not edit, so they are ANCHORED
// (English token kept + Korean gloss added) — guarded here as survival, not removal.
// ═════════════════════════════════════════════════════════════════════════════
describe('SURFACE-COMPLETENESS — the six residual gate/Stop reasons are Koreanized (#30)', () => {
  // 1. interviewReadinessGate: BOTH reasons fire (a critical dimension unresolved
  // AND the floor-capped readiness under threshold). De-jargon `floor-capped` /
  // `below threshold`; keep the `<` threshold cue and the `critical` anchor
  // (gates.test.ts:68 asserts `r.includes('critical')`).
  const readinessBlocked = {
    dimensions: [{ id: 'dim-x', critical: true, state: 'open' }],
    questions: [],
    assumptions: [],
    readiness: { score: 0.9, threshold: 0.99 },
  } as unknown as Parameters<typeof interviewReadinessGate>[0];

  test('interviewReadinessGate: Korean + `<` threshold cue kept, `floor-capped`/`below threshold` gone', () => {
    const r = interviewReadinessGate(readinessBlocked).reasons.join('\n');
    expect(HANGUL.test(r)).toBe(true);
    expect(r).toContain('critical'); // survival anchor (gates.test.ts pins it)
    expect(r).toContain('임계값'); // threshold rendered in Korean
    expect(r).toContain('<'); // "below threshold" polarity kept as strict-less
    expect(r).not.toContain('floor-capped');
    expect(r).not.toContain('below threshold');
  });

  // 2. acceptanceTestable: `vague`/`observable` are string-matched by gates.test.ts
  // (`/vague/`, `/observable/`), so they are anchored, not removed; the prose is
  // Koreanized around them.
  test('acceptanceTestable: Korean added; `vague`/`observable` anchors survive', () => {
    const vagueR = acceptanceTestable({ statement: 'makes it robust' }).reasons.join('\n');
    expect(HANGUL.test(vagueR)).toBe(true);
    expect(vagueR).toContain('vague'); // anchor (gates.test.ts /vague/)
    expect(vagueR).toContain('모호');
    const obsR = acceptanceTestable({ statement: '비밀번호 기능을 더 좋게 만든다' }).reasons.join(
      '\n',
    );
    expect(HANGUL.test(obsR)).toBe(true);
    expect(obsR).toContain('observable'); // anchor (gates.test.ts /observable/)
    expect(obsR).toContain('완료 조건');
  });

  // 3. knowledgeUpdateGate: the `over-recording`/`under-recording` aliases are pinned
  // by gates.test.ts + knowledge-cli.test.ts + stop.test.ts, so they SURVIVE as
  // anchors; the trigger ENUM tokens (`adr_worthy_decision`/`new_agreed_term`/
  // `repeated_pattern`) are NOT string-matched in any reason consumer (grep-verified)
  // and are de-jargoned to concept-Korean.
  const NONE = { adr_worthy_decision: false, new_agreed_term: false, repeated_pattern: false };
  const ALL = { adr_worthy_decision: true, new_agreed_term: true, repeated_pattern: true };
  const ZERO = { decisions: 0, glossary_terms: 0, patterns: 0, learnings: 0 };

  test('knowledgeUpdateGate: over/under-recording anchors survive, trigger tokens de-jargoned', () => {
    const overR = knowledgeUpdateGate(NONE, { ...ZERO, decisions: 1 }).reasons.join('\n');
    expect(HANGUL.test(overR)).toBe(true);
    expect(overR).toContain('over-recording'); // anchor (gates.test.ts + cli pin)
    const underR = knowledgeUpdateGate(ALL, ZERO).reasons.join('\n');
    expect(HANGUL.test(underR)).toBe(true);
    expect(underR).toContain('under-recording'); // anchor (multiple pins)
    expect(underR).not.toContain('adr_worthy_decision');
    expect(underR).not.toContain('new_agreed_term');
    expect(underR).not.toContain('repeated_pattern');
  });

  // 4. directionForkGate: the three condition field-names are pinned by gates.test.ts
  // (`x.includes('purpose_change'|'no_clear_advantage'|'intent_cannot_break_tie')`)
  // and stop.test.ts, so they are kept as anchors; the `missing (present:false or
  // empty basis)` English prose is Koreanized.
  const forkMissing = {
    schema_version: '0.1.0',
    mode: 'autopilot',
    node_id: 'impl-x',
    purpose_change: { present: false, basis: '' },
    no_clear_advantage: { present: false, basis: '' },
    intent_cannot_break_tie: { present: false, basis: '' },
  } as unknown as Parameters<typeof directionForkGate>[0];

  test('directionForkGate: Korean added; the three condition field-name anchors survive', () => {
    const r = directionForkGate(forkMissing).reasons.join('\n');
    expect(HANGUL.test(r)).toBe(true);
    expect(r).toContain('purpose_change'); // field-name anchors (gates/stop pins)
    expect(r).toContain('no_clear_advantage');
    expect(r).toContain('intent_cannot_break_tie');
    expect(r).not.toContain('missing (present'); // English prose Koreanized
  });

  // 5. interfaceBaselineDriftGate: `grow`/`shrink` polarity words are pinned by
  // gates.test.ts (`x.includes('grow')` / `x.includes('shrink')`), kept as anchors;
  // `frozen baseline` is Koreanized. baseline=[a] vs current=[b] fires BOTH reasons.
  test('interfaceBaselineDriftGate: grow/shrink polarity anchors survive, `frozen baseline` gone', () => {
    const r = interfaceBaselineDriftGate(['a.ts'], ['b.ts']).reasons.join('\n');
    expect(HANGUL.test(r)).toBe(true);
    expect(r).toContain('grow'); // polarity anchor (gates.test.ts pins)
    expect(r).toContain('shrink'); // polarity anchor
    expect(r).toContain('기준선'); // baseline in Korean
    expect(r).not.toContain('frozen baseline');
  });

  // 6. semanticForcesContinuation (stop.ts): Korean-primary reasons keeping only the
  // `semantic:` structural category marker (namespace tag, like H1:/H2:/H3:). The
  // Korean phrases `semantic: 의미 호환성 미검증` / `semantic: 의도치 않은 의미 파손`
  // are pinned by stop.test.ts + semantic-pipeline-e2e.test.ts. The imperative
  // "verify or declare" and the "unintended break" polarity are preserved in Korean.
  const semChanges = {
    changes: [
      {
        before: 'User|null',
        after: 'User',
        old_meaning: '없을 수 있음',
        verdict: { type_safe: true, semantic_safe: 'unverified' },
      },
      {
        before: 'A',
        after: 'B',
        old_meaning: '옛 의미',
        verdict: { type_safe: true, semantic_safe: 'no', intended_breaking: false },
      },
    ],
  } as unknown as Parameters<typeof semanticForcesContinuation>[0];

  test('semanticForcesContinuation: `semantic:` marker kept, Korean-primary + imperative preserved', () => {
    const r = semanticForcesContinuation(semChanges).join('\n');
    expect(HANGUL.test(r)).toBe(true);
    expect(r).toContain('semantic: 의미 호환성 미검증'); // anchor (stop + e2e pin)
    expect(r).toContain('semantic: 의도치 않은 의미 파손'); // anchor (stop pin)
    expect(r).toContain('검증하거나'); // "verify or declare" imperative preserved
    expect(r).toContain('의도치 않은'); // "unintended break" polarity preserved
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// BLOCK G — SURFACE-COMPLETE LOCK (#30, wi_260714z16): "no English-only user-read
// Stop/gate string". The root-cause fix for the false "surface-complete" claim.
//
// Why the earlier locks did NOT catch the misses: BLOCK A only asserts that named
// jargon TOKENS were REMOVED — a string that stayed FULLY English has no token to
// remove, so it stays green while shipping English (a live Stop-gate feedback then
// showed English). This block closes that gap POSITIVELY: every user-read
// reason/header builder that flows into the Stop cascade is CALLED with inputs that
// FIRE its reason(s), and its output must CONTAIN Hangul. Any future English-only
// miss on this surface trips RED here.
//
// EXCLUSIONS (documented, deliberately NOT asserted as Stop-surface Korean):
//  - `oracleSatisfaction` / `assertFrozenTestsIntact` (gates.ts): their reasons
//    surface in the autopilot LOOP node-verdicts (autopilot-loop.ts / -complete.ts),
//    NEVER in stop.ts stderr — grep-verified absent from src/hooks. Different surface.
//  - the P6 decision-LEDGER audit reason (stop.ts ~689): a machine audit field in
//    the append-only decision log, following the codebase's English ledger-reason
//    pattern (autopilot-loop.ts:1035, autopilot-complete.ts:483/529); its USER-FACING
//    twin for the same event is already Korean (stop.ts ~868).
//  - genuinely-structural pure-marker strings (all-`${...}`/token, no prose) — but
//    every builder below emits prose, so all are in scope.
// ═════════════════════════════════════════════════════════════════════════════
describe('SURFACE-COMPLETE (BLOCK G) — every user-read Stop/gate builder emits Korean', () => {
  // Minimal fixtures that FIRE each builder's reason(s). Builders only READ fields
  // (no zod re-validation), so partial literals cast to the param type suffice.
  const gReadiness = {
    dimensions: [{ id: 'dim-x', critical: true, state: 'open' }],
    questions: [],
    assumptions: [],
    readiness: { score: 0.9, threshold: 0.99 },
  } as unknown as Parameters<typeof interviewReadinessGate>[0];

  const gCompItem = { acceptance_criteria: [{ id: 'ac-1' }] } as unknown as Parameters<
    typeof completionGate
  >[0];
  // pass verdict on an id NOT in the work item → missing ac-1 + extra ac-2 both fire.
  const gCompletion = {
    final_verdict: 'pass',
    acceptance: [{ criterion_id: 'ac-2', verdict: 'pass' }],
    verifications: [],
  } as unknown as Parameters<typeof completionGate>[1];

  // pass with only a note + no verifications → ack≠verification reason fires.
  const gEvidence = {
    final_verdict: 'pass',
    verifications: [],
    acceptance: [{ evidence: [{ kind: 'note' }], evidence_records: [] }],
  } as unknown as Parameters<typeof completionEvidenceGate>[0];

  const forkMissing = {
    schema_version: '0.1.0',
    mode: 'autopilot',
    node_id: 'impl-x',
    purpose_change: { present: false, basis: '' },
    no_clear_advantage: { present: false, basis: '' },
    intent_cannot_break_tie: { present: false, basis: '' },
  } as unknown as Parameters<typeof directionForkGate>[0];

  const semChanges = {
    changes: [
      {
        before: 'User|null',
        after: 'User',
        old_meaning: '없을 수 있음',
        verdict: { type_safe: true, semantic_safe: 'unverified' },
      },
    ],
  } as unknown as Parameters<typeof semanticForcesContinuation>[0];

  const wiNoAcs = { acceptance_criteria: [] } as unknown as Parameters<
    typeof residualResolvabilityForcesContinuation
  >[1];
  const gRiskCompletion = {
    unverified: [],
    remaining_risk_records: [{ risk: '위험X', resolvability: 'agent_resolvable' }],
  } as unknown as Parameters<typeof riskRecordForcesContinuation>[0];

  const gReview = {
    files: [{ risk: 'high', path: 'src/x.ts', risk_reason: '위험 사유' }],
  } as unknown as Parameters<typeof acgReviewForcesContinuation>[0];
  const gAssurance = {
    results: [{ outcome: 'fail', function_id: 'f1', new_violations: 2 }],
  } as unknown as Parameters<typeof assuranceSnapshotForcesContinuation>[0];
  const gImpact = {
    unresolved: [{ kind: 'dynamic', path: 'src/x.ts', reason: '사유' }],
  } as unknown as Parameters<typeof impactForcesContinuation>[0];
  const gConflict = {
    mode: 'autopilot',
    conflicts: [{ adr_id: 'ADR-0006', kind: 'forbid', level: 'intent', basis: '근거' }],
  } as unknown as Parameters<typeof decisionConflictForcesContinuation>[0];
  const gDialectic = {
    review_id: 'r1',
    round: 1,
    input: { constraints: { max_rounds: 1 } },
    synthesizer: {
      verdict: 'reject',
      accepted_objections: [],
      rejected_objections: [],
      required_edits: [],
    },
    opponent: { objections: [] },
  } as unknown as Parameters<typeof dialecticForcesContinuation>[0];
  const gKnowledgeGraph = {
    nodes: [{ kind: 'knowledge', owner: 'implementer', status: 'passed', acceptance_refs: [] }],
  } as unknown as Parameters<typeof knowledgeForcesContinuation>[0];
  const gKnowledgeCarrier = {
    triggers: { adr_worthy_decision: true, new_agreed_term: false, repeated_pattern: false },
    delta: { decisions: 0, glossary_terms: 0, patterns: 0, learnings: 0 },
  } as unknown as Parameters<typeof knowledgeForcesContinuation>[1];

  // Each entry produces the builder's user-read text. A builder whose input is rigged
  // to fire produces non-empty prose; the two invariants are: it FIRED (length>0) and
  // it reads as Korean (Hangul present).
  const cases: Array<[string, () => string]> = [
    ['interviewReadinessGate', () => interviewReadinessGate(gReadiness).reasons.join('\n')],
    [
      'acceptanceTestable',
      () => acceptanceTestable({ statement: 'makes it robust' }).reasons.join('\n'),
    ],
    ['convergenceGate', () => convergenceGate(nonArgmaxConvergence).reasons.join('\n')],
    ['completionGate', () => completionGate(gCompItem, gCompletion).reasons.join('\n')],
    ['completionEvidenceGate', () => completionEvidenceGate(gEvidence).reasons.join('\n')],
    ['nonPassTerminationGate', () => nonPassTerminationGate(parkedCompletion).reasons.join('\n')],
    [
      'intentDriftGate',
      () =>
        [...intentDriftGate(driftAll).reasons, ...intentDriftGate(driftAll).advisories].join('\n'),
    ],
    [
      'passCloseResidualBlockers',
      () => passCloseResidualBlockers(residualCompletion, []).join('\n'),
    ],
    ['landGate', () => landGate('done', 'pass', ['src/x.ts']).reasons.join('\n')],
    [
      'knowledgeUpdateGate',
      () =>
        knowledgeUpdateGate(
          { adr_worthy_decision: true, new_agreed_term: true, repeated_pattern: true },
          { decisions: 0, glossary_terms: 0, patterns: 0, learnings: 0 },
        ).reasons.join('\n'),
    ],
    ['directionForkGate', () => directionForkGate(forkMissing).reasons.join('\n')],
    [
      'interfaceBaselineDriftGate',
      () => interfaceBaselineDriftGate(['a.ts'], ['b.ts']).reasons.join('\n'),
    ],
    ['semanticForcesContinuation', () => semanticForcesContinuation(semChanges).join('\n')],
    ['autopilotBypassForcesContinuation', () => bypassArgs().join('\n')],
    ['acgReviewForcesContinuation', () => acgReviewForcesContinuation(gReview).join('\n')],
    [
      'assuranceSnapshotForcesContinuation',
      () => assuranceSnapshotForcesContinuation(gAssurance).join('\n'),
    ],
    ['impactForcesContinuation', () => impactForcesContinuation(gImpact).join('\n')],
    [
      'residualResolvabilityForcesContinuation',
      () => residualResolvabilityForcesContinuation(residualCompletion, wiNoAcs).join('\n'),
    ],
    [
      'riskRecordForcesContinuation',
      () => riskRecordForcesContinuation(gRiskCompletion, wiNoAcs).join('\n'),
    ],
    [
      'decisionConflictForcesContinuation',
      () => decisionConflictForcesContinuation(gConflict).reasons.join('\n'),
    ],
    ['dialecticForcesContinuation', () => dialecticForcesContinuation(gDialectic).join('\n')],
    [
      'knowledgeForcesContinuation',
      () => knowledgeForcesContinuation(gKnowledgeGraph, gKnowledgeCarrier).join('\n'),
    ],
    ['semanticScanNudge(observe)', () => semanticScanNudge(nudgeObserve) ?? ''],
    ['semanticScanNudge(detect)', () => semanticScanNudge(nudgeDetect) ?? ''],
  ];

  for (const [name, produce] of cases) {
    test(`${name} emits fired Korean reason (no English-only miss)`, () => {
      const text = produce();
      expect(text.length).toBeGreaterThan(0); // the builder actually FIRED a reason
      expect(HANGUL.test(text)).toBe(true); // and it reads as Korean
    });
  }

  // The three inline stopHandler stderr strings the earlier rewrite MISSED. They are
  // template literals inside the handler body (not exported/callable), so they are
  // guarded against the real module source text (BLOCK C2 precedent): the pre-#30
  // English-only phrase must be GONE and its Korean replacement PRESENT.
  test('G-inline: the three formerly-English stop.ts stderr strings are Koreanized', () => {
    // runnable-node continuation reason (stop.ts ~919); "not complete yet" negation kept.
    expect(stopSrc).not.toContain(
      'autopilot has runnable node(s); the work item is not complete yet',
    );
    expect(stopSrc).toContain('아직 완료되지 않음');
    // direction-fork-incomplete prefix (stop.ts ~875); `direction fork` anchor kept.
    expect(stopSrc).not.toContain('direction fork incomplete —');
    expect(stopSrc).toContain('방향 분기(direction fork)가 불완전함');
    // per-AC attestation header + state rendering (stop.ts ~1039); `attestation` and
    // the `verified-by-evidence`/… enum tokens kept as anchors (stop.test.ts pins them).
    expect(stopSrc).not.toContain('DITTO Stop attestation (per-AC) —');
    expect(stopSrc).toContain('DITTO Stop attestation(완료 조건별 증거 확인)');
    expect(stopSrc).toContain("'verified-by-evidence': '증거로 검증됨'"); // anchor + gloss survive
  });
});
