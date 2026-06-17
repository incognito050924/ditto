import { describe, expect, test } from 'bun:test';
import { type AgentLinkStepDeps, runAgentLinkStep } from '~/cli/wizard/agent-link-step';
import type { PromptIO } from '~/cli/wizard/prompt';
import type { AgentVariant } from '~/core/agent-variants';

function fakeIO(answers: string[], isTTY = true): PromptIO {
  const q = [...answers];
  return { isTTY, ask: async () => q.shift() ?? '', write: () => {} };
}

const DISCOVERED = [
  { name: 'sec-bot', description: 'finds vulnerabilities' },
  { name: 'feature-builder', description: 'writes code' },
];

function deps(over: Partial<AgentLinkStepDeps> = {}): {
  deps: AgentLinkStepDeps;
  writes: AgentVariant[];
} {
  const writes: AgentVariant[] = [];
  const d: AgentLinkStepDeps = {
    loadAgents: async () => DISCOVERED,
    writeVariants: async (variants) => {
      writes.push(...variants);
      return { written: variants.map((v) => v.name), skipped: [] };
    },
    ...over,
  };
  return { deps: d, writes };
}

describe('runAgentLinkStep', () => {
  test('ac-1: recommends a role for every discovered agent', async () => {
    const { deps: d } = deps();
    const r = await runAgentLinkStep(fakeIO([], false), d);
    expect(r.discovered).toEqual([
      { name: 'sec-bot', description: 'finds vulnerabilities', role: 'security-reviewer' },
      { name: 'feature-builder', description: 'writes code', role: 'implementer' },
    ]);
  });

  test('ac-3: non-TTY writes nothing, reports only', async () => {
    const { deps: d, writes } = deps();
    const r = await runAgentLinkStep(fakeIO([], false), d);
    expect(writes).toEqual([]);
    expect(r.written).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  test('ac-2: TTY writes only the approved (selected) agents', async () => {
    const { deps: d, writes } = deps();
    // multiSelect: pick "1" → only sec-bot
    const r = await runAgentLinkStep(fakeIO(['1'], true), d);
    expect(writes.map((v) => v.name)).toEqual(['sec-bot']);
    expect(writes[0]?.role).toBe('security-reviewer');
    expect(r.written).toEqual(['sec-bot']);
  });

  test('ac-2: TTY selecting none writes nothing', async () => {
    const { deps: d, writes } = deps();
    // empty input → multiSelect default = checked items; default checked is false
    const r = await runAgentLinkStep(fakeIO([''], true), d);
    expect(writes).toEqual([]);
    expect(r.written).toEqual([]);
  });

  test('ac-4: writer skips report propagates', async () => {
    const { deps: d } = deps({
      writeVariants: async () => ({ written: [], skipped: ['sec-bot'] }),
    });
    const r = await runAgentLinkStep(fakeIO(['1'], true), d);
    expect(r.skipped).toEqual(['sec-bot']);
  });

  test('no discovered agents → empty report, no prompt', async () => {
    const { deps: d, writes } = deps({ loadAgents: async () => [] });
    const r = await runAgentLinkStep(fakeIO([], true), d);
    expect(r.discovered).toEqual([]);
    expect(writes).toEqual([]);
  });
});
