import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const SKILL_PATH = join(REPO_ROOT, 'skills', 'deep-interview', 'SKILL.md');

describe('deep-interview pre-mortem output discipline (leak guard)', () => {
  test('pre-mortem is an internal tool — its prompt phrasing is never surfaced to the user', () => {
    const skill = readFileSync(SKILL_PATH, 'utf8');
    // 가드가 명문화돼 있다: 내부 추론이고 사용자에게 surfacing하지 않는다
    expect(skill).toMatch(/not surfaced to the user/i);
    expect(skill).toMatch(/never the pre-mortem prompt itself/i);
  });

  test('pre-mortem carries no arbitrary time anchor (no "N days" framing that leaks as a confusing claim)', () => {
    const skill = readFileSync(SKILL_PATH, 'utf8');
    expect(skill).not.toContain('3 days');
    // 어떤 "<숫자> day(s)" 시간 앵커도 pre-mortem 프레이밍에 두지 않는다
    expect(skill).not.toMatch(/broke in \d+ days?/i);
  });
});

describe('deep-interview honors user config (no gratuitous flag override)', () => {
  test('start guidance tells the agent to run start WITHOUT --generators when a config default is set', () => {
    const skill = readFileSync(SKILL_PATH, 'utf8');
    // local config가 사용자의 표명된 선호이므로, 에이전트가 --generators를 박아 덮어쓰지 않도록 명시.
    expect(skill).toContain('without `--generators`');
  });
});
