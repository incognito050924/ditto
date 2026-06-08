/**
 * `doctor codeql --install` — opt-in CodeQL CLI 설치 지원 (사용자가 명시적으로 실행).
 *
 * 설계 정합성: Playwright와 동일하게 ditto는 분석 흐름 *도중* 무거운 외부 도구를 몰래
 * 설치하지 않는다(browser.ts §HARD CONSTRAINT). 이 모듈은 **자동 흐름이 아니라**
 * 사용자가 `--install`을 직접 줄 때만 동작하는 opt-in 경로다.
 *
 * 설치 정본(single source): `scripts/install-plugin.mjs` step 3b가 `scripts/install.sh`
 * 설치 흐름에서 쓰는 codeql 설치기와 **동일한 선택**을 따른다 — 번들 소스/위치/탐지가
 * 갈라지면 두 개의 모순된 codeql이 생긴다. 둘을 바꿀 땐 같이 바꿀 것:
 *   - 소스: github/codeql-cli-binaries (CLI-only `.zip`; 쿼리팩은 분석 시 자동 다운로드)
 *   - 위치: ~/.local/share/ditto/codeql (`codeql/` 하위에 런처)
 *   - PATH: ~/.local/bin/codeql 로 심링크 (ditto 바이너리와 같은 placeDir)
 *   - 탐지: CODEQL_BIN → PATH → gh extension → ditto-managed
 *
 * `claude plugin install` 경로는 install.sh를 거치지 않아 codeql 부트스트랩이 없다 —
 * 그 사용자를 위한 런타임 opt-in이 이 명령이다.
 */
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** github/codeql-cli-binaries 자산명에 쓰는 플랫폼 토큰. */
export type CodeqlPlatform = 'osx64' | 'linux64' | 'win64';

export function detectPlatform(os: NodeJS.Platform = process.platform): CodeqlPlatform | null {
  switch (os) {
    case 'darwin':
      return 'osx64';
    case 'linux':
      return 'linux64';
    case 'win32':
      return 'win64';
    default:
      return null;
  }
}

/** CLI-only 번들(쿼리팩 제외). 풀 action 번들이 아니다 — 팩은 review가 download:true로 받는다. */
export function bundleUrl(platform: CodeqlPlatform): string {
  return `https://github.com/github/codeql-cli-binaries/releases/latest/download/codeql-${platform}.zip`;
}

/** 정본 설치 위치(install-plugin.mjs codeqlInstallDir와 일치). */
export const DEFAULT_INSTALL_DIR = join(homedir(), '.local', 'share', 'ditto', 'codeql');
/** 정본 심링크 위치(install-plugin.mjs placeDir와 일치). */
export const DEFAULT_BIN_DIR = join(homedir(), '.local', 'bin');

/** 번들이 풀리는 런처 경로: <installDir>/codeql/codeql(.exe). */
export function managedBinary(installDir: string, platform: CodeqlPlatform): string {
  return join(installDir, 'codeql', platform === 'win64' ? 'codeql.exe' : 'codeql');
}

export type InstallStatus = 'already-present' | 'installed' | 'failed' | 'unsupported-platform';

export interface InstallResult {
  status: InstallStatus;
  /** present/installed일 때 resolved codeql 경로. */
  binary?: string;
  message: string;
  /** ditto가 자동 설치할 수 없거나 실패했을 때의 복붙용 수동 명령. */
  manual?: string[];
}

export interface InstallDeps {
  platform: () => CodeqlPlatform | null;
  /** codeql가 이미 있으면 그 경로, 없으면 null (CODEQL_BIN→PATH→gh-ext→ditto-managed). */
  resolveExisting: () => Promise<string | null>;
  /** 한 단계 실행(curl/unzip/tar/ln). exit 0이면 성공. */
  run: (binary: string, args: string[]) => Promise<{ exit_code: number | null; stderr: string }>;
  /** 번들 추출 위치(여기 밑에 `codeql/`이 풀린다). */
  installDir: string;
  /** `codeql` 심링크를 둘 PATH 디렉토리. */
  binDir: string;
  ensureDir: (dir: string) => Promise<void>;
  fileExists: (p: string) => boolean;
  /** binDir이 현재 PATH에 포함되어 있는가. */
  pathIncludes: (dir: string) => boolean;
}

/** 사용자가 직접 실행할 수 있는 수동 설치 명령(자동 설치 불가/실패 시 안내). */
export function manualInstructions(platform: CodeqlPlatform | null): string[] {
  const lines = [
    'gh extensions install github/gh-codeql && gh codeql set-version latest   # gh CLI가 있으면 가장 간단',
  ];
  if (platform) {
    lines.push(
      `# 또는 번들 직접: ${bundleUrl(platform)} 를 받아 압축 해제 후 codeql/ 를 PATH에 추가`,
    );
  } else {
    lines.push('# 또는 번들 직접: https://github.com/github/codeql-cli-binaries/releases/latest');
  }
  return lines;
}

