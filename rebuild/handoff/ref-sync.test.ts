import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { consumeHandoff, HANDOFFS_REF, writeHandoff } from './ref-store';
import { assertDittoPushRefspec, pushHandoffs } from './ref-sync';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function repoWithBareOrigin(): Promise<{ work: string; bare: string }> {
  const base = await mkdtemp(join(tmpdir(), 'ditto-sync-'));
  const bare = join(base, 'origin.git');
  const work = join(base, 'work');
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['init', '-q', work]);
  git(work, ['remote', 'add', 'origin', bare]);
  return { work, bare };
}

describe('assertDittoPushRefspec — pushes are confined to refs/ditto/*', () => {
  test('accepts the ditto-to-ditto refspec', () => {
    expect(() =>
      assertDittoPushRefspec('refs/ditto/handoffs:refs/ditto/handoffs'),
    ).not.toThrow();
  });

  test('rejects any refspec touching non-ditto refs on either side', () => {
    for (const bad of [
      'refs/heads/main:refs/heads/main',
      'refs/ditto/handoffs:refs/heads/main',
      'refs/heads/main:refs/ditto/handoffs',
      '+refs/ditto/handoffs:refs/ditto/handoffs', // 강제 push 접두사 불허
      'refs/ditto:refs/ditto', // 네임스페이스 자체는 ref가 아님
      '',
    ]) {
      expect(() => assertDittoPushRefspec(bad)).toThrow(/refs\/ditto/);
    }
  });
});

describe('pushHandoffs — the remote handoff contract, verified against a local bare origin', () => {
  test('pushes the hidden ref so the baton is consumable from the remote', async () => {
    const { work, bare } = await repoWithBareOrigin();
    await writeHandoff(work, 'baton-remote', '원격 인계 본문');

    await pushHandoffs(work, 'origin');

    const remoteTip = git(bare, ['rev-parse', HANDOFFS_REF]);
    expect(remoteTip).toBe(git(work, ['rev-parse', HANDOFFS_REF]));
    // 원격에는 브랜치가 하나도 생기지 않았다 — 숨은 ref만 전송됐다
    expect(git(bare, ['branch', '--list'])).toBe('');
  });

  test('consume then push fast-forwards the remote (no force needed)', async () => {
    const { work, bare } = await repoWithBareOrigin();
    await writeHandoff(work, 'baton-ff', 'X');
    await pushHandoffs(work, 'origin');

    expect(await consumeHandoff(work, 'baton-ff')).toBe('X');
    await pushHandoffs(work, 'origin');

    const remoteTip = git(bare, ['rev-parse', HANDOFFS_REF]);
    expect(remoteTip).toBe(git(work, ['rev-parse', HANDOFFS_REF]));
    // 소비 후 tip tree는 비어 있다
    expect(git(bare, ['ls-tree', '--name-only', remoteTip])).toBe('');
  });

  test('push with nothing written is a no-op, not an error', async () => {
    const { work } = await repoWithBareOrigin();
    await expect(pushHandoffs(work, 'origin')).resolves.toBeUndefined();
  });
});
