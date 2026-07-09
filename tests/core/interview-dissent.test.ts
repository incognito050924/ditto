import { describe, expect, test } from 'bun:test';
import {
  INTENT_DISSENT_CONSTRAINT,
  buildIntentDissentBrief,
  engageIntentDissent,
  mergeDissent,
} from '~/core/interview-dissent';
import type { OpponentBrief, OpponentSeamConfig } from '~/core/prism/opponent';
import type { InterviewDimension, InterviewDissent } from '~/schemas/interview-state';

const BARE_POLICY: OpponentSeamConfig['policy'] = {
  producer: 'current-host',
  opponent_preferred: 'codex',
  opponent_fallback: [],
  synthesizer: 'claude-opus',
};

function makeConfig(over: Partial<OpponentSeamConfig>): OpponentSeamConfig {
  return {
    policy: BARE_POLICY,
    currentHost: 'claude-code',
    isAvailable: () => ({ available: true }),
    delegate: async () => null,
    intent: 'add a /password-strength endpoint that returns a 0-100 score',
    ...over,
  };
}

const CRIT: InterviewDimension = {
  id: 'd-score-formula',
  critical: true,
  state: 'resolved',
  ambiguity: 0,
  resolved_by: [],
  notes: 'raw transcript notes that must NOT leak into the brief',
};

describe('engageIntentDissent (ac-1 seam · ADR-0001 host-delegated · ADR-0018 degrade)', () => {
  test('no host (selection null) → host_absent, delegate NEVER called', async () => {
    let called = false;
    const cfg = makeConfig({
      isAvailable: () => ({ available: false, reason: 'runtime' }),
      delegate: async () => {
        called = true;
        return 'should not run';
      },
    });
    const out = await engageIntentDissent(CRIT, cfg);
    expect(out.status).toBe('host_absent');
    expect(called).toBe(false);
  });

  test('delegate returns non-empty text → engaged, high impact on a critical dimension', async () => {
    const cfg = makeConfig({ delegate: async () => 'The intent conflates score with policy.' });
    const out = await engageIntentDissent(CRIT, cfg);
    expect(out.status).toBe('engaged');
    expect(out.impact).toBe('high');
    expect(out.verdict).toBe('revise');
    expect(out.text).toBe('The intent conflates score with policy.');
    expect(out.acknowledged).toBe(false);
  });

  test('non-critical dimension engaged → low impact (never a finalize block)', async () => {
    const cfg = makeConfig({ delegate: async () => 'minor sharpening' });
    const out = await engageIntentDissent({ ...CRIT, critical: false }, cfg);
    expect(out.status).toBe('engaged');
    expect(out.impact).toBe('low');
  });

  test('delegate returns empty/whitespace → host_absent (never a fake accept)', async () => {
    const cfg = makeConfig({ delegate: async () => '   ' });
    const out = await engageIntentDissent(CRIT, cfg);
    expect(out.status).toBe('host_absent');
  });

  test('delegate THROWS → host_absent degrade, not a crash (ADR-0018 D2)', async () => {
    const cfg = makeConfig({
      delegate: async () => {
        throw new Error('subprocess spawn failed');
      },
    });
    const out = await engageIntentDissent(CRIT, cfg);
    expect(out.status).toBe('host_absent');
  });
});

describe('buildIntentDissentBrief (ac-4 anti-inflation · minimal-field egress)', () => {
  const selection = {
    provider: 'codex' as const,
    model: 'codex',
    fallback_from: null,
    fallback_reason: 'none' as const,
  };

  test('brief carries the anti-inflation constraint (same intent, more accurate — never bigger)', () => {
    const brief: OpponentBrief = buildIntentDissentBrief(CRIT, makeConfig({}), selection);
    expect(brief.intent).toContain(INTENT_DISSENT_CONSTRAINT);
    expect(brief.intent.toLowerCase()).toContain('do not grow the scope');
  });

  test('brief does NOT forward raw dimension notes / transcript (minimal-field scope)', () => {
    const brief = buildIntentDissentBrief(CRIT, makeConfig({}), selection);
    expect(brief.label).toBe('d-score-formula');
    expect(brief.intent).not.toContain('raw transcript notes');
    expect(brief.label).not.toContain('raw transcript notes');
  });
});

describe('mergeDissent (ac-3 fail-closed carry-forward)', () => {
  const priorBlock: InterviewDissent = {
    status: 'engaged',
    verdict: 'revise',
    impact: 'high',
    text: 'prior dissent',
    acknowledged: false,
  };

  test('a prior engaged high-impact unacknowledged block survives a later host_absent', () => {
    const merged = mergeDissent(priorBlock, { status: 'host_absent', acknowledged: false });
    expect(merged).toEqual(priorBlock);
  });

  test('an acknowledged prior block is NOT resurrected by a later host_absent', () => {
    const acked: InterviewDissent = { ...priorBlock, acknowledged: true };
    const merged = mergeDissent(acked, { status: 'host_absent', acknowledged: false });
    expect(merged.status).toBe('host_absent');
  });

  test('a new engaged outcome overrides an existing host_absent', () => {
    const merged = mergeDissent({ status: 'host_absent', acknowledged: false }, priorBlock);
    expect(merged).toEqual(priorBlock);
  });
});
