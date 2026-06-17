import { describe, expect, test } from 'bun:test';
import type { PromptIO } from '~/cli/wizard/prompt';
import { type Option, select } from '~/cli/wizard/prompt';
import { type SetupWizardDeps, runSetupWizard } from '~/cli/wizard/setup-wizard';
import type { MemorySeparateResult } from '~/core/provision/memory-separate';
import type { SetupHost, SetupResult } from '~/core/setup';

function fakeIO(answers: string[], isTTY = true): PromptIO {
  const q = [...answers];
  return { isTTY, ask: async () => q.shift() ?? '', write: () => {} };
}

const stubSetup: SetupResult = {
  resources: [],
  scaffold: {
    repoRoot: '/repo',
    alreadyInitialized: true,
    createdDirs: [],
    createdFiles: [],
    skippedFiles: [],
  },
  allowlistPath: '/repo/.claude/settings.json',
  allowlistApplied: true,
  codex: null,
};

function deps(over: Partial<SetupWizardDeps> = {}): { deps: SetupWizardDeps; log: string[] } {
  const log: string[] = [];
  const d: SetupWizardDeps = {
    projectRoot: '/repo',
    sourceRoot: '/repo/src',
    setup: async (host) => {
      log.push(`setup:${host}`);
      return stubSetup;
    },
    runProvision: async () => {
      log.push('provision');
      return { outcomes: [], unservicedLanguages: [] };
    },
    separateMemory: async (mode) => {
      log.push(`memory:${mode}`);
      return { status: 'separated', message: 'ok' } as MemorySeparateResult;
    },
    runAgentLink: async () => {
      log.push('agent-link');
      return { discovered: [], written: [], skipped: [] };
    },
    ...over,
  };
  return { deps: d, log };
}

describe('select primitive', () => {
  const opts: Option[] = [
    { label: 'A', value: 'a' },
    { label: 'B', value: 'b' },
  ];
  test('비TTY면 defaultValue', async () => {
    expect(await select(fakeIO([], false), 'x', opts, 'b')).toBe('b');
  });
  test('빈 입력은 default', async () => {
    expect(await select(fakeIO(['']), 'x', opts, 'a')).toBe('a');
  });
  test('번호로 선택', async () => {
    expect(await select(fakeIO(['2']), 'x', opts, 'a')).toBe('b');
  });
  test('범위 밖이면 default', async () => {
    expect(await select(fakeIO(['9']), 'x', opts, 'a')).toBe('a');
  });
});

describe('runSetupWizard', () => {
  test('비TTY: 전부 기본값 — host=claude-code, 분리 안 함(무정지)', async () => {
    const { deps: d, log } = deps();
    const r = await runSetupWizard(fakeIO([], false), d);
    expect(r.host).toBe('claude-code');
    expect(r.memory.mode).toBe('in-project');
    expect(r.memory.result).toBeNull();
    expect(log).toEqual(['setup:claude-code', 'provision', 'agent-link']); // memory 분리 미호출
  });

  test('TTY: host=both 선택 → setup(both)', async () => {
    const { deps: d, log } = deps();
    // 답변 순서: host(3=both) → memory 분리?(빈=기본 no)
    await runSetupWizard(fakeIO(['3', '']), d);
    expect(log[0]).toBe('setup:both');
  });

  test('TTY: memory 분리 yes → gitignore 기본 모드로 separateMemory 호출', async () => {
    const { deps: d, log } = deps();
    // host(빈=claude-code) → 분리?(y) → 방식(빈=gitignore 기본)
    const r = await runSetupWizard(fakeIO(['', 'y', '']), d);
    expect(r.memory.mode).toBe('gitignore');
    expect(log).toContain('memory:gitignore');
  });

  test('TTY: memory 분리 yes + submodule 선택', async () => {
    const { deps: d } = deps();
    // host(빈) → 분리?(y) → 방식(2=submodule)
    const r = await runSetupWizard(fakeIO(['', 'y', '2']), d);
    expect(r.memory.mode).toBe('submodule');
  });

  test('provision 단계는 항상 실행된다', async () => {
    const { deps: d, log } = deps();
    await runSetupWizard(fakeIO([], false), d);
    expect(log).toContain('provision');
  });

  test('agent-link 단계는 선택된 host를 받는다(host별 발견 분기)', async () => {
    let receivedHost: SetupHost | undefined;
    const { deps: d } = deps({
      runAgentLink: async (_io: PromptIO, host?: SetupHost) => {
        receivedHost = host;
        return { discovered: [], written: [], skipped: [] };
      },
    });
    // host(3=both) → memory 분리?(빈=no)
    await runSetupWizard(fakeIO(['3', ''], true), d);
    expect(receivedHost).toBe('both');
  });

  test('agent-link 단계가 실행되고 결과가 요약에 실린다', async () => {
    const { deps: d, log } = deps({
      runAgentLink: async () => {
        log.push('agent-link');
        return {
          discovered: [{ name: 'x', description: 'd', role: 'implementer' }],
          written: ['x'],
          skipped: [],
        };
      },
    });
    const r = await runSetupWizard(fakeIO([], false), d);
    expect(log).toContain('agent-link');
    expect(r.agents.written).toEqual(['x']);
    expect(r.agents.discovered[0]?.role).toBe('implementer');
  });
});
