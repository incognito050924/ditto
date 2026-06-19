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

describe('output discipline — no elicitation leak (ac-5)', () => {
  // 질문/내부 도구 문구는 작성 루프의 도구일 뿐, 산출물(템플릿 인스턴스)엔 결론만 남는다.
  // 설계 §5·§6-4: "질문 문구 산출물 누출 금지 + 기존 pre-mortem 템플릿 누출 수정".
  test('TEMPLATE spec section headings carry no internal tool name (no "Pre-mortem" in headings)', () => {
    const template = readFileSync(TEMPLATE_PATH, 'utf8');
    const headings = template.split('\n').filter((l) => l.startsWith('## '));
    for (const h of headings) {
      expect(h.toLowerCase()).not.toContain('pre-mortem');
      expect(h.toLowerCase()).not.toContain('premortem');
    }
  });

  test('TEMPLATE does not embed the pre-mortem question verbatim (the question is an internal tool, not output)', () => {
    const template = readFileSync(TEMPLATE_PATH, 'utf8');
    expect(template).not.toContain('깨진다면 원인은');
    expect(template).not.toContain('3일 만에 깨진다면');
  });

  test('SKILL.md declares output discipline and keeps the pre-mortem prompt as an internal tool', () => {
    const skill = readFileSync(SKILL_PATH, 'utf8');
    // 누출 금지 규율이 스킬에 명시돼 있다 (ac-5: 스킬에 출력 규율 명시)
    expect(skill).toContain('Output discipline');
    expect(skill).toMatch(/Never leak .*question phrasing/);
    // pre-mortem 질문은 삭제가 아니라 스킬(비판 축)로 옮겨 내부 도구로 산다
    expect(skill).toContain('broke in 3 days');
  });
});
