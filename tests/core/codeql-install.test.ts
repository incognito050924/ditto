import { describe, expect, test } from 'bun:test';
import {
  type InstallDeps,
  bundleUrl,
  detectPlatform,
  installCodeqlCli,
} from '~/core/codeql/install';

describe('detectPlatform', () => {
  test('maps node platforms to codeql bundle tokens', () => {
    expect(detectPlatform('darwin')).toBe('osx64');
    expect(detectPlatform('linux')).toBe('linux64');
    expect(detectPlatform('win32')).toBe('win64');
  });

  test('returns null for unsupported platforms', () => {
    expect(detectPlatform('aix' as NodeJS.Platform)).toBeNull();
  });
});

describe('bundleUrl', () => {
  // 정본(install-plugin.mjs)과 동일하게 CLI-only codeql-cli-binaries zip을 받는다.
  test('points at the codeql-cli-binaries latest release zip', () => {
    expect(bundleUrl('osx64')).toBe(
      'https://github.com/github/codeql-cli-binaries/releases/latest/download/codeql-osx64.zip',
    );
  });
});

describe('installCodeqlCli', () => {
  function baseDeps(over: Partial<InstallDeps> = {}): { deps: InstallDeps; calls: string[][] } {
    const calls: string[][] = [];
    // run을 오버라이드해도 호출 기록은 항상 남도록: 동작만 위임하고 기록은 baseDeps가 한다.
    const { run: runBehavior, ...rest } = over;
    const deps: InstallDeps = {
      platform: () => 'osx64',
      resolveExisting: async () => null,
      installDir: '/home/u/.local/share/ditto/codeql',
      binDir: '/home/u/.local/bin',
      ensureDir: async () => {},
      fileExists: () => true,
      pathIncludes: () => true,
      ...rest,
      run: async (binary, args) => {
        calls.push([binary, ...args]);
        return runBehavior ? runBehavior(binary, args) : { exit_code: 0, stderr: '' };
      },
    };
    return { deps, calls };
  }

  test('already-present short-circuits without running install steps', async () => {
    const { deps, calls } = baseDeps({ resolveExisting: async () => '/usr/local/bin/codeql' });
    const result = await installCodeqlCli(deps);
    expect(result.status).toBe('already-present');
    expect(result.binary).toBe('/usr/local/bin/codeql');
    expect(calls).toEqual([]); // 아무것도 설치하지 않음
  });

  test('unsupported platform returns manual instructions, no steps', async () => {
    const { deps, calls } = baseDeps({ platform: () => null });
    const result = await installCodeqlCli(deps);
    expect(result.status).toBe('unsupported-platform');
    expect(result.manual?.length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });

  test('happy path downloads, unzips, links, verifies → installed', async () => {
    const { deps, calls } = baseDeps();
    const result = await installCodeqlCli(deps);
    expect(result.status).toBe('installed');
    expect(result.binary).toBe('/home/u/.local/bin/codeql');
    // curl → unzip → ln 순서로 실행 (unzip 성공 시 tar 폴백 없음)
    expect((calls[0] as (typeof calls)[number])[0]).toBe('curl');
    expect((calls[1] as (typeof calls)[number])[0]).toBe('unzip');
    expect((calls[2] as (typeof calls)[number])[0]).toBe('ln');
    expect(calls.some((c) => c.some((a) => a.includes('codeql-osx64.zip')))).toBe(true);
  });

  test('falls back to tar when unzip is unavailable/fails', async () => {
    const { deps, calls } = baseDeps({
      run: async (binary, _args) => {
        if (binary === 'unzip') return { exit_code: 1, stderr: 'no unzip' };
        return { exit_code: 0, stderr: '' };
      },
    });
    const result = await installCodeqlCli(deps);
    expect(result.status).toBe('installed');
    expect(calls.map((c) => c[0])).toEqual(['curl', 'unzip', 'tar', 'ln']);
  });

  test('download failure yields failed status + manual fallback', async () => {
    const { deps } = baseDeps({
      run: async (binary) =>
        binary === 'curl' ? { exit_code: 7, stderr: 'conn refused' } : { exit_code: 0, stderr: '' },
    });
    const result = await installCodeqlCli(deps);
    expect(result.status).toBe('failed');
    expect(result.manual?.length).toBeGreaterThan(0);
  });

  test('both unzip and tar failing is a failed extract', async () => {
    const { deps } = baseDeps({
      run: async (binary) =>
        binary === 'unzip' || binary === 'tar'
          ? { exit_code: 1, stderr: 'boom' }
          : { exit_code: 0, stderr: '' },
    });
    const result = await installCodeqlCli(deps);
    expect(result.status).toBe('failed');
  });

  test('missing launcher after extract is reported as failed', async () => {
    // fileExists(false)면 추출 후 런처 확인에서 실패.
    const { deps } = baseDeps({ fileExists: () => false });
    const result = await installCodeqlCli(deps);
    expect(result.status).toBe('failed');
  });

  test('installed-but-not-on-PATH adds a PATH hint to the message', async () => {
    const { deps } = baseDeps({ pathIncludes: () => false });
    const result = await installCodeqlCli(deps);
    expect(result.status).toBe('installed');
    expect(result.message).toContain('PATH');
  });

  test('windows skips symlink and advises PATH', async () => {
    const { deps, calls } = baseDeps({ platform: () => 'win64' });
    const result = await installCodeqlCli(deps);
    expect(result.status).toBe('installed');
    expect(calls.some((c) => c[0] === 'ln')).toBe(false); // 심링크 안 함
    expect(result.message).toContain('PATH');
  });
});
