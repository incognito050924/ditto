import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { consumeHandoff, HANDOFFS_REF, writeHandoff } from './ref-store';

async function freshGitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ditto-handoff-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  return root;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

describe('handoff hidden-ref baton store (refs/ditto/handoffs)', () => {
  test('write stores the baton as a commit on the hidden ref — no working-tree file, no branch', async () => {
    const root = await freshGitRepo();
    await writeHandoff(root, 'baton-1', '# 인계\n다음 단계: X');

    // 숨은 ref가 생겼다
    const tip = git(root, ['rev-parse', HANDOFFS_REF]);
    expect(tip).toMatch(/^[0-9a-f]{40}$/);
    // 바통이 tip tree의 엔트리다
    const tree = git(root, ['ls-tree', '--name-only', tip]);
    expect(tree.split('\n')).toContain('baton-1');
    // 워킹트리에는 아무 파일도 없다
    const files = await readdir(root);
    expect(files.filter((f) => f !== '.git')).toEqual([]);
    // 브랜치도 없다
    expect(git(root, ['branch', '--list'])).toBe('');
  });

  test('consume returns the body exactly once and deletes it (first-consumer-wins)', async () => {
    const root = await freshGitRepo();
    await writeHandoff(root, 'baton-once', '본문 내용');

    const first = await consumeHandoff(root, 'baton-once');
    expect(first).toBe('본문 내용');

    const second = await consumeHandoff(root, 'baton-once');
    expect(second).toBeNull(); // 이미 소비됨 — idempotent
  });

  test('consume removes only the named baton, others survive', async () => {
    const root = await freshGitRepo();
    await writeHandoff(root, 'baton-a', 'A');
    await writeHandoff(root, 'baton-b', 'B');

    expect(await consumeHandoff(root, 'baton-a')).toBe('A');
    expect(await consumeHandoff(root, 'baton-b')).toBe('B');
  });

  test('consume on an unborn ref is null, not an error', async () => {
    const root = await freshGitRepo();
    expect(await consumeHandoff(root, 'never-written')).toBeNull();
  });

  test('unsafe baton names are refused (tree-entry injection guard)', async () => {
    const root = await freshGitRepo();
    for (const bad of ['a\nb', 'a\tb', 'a/b', '..', '', '.git']) {
      await expect(writeHandoff(root, bad, 'x')).rejects.toThrow(/name/i);
    }
  });

  test('duplicate baton name is refused until consumed (no silent overwrite)', async () => {
    const root = await freshGitRepo();
    await writeHandoff(root, 'baton-dup', '원본');
    await expect(writeHandoff(root, 'baton-dup', '덮어쓰기')).rejects.toThrow(
      /exists/i,
    );
    expect(await consumeHandoff(root, 'baton-dup')).toBe('원본');
  });
});
