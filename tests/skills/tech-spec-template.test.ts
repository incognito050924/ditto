import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..');
const TEMPLATE_PATH = join(REPO_ROOT, 'skills', 'tech-spec', 'TEMPLATE.md');
const SKILL_PATH = join(REPO_ROOT, 'skills', 'tech-spec', 'SKILL.md');
const GENERATOR_AGENT_PATH = join(REPO_ROOT, 'agents', 'question-generator.md');
const GATE_AGENT_PATH = join(REPO_ROOT, 'agents', 'question-gate.md');

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

describe('question generation workflow — multi-agent (ac-10~12)', () => {
  // 설계 §6-6 + §9 확정값. 증거 종류=doc: 계약이 SKILL/에이전트 정의에 박혀 있는지 grep으로 잠근다.
  test('generation is delegated to fresh minimal-packet generator subagents, not inline (ac-10)', () => {
    const skill = readFileSync(SKILL_PATH, 'utf8');
    // driver 인라인 생성이 아니라 fresh 서브에이전트 위임 + 최소 패킷이 계약에 명시된다.
    expect(skill).toContain('ditto:question-generator');
    expect(skill).toContain('minimal packet');
    expect(skill).toMatch(/fresh/i);
    // 패킷 제외 항목(편향원): 인터뷰 서사 + driver 추측.
    expect(skill).toMatch(/Excluded:.*interview narrative.*guesses/);
    // 하드 룰로도 잠긴다: 인라인 최종 질문 생성 금지.
    expect(skill).toMatch(/Never generate the final question set inline/);
  });

  test('generator agent contract exists, read-only, minimal-packet, generate-only (ac-10)', () => {
    const gen = readFileSync(GENERATOR_AGENT_PATH, 'utf8');
    expect(gen).toMatch(/^---\nname: question-generator\n/);
    expect(gen).toContain('tools: Read, Grep, Glob'); // read-only
    expect(gen).toContain('minimal packet');
    expect(gen).toContain('You do NOT receive'); // 컨텍스트 격리(반-편향)
    // 생성 전용: 점수/선정은 게이트의 일이다.
    expect(gen).toMatch(/do \*\*not\*\* score, select/);
  });

  test('fan-out → fan-in gate is the workflow, with the four-dimension score schema (ac-11)', () => {
    const skill = readFileSync(SKILL_PATH, 'utf8');
    expect(skill).toContain('ditto:question-gate');
    expect(skill).toMatch(/fan out N generators/);
    expect(skill).toMatch(/fan-in/);
    // N 생성기 수는 config-driven: 기본 2, 1..6 (§9 #5 갱신, wi_260619yfw).
    expect(skill).toMatch(/--generators/);
    expect(skill).toMatch(/default 2/);
    expect(skill).toMatch(/range 1\.\.6/);
    // 점수 4차원 (§9 #3: consensus=공통도, 나머지 품질·필요성·가치).
    for (const dim of ['consensus', 'quality', 'necessity', 'answer_value']) {
      expect(skill).toContain(dim);
    }
  });

  test('gate agent scores four dimensions, selects by threshold, returns to driver not the user (ac-11~12)', () => {
    const gate = readFileSync(GATE_AGENT_PATH, 'utf8');
    expect(gate).toMatch(/^---\nname: question-gate\n/);
    expect(gate).toContain('tools: Read, Grep, Glob'); // read-only
    for (const dim of ['consensus', 'quality', 'necessity', 'answer_value']) {
      expect(gate).toContain(dim);
    }
    // 게이트는 사용자에게 직접 질문하지 않는다 (§9 #7 확정).
    expect(gate).toMatch(/never ask the user/);
    // dry 신호 + 임계 (§9 #4 확정).
    expect(gate).toContain('dry');
    expect(gate).toContain('threshold');
  });

  test('termination is score-based (dry round), not a fixed question count (ac-12)', () => {
    const skill = readFileSync(SKILL_PATH, 'utf8');
    expect(skill).toMatch(/score-based.*not a fixed question count/);
    expect(skill).toContain('dry');
    // 임계는 강도 유도값, hard-cap은 선택적(기본 무제한) — wi_260619yfw 갱신.
    expect(skill).toMatch(/intensity-derived/);
    expect(skill).toMatch(/max_rounds|max_questions/);
    expect(skill).toMatch(/default 0 = unlimited/);
  });
});

// wi_260619nep: every relayed option needs a "how to obey" basis at its consumer,
// otherwise next-round relaying it is hollow. Guards against regressing to
// "option named but no behavior defined".
describe('per-option behavior rubric — relayed options carry an obey basis (ac-7)', () => {
  test('generator_effort changes generator grounding depth (defined in the generator agent)', () => {
    const gen = readFileSync(GENERATOR_AGENT_PATH, 'utf8');
    expect(gen).toMatch(/effort/i);
    // low↔high must differ in concrete behavior, not just be named
    expect(gen).toMatch(/\blow\b/);
    expect(gen).toMatch(/\bhigh\b/);
    expect(gen).toMatch(/grounding|Read\/Grep|code/i);
  });

  test('granularity changes how a section is split into questions (defined for the generator)', () => {
    const gen = readFileSync(GENERATOR_AGENT_PATH, 'utf8');
    expect(gen).toMatch(/granularity/i);
    expect(gen).toMatch(/\blow\b/);
    expect(gen).toMatch(/\bhigh\b/);
  });

  test('gate_mode confirm vs draft behavior — and draft’s safety boundary — is defined in the SKILL', () => {
    const skill = readFileSync(SKILL_PATH, 'utf8');
    expect(skill).toMatch(/gate_mode/);
    expect(skill).toMatch(/\bconfirm\b/);
    expect(skill).toMatch(/\bdraft\b/);
    // draft's safety boundary stated near `draft` itself (not the far-away pre-mortem
    // mention of irreversible) — the boundary is what makes draft safe to obey.
    expect(skill).toMatch(/draft[\s\S]{0,400}(irreversible|비가역)/i);
  });
});
