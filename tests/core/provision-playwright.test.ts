import { describe, expect, test } from 'bun:test';
import {
  type PlaywrightDeps,
  detectPlaywright,
  installPlaywright,
  playwrightCacheRoot,
  playwrightProvisioner,
} from '~/core/provision/playwright';

function baseDeps(over: Partial<PlaywrightDeps> = {}): { deps: PlaywrightDeps; calls: string[][] } {
  const calls: string[][] = [];
  const { run: runBehavior, ...rest } = over;
  const deps: PlaywrightDeps = {
    cacheRoot: '/home/u/.cache/ms-playwright',
    bunCache: '/home/u/.bun/install/cache',
    // 기본: 둘 다 부재(빈 디렉토리).
    listDir: () => [],
    ...rest,
    run: async (binary, args) => {
      calls.push([binary, ...args]);
      return runBehavior ? runBehavior(binary, args) : { exit_code: 0, stderr: '' };
    },
  };
  return { deps, calls };
}

/** core/chromium 둘 다 있는 캐시를 흉내내는 listDir. */
function presentDirs(deps: PlaywrightDeps): (dir: string) => string[] {
  return (dir) => {
    if (dir === deps.bunCache) return ['playwright-core@1.49.0', 'other'];
    if (dir === deps.cacheRoot) return ['chromium-1148', 'ffmpeg-1011'];
    return [];
  };
}

describe('playwrightCacheRoot', () => {
  test('플랫폼별 ms-playwright 경로', () => {
    expect(playwrightCacheRoot('darwin')).toContain('Library/Caches/ms-playwright');
    expect(playwrightCacheRoot('linux')).toContain('.cache/ms-playwright');
    expect(playwrightCacheRoot('win32')).toContain('ms-playwright');
  });
});

describe('detectPlaywright', () => {
  test('core + chromium 둘 다 있으면 available', () => {
    const { deps } = baseDeps();
    deps.listDir = presentDirs(deps);
    expect(detectPlaywright(deps)).toEqual({ core: true, chromium: true, available: true });
  });

  test('chromium만 없으면 available=false', () => {
    const { deps } = baseDeps();
    deps.listDir = (dir) => (dir === deps.bunCache ? ['playwright-core@1.49.0'] : []);
    expect(detectPlaywright(deps).available).toBe(false);
  });
});

describe('installPlaywright', () => {
  test('이미 있으면 already-present, install 명령 미실행', async () => {
    const { deps, calls } = baseDeps();
    deps.listDir = presentDirs(deps);
    const result = await installPlaywright(deps);
    expect(result.status).toBe('already-present');
    expect(calls).toEqual([]);
  });

  test('부재 → bun x playwright install chromium 실행 후 설치 확인', async () => {
    const { deps, calls } = baseDeps();
    // 설치 전엔 부재, run 후엔 존재하도록 토글.
    let installed = false;
    deps.listDir = (dir) => {
      if (!installed) return [];
      if (dir === deps.bunCache) return ['playwright-core@1.49.0'];
      if (dir === deps.cacheRoot) return ['chromium-1148'];
      return [];
    };
    deps.run = async (binary, args) => {
      calls.push([binary, ...args]);
      installed = true;
      return { exit_code: 0, stderr: '' };
    };
    const result = await installPlaywright(deps);
    expect(result.status).toBe('installed');
    expect(calls[0]).toEqual(['bun', 'x', 'playwright', 'install', 'chromium']);
  });

  test('설치 명령 실패 → failed + manual', async () => {
    const { deps } = baseDeps({
      run: async () => ({ exit_code: 1, stderr: 'network down' }),
    });
    const result = await installPlaywright(deps);
    expect(result.status).toBe('failed');
    expect(result.manual?.length).toBeGreaterThan(0);
  });

  test('명령 성공했으나 probe 여전히 음성 → failed', async () => {
    const { deps } = baseDeps(); // listDir 계속 [] → 설치 후에도 음성
    const result = await installPlaywright(deps);
    expect(result.status).toBe('failed');
  });
});

describe('playwrightProvisioner adapter', () => {
  test('resolveExisting: available면 cacheRoot, 아니면 null', async () => {
    const { deps } = baseDeps();
    expect(await playwrightProvisioner(deps).resolveExisting()).toBeNull();
    deps.listDir = presentDirs(deps);
    expect(await playwrightProvisioner(deps).resolveExisting()).toBe(deps.cacheRoot);
  });

  test('id/label', () => {
    const p = playwrightProvisioner(baseDeps().deps);
    expect(p.id).toBe('playwright');
    expect(p.label).toBe('Playwright/Chromium');
  });
});
