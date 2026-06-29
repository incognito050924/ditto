import { describe, expect, test } from 'bun:test';
import { type AgentLinkStepDeps, runAgentLinkStep } from '~/cli/wizard/agent-link-step';
import type { PromptIO } from '~/cli/wizard/prompt';
import type { AgentVariant } from '~/core/agent-variants';

function fakeIO(answers: string[], isTTY = true): PromptIO {
  const q = [...answers];
  return { isTTY, ask: async () => q.shift() ?? '', write: () => {} };
}

/** asked 프롬프트를 캡처하는 가짜 IO(프롬프트 라운드 수 검증용). */
function fakeIOCap(answers: string[], isTTY = true): { io: PromptIO; asked: string[] } {
  const q = [...answers];
  const asked: string[] = [];
  const io: PromptIO = {
    isTTY,
    ask: async (query) => {
      asked.push(query);
      return q.shift() ?? '';
    },
    write: () => {},
  };
  return { io, asked };
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

  test('ac-2: override는 follow-up 다중선택으로만 추천 role을 바꾼다', async () => {
    const { deps: d, writes } = deps();
    // link "1" → sec-bot; override-multiSelect "1" → sec-bot; role select "4" → reviewer.
    const r = await runAgentLinkStep(fakeIO(['1', '1', '4'], true), d);
    expect(writes.map((v) => v.name)).toEqual(['sec-bot']);
    expect(writes[0]?.role).toBe('reviewer');
    expect(r.written).toEqual(['sec-bot']);
  });

  test('ac-2: override 다중선택을 비우면(Enter) 추천 role을 유지', async () => {
    const { deps: d, writes } = deps();
    // link "1" → sec-bot; override-multiSelect "" → 아무도 안 바꿈 → 추천 security-reviewer.
    await runAgentLinkStep(fakeIO(['1', ''], true), d);
    expect(writes[0]?.role).toBe('security-reviewer');
  });

  test('ac-2: override로 휴리스틱이 추천하지 않는 role(planner)로도 바꿀 수 있다', async () => {
    const { deps: d, writes } = deps();
    // link "1" → sec-bot; override "1" → sec-bot; role select "2" → planner.
    await runAgentLinkStep(fakeIO(['1', '1', '2'], true), d);
    expect(writes[0]?.role).toBe('planner');
  });

  test('ac-4: writer skips report propagates', async () => {
    const { deps: d } = deps({
      writeVariants: async () => ({ written: [], skipped: ['sec-bot'] }),
    });
    const r = await runAgentLinkStep(fakeIO(['1'], true), d);
    expect(r.skipped).toEqual(['sec-bot']);
  });

  test('ac-2: 다중선택한 모든 agent에 추천 role을 per-agent 번호 재질문 없이 적용', async () => {
    const { deps: d, writes } = deps();
    // link "1,2" → 둘 다 선택, 이후 override multiSelect는 Enter(빈 입력)로 추천 수락.
    const { io, asked } = fakeIOCap(['1,2'], true);
    await runAgentLinkStep(io, d);
    expect(writes.map((v) => v.name)).toEqual(['sec-bot', 'feature-builder']);
    expect(writes.map((v) => v.role)).toEqual(['security-reviewer', 'implementer']);
    // 2단 번호 재질문 제거: link 1회 + override 1회 = 2회. per-agent role 재질문이면 3회.
    expect(asked.length).toBe(2);
  });

  test('no discovered agents → empty report, no prompt', async () => {
    const { deps: d, writes } = deps({ loadAgents: async () => [] });
    const r = await runAgentLinkStep(fakeIO([], true), d);
    expect(r.discovered).toEqual([]);
    expect(writes).toEqual([]);
  });
});
