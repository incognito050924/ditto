import { describe, expect, test } from 'bun:test';
// @ts-expect-error — plain Node ESM bundled with the skill, no types
import { validateSkill } from '../../skills/ditto-skill-creator/scripts/validate-skill.mjs';

const GOOD = `---
name: processing-pdfs
description: Extract text and tables from PDF files. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
---

# Processing PDFs

Body that follows progressive disclosure.
`;

describe('validateSkill — contract test', () => {
  test('a conforming SKILL.md passes with no errors', () => {
    const r = validateSkill(GOOD);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test('missing description is an error', () => {
    const bad = '---\nname: foo-bar\n---\n# x\n';
    const r = validateSkill(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e: string) => /description/i.test(e))).toBe(true);
  });

  test('a name containing the reserved word "claude" is an error', () => {
    const bad = GOOD.replace('processing-pdfs', 'claude-helper');
    const r = validateSkill(bad);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e: string) => /reserved/i.test(e))).toBe(true);
  });

  test('an uppercase/space name (bad charset) is an error', () => {
    const bad = GOOD.replace('processing-pdfs', 'My Skill');
    const r = validateSkill(bad);
    expect(r.ok).toBe(false);
    expect(
      r.errors.some((e: string) => /name/i.test(e) && /charset|lowercase|hyphen/i.test(e)),
    ).toBe(true);
  });

  test('missing frontmatter is an error', () => {
    const r = validateSkill('# just a body, no frontmatter\n');
    expect(r.ok).toBe(false);
    expect(r.errors.some((e: string) => /frontmatter/i.test(e))).toBe(true);
  });

  test('first-person description is a warning, not a hard error', () => {
    const fp = GOOD.replace(
      'Extract text and tables from PDF files.',
      'I can help you extract text from PDF files.',
    );
    const r = validateSkill(fp);
    expect(r.warnings.some((w: string) => /third person/i.test(w))).toBe(true);
  });

  test('the two skills authored by this work item pass', async () => {
    const { readFileSync } = await import('node:fs');
    for (const p of [
      'skills/ditto-skill-creator/SKILL.md',
      'skills/ditto-agent-creator/SKILL.md',
    ]) {
      const r = validateSkill(readFileSync(p, 'utf8'));
      expect(r.errors, `${p}: ${r.errors.join('; ')}`).toEqual([]);
    }
  });
});
