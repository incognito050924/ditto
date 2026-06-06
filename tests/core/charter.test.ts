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
    // The hook does not blindly auto-create on every prompt; the agent decides.
    expect(out).toContain('does not blindly auto-create a work item on every prompt');
    expect(out).toContain('1st-pass judgment');
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
