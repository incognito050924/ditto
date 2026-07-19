import { describe, expect, test } from 'bun:test';
import type { InstallDeps } from '~/core/codeql/install';
import { codeqlProvisioner, defaultRegistry } from '~/core/provision/provisioner';

/** 네트워크/fs 없이 동작을 검증하기 위한 가짜 codeql deps. */
function fakeCodeqlDeps(over: Partial<InstallDeps> = {}): InstallDeps {
  return {
    platform: () => 'osx64',
    resolveExisting: async () => null,
    run: async () => ({ exit_code: 0, stderr: '' }),
    installDir: '/home/u/.local/share/ditto/codeql',
    binDir: '/home/u/.local/bin',
    ensureDir: async () => {},
    fileExists: () => true,
    pathIncludes: () => true,
    ...over,
  };
}

describe('codeqlProvisioner adapter', () => {
  test('resolveExisting/manual를 주입된 deps에 위임한다', async () => {
    const deps = fakeCodeqlDeps({ resolveExisting: async () => '/usr/local/bin/codeql' });
    const p = codeqlProvisioner(deps);
    expect(p.id).toBe('codeql');
    expect(await p.resolveExisting()).toBe('/usr/local/bin/codeql');
    expect(p.manual().length).toBeGreaterThan(0);
    expect(p.prereqs()).toEqual([]);
  });

  test('install()을 installCodeqlCli로 위임 — already-present 단락', async () => {
    const deps = fakeCodeqlDeps({ resolveExisting: async () => '/usr/local/bin/codeql' });
    const result = await codeqlProvisioner(deps).install();
    expect(result.status).toBe('already-present');
    expect(result.binary).toBe('/usr/local/bin/codeql');
  });

  test('install() happy path → installed (주입 deps로 실제 spawn 없이)', async () => {
    const result = await codeqlProvisioner(fakeCodeqlDeps()).install();
    expect(result.status).toBe('installed');
  });
});

describe('defaultRegistry', () => {
  test('codeql·playwright 도구 + 언어별 LSP 서버가 등록돼 있다', () => {
    const reg = defaultRegistry();
    expect(reg.tools.has('codeql')).toBe(true);
    expect(reg.tools.get('codeql')?.label).toBe('CodeQL CLI');
    expect(reg.tools.has('playwright')).toBe(true);
    // lsp Map 키는 LSP_LANGUAGES taxonomy(예: typescript/go/java/kotlin)
    expect(reg.lsp.has('typescript')).toBe(true);
    expect(reg.lsp.has('kotlin')).toBe(true);
    expect(reg.lsp.get('go')?.id).toBe('lsp:go');
  });
});
