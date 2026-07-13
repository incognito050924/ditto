import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
// @ts-expect-error — plain Node ESM bundled with the skill, no types
import { validateAgent } from '../../skills/ditto-agent-creator/scripts/validate-agent.mjs';

describe('validateAgent — ditto owner-subagent contract test', () => {
  test('the existing implementer.md conforms', () => {
    const r = validateAgent(readFileSync('agents/implementer.md', 'utf8'));
    expect(r.errors as unknown[], r.errors.join('; ')).toEqual([]);
    expect(r.ok).toBe(true);
  });

  test('the existing researcher.md (read-only) conforms', () => {
    const r = validateAgent(readFileSync('agents/researcher.md', 'utf8'));
    expect(r.errors as unknown[], r.errors.join('; ')).toEqual([]);
    expect(r.ok).toBe(true);
  });

  test('a bare stub missing the ditto convention markers fails', () => {
    const stub = `---
name: my-agent
description: Does something.
tools: Read, Edit
---

# My Agent

Just do the thing.
`;
    const r = validateAgent(stub);
    expect(r.ok).toBe(false);
    // must flag the missing envelope + Contract + isolation markers
    expect(r.errors.some((e: string) => /envelope/i.test(e))).toBe(true);
    expect(r.errors.some((e: string) => /contract/i.test(e))).toBe(true);
  });

  test('missing tools (would inherit all) is an error — least privilege', () => {
    const noTools = `---
name: my-agent
description: Read-only research helper.
---

You are an autopilot owner subagent. Context Isolation applies.
owner-return envelope ... summary verbatim_detail.
## Contract
- Read-only.
`;
    const r = validateAgent(noTools);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e: string) => /tools/i.test(e))).toBe(true);
  });

  test('a read-only agent that nonetheless grants Edit/Write fails (least privilege)', () => {
    const leaky = `---
name: leaky-reviewer
description: Reviews code. Read-only; returns findings, no mutations.
tools: Read, Grep, Glob, Edit
---

You are an autopilot owner subagent (Context Isolation).
Emit the owner-return envelope (summary, verbatim_detail).
## Contract
- Read-only: never mutate files.
`;
    const r = validateAgent(leaky);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e: string) => /read-only/i.test(e) && /(edit|write)/i.test(e))).toBe(
      true,
    );
  });

  test('no-op filler and filler-negation are advisory warnings, not errors', () => {
    const filler = `---
name: filler-agent
description: Reviews code. Read-only; returns findings, no mutations.
tools: Read, Grep, Glob
---

You are an autopilot owner subagent (Context Isolation).
Emit the owner-return envelope (summary, verbatim_detail).
Be thorough and make sure to review. Don't forget the edge cases.
## Contract
- Read-only: never mutate files.
`;
    const r = validateAgent(filler);
    expect(r.warnings.some((w: string) => /no-op filler/i.test(w))).toBe(true);
    expect(r.warnings.some((w: string) => /negation/i.test(w))).toBe(true);
    // advisory: filler must not become an error on an otherwise-conforming body
    expect(r.errors.some((e: string) => /filler|no-op|negation/i.test(e))).toBe(false);
  });

  test('existing conforming agents raise no craft filler warnings', () => {
    for (const p of ['agents/implementer.md', 'agents/researcher.md']) {
      const r = validateAgent(readFileSync(p, 'utf8'));
      expect(
        r.warnings.some((w: string) => /no-op filler|negation/i.test(w)),
        p,
      ).toBe(false);
    }
  });

  test('the agent-creator skill itself documents these checks (smoke)', () => {
    const skill = readFileSync('skills/ditto-agent-creator/SKILL.md', 'utf8');
    expect(skill).toMatch(/owner-return envelope/);
    expect(skill).toMatch(/Context Isolation/);
    expect(skill).toMatch(/Contract/);
  });
});