/**
 * CodeQL CLI를 설치한다(opt-in). 이미 있으면 아무것도 하지 않고, 실패하면 hard-fail 대신
 * status='failed' + 수동 명령을 돌려준다(browser.ts / install-plugin.mjs의 graceful 철학과 동일).
 */
export async function installCodeqlCli(deps: InstallDeps): Promise<InstallResult> {
  const existing = await deps.resolveExisting();
  if (existing) {
    return {
      status: 'already-present',
      binary: existing,
      message: `codeql already installed at ${existing}; nothing to do`,
    };
  }

  const platform = deps.platform();
  if (!platform) {
    return {
      status: 'unsupported-platform',
      message: `${process.platform}은(는) codeql 번들 자동 설치를 지원하지 않는다. 수동 설치하라.`,
      manual: manualInstructions(null),
    };
  }

  await deps.ensureDir(deps.installDir);
  await deps.ensureDir(deps.binDir);

  const zip = join(deps.installDir, `codeql-${platform}.zip`);
  const url = bundleUrl(platform);

  const fail = (why: string, stderr?: string): InstallResult => ({
    status: 'failed',
    message: `${why}${stderr ? `: ${stderr.trim()}` : ''}`,
    manual: manualInstructions(platform),
  });

  const dl = await deps.run('curl', ['-fsSL', '--retry', '3', '-o', zip, url]);
  if (dl.exit_code !== 0)
    return fail(`codeql 다운로드 실패 (curl exit=${dl.exit_code ?? 'null'})`, dl.stderr);

  // unzip 우선, 없거나 실패하면 tar(bsdtar는 zip을 읽는다)로 폴백.
  let ex = await deps.run('unzip', ['-q', '-o', zip, '-d', deps.installDir]);
  if (ex.exit_code !== 0) {
    ex = await deps.run('tar', ['-xf', zip, '-C', deps.installDir]);
    if (ex.exit_code !== 0) return fail('codeql 추출 실패 (unzip/tar 둘 다 실패)', ex.stderr);
  }

  const binary = managedBinary(deps.installDir, platform);
  if (!deps.fileExists(binary)) return fail('추출은 됐으나 codeql 런처를 찾지 못했다');

  // Windows는 심링크 대신 PATH 안내(install-plugin.mjs와 동일).
  if (platform === 'win64') {
    return {
      status: 'installed',
      binary,
      message: `codeql installed at ${binary} — ${join(deps.installDir, 'codeql')}를 PATH에 추가하라.`,
    };
  }

  const link = join(deps.binDir, 'codeql');
  const ln = await deps.run('ln', ['-sf', binary, link]);
  if (ln.exit_code !== 0) return fail(`심링크 실패 (ln exit=${ln.exit_code ?? 'null'})`, ln.stderr);
  if (!deps.fileExists(link)) return fail(`설치 단계는 끝났으나 ${link}를 확인하지 못했다`);

  const pathHint = deps.pathIncludes(deps.binDir)
    ? ''
    : ` — 단 ${deps.binDir}가 PATH에 없다. PATH에 추가해야 codeql이 잡힌다.`;
  return { status: 'installed', binary: link, message: `codeql installed at ${link}${pathHint}` };
}

/** 실제 파일시스템·spawn을 쓰는 기본 deps(탐지·위치는 install-plugin.mjs step 3b와 일치). */
export const defaultInstallDeps: InstallDeps = {
  platform: () => detectPlatform(),
  resolveExisting: async () => {
    const bin = process.env.CODEQL_BIN;
    if (bin && existsSync(bin)) return bin;
    const onPath = Bun.which('codeql');
    if (onPath) return onPath;
    const gh = join(homedir(), '.local', 'share', 'gh', 'extensions', 'gh-codeql');
    if (existsSync(gh)) return gh;
    const platform = detectPlatform();
    if (platform) {
      const managed = managedBinary(DEFAULT_INSTALL_DIR, platform);
      if (existsSync(managed)) return managed;
    }
    return null;
  },
  run: async (binary, args) => {
    const proc = Bun.spawn([binary, ...args], {
      stdout: 'ignore',
      stderr: 'pipe',
      stdin: 'ignore',
    });
    // stderr를 exit과 동시에 소비한다(exit 후 닫힌 스트림을 Response로 읽으면 bun 1.0.2가
    // ReadableStream controller TypeError를 뱉는다). 실패해도 진단용 문자열만 비울 뿐.
    const [exit_code, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text().catch(() => ''),
    ]);
    return { exit_code, stderr };
  },
  installDir: DEFAULT_INSTALL_DIR,
  binDir: DEFAULT_BIN_DIR,
  ensureDir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  fileExists: (p) => existsSync(p),
  pathIncludes: (dir) => (process.env.PATH ?? '').split(':').includes(dir),
};
