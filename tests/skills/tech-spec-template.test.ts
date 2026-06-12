import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const TEMPLATE_PATH = join(REPO_ROOT, 'skills', 'tech-spec', 'TEMPLATE.md');
const SKILL_PATH = join(REPO_ROOT, 'skills', 'tech-spec', 'SKILL.md');

describe('tech-spec template generalization (ac-1)', () => {
  test('TEMPLATE.md exists and carries the 12 generalized sections + 인터뷰 기록', () => {
    const template = readFileSync(TEMPLATE_PATH, 'utf8');
    const requiredSections = [
      '기능',
      '요약',
      '배경',
      '목표',
      '비목표',
      '완료 조건',
      '위험',
      '계획',
      '영향도',
      '기각된 대안',
      '마일스톤',
      '인터뷰 기록',
      '빌드 후 처리',
    ];
    for (const section of requiredSections) {
      expect(template).toContain(section);
    }
    // 수명 라벨(WHY/HOW half-life)은 일반화 후에도 유지된다 (기획문서 §8)
    expect(template).toContain('[장]');
    expect(template).toContain('[단]');
    // §8 계획의 비구속 배너는 템플릿이 직접 들고 있어야 한다 (기획문서 §8)
    expect(template).toContain('비구속');
  });

  test('TEMPLATE.md contains no BOXWOOD-specific terms (기획문서 §5)', () => {
    const template = readFileSync(TEMPLATE_PATH, 'utf8');
    const forbidden = [
      'BOXWOOD',
      'process-assets',
      'PA-',
      'BWASSETS',
      'Confluence',
      '요구사항 v2.1',
    ];
    for (const term of forbidden) {
      expect(template).not.toContain(term);
    }
  });

  test('SKILL.md exists with tech-spec frontmatter and stepwise default mode', () => {
    const skill = readFileSync(SKILL_PATH, 'utf8');
    expect(skill).toMatch(/^---\nname: tech-spec\n/);
    // 기본 모드는 증분(stepwise)으로 고정 — 일괄(oneshot)은 명시적 opt-in (기획문서 §5)
    expect(skill).toContain('stepwise');
    expect(skill).toContain('oneshot');
    // 스펙 인스턴스 저장 위치는 M1 확정 결정을 따른다
    expect(skill).toContain('.ditto/specs/');
  });
});
