import { describe, expect, test } from 'bun:test';
import { isRecipePresent, runRecipeSetup } from '~/cli/commands/setup';
import type { Recipe } from '~/schemas/recipe';

// Minimal SetupResult stand-in — runRecipeSetup only carries it through to the summary.
// biome-ignore lint/suspicious/noExplicitAny: opaque pass-through value in the headless drive
const fakeSetupResult = { host: 'codex' } as any;

describe('isRecipePresent (ac-3 detection / ac-6 regression)', () => {
  test('no cli path + empty resolved recipe → absent (falls through to legacy path)', () => {
    expect(isRecipePresent(undefined, {})).toBe(false);
  });

  test('non-empty resolved recipe → present', () => {
    expect(isRecipePresent(undefined, { host: 'codex' })).toBe(true);
  });

  test('explicit --recipe path → present even if the resolved recipe is empty', () => {
    expect(isRecipePresent('/some/recipe.yaml', {})).toBe(true);
  });
});

function makeDeps() {
  const calls = {
    setup: [] as string[],
    tools: [] as string[][],
    // biome-ignore lint/suspicious/noExplicitAny: variant array capture
    variants: [] as any[],
    memory: [] as string[],
    // biome-ignore lint/suspicious/noExplicitAny: seeded github block capture
    seed: [] as any[],
    order: [] as string[],
  };
  let seedResult = { seeded: true, reason: 'absent' as const };
  let seedThrows = false;
  return {
    calls,
    // biome-ignore lint/suspicious/noExplicitAny: test seam to vary seed outcome
    setSeedResult: (r: any) => {
      seedResult = r;
    },
    setSeedThrows: () => {
      seedThrows = true;
    },
    deps: {
      setup: async (h: string) => {
        calls.setup.push(h);
        calls.order.push('setup');
        return fakeSetupResult;
      },
      provisionTools: async (ids: string[]) => {
        calls.tools.push(ids);
        return [];
      },
      // biome-ignore lint/suspicious/noExplicitAny: variant array
      writeVariants: async (v: any[]) => {
        calls.variants.push(v);
        return { written: v.map((x) => x.name as string), skipped: [] as string[] };
      },
      separateMemory: async (m: string) => {
        calls.memory.push(m);
        return { status: 'separated' as const, message: 'ok' };
      },
      // biome-ignore lint/suspicious/noExplicitAny: injected github block
      seedGithubConfig: async (github: any) => {
        calls.seed.push(github);
        calls.order.push('seed');
        if (seedThrows) throw new Error('EACCES: seed write failed');
        return seedResult;
      },
    },
  };
}

describe('runRecipeSetup (ac-3 full 4-stage headless drive)', () => {
  test('drives host + tools + agent-link + memory(gitignore) from recipe values', async () => {
    const { calls, deps } = makeDeps();
    const recipe: Recipe = {
      host: 'codex',
      tools: ['codeql'],
      agents: [{ name: 'my-impl', role: 'implementer' }],
      memory: 'gitignore',
    };
    // biome-ignore lint/suspicious/noExplicitAny: injected deps shape
    const summary = await runRecipeSetup(recipe, 'codex', deps as any);

    expect(calls.setup).toEqual(['codex']);
    expect(calls.tools).toEqual([['codeql']]);
    expect(calls.variants[0]).toEqual([
      { name: 'my-impl', role: 'implementer', description: '', match: [] },
    ]);
    expect(calls.memory).toEqual(['gitignore']);
    expect(summary.agents.written).toEqual(['my-impl']);
    expect(summary.memory.mode).toBe('gitignore');
  });

  test('no agents / no memory in recipe → those stages no-op (memory stays in-project)', async () => {
    const { calls, deps } = makeDeps();
    // biome-ignore lint/suspicious/noExplicitAny: injected deps shape
    const summary = await runRecipeSetup({ host: 'claude-code' }, 'claude-code', deps as any);

    expect(calls.variants).toEqual([]);
    expect(calls.memory).toEqual([]);
    expect(summary.memory.mode).toBe('in-project');
  });

  test('memory: submodule is rejected headless (ac-3 minimal-increment) — no silent success', async () => {
    const { calls, deps } = makeDeps();
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: injected deps shape
      runRecipeSetup({ memory: 'submodule' }, 'claude-code', deps as any),
    ).rejects.toThrow(/submodule/);
    // guard fails closed before any side effects run
    expect(calls.setup).toEqual([]);
    expect(calls.memory).toEqual([]);
  });
});

describe('runRecipeSetup — github backlog seed (wi_260629vnt)', () => {
  const backlog = {
    project: { owner: 'team-org', number: 7 },
    status_map: { done: 'opt_done' },
    auto_reflect: true,
  } as const;

  test('recipe.backlog present → seeds github config via the injected dep (ac-1)', async () => {
    const { calls, deps } = makeDeps();
    // biome-ignore lint/suspicious/noExplicitAny: injected deps shape
    const summary = await runRecipeSetup({ host: 'codex', backlog }, 'codex', deps as any);
    expect(calls.seed).toEqual([backlog]);
    expect(summary.githubSeed).toEqual({ seeded: true, reason: 'absent' });
  });

  test('existing personal github config → dep reports existing, summary discloses it (ac-2)', async () => {
    const { calls, deps, setSeedResult } = makeDeps();
    setSeedResult({ seeded: false, reason: 'existing' });
    // biome-ignore lint/suspicious/noExplicitAny: injected deps shape
    const summary = await runRecipeSetup({ backlog }, 'claude-code', deps as any);
    expect(calls.seed.length).toBe(1);
    expect(summary.githubSeed).toEqual({ seeded: false, reason: 'existing' });
  });

  test('no backlog in recipe → seed dep NOT called, reason no-backlog, other stages unaffected (ac-3)', async () => {
    const { calls, deps } = makeDeps();
    const summary = await runRecipeSetup(
      { host: 'codex', tools: ['codeql'] },
      'codex',
      // biome-ignore lint/suspicious/noExplicitAny: injected deps shape
      deps as any,
    );
    expect(calls.seed).toEqual([]);
    expect(summary.githubSeed).toEqual({ seeded: false, reason: 'no-backlog' });
    // other stages untouched by the seed wiring
    expect(calls.setup).toEqual(['codex']);
    expect(calls.tools).toEqual([['codeql']]);
  });

  test('seed runs AFTER deps.setup (C3 — gitignore must exist before the personal coord is written)', async () => {
    const { calls, deps } = makeDeps();
    // biome-ignore lint/suspicious/noExplicitAny: injected deps shape
    await runRecipeSetup({ backlog }, 'codex', deps as any);
    expect(calls.order.indexOf('setup')).toBeLessThan(calls.order.indexOf('seed'));
  });

  test('seed write failure does NOT break runRecipeSetup — other stages still complete (C2, ADR-0018)', async () => {
    const { calls, deps, setSeedThrows } = makeDeps();
    setSeedThrows();
    const summary = await runRecipeSetup(
      { host: 'codex', tools: ['codeql'], backlog },
      'codex',
      // biome-ignore lint/suspicious/noExplicitAny: injected deps shape
      deps as any,
    );
    expect(calls.setup).toEqual(['codex']);
    expect(calls.tools).toEqual([['codeql']]);
    expect(summary.githubSeed.seeded).toBe(false);
  });
});
