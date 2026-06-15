import { describe, expect, test } from 'bun:test';
import { buildTidyChangeContract } from '~/acg/tidy/scope-contract';

describe('buildTidyChangeContract — ② scope contract (WU-1, ac-1)', () => {
  const contract = buildTidyChangeContract({
    workItemId: 'wi_test0001',
    changedFiles: ['src/a.ts', 'src/b.ts'],
    producedAt: '2026-06-15T00:00:00Z',
  });

  test('allowed_scope equals the changed files as path refs (allowed=diff)', () => {
    expect(contract.allowed_scope.map((r) => r.ref)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(contract.allowed_scope.every((r) => r.kind === 'path')).toBe(true);
  });

  test('forbidden_scope is non-empty (그외)', () => {
    expect(contract.forbidden_scope.length).toBeGreaterThanOrEqual(1);
  });

  test('scope_mode equals whitelist (allowed=diff, forbidden=그외)', () => {
    expect(contract.scope_mode).toBe('whitelist');
  });

  test('is a schema-valid low-risk change contract', () => {
    expect(contract.risk_default).toBe('low');
    expect(contract.kind).toBe('acg.change-contract.v1');
  });
});
