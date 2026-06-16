/**
 * Playwright/Chromium 프로비저너 (opt-in 설치 + 탐지).
 *
 * `/ditto:e2e` 런타임은 절대 *자동* 다운로드하지 않고, 브라우저가 없으면 `result='blocked'`로
 * degrade 한다(e2e/browser.ts §HARD CONSTRAINT). 그래서 설치는 오직 wizard(`ditto setup`)나
 * `doctor … --install` 같은 opt-in 경로에서만 일어난다 — codeql/install.ts와 동일한 철학.
 *
 * 지금까지 Playwright 설치 로직은 `scripts/install-plugin.mjs`(installPlaywright/detectPlaywright)
 * 에만 있었다. 이 모듈이 그 로직을 TS 단일 진실원으로 끌어와 codeql과 런타임 패리티를 맞춘다.
 *
 * 탐지(browser.ts 런타임 probe와 install-plugin.mjs 부트스트랩 둘 다와 일치):
 *  - playwright-core: bun install 캐시에 `playwright-core@x.y.z` 디렉토리가 있는가
 *  - chromium: ms-playwright 캐시에 `chromium-<rev>` 빌드가 있는가
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { join } from 'node:path';
import type { InstallResult } from '~/core/codeql/install';
import type { Provisioner } from '~/core/provision/provisioner';

/** ms-playwright Chromium 캐시 루트(플랫폼별 — install-plugin.mjs playwrightCacheRoot와 일치). */
export function playwrightCacheRoot(os: NodeJS.Platform = osPlatform()): string {
  if (os === 'win32') return join(homedir(), 'AppData', 'Local', 'ms-playwright');
  if (os === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  return join(homedir(), '.cache', 'ms-playwright'); // linux
}

/** bun install 캐시 디렉토리(playwright-core가 풀리는 곳). */
export function bunCacheDir(): string {
  return join(process.env.BUN_INSTALL ?? join(homedir(), '.bun'), 'install', 'cache');
}

export interface PlaywrightDeps {
  /** ms-playwright 캐시 루트. */
  cacheRoot: string;
  /** bun install 캐시 디렉토리. */
  bunCache: string;
  /** 디렉토리 엔트리 목록(없으면 []). */
  listDir: (dir: string) => string[];
  /** 한 단계 실행(bun x playwright install chromium). exit 0이면 성공. */
  run: (binary: string, args: string[]) => Promise<{ exit_code: number | null; stderr: string }>;
}

interface PlaywrightPresence {
  core: boolean;
  chromium: boolean;
  available: boolean;
}

/** playwright-core + cached chromium 둘 다 있는지 probe. */
export function detectPlaywright(deps: PlaywrightDeps): PlaywrightPresence {
  const core = deps.listDir(deps.bunCache).some((e) => /^playwright-core@\d+\.\d+\.\d+$/.test(e));
  const chromium = deps.listDir(deps.cacheRoot).some((e) => /^chromium-\d+$/.test(e));
  return { core, chromium, available: core && chromium };
}

/** 자동 설치 불가/실패 시 복붙용 수동 명령. */
export function manualInstructions(cacheRoot: string): string[] {
  return [`bunx playwright install chromium   # Chromium을 ${cacheRoot}에 받는다 (전제: bun)`];
}

/**
 * Playwright/Chromium을 설치한다(opt-in). 이미 있으면 아무것도 안 하고, 실패하면 throw 대신
 * status:'failed' + 수동 명령을 돌려준다.
 */
export async function installPlaywright(deps: PlaywrightDeps): Promise<InstallResult> {
  if (detectPlaywright(deps).available) {
    return {
      status: 'already-present',
      binary: deps.cacheRoot,
      message: 'playwright already installed (playwright-core + cached chromium)',
    };
  }

  const r = await deps.run('bun', ['x', 'playwright', 'install', 'chromium']);
  if (r.exit_code !== 0) {
    return {
      status: 'failed',
      message: `playwright 설치 실패 (bun exit=${r.exit_code ?? 'null'})${r.stderr ? `: ${r.stderr.trim()}` : ''}`,
      manual: manualInstructions(deps.cacheRoot),
    };
  }

  if (!detectPlaywright(deps).available) {
    return {
      status: 'failed',
      message: '설치 명령은 끝났으나 캐시 probe가 여전히 음성이다',
      manual: manualInstructions(deps.cacheRoot),
    };
  }
  return {
    status: 'installed',
    binary: deps.cacheRoot,
    message: `Chromium 설치 완료 → ${deps.cacheRoot}`,
  };
}

/** 실제 fs·spawn을 쓰는 기본 deps. */
export const defaultPlaywrightDeps: PlaywrightDeps = {
  cacheRoot: playwrightCacheRoot(),
  bunCache: bunCacheDir(),
  listDir: (dir) => {
    try {
      return existsSync(dir) ? readdirSync(dir) : [];
    } catch {
      return [];
    }
  },
  run: async (binary, args) => {
    const proc = Bun.spawn([binary, ...args], {
      stdout: 'ignore',
      stderr: 'pipe',
      stdin: 'ignore',
    });
    const [exit_code, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text().catch(() => ''),
    ]);
    return { exit_code, stderr };
  },
};

/** Playwright 어댑터: PlaywrightDeps를 Provisioner 모양으로 감싼다. */
export function playwrightProvisioner(deps: PlaywrightDeps = defaultPlaywrightDeps): Provisioner {
  return {
    id: 'playwright',
    label: 'Playwright/Chromium',
    resolveExisting: async () => (detectPlaywright(deps).available ? deps.cacheRoot : null),
    install: () => installPlaywright(deps),
    manual: () => manualInstructions(deps.cacheRoot),
    // bun은 ditto 런타임 전제이므로 별도 prereq로 노출하지 않는다.
    prereqs: () => [],
  };
}
