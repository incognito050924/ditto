import { describe, expect, test } from 'bun:test';
import { LSP_LANGUAGES } from '~/core/provision/lsp-detect';
import {
  LSP_SPECS,
  type LspServerDeps,
  type LspSpec,
  installLspServer,
  lspProvisioners,
  resolveServerPath,
} from '~/core/provision/lsp-servers';

const tsSpec: LspSpec = {
  language: 'typescript',
  bin: 'typescript-language-server',
  envVar: 'TYPESCRIPT_LSP_BIN',
  label: 'typescript-language-server',
  prereqs: [{ name: 'node', probe: ['node', '--version'], reason: 'npm' }],
  installCmd: { cmd: 'npm', args: ['i', '-g', 'typescript-language-server', 'typescript'] },
  manual: ['npm i -g typescript-language-server typescript'],
};

function deps(over: Partial<LspServerDeps> = {}): { deps: LspServerDeps; calls: string[][] } {
  const calls: string[][] = [];
  const { run: runBehavior, ...rest } = over;
  const d: LspServerDeps = {
    which: () => null,
    env: () => undefined,
    managedDir: '/home/u/.local/share/ditto/lsp',
    fileExists: () => false,
    ...rest,
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      return runBehavior ? runBehavior(cmd, args) : { exit_code: 0, stderr: '' };
    },
  };
  return { deps: d, calls };
}

describe('resolveServerPath (탐지 순서 env→which→managed)', () => {
  test('env가 최우선(파일 존재 시)', () => {
    const { deps: d } = deps({
      env: (n) => (n === 'TYPESCRIPT_LSP_BIN' ? '/custom/tsls' : undefined),
      fileExists: (p) => p === '/custom/tsls',
      which: () => '/usr/bin/typescript-language-server',
    });
    expect(resolveServerPath(tsSpec, d)).toBe('/custom/tsls');
  });

  test('env 없으면 PATH(which)', () => {
    const { deps: d } = deps({ which: () => '/usr/bin/typescript-language-server' });
    expect(resolveServerPath(tsSpec, d)).toBe('/usr/bin/typescript-language-server');
  });

  test('env·PATH 없으면 managed 경로', () => {
    const managed = '/home/u/.local/share/ditto/lsp/typescript/bin/typescript-language-server';
    const { deps: d } = deps({ fileExists: (p) => p === managed });
    expect(resolveServerPath(tsSpec, d)).toBe(managed);
  });

  test('어디에도 없으면 null', () => {
    expect(resolveServerPath(tsSpec, deps().deps)).toBeNull();
  });
});

describe('installLspServer (opt-in, fail-soft)', () => {
  test('이미 있으면 already-present, 설치 미실행', async () => {
    const { deps: d, calls } = deps({ which: () => '/usr/bin/typescript-language-server' });
    const r = await installLspServer(tsSpec, d);
    expect(r.status).toBe('already-present');
    expect(calls).toEqual([]);
  });

  test('전제(node) 미충족 → failed + manual, 설치 미실행', async () => {
    // which: node 없음(null), 서버도 없음.
    const { deps: d, calls } = deps({ which: () => null });
    const r = await installLspServer(tsSpec, d);
    expect(r.status).toBe('failed');
    expect(r.message).toContain('전제 미충족');
    expect(r.manual?.length).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });

  test('자동 설치 명령 없음(installCmd=null) → failed + manual', async () => {
    const manualOnly: LspSpec = { ...tsSpec, installCmd: null, prereqs: [] };
    const r = await installLspServer(manualOnly, deps().deps);
    expect(r.status).toBe('failed');
    expect(r.message).toContain('자동 설치 미지원');
  });

  test('happy: 전제 충족 → npm 실행 → 설치 후 resolve 됨 → installed', async () => {
    // node는 있고(which truthy), 서버는 설치 전 없음→후 있음으로 토글.
    let installed = false;
    const { deps: d, calls } = deps({
      which: (bin) => {
        if (bin === 'node') return '/usr/bin/node';
        if (bin === 'typescript-language-server' && installed)
          return '/usr/bin/typescript-language-server';
        return null;
      },
      run: async () => {
        installed = true;
        return { exit_code: 0, stderr: '' };
      },
    });
    const r = await installLspServer(tsSpec, d);
    expect(r.status).toBe('installed');
    expect(calls[0]).toEqual(['npm', 'i', '-g', 'typescript-language-server', 'typescript']);
  });

  test('설치 명령 실패 → failed + manual', async () => {
    const { deps: d } = deps({
      which: (bin) => (bin === 'node' ? '/usr/bin/node' : null),
      run: async () => ({ exit_code: 1, stderr: 'npm err' }),
    });
    const r = await installLspServer(tsSpec, d);
    expect(r.status).toBe('failed');
    expect(r.manual?.length).toBeGreaterThan(0);
  });

  test('명령 성공했으나 여전히 resolve 안 됨 → failed', async () => {
    const { deps: d } = deps({
      which: (bin) => (bin === 'node' ? '/usr/bin/node' : null), // 설치 후에도 서버 없음
      run: async () => ({ exit_code: 0, stderr: '' }),
    });
    const r = await installLspServer(tsSpec, d);
    expect(r.status).toBe('failed');
  });
});

describe('LSP_SPECS ↔ LSP_LANGUAGES 계약 정합', () => {
  test('모든 spec.language는 감지 taxonomy(LSP_LANGUAGES)에 속한다', () => {
    for (const spec of LSP_SPECS) expect(LSP_LANGUAGES.has(spec.language)).toBe(true);
  });

  test('Kotlin·Java가 별개 spec으로 존재(서버 분리)', () => {
    const langs = LSP_SPECS.map((s) => s.language);
    expect(langs).toContain('java');
    expect(langs).toContain('kotlin');
  });

  test('heavy 서버(java/kotlin)는 자동 설치 안 함(installCmd=null)', () => {
    for (const lang of ['java', 'kotlin']) {
      expect(LSP_SPECS.find((s) => s.language === lang)?.installCmd).toBeNull();
    }
  });
});

describe('lspProvisioners', () => {
  test('language→Provisioner Map, id는 lsp: 접두', () => {
    const map = lspProvisioners(deps().deps);
    expect(map.get('typescript')?.id).toBe('lsp:typescript');
    expect(map.get('go')?.label).toBe('gopls');
    expect(map.size).toBe(LSP_SPECS.length);
  });
});
