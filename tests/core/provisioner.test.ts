import { describe, expect, test } from 'bun:test';
import type { InstallDeps } from '~/core/codeql/install';
import {
  type Provisioner,
  type ProvisionerRegistry,
  codeqlProvisioner,
  defaultRegistry,
  resolveServer,
} from '~/core/provision/provisioner';

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

/** resolveServer 검증용 최소 가짜 provisioner. */
function fakeProvisioner(id: string, path: string | null): Provisioner {
  return {
    id,
    label: id,
    resolveExisting: async () => path,
    install: async () => ({ status: 'already-present', message: 'fake' }),
    manual: () => [],
    prereqs: () => [],
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

describe('resolveServer (LSP 표면 계약)', () => {
  test('등록되지 않은 언어는 null', async () => {
    const reg: ProvisionerRegistry = { tools: new Map(), lsp: new Map() };
    expect(await resolveServer(reg, 'python')).toBeNull();
  });

  test('등록된 언어는 그 provisioner의 resolveExisting에 위임', async () => {
    const reg: ProvisionerRegistry = {
      tools: new Map(),
      lsp: new Map([['typescript', fakeProvisioner('lsp:typescript', '/bin/tsserver')]]),
    };
    expect(await resolveServer(reg, 'typescript')).toBe('/bin/tsserver');
  });

  test('등록됐지만 부재(probe null)면 null', async () => {
    const reg: ProvisionerRegistry = {
      tools: new Map(),
      lsp: new Map([['go', fakeProvisioner('lsp:go', null)]]),
    };
    expect(await resolveServer(reg, 'go')).toBeNull();
  });
});

describe('defaultRegistry', () => {
  test('codeql 단일 도구가 등록돼 있고 lsp는 비어 있다(증분 3 전)', () => {
    const reg = defaultRegistry();
    expect(reg.tools.has('codeql')).toBe(true);
    expect(reg.tools.get('codeql')?.label).toBe('CodeQL CLI');
    expect(reg.lsp.size).toBe(0);
  });
});
