import { describe, expect, test } from 'bun:test';
import { buildCodexSpawnArgs } from '~/core/hosts/codex';

describe('buildCodexSpawnArgs', () => {
  test('read-only maps to --sandbox read-only with no unverified', () => {
    const { args, unverified } = buildCodexSpawnArgs('read-only', ['exec', '--help']);
    expect(args).toEqual(['--sandbox', 'read-only', 'exec', '--help']);
    expect(unverified).toEqual([]);
  });

  test('workspace-write maps to --sandbox workspace-write with no unverified', () => {
    const { args, unverified } = buildCodexSpawnArgs('workspace-write', ['exec']);
    expect(args).toEqual(['--sandbox', 'workspace-write', 'exec']);
    expect(unverified).toEqual([]);
  });

  test('reviewer maps to --sandbox read-only (reviewer is read-only-shaped)', () => {
    const { args, unverified } = buildCodexSpawnArgs('reviewer', []);
    expect(args).toEqual(['--sandbox', 'read-only']);
    expect(unverified).toEqual([]);
  });

  test('networked uses workspace-write sandbox and surfaces the network limitation', () => {
    const { args, unverified } = buildCodexSpawnArgs('networked', ['exec']);
    expect(args).toEqual(['--sandbox', 'workspace-write', 'exec']);
    expect(unverified).toEqual([
      'codex network is not forced open by v0.3; sandbox restricts outbound',
    ]);
  });

  test('isolated maps to --sandbox workspace-write (worktree handled by wrapper)', () => {
    const { args, unverified } = buildCodexSpawnArgs('isolated', ['exec']);
    expect(args).toEqual(['--sandbox', 'workspace-write', 'exec']);
    expect(unverified).toEqual([]);
  });

  test('preserves user args order after profile flags', () => {
    const { args } = buildCodexSpawnArgs('read-only', ['--model', 'sonnet', 'exec']);
    expect(args).toEqual(['--sandbox', 'read-only', '--model', 'sonnet', 'exec']);
  });
});
