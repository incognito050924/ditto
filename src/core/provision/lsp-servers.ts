/**
 * 언어별 LSP 서버 provisioner (codeql/install.ts InstallDeps 패턴의 LSP판).
 *
 * CodeQL/Playwright와 결정적 차이: 단일 설치기가 아니라 **언어별 레지스트리**. 서버마다
 * 설치법·전제가 다르므로(npm / go install / rustup / 수동) provisioner를 spec으로 표현한다.
 *
 * 탐지 순서(소비자 — LSP 표면 세션 — 가 그대로 의존): `<LANG>_LSP_BIN` env → Bun.which(bin)
 * → ditto-managed(~/.local/share/ditto/lsp/<language>/bin/<bin>). Bun.which는 부재 시 null
 * (안전), raw spawn은 부재 시 throw이므로 항상 which로 먼저 probe한다.
 *
 * 설치는 opt-in·fail-soft: 전제 미충족/자동 불가/실패는 throw 대신 status:'failed' + 복붙
 * 명령(manual)을 돌려준다. heavy 서버(jdtls/kotlin)는 자동 설치하지 않고 manual만 안내한다.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { InstallResult } from '~/core/codeql/install';
import type { Prereq, Provisioner } from '~/core/provision/provisioner';

/** 한 LSP 서버의 설치/탐지 명세. */
export interface LspSpec {
  /** LSP_LANGUAGES의 language id(= registry.lsp 키). */
  language: string;
  /** PATH에서 probe할 바이너리 이름. */
  bin: string;
  /** 경로 강제용 환경변수 이름(`<LANG>_LSP_BIN`). */
  envVar: string;
  /** wizard/doctor 출력 라벨. */
  label: string;
  /** 설치 전 갖춰져야 하는 전제. */
  prereqs: Prereq[];
  /** 자동 설치 명령. null이면 자동 불가(manual만). */
  installCmd: { cmd: string; args: string[] } | null;
  /** 복붙용 수동 명령. */
  manual: string[];
}

export interface LspServerDeps {
  /** Bun.which — 바이너리 절대경로 또는 null. */
  which: (bin: string) => string | null;
  /** 한 단계 실행(npm/go/rustup). exit 0이면 성공. */
  run: (cmd: string, args: string[]) => Promise<{ exit_code: number | null; stderr: string }>;
  /** 환경변수 조회. */
  env: (name: string) => string | undefined;
  /** ditto-managed LSP 루트(~/.local/share/ditto/lsp). */
  managedDir: string;
  fileExists: (p: string) => boolean;
}

/** env → PATH(which) → managed 순으로 서버 경로를 resolve, 없으면 null. */
export function resolveServerPath(spec: LspSpec, deps: LspServerDeps): string | null {
  const forced = deps.env(spec.envVar);
  if (forced && deps.fileExists(forced)) return forced;
  const onPath = deps.which(spec.bin);
  if (onPath) return onPath;
  const managed = join(deps.managedDir, spec.language, 'bin', spec.bin);
  if (deps.fileExists(managed)) return managed;
  return null;
}

/** 전제 중 빠진 것의 이름들(probe[0]을 which로 확인). */
function missingPrereqs(spec: LspSpec, deps: LspServerDeps): string[] {
  return spec.prereqs.filter((p) => deps.which(p.probe[0] as string) === null).map((p) => p.name);
}

/** 한 LSP 서버를 설치한다(opt-in, fail-soft). */
export async function installLspServer(spec: LspSpec, deps: LspServerDeps): Promise<InstallResult> {
  const existing = resolveServerPath(spec, deps);
  if (existing) {
    return { status: 'already-present', binary: existing, message: `${spec.label} 이미 설치됨` };
  }

  const missing = missingPrereqs(spec, deps);
  if (missing.length > 0) {
    return {
      status: 'failed',
      message: `${spec.label}: 전제 미충족(${missing.join(', ')})`,
      manual: spec.manual,
    };
  }

  if (!spec.installCmd) {
    return {
      status: 'failed',
      message: `${spec.label}: 자동 설치 미지원 — 수동 설치 필요`,
      manual: spec.manual,
    };
  }

  const r = await deps.run(spec.installCmd.cmd, spec.installCmd.args);
  if (r.exit_code !== 0) {
    return {
      status: 'failed',
      message: `${spec.label} 설치 실패 (${spec.installCmd.cmd} exit=${r.exit_code ?? 'null'})${r.stderr ? `: ${r.stderr.trim()}` : ''}`,
      manual: spec.manual,
    };
  }

  const after = resolveServerPath(spec, deps);
  if (!after) {
    return {
      status: 'failed',
      message: `${spec.label}: 설치 명령은 끝났으나 ${spec.bin}을(를) PATH에서 찾지 못했다`,
      manual: spec.manual,
    };
  }
  return { status: 'installed', binary: after, message: `${spec.label} 설치 완료 → ${after}` };
}

