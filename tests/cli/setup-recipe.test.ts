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
  };
  return {
    calls,
    deps: {
      setup: async (h: string) => {
        calls.setup.push(h);
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
