import { describe, expect, test } from 'bun:test';
import { parseArchitectureSpecText } from '~/core/fs';
import { acgArchitectureSpec } from '~/schemas/acg-architecture-spec';

// 20-contracts.md §3 예시를 JSON/YAML 두 형식으로 동일하게 표현:
// layers(중첩 map), forbidden_dependencies(inline-object 리스트), conventions(중첩).
const SPEC_OBJECT = {
  schema_version: '0.1.0',
  kind: 'acg.architecture-spec.v1',
  produced_by: 'user',
  produced_at: '2026-06-04T00:00:00Z',
  layers: {
    controller: { can_call: ['service'] },
    service: { can_call: ['repository'] },
    repository: { can_call: [] },
  },
  public_surfaces: ['portal-backend/**/controller/**'],
  forbidden_dependencies: [
    {
      from: 'automation-engine/**',
      to: 'portal-backend/**',
      reason: '엔진은 포털을 REST로만 호출',
    },
  ],
  conventions: {
    formatter: { cmd: 'ktlintFormat --check', on_violation: 'block' },
    naming: { rule: 'service 클래스는 *Service 접미사', evaluator: 'deterministic' },
    approved_patterns: ['repository 접근은 Exposed DSL'],
  },
};

const JSON_TEXT = JSON.stringify(SPEC_OBJECT);

const YAML_TEXT = `schema_version: "0.1.0"
kind: acg.architecture-spec.v1
produced_by: user
produced_at: "2026-06-04T00:00:00Z"
layers:
  controller: { can_call: [service] }
  service:    { can_call: [repository] }
  repository: { can_call: [] }
public_surfaces:
  - portal-backend/**/controller/**
forbidden_dependencies:
  - { from: "automation-engine/**", to: "portal-backend/**", reason: "엔진은 포털을 REST로만 호출" }
conventions:
  formatter: { cmd: "ktlintFormat --check", on_violation: block }
  naming:    { rule: "service 클래스는 *Service 접미사", evaluator: deterministic }
  approved_patterns:
    - "repository 접근은 Exposed DSL"
`;

describe('parseArchitectureSpecText', () => {
  test('YAML과 JSON이 동일 객체로 파싱된다', () => {
    const fromYaml = parseArchitectureSpecText(YAML_TEXT, 'architecture.yaml');
    const fromJson = parseArchitectureSpecText(JSON_TEXT, 'architecture.json');
    expect(fromYaml).toEqual(fromJson);
  });

  test('YAML 파싱 결과가 acgArchitectureSpec.parse를 통과한다', () => {
    const spec = acgArchitectureSpec.parse(
      parseArchitectureSpecText(YAML_TEXT, '.acg/architecture.yaml'),
    );
    expect(spec.layers.controller.can_call).toEqual(['service']);
    expect(spec.forbidden_dependencies[0].from).toBe('automation-engine/**');
    expect(spec.conventions?.formatter?.cmd).toBe('ktlintFormat --check');
  });

  test('.yml 확장자도 YAML로 파싱한다', () => {
    const fromYml = parseArchitectureSpecText(YAML_TEXT, 'spec.yml');
    expect(acgArchitectureSpec.parse(fromYml).public_surfaces[0]).toBe(
      'portal-backend/**/controller/**',
    );
  });

  test('JSON 본문은 .json 외 확장자에서도 JSON.parse 경로로 읽힌다', () => {
    const parsed = parseArchitectureSpecText(JSON_TEXT, 'architecture.json');
    expect(acgArchitectureSpec.parse(parsed).layers.repository.can_call).toEqual([]);
  });

  test('internal_packages — 미지정 시 기본 빈 배열, 지정 시 그대로 보존', () => {
    expect(acgArchitectureSpec.parse(SPEC_OBJECT).internal_packages).toEqual([]);
    const withInternal = acgArchitectureSpec.parse({
      ...SPEC_OBJECT,
      internal_packages: ['kr.co.ecoletree.boxwood'],
    });
    expect(withInternal.internal_packages).toEqual(['kr.co.ecoletree.boxwood']);
  });
});
