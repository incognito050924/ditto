import { describe, expect, test } from 'bun:test';
import { buildClaudeCodeSpawnArgs } from '~/core/hosts/claude-code';

describe('buildClaudeCodeSpawnArgs', () => {
  test('read-only maps to --permission-mode plan with best-effort caveat', () => {
    const { args, unverified } = buildClaudeCodeSpawnArgs('read-only', ['--print', 'hi']);
    expect(args).toEqual(['--permission-mode', 'plan', '--print', 'hi']);
    expect(unverified).toEqual([
      'claude-code --permission-mode plan mapping is best-effort in v0.3',
    ]);
  });

  test('workspace-write maps to --permission-mode default with best-effort caveat', () => {
    const { args, unverified } = buildClaudeCodeSpawnArgs('workspace-write', []);
    expect(args).toEqual(['--permission-mode', 'default']);
    expect(unverified).toEqual([
      'claude-code --permission-mode default mapping is best-effort in v0.3',
    ]);
  });

  test('reviewer maps to --permission-mode plan (reviewer is read-only-shaped)', () => {
    const { args, unverified } = buildClaudeCodeSpawnArgs('reviewer', ['--print']);
    expect(args).toEqual(['--permission-mode', 'plan', '--print']);
    expect(unverified).toEqual([
      'claude-code --permission-mode plan mapping is best-effort in v0.3',
    ]);
  });

  test('networked maps to default and adds a network notice on top of the caveat', () => {
    const { args, unverified } = buildClaudeCodeSpawnArgs('networked', []);
    expect(args).toEqual(['--permission-mode', 'default']);
    expect(unverified).toEqual([
      'claude-code --permission-mode default mapping is best-effort in v0.3',
      'claude-code network is not forced open by v0.3',
    ]);
  });

  test('isolated maps to default (worktree handled by wrapper)', () => {
    const { args, unverified } = buildClaudeCodeSpawnArgs('isolated', []);
    expect(args).toEqual(['--permission-mode', 'default']);
    expect(unverified).toEqual([
      'claude-code --permission-mode default mapping is best-effort in v0.3',
    ]);
  });

  test('preserves user args order after profile flags', () => {
    const { args } = buildClaudeCodeSpawnArgs('read-only', ['--model', 'sonnet', '--print', 'x']);
    expect(args).toEqual(['--permission-mode', 'plan', '--model', 'sonnet', '--print', 'x']);
  });
});