/** spec을 Provisioner 모양으로 감싼다. */
export function lspProvisioner(spec: LspSpec, deps: LspServerDeps): Provisioner {
  return {
    id: `lsp:${spec.language}`,
    label: spec.label,
    resolveExisting: async () => resolveServerPath(spec, deps),
    install: () => installLspServer(spec, deps),
    manual: () => spec.manual,
    prereqs: () => spec.prereqs,
  };
}

const NODE_PREREQ: Prereq = {
  name: 'node',
  probe: ['node', '--version'],
  reason: 'npm 전역 설치에 필요',
};

/** 지원 LSP 서버 명세. 자동 설치 가능한 것(ts/py/go/rust)과 manual-only heavy(java/kotlin). */
export const LSP_SPECS: LspSpec[] = [
  {
    language: 'typescript',
    bin: 'typescript-language-server',
    envVar: 'TYPESCRIPT_LSP_BIN',
    label: 'typescript-language-server',
    prereqs: [NODE_PREREQ],
    installCmd: { cmd: 'npm', args: ['i', '-g', 'typescript-language-server', 'typescript'] },
    manual: ['npm i -g typescript-language-server typescript'],
  },
  {
    language: 'javascript',
    bin: 'typescript-language-server',
    envVar: 'JAVASCRIPT_LSP_BIN',
    label: 'typescript-language-server (JS)',
    prereqs: [NODE_PREREQ],
    installCmd: { cmd: 'npm', args: ['i', '-g', 'typescript-language-server', 'typescript'] },
    manual: ['npm i -g typescript-language-server typescript'],
  },
  {
    language: 'python',
    bin: 'pyright-langserver',
    envVar: 'PYTHON_LSP_BIN',
    label: 'pyright',
    prereqs: [NODE_PREREQ],
    installCmd: { cmd: 'npm', args: ['i', '-g', 'pyright'] },
    manual: ['npm i -g pyright'],
  },
  {
    language: 'go',
    bin: 'gopls',
    envVar: 'GO_LSP_BIN',
    label: 'gopls',
    prereqs: [{ name: 'go', probe: ['go', 'version'], reason: 'go install에 필요' }],
    installCmd: { cmd: 'go', args: ['install', 'golang.org/x/tools/gopls@latest'] },
    manual: [
      'go install golang.org/x/tools/gopls@latest   # $GOBIN/$GOPATH/bin이 PATH에 있어야 함',
    ],
  },
  {
    language: 'rust',
    bin: 'rust-analyzer',
    envVar: 'RUST_LSP_BIN',
    label: 'rust-analyzer',
    prereqs: [
      { name: 'rustup', probe: ['rustup', '--version'], reason: 'rustup component에 필요' },
    ],
    installCmd: { cmd: 'rustup', args: ['component', 'add', 'rust-analyzer'] },
    manual: ['rustup component add rust-analyzer'],
  },
  {
    // heavy: JDK 17+ 전제 + Eclipse JDT.LS — 자동 설치하지 않고 manual만 안내.
    language: 'java',
    bin: 'jdtls',
    envVar: 'JAVA_LSP_BIN',
    label: 'Eclipse JDT.LS (jdtls)',
    prereqs: [{ name: 'jdk17', probe: ['java', '-version'], reason: 'JDT.LS 실행에 JDK 17+ 필요' }],
    installCmd: null,
    manual: ['brew install jdtls   # 또는 Eclipse JDT.LS 번들 수동 설치 후 jdtls를 PATH에'],
  },
  {
    // heavy: 별도 릴리스 다운로드 — 자동 설치하지 않음.
    language: 'kotlin',
    bin: 'kotlin-language-server',
    envVar: 'KOTLIN_LSP_BIN',
    label: 'kotlin-language-server',
    prereqs: [],
    installCmd: null,
    manual: ['kotlin-language-server 릴리스를 받아 bin/을 PATH에 추가'],
  },
];

/** ditto-managed LSP 설치 루트. */
export function lspManagedDir(): string {
  return join(homedir(), '.local', 'share', 'ditto', 'lsp');
}

/** 실제 Bun.which/spawn/env를 쓰는 기본 deps. */
export const defaultLspServerDeps: LspServerDeps = {
  which: (bin) => Bun.which(bin),
  run: async (cmd, args) => {
    const proc = Bun.spawn([cmd, ...args], { stdout: 'ignore', stderr: 'pipe', stdin: 'ignore' });
    const [exit_code, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text().catch(() => ''),
    ]);
    return { exit_code, stderr };
  },
  env: (name) => process.env[name],
  managedDir: lspManagedDir(),
  fileExists: (p) => existsSync(p),
};

/** 언어 → Provisioner Map(registry.lsp용). */
export function lspProvisioners(
  deps: LspServerDeps = defaultLspServerDeps,
): Map<string, Provisioner> {
  return new Map(LSP_SPECS.map((spec) => [spec.language, lspProvisioner(spec, deps)]));
}
