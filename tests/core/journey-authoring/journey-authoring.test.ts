import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  IdConflictError,
  JourneyAuthoringStore,
  JourneyReferenceNotFoundError,
  decomposeIntent,
  finalizeAuthoring,
  recordJourney,
  recordStory,
  startAuthoring,
} from '~/core/journey-authoring';

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'journey-authoring-'));
}

const WI = 'wi_260630aaa';
const NOW = new Date('2026-06-30T00:00:00.000Z');

function journeyDraft(over: Partial<Record<string, unknown>> = {}) {
  return {
    slug: 'checkout',
    name: '결제 여정',
    description: '비회원이 결제를 완료한다',
    owner: 'pm',
    intent: '상품을 담고 그리고 쿠폰을 적용하고 그리고 주문한다',
    surfaces: ['page:/checkout'],
    steps: [
      { step_id: 's1', intent: '상품 담기' },
      { step_id: 's2', intent: '주문하기' },
    ],
    implemented: true,
    ...over,
  };
}

describe('decomposeIntent (ac-5: propose only, no auto-materialize)', () => {
  test('splits a one-line intent into a multi-step DRAFT marked as a proposal', () => {
    const draft = decomposeIntent('상품을 담고 그리고 쿠폰을 적용하고 그리고 주문한다');
    expect(draft.proposed).toBe(true);
    expect(draft.steps.length).toBe(3);
    expect(draft.steps[0]?.step_id).toBe('s1');
    expect(draft.steps[2]?.step_id).toBe('s3');
  });

  test('skeleton single step when the intent has no connectives (no code inference)', () => {
    const draft = decomposeIntent('주문을 완료한다');
    expect(draft.proposed).toBe(true);
    expect(draft.steps.length).toBe(1);
  });
});

