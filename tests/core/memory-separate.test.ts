import { describe, expect, test } from 'bun:test';
import { type MemorySeparateDeps, separateMemoryRepo } from '~/core/provision/memory-separate';

function deps(over: Partial<MemorySeparateDeps> = {}): {
  deps: MemorySeparateDeps;
  calls: string[][];
  gitignore: { value: string };
} {
  const calls: string[][] = [];
  const gitignore = { value: over.readGitignore ? over.readGitignore() : '' };
  const { run: runBehavior, readGitignore: _r, writeGitignore: _w, ...rest } = over;
  const d: MemorySeparateDeps = {
    repoRoot: '/repo',
    pathExists: (p) => p === '/repo/.ditto/memory', // memory 존재, .git 없음(기본)
    readGitignore: () => gitignore.value,
    writeGitignore: (c) => {
      gitignore.value = c;
    },
    ...rest,
    run: async (cmd, args, cwd) => {
      calls.push([cmd, ...args, `cwd=${cwd}`]);
      return runBehavior ? runBehavior(cmd, args, cwd) : { exit_code: 0, stderr: '' };
    },
  };
  return { deps: d, calls, gitignore };
}

describe('separateMemoryRepo (gitignore 기본)', () => {
  test('memory 없으면 failed', async () => {
    const { deps: d } = deps({ pathExists: () => false });
    const r = await separateMemoryRepo(d);
    expect(r.status).toBe('failed');
    expect(r.message).toContain('초기화');
  });

  test('git init 실행 + 부모 .gitignore에 경로 추가 → separated', async () => {
    const { deps: d, calls, gitignore } = deps();
    const r = await separateMemoryRepo(d);
    expect(r.status).toBe('separated');
    expect(calls[0]).toEqual(['git', 'init', 'cwd=/repo/.ditto/memory']);
    expect(gitignore.value).toContain('.ditto/memory/');
  });

  test('이미 .git 있고 gitignore도 돼 있으면 already (git init 미실행)', async () => {
    const { deps: d, calls } = deps({
      pathExists: (p) => p === '/repo/.ditto/memory' || p === '/repo/.ditto/memory/.git',
      readGitignore: () => '.ditto/memory/\n',
    });
    const r = await separateMemoryRepo(d);
    expect(r.status).toBe('already');
    expect(calls).toEqual([]); // git init 안 함
  });

  test('이미 .git 있지만 gitignore 누락 → 추가하고 separated', async () => {
    const {
      deps: d,
      calls,
      gitignore,
    } = deps({
      pathExists: (p) => p === '/repo/.ditto/memory' || p === '/repo/.ditto/memory/.git',
      readGitignore: () => 'node_modules\n',
    });
    const r = await separateMemoryRepo(d);
    expect(r.status).toBe('separated');
    expect(calls).toEqual([]); // .git 있으니 init 생략
    expect(gitignore.value).toContain('.ditto/memory/');
    expect(gitignore.value).toContain('node_modules');
  });

  test('gitignore 중복 추가 안 함(멱등)', async () => {
    const { deps: d, gitignore } = deps({ readGitignore: () => '.ditto/memory/\n' });
    await separateMemoryRepo(d);
    expect(gitignore.value.match(/\.ditto\/memory\//g)?.length).toBe(1);
  });

  test('git init 실패 → failed + manual', async () => {
    const { deps: d } = deps({ run: async () => ({ exit_code: 1, stderr: 'no git' }) });
    const r = await separateMemoryRepo(d);
    expect(r.status).toBe('failed');
    expect(r.manual?.length).toBeGreaterThan(0);
  });
});

describe('separateMemoryRepo (submodule opt-in)', () => {
  test('submodule은 자동 안 하고 manual 절차 안내', async () => {
    const { deps: d, calls } = deps();
    const r = await separateMemoryRepo(d, 'submodule');
    expect(r.status).toBe('manual');
    expect(r.manual?.some((l) => l.includes('submodule add'))).toBe(true);
    expect(calls).toEqual([]); // 아무것도 실행 안 함
  });
});
