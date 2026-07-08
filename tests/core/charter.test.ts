import { describe, expect, test } from 'bun:test';
import { type CharterContext, charterProjection } from '~/core/charter';

describe('charterProjection (D8)', () => {
  test('base case: prime directive only when ctx is empty', () => {
    const out = charterProjection();
    expect(out).toContain('DITTO prime directive');
    expect(out).not.toContain('▶');
    expect(out).not.toContain('⚠');
  });

  test('placeholderAcceptanceCriteria → placeholder advisory (⚠)', () => {
    const out = charterProjection({ placeholderAcceptanceCriteria: true });
    expect(out).toContain('acceptance criteria are placeholders');
    expect(out).toContain('/ditto:deep-interview');
  });

  test('deepInterviewDirective → concrete /ditto:deep-interview directive (▶)', () => {
    const out = charterProjection({ deepInterviewDirective: true });
    expect(out).toContain('Run /ditto:deep-interview now');
    expect(out).toContain('Recommended');
    expect(out).toContain('IntentContract entry');
  });

  test('base prime directive reflects the agent-judged, agent-registered work-item model', () => {
    const out = charterProjection();
    // The hook does not auto-create on every prompt; the agent decides (compressed
    // wording, wi_260708700 — the anchors survive, the verbose how-to does not).
    expect(out).toContain('never auto-creates one');
    expect(out.toLowerCase()).toContain('you judge');
    // Creation is agent-driven (the agent runs the command), not user-manual.
    expect(out).toContain('register it YOURSELF');
    expect(out).toContain('ditto work start');
  });

  test('workItemGuide → empty-state work-item guide advisory (⚠)', () => {
    const out = charterProjection({ workItemGuide: true });
    expect(out).toContain('No active work item');
    expect(out).toContain('1st-pass judgment');
    expect(out).toContain('ditto work start');
  });

  // idea ② (wi_260627v93): weight-routing guidance — small/reversible → light path,
  // heavy reserved for ambiguous/irreversible/multi-surface. Advisory (agent-judged,
  // NOT an auto-classifier/auto-router) per D4 ADR (ADR-20260627). Always projected.
  test('prime directive carries weight-routing guidance (small/reversible → light)', () => {
    const out = charterProjection();
    expect(out).toContain('Route by weight');
    expect(out).toContain('small/reversible → light'); // light path routing
    expect(out).toContain('ditto work set-criteria'); // light path entry command
    expect(out).toContain('/ditto:deep-interview'); // heavy path entry
    expect(out).toContain('advisory');
    expect(out.toLowerCase()).toContain('you judge');
    expect(out).toContain('declared risk → heavy'); // declared risk defaults heavy
  });

  // wi_2606290xm: only two standard paths exist; the ad-hoc/console-TDD third
  // path is forbidden. The *choice* between the two stays advisory (above), but
  // *bypassing* both is hard-forbidden — this is the always-projected guard.
  test('prime directive forbids the ad-hoc third path (only two standard paths)', () => {
    const out = charterProjection();
    expect(out).toContain('TWO standard paths only');
    expect(out).toContain('Ad-hoc/console-TDD editing outside a work item');
    expect(out).toContain('FORBIDDEN');
    expect(out).toContain('TDD is HOW you implement inside a path');
    // The path *choice* must remain agent-judged (no regression on routing tone).
    expect(out).toContain('Route by weight');
    expect(out.toLowerCase()).toContain('you judge');
  });

  test('selfAnswerHint → QuestionGate advisory (⚠)', () => {
    const out = charterProjection({ selfAnswerHint: true });
    expect(out).toContain('self-answer from code/docs/web first');
    expect(out).toContain('QuestionGate');
  });

  test('all advisory flags can stack independently', () => {
    const ctx: CharterContext = {
      placeholderAcceptanceCriteria: true,
      deepInterviewDirective: true,
      selfAnswerHint: true,
    };
    const out = charterProjection(ctx);
    expect(out).toContain('acceptance criteria are placeholders');
    expect(out).toContain('Run /ditto:deep-interview now');
    expect(out).toContain('self-answer from code/docs/web first');
  });

  test('work item header + handoff hint still render with new fields', () => {
    const out = charterProjection({
      workItemId: 'wi_test1234',
      workItemTitle: 'sample',
      workItemStatus: 'draft',
      pendingHandoff: '.ditto/work-items/wi_test1234/handoff.json',
      deepInterviewDirective: true,
    });
    expect(out).toContain('Active work item: wi_test1234');
    expect(out).toContain('title="sample"');
    expect(out).toContain('Pending handoff/re-entry:');
    expect(out).toContain('Run /ditto:deep-interview now');
  });
});