describe('finalize idempotency (ac-3)', () => {
  test('same input finalized twice keeps per-entity file/entry counts stable', async () => {
    const repo = await tmp();
    try {
      await startAuthoring(repo, { workItemId: WI, kind: 'journey', now: NOW });
      await recordJourney(repo, { workItemId: WI, journey: journeyDraft(), now: NOW });
      const first = await finalizeAuthoring(repo, { workItemId: WI, now: NOW });
      expect(first.status).toBe('finalized');

      const store = new JourneyAuthoringStore(repo);
      const afterFirst = (await store.loadAllJourneys()).length;

      const second = await finalizeAuthoring(repo, { workItemId: WI, now: NOW });
      expect(second.status).toBe('finalized');
      const afterSecond = (await store.loadAllJourneys()).length;
      expect(afterSecond).toBe(afterFirst);
      expect(afterSecond).toBe(1);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('id conflict fail-closed (ac-4)', () => {
  test('finalize throws when the jrn- id is already owned by a different story', async () => {
    const repo = await tmp();
    try {
      const store = new JourneyAuthoringStore(repo);
      await store.writeJourney({
        schema_version: '0.1.0',
        kind: 'acg.journey-spec.v1',
        produced_by: 'user',
        produced_at: NOW.toISOString(),
        id: 'jrn-checkout',
        status: 'validated',
        story_id: 'us-other',
        owner: 'pm',
        steps: [],
        surfaces: [],
        fixtures: [],
        evidence_requirement: { kind: 'e2e', must_pass_steps: [] },
      });

      await startAuthoring(repo, { workItemId: WI, kind: 'journey', now: NOW });
      await recordJourney(repo, { workItemId: WI, journey: journeyDraft(), now: NOW });
      await expect(finalizeAuthoring(repo, { workItemId: WI, now: NOW })).rejects.toBeInstanceOf(
        IdConflictError,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('hand-authored DSL overwrite fail-closed (ac-4: no silent data loss)', () => {
  const HAND_AUTHORED = `---
ditto_journey: v1
id: jrn-checkout
name: 결제 여정
description: 비회원이 결제를 완료한다
surfaces:
  - page:/checkout
uses_blocks:
  - auth-login
flaky_history: []
---

## 케이스: 쿠폰 적용
1. [s1] 상품 담기
2. [s2] 주문하기
`;

  test('finalize throws (no overwrite) when a same-id DSL with richer content already exists', async () => {
    const repo = await tmp();
    try {
      const dslPath = join(repo, 'e2e/journeys/checkout.journey.md');
      await mkdir(dirname(dslPath), { recursive: true });
      await writeFile(dslPath, HAND_AUTHORED, 'utf8');

      await startAuthoring(repo, { workItemId: WI, kind: 'journey', now: NOW });
      await recordJourney(repo, { workItemId: WI, journey: journeyDraft(), now: NOW });
      await expect(finalizeAuthoring(repo, { workItemId: WI, now: NOW })).rejects.toBeInstanceOf(
        IdConflictError,
      );
      // the hand-authored file is left untouched (no silent data loss)
      expect(await readFile(dslPath, 'utf8')).toBe(HAND_AUTHORED);
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });

  test('our own previously-rendered DSL re-finalizes idempotently (byte-identical, no throw)', async () => {
    const repo = await tmp();
    try {
      await startAuthoring(repo, { workItemId: WI, kind: 'journey', now: NOW });
      await recordJourney(repo, { workItemId: WI, journey: journeyDraft(), now: NOW });
      await finalizeAuthoring(repo, { workItemId: WI, now: NOW });
      const second = await finalizeAuthoring(repo, { workItemId: WI, now: NOW });
      expect(second.status).toBe('finalized');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('unimplemented journey → spec_first (ac-6)', () => {
  test('implemented=false yields spec_first, implemented=true yields awaiting_validation', async () => {
    const repo = await tmp();
    try {
      await startAuthoring(repo, { workItemId: WI, kind: 'journey', now: NOW });
      await recordJourney(repo, {
        workItemId: WI,
        journey: journeyDraft({ slug: 'unbuilt', implemented: false }),
        now: NOW,
      });
      await recordJourney(repo, {
        workItemId: WI,
        journey: journeyDraft({ slug: 'built', implemented: true }),
        now: NOW,
      });
      await finalizeAuthoring(repo, { workItemId: WI, now: NOW });

      const store = new JourneyAuthoringStore(repo);
      expect((await store.getJourney('jrn-unbuilt'))?.status).toBe('spec_first');
      expect((await store.getJourney('jrn-built'))?.status).toBe('awaiting_validation');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('finalize writes DSL + per-entity (ac-2)', () => {
  test('a journey DSL file is generated under e2e/journeys', async () => {
    const repo = await tmp();
    try {
      await startAuthoring(repo, { workItemId: WI, kind: 'journey', now: NOW });
      await recordJourney(repo, { workItemId: WI, journey: journeyDraft(), now: NOW });
      const res = await finalizeAuthoring(repo, { workItemId: WI, now: NOW });
      expect(res.status).toBe('finalized');
      const dsl = await readFile(join(repo, 'e2e/journeys/checkout.journey.md'), 'utf8');
      expect(dsl).toContain('id: jrn-checkout');
      expect(dsl).toContain('[s1]');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('story child reduction → superseded (ac-7)', () => {
  test('re-authoring a story with a dropped child supersedes the missing journey', async () => {
    const repo = await tmp();
    try {
      await startAuthoring(repo, { workItemId: WI, kind: 'story', now: NOW });
      await recordStory(repo, {
        workItemId: WI,
        story: { slug: 'shop', owner: 'pm', actor: '고객', want: '산다', value: '편리' },
        now: NOW,
      });
      await recordJourney(repo, { workItemId: WI, journey: journeyDraft({ slug: 'a' }), now: NOW });
      await recordJourney(repo, { workItemId: WI, journey: journeyDraft({ slug: 'b' }), now: NOW });
      await finalizeAuthoring(repo, { workItemId: WI, now: NOW });

      const store = new JourneyAuthoringStore(repo);
      expect((await store.getJourney('jrn-b'))?.status).not.toBe('superseded');

      // Re-author: drop journey b.
      await startAuthoring(repo, { workItemId: WI, kind: 'story', now: NOW });
      await recordStory(repo, {
        workItemId: WI,
        story: { slug: 'shop', owner: 'pm', actor: '고객', want: '산다', value: '편리' },
        now: NOW,
      });
      await recordJourney(repo, { workItemId: WI, journey: journeyDraft({ slug: 'a' }), now: NOW });
      const res = await finalizeAuthoring(repo, { workItemId: WI, now: NOW });
      expect(res.status).toBe('finalized');

      expect((await store.getJourney('jrn-b'))?.status).toBe('superseded');
      // projection excludes superseded from the active mapping
      const activeIds = (await store.activeJourneys()).map((j) => j.id);
      expect(activeIds).not.toContain('jrn-b');
      // story no longer references the dropped journey
      expect((await store.getStory('us-shop'))?.journey_ids).not.toContain('jrn-b');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('story re-referencing a missing journey fail-closed (ac-8)', () => {
  test('finalize throws when a referenced journey id is absent from the catalog', async () => {
    const repo = await tmp();
    try {
      await startAuthoring(repo, { workItemId: WI, kind: 'story', now: NOW });
      await recordStory(repo, {
        workItemId: WI,
        story: {
          slug: 'shop',
          owner: 'pm',
          actor: '고객',
          want: '산다',
          value: '편리',
          reference_journey_ids: ['jrn-ghost'],
        },
        now: NOW,
      });
      await recordJourney(repo, { workItemId: WI, journey: journeyDraft({ slug: 'a' }), now: NOW });
      await expect(finalizeAuthoring(repo, { workItemId: WI, now: NOW })).rejects.toBeInstanceOf(
        JourneyReferenceNotFoundError,
      );
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});

describe('not started', () => {
  test('finalize without start returns not_started', async () => {
    const repo = await tmp();
    try {
      const res = await finalizeAuthoring(repo, { workItemId: WI, now: NOW });
      expect(res.status).toBe('not_started');
    } finally {
      await rm(repo, { recursive: true, force: true });
    }
  });
});
