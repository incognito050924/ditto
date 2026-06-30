import { describe, expect, test } from 'bun:test';
import { acgJourneySpec } from '~/schemas/acg-journey-spec';
import { acgStorySpec } from '~/schemas/acg-story-spec';

// n2-schema acceptance: user story catalog entry (us-<kebab> id) referencing
// journeys 1:N (jrn- ids), plus additive journey-spec lifecycle status + story_id
// back-link. Story envelope mirrors acgCatalogEnvelope (no work_item_id).

const AT = '2026-06-30T00:00:00Z';

const storyBase = () => ({
  schema_version: '0.1.0' as const,
  kind: 'acg.story-spec.v1' as const,
  produced_by: 'user' as const,
  produced_at: AT,
  id: 'us-process-automation',
  owner: 'automation-team',
  actor: '운영 담당자',
  want: '프로세스를 자동 실행하고 싶다',
  value: '수작업 운영 부담을 줄인다',
  journey_ids: ['jrn-process-run', 'jrn-process-review'],
});

describe('ACG StorySpec (catalog, story→journey 1:N)', () => {
  test('valid story with multiple journeys parses', () => {
    expect(acgStorySpec.safeParse(storyBase()).success).toBe(true);
  });

  test('single-journey 1:N still parses', () => {
    expect(
      acgStorySpec.safeParse({ ...storyBase(), journey_ids: ['jrn-process-run'] }).success,
    ).toBe(true);
  });

  test('empty journey_ids rejected (a story must own ≥1 journey)', () => {
    expect(acgStorySpec.safeParse({ ...storyBase(), journey_ids: [] }).success).toBe(false);
  });

  test('non-jrn journey id rejected (must reference jrn- ids)', () => {
    expect(acgStorySpec.safeParse({ ...storyBase(), journey_ids: ['process-run'] }).success).toBe(
      false,
    );
  });

  test('non-us story id rejected (must be us-<kebab>)', () => {
    expect(acgStorySpec.safeParse({ ...storyBase(), id: 'story_1' }).success).toBe(false);
  });

  test('missing owner rejected', () => {
    const { owner: _owner, ...noOwner } = storyBase();
    expect(acgStorySpec.safeParse(noOwner).success).toBe(false);
  });

  test('missing value narrative rejected', () => {
    const { value: _value, ...noValue } = storyBase();
    expect(acgStorySpec.safeParse(noValue).success).toBe(false);
  });
});

describe('ACG JourneySpec lifecycle status (additive optional) + story_id back-link', () => {
  const journeyBase = () => ({
    schema_version: '0.1.0' as const,
    kind: 'acg.journey-spec.v1' as const,
    produced_by: 'user' as const,
    produced_at: AT,
    id: 'jrn-process-run',
    owner: 'automation-team',
    steps: [{ step_id: 's1', intent: '프로세스 생성' }],
    surfaces: ['/automation/process'],
    evidence_requirement: { kind: 'e2e' as const, must_pass_steps: ['s1'] },
  });

  test('pre-existing journey WITHOUT status still parses (additive invariant)', () => {
    expect(acgJourneySpec.safeParse(journeyBase()).success).toBe(true);
  });

  test('all 4 lifecycle states parse', () => {
    for (const status of ['spec_first', 'awaiting_validation', 'validated', 'superseded']) {
      expect(
        acgJourneySpec.safeParse({ ...journeyBase(), status }).success,
        `status ${status} should parse`,
      ).toBe(true);
    }
  });

  test('unknown status rejected', () => {
    expect(acgJourneySpec.safeParse({ ...journeyBase(), status: 'done' }).success).toBe(false);
  });

  test('id must be jrn-<kebab> (journeyDslId enforced)', () => {
    expect(acgJourneySpec.safeParse({ ...journeyBase(), id: 'process-run' }).success).toBe(false);
  });

  test('story_id back-link (optional) accepts a us- id', () => {
    expect(
      acgJourneySpec.safeParse({ ...journeyBase(), story_id: 'us-process-automation' }).success,
    ).toBe(true);
  });

  test('story_id back-link rejects a non-us id', () => {
    expect(
      acgJourneySpec.safeParse({ ...journeyBase(), story_id: 'jrn-process-run' }).success,
    ).toBe(false);
  });
});
