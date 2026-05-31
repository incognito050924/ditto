import { describe, expect, test } from 'bun:test';
import {
  NoOpponentAvailableError,
  type OpponentCandidate,
  resolveOpponentCandidates,
  selectOpponent,
} from '~/core/opponent-router';

const policy = (over: Record<string, unknown> = {}) => ({
  producer: 'current-host',
  opponent_preferred: 'codex',
  opponent_fallback: ['claude-opus', 'claude-sonnet'],
  synthesizer: 'claude-opus',
  ...over,
});

describe('resolveOpponentCandidates', () => {
  test('preferred first, then fallbacks in order, mapped to provider/model', () => {
    const cands = resolveOpponentCandidates(policy());
    expect(cands.map((c) => c.token)).toEqual(['codex', 'claude-opus', 'claude-sonnet']);
    expect(cands[0]).toEqual({ token: 'codex', provider: 'codex', model: 'codex' });
    expect(cands[1]).toEqual({
      token: 'claude-opus',
      provider: 'claude-code',
      model: 'claude-opus',
    });
  });

  test('duplicate tokens are dropped (first wins)', () => {
    const cands = resolveOpponentCandidates(
      policy({ opponent_preferred: 'codex', opponent_fallback: ['codex', 'claude-opus'] }),
    );
    expect(cands.map((c) => c.token)).toEqual(['codex', 'claude-opus']);
  });

  test('unknown token defaults to claude-code host carrying the token as model', () => {
    const cands = resolveOpponentCandidates(
      policy({ opponent_preferred: 'mystery-model', opponent_fallback: [] }),
    );
    expect(cands[0]).toEqual({
      token: 'mystery-model',
      provider: 'claude-code',
      model: 'mystery-model',
    });
  });
});

describe('selectOpponent', () => {
  const cands = resolveOpponentCandidates(policy());
  const always = () => ({ available: true });

  test('preferred available → fallback_from null, reason none', () => {
    const sel = selectOpponent(cands, always);
    expect(sel).toEqual({
      provider: 'codex',
      model: 'codex',
      fallback_from: null,
      fallback_reason: 'none',
    });
  });

  test('preferred unavailable → falls back, records preferred provider + its reason', () => {
    const sel = selectOpponent(cands, (c) =>
      c.token === 'codex' ? { available: false, reason: 'auth' } : { available: true },
    );
    expect(sel).toEqual({
      provider: 'claude-code',
      model: 'claude-opus',
      fallback_from: 'codex',
      fallback_reason: 'auth',
    });
  });

  test('skips multiple unavailable, reason stays the preferred failure', () => {
    const sel = selectOpponent(cands, (c) => {
      if (c.token === 'codex') return { available: false, reason: 'network' };
      if (c.token === 'claude-opus') return { available: false, reason: 'cost' };
      return { available: true };
    });
    // fell back all the way to sonnet; reason = why the *preferred* (codex) failed
    expect(sel.model).toBe('claude-sonnet');
    expect(sel.fallback_from).toBe('codex');
    expect(sel.fallback_reason).toBe('network');
  });

  test('preferred unavailable without explicit reason defaults to runtime', () => {
    const sel = selectOpponent(cands, (c) =>
      c.token === 'codex' ? { available: false } : { available: true },
    );
    expect(sel.fallback_reason).toBe('runtime');
  });

  test('no candidate available → NoOpponentAvailableError', () => {
    expect(() => selectOpponent(cands, () => ({ available: false, reason: 'runtime' }))).toThrow(
      NoOpponentAvailableError,
    );
  });

  test('empty candidate list → NoOpponentAvailableError', () => {
    expect(() => selectOpponent([] as OpponentCandidate[], always)).toThrow(
      NoOpponentAvailableError,
    );
  });
});
