import { describe, expect, test } from 'bun:test';
import {
  type CodeqlDeps,
  buildAnalyzeArgs,
  buildCreateArgs,
  cacheKey,
  runCodeqlAnalysis,
  selectBuildMode,
} from '~/core/codeql/runner';
import type { HostRunProcess } from '~/core/hosts/types';

const CLEAN_SARIF = JSON.stringify({ version: '2.1.0', runs: [{ results: [] }] });

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.close();
    },
  });
}

/** exit code 큐로 spawn을 흉내내고 호출 인자를 캡처하는 mock deps. */
function mockDeps(opts: {
  exitCodes: number[];
  sarif?: string;
  cacheExists?: boolean;
}): { deps: CodeqlDeps; calls: string[][] } {
  const calls: string[][] = [];
  const queue = [...opts.exitCodes];
  const deps: CodeqlDeps = {
    spawn: (input): HostRunProcess => {
      calls.push(input.args);
      const exit = queue.shift() ?? 0;
      return {
        entrypoint: input.binary,
        stdout: emptyStream(),
        stderr: emptyStream(),
        completion: Promise.resolve({ exit_code: exit, model_reported: null }),
      };
    },
    readText: async () => opts.sarif ?? CLEAN_SARIF,
    fileExists: async () => opts.cacheExists ?? false,
    drain: async () => '',
  };
  return { deps, calls };
}

const baseInput = {
  repoRoot: '/repo',
  sourceRoot: '/repo/src',
  language: 'javascript' as const,
  commitSha: 'abcdef0123456789',
  dbPath: '/repo/.ditto/cache/db',
  sarifPath: '/repo/.ditto/cache/out.sarif',
  suite: 'javascript-security-extended.qls',
};

describe('selectBuildMode', () => {
  test('interpreted/source languages need no build', () => {
    expect(selectBuildMode('javascript')).toBe('none');
    expect(selectBuildMode('python')).toBe('none');
    expect(selectBuildMode('ruby')).toBe('none');
    expect(selectBuildMode('actions')).toBe('none');
  });

  test('compiled languages default to autobuild (never none — 부록4 empty-extract guard)', () => {
    expect(selectBuildMode('java')).toBe('autobuild');
    expect(selectBuildMode('csharp')).toBe('autobuild');
    expect(selectBuildMode('go')).toBe('autobuild');
  });

  test('a build command forces manual mode for compiled languages', () => {
    expect(selectBuildMode('java', './gradlew clean compileKotlin')).toBe('manual');
  });

  test('a build command does not override none for interpreted languages', () => {
    expect(selectBuildMode('javascript', 'whatever')).toBe('none');
  });
});

describe('buildCreateArgs', () => {
  test('none mode emits --build-mode=none', () => {
    const args = buildCreateArgs({
      dbPath: 'db',
      language: 'javascript',
      sourceRoot: 'src',
      buildMode: 'none',
    });
    expect(args).toContain('--build-mode=none');
    expect(args).toContain('--language=javascript');
    expect(args).toContain('--source-root=src');
    expect(args[0]).toBe('database');
    expect(args[1]).toBe('create');
  });

  test('manual mode emits --command and omits --build-mode', () => {
    const args = buildCreateArgs({
      dbPath: 'db',
      language: 'java',
      sourceRoot: 'src',
      buildMode: 'manual',
      buildCommand: './gradlew clean compileKotlin',
    });
    expect(args).toContain('--command=./gradlew clean compileKotlin');
    expect(args.some((a) => a.startsWith('--build-mode='))).toBe(false);
  });

  test('manual mode without a build command throws', () => {
    expect(() =>
      buildCreateArgs({ dbPath: 'db', language: 'java', sourceRoot: 'src', buildMode: 'manual' }),
    ).toThrow(/requires buildCommand/);
  });
});

describe('buildAnalyzeArgs', () => {
  test('emits sarif-latest format, output path, and threads', () => {
    const args = buildAnalyzeArgs({ dbPath: 'db', suite: 's.qls', sarifOut: 'o.sarif' });
    expect(args).toEqual([
      'database',
      'analyze',
      'db',
      's.qls',
      '--format=sarif-latest',
      '--output=o.sarif',
      '--threads=0',
    ]);
  });

  test('honors an explicit thread count', () => {
    expect(buildAnalyzeArgs({ dbPath: 'db', suite: 's', sarifOut: 'o', threads: 4 })).toContain(
      '--threads=4',
    );
  });
});

describe('cacheKey', () => {
  test('combines a 12-char short sha with the language', () => {
    expect(cacheKey('abcdef0123456789aaaa', 'javascript')).toBe('abcdef012345-javascript');
  });
});

describe('runCodeqlAnalysis', () => {
  test('cache hit: reads SARIF without spawning codeql', async () => {
    const { deps, calls } = mockDeps({ exitCodes: [], cacheExists: true });
    const result = await runCodeqlAnalysis(baseInput, deps);
    expect(result.fromCache).toBe(true);
    expect(calls).toHaveLength(0);
    expect(result.findings).toEqual([]);
  });

  test('cold run: spawns create then analyze in order, then parses SARIF', async () => {
    const { deps, calls } = mockDeps({ exitCodes: [0, 0] });
    const result = await runCodeqlAnalysis(baseInput, deps);
    expect(result.fromCache).toBe(false);
    expect(result.buildMode).toBe('none');
    expect(calls).toHaveLength(2);
    expect((calls[0] as (typeof calls)[number]).slice(0, 2)).toEqual(['database', 'create']);
    expect((calls[1] as (typeof calls)[number]).slice(0, 2)).toEqual(['database', 'analyze']);
  });

  test('throws when database create fails (non-zero exit)', async () => {
    const { deps, calls } = mockDeps({ exitCodes: [1, 0] });
    let err: Error | undefined;
    try {
      await runCodeqlAnalysis(baseInput, deps);
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toMatch(/create failed \(exit 1/);
    expect(calls).toHaveLength(1); // analyze가 실행되지 않음
  });

  test('throws when database analyze fails', async () => {
    const { deps } = mockDeps({ exitCodes: [0, 1] });
    let err: Error | undefined;
    try {
      await runCodeqlAnalysis(baseInput, deps);
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toMatch(/analyze failed \(exit 1/);
  });

  test('compiled language without build command resolves to autobuild', async () => {
    const { deps, calls } = mockDeps({ exitCodes: [0, 0] });
    const result = await runCodeqlAnalysis({ ...baseInput, language: 'java' }, deps);
    expect(result.buildMode).toBe('autobuild');
    expect(calls[0]).toContain('--build-mode=autobuild');
  });
});
