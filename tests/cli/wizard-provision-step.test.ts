import { describe, expect, test } from 'bun:test';
import type { PromptIO } from '~/cli/wizard/prompt';
import { planProvisioning, runProvisionStep } from '~/cli/wizard/provision-step';
import type { InstallResult } from '~/core/codeql/install';
import type { Provisioner, ProvisionerRegistry } from '~/core/provision/provisioner';

function fakeProvisioner(
  id: string,
  opts: { present?: boolean; install?: InstallResult } = {},
): Provisioner {
  return {
    id,
    label: id,
    resolveExisting: async () => (opts.present ? `/bin/${id}` : null),
    install: async () => opts.install ?? { status: 'installed', message: `${id} 설치됨` },
    manual: () => [`install ${id}`],
    prereqs: () => [],
  };
}

function registry(
  tools: Provisioner[],
  lsp: Record<string, Provisioner> = {},
): ProvisionerRegistry {
  return {
    tools: new Map(tools.map((p) => [p.id, p])),
    lsp: new Map(Object.entries(lsp)),
  };
}

function fakeIO(answers: string[], isTTY = true): PromptIO {
  const q = [...answers];
  return { isTTY, ask: async () => q.shift() ?? '', write: () => {} };
}

const detect = (langs: string[]) => async () =>
  langs.map((language, i) => ({ language, files: 10 - i }));

describe('planProvisioning', () => {
  test('tools + 감지된 언어의 lsp provisioner를 후보로 모은다', async () => {
    const reg = registry([fakeProvisioner('codeql'), fakeProvisioner('playwright')], {
      typescript: fakeProvisioner('lsp:typescript'),
    });
    const plan = await planProvisioning(reg, ['typescript']);
    expect(plan.map((c) => c.id).sort()).toEqual(['codeql', 'lsp:typescript', 'playwright']);
  });

  test('감지 안 된 언어의 lsp는 후보에서 제외', async () => {
    const reg = registry([], {
      typescript: fakeProvisioner('lsp:typescript'),
      go: fakeProvisioner('lsp:go'),
    });
    const plan = await planProvisioning(reg, ['typescript']);
    expect(plan.map((c) => c.id)).toEqual(['lsp:typescript']);
  });

  test('이미 있으면 present=true·recommended=false', async () => {
    const reg = registry([fakeProvisioner('codeql', { present: true })]);
    const plan = await planProvisioning(reg, []);
    expect(plan[0]).toMatchObject({ present: true, recommended: false });
  });
});

describe('runProvisionStep', () => {
  test('비TTY: 추천(빠진) 도구를 사람 개입 없이 설치', async () => {
    const reg = registry([
      fakeProvisioner('codeql'),
      fakeProvisioner('playwright', { present: true }),
    ]);
    const summary = await runProvisionStep(fakeIO([], false), reg, 'src', { detect: detect([]) });
    const byId = new Map(summary.outcomes.map((o) => [o.id, o.action]));
    expect(byId.get('codeql')).toBe('installed'); // 빠짐 → 추천 → 설치
    expect(byId.get('playwright')).toBe('already-present'); // 있음 → 표시만
  });

  test('TTY 빈 입력: 추천 기본 유지(빠진 것 설치)', async () => {
    const reg = registry([fakeProvisioner('codeql')]);
    const summary = await runProvisionStep(fakeIO(['']), reg, 'src', { detect: detect([]) });
    expect(summary.outcomes.find((o) => o.id === 'codeql')?.action).toBe('installed');
  });

  test('TTY 선택 해제: 미선택은 skipped', async () => {
    // codeql·playwright 둘 다 빠짐 → "2"만 선택(=playwright만), codeql은 skipped.
    const reg = registry([fakeProvisioner('codeql'), fakeProvisioner('playwright')]);
    const summary = await runProvisionStep(fakeIO(['2']), reg, 'src', { detect: detect([]) });
    const byId = new Map(summary.outcomes.map((o) => [o.id, o.action]));
    expect(byId.get('codeql')).toBe('skipped');
    expect(byId.get('playwright')).toBe('installed');
  });

  test('설치 실패 → failed + manual 보존', async () => {
    const reg = registry([
      fakeProvisioner('codeql', {
        install: { status: 'failed', message: '실패', manual: ['수동 설치'] },
      }),
    ]);
    const summary = await runProvisionStep(fakeIO([], false), reg, 'src', { detect: detect([]) });
    const o = summary.outcomes.find((x) => x.id === 'codeql');
    expect(o?.action).toBe('failed');
    expect(o?.manual).toEqual(['수동 설치']);
  });

  test('감지됐지만 registry.lsp에 없는 언어는 unservicedLanguages로 보고', async () => {
    const reg = registry([], { typescript: fakeProvisioner('lsp:typescript') });
    const summary = await runProvisionStep(fakeIO([], false), reg, 'src', {
      detect: detect(['typescript', 'go', 'rust']),
    });
    expect(summary.unservicedLanguages).toEqual(['go', 'rust']); // ts는 등록됨
  });

  test('설치 후보 없으면(전부 present) multiSelect 미호출, already-present만', async () => {
    const reg = registry([fakeProvisioner('codeql', { present: true })]);
    // ask가 호출되면 throw하는 io로 multiSelect 미호출 검증.
    const strictIO: PromptIO = {
      isTTY: true,
      ask: async () => {
        throw new Error('should not prompt');
      },
      write: () => {},
    };
    const summary = await runProvisionStep(strictIO, reg, 'src', { detect: detect([]) });
    expect(summary.outcomes).toEqual([
      { id: 'codeql', action: 'already-present', message: 'codeql: 이미 설치됨' },
    ]);
  });
});
