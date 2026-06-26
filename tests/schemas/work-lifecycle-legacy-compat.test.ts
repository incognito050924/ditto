import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WorkItemStore, pushReadiness } from '~/core/work-item-store';
import { intentContract } from '~/schemas/intent';
import { workItem } from '~/schemas/work-item';

// ac-7 A (wi_260626wnv): legacy-compatibility guard. The work-lifecycle increment
// added SIX additive-OPTIONAL fields across ac-1..ac-6 — `superseded` (on an
// acceptance criterion) and `declared_risk` / `promoted_to_heavy` / `follow_ups` /
// `discovered_by` / `follows` (on the work item) — with no schema_version bump. The
// contract: a work item / intent JSON written BEFORE any of those fields existed
// still parses unchanged, and the new derived behaviors (pushReadiness, stem)
// degrade gracefully rather than throw.

// A minimal valid work item that pre-dates every field this increment added. Built
// inline so the literal IS the "legacy" shape (none of the six fields present).
function legacyWorkItemLiteral(id = 'wi_legacy0001') {
  return {
    schema_version: '0.1.0',
    id,
    title: 'legacy work item',
    source_request: 'do the legacy thing the old way',
    goal: 'the legacy outcome is observable',
    acceptance_criteria: [
      {
        id: 'ac-1',
        // placeholder/unverified criterion — a lightweight WI's starting state
        statement: 'TODO: criterion to be defined',
        verdict: 'unverified' as const,
        evidence: [],
      },
    ],
    status: 'draft' as const,
    owner_profile: 'workspace-write' as const,
    child_ids: [],
    changed_files: [],
    risks: [],
    runs: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  };
}

describe('work-lifecycle legacy compatibility (ac-7 A)', () => {
  test('legacy work-item.json parses unchanged and the six new fields are absent', () => {
    const parsed = workItem.parse(legacyWorkItemLiteral());
    // five work-item-level additive-optional fields → undefined on a legacy parse
    expect(parsed.declared_risk).toBeUndefined();
    expect(parsed.promoted_to_heavy).toBeUndefined();
    expect(parsed.follow_ups).toBeUndefined();
    expect(parsed.discovered_by).toBeUndefined();
    expect(parsed.follows).toBeUndefined();
    // the sixth field lives on the acceptance criterion
    expect(parsed.acceptance_criteria[0]?.superseded).toBeUndefined();
  });

  test('legacy intent.json parses unchanged and round-trips', () => {
    // intent.json never carried work-lifecycle fields; a minimal legacy intent must
    // still parse and re-parse to an equal object (defaults are stable).
    const legacyIntent = {
      schema_version: '0.1.0',
      work_item_id: 'wi_legacy0001',
      source_request: 'do the legacy thing the old way',
      goal: 'the legacy outcome is observable',
      acceptance_criteria: [{ id: 'ac-1', statement: 'an observable behavior' }],
      question_policy: 'ask_only_if_user_only_can_answer' as const,
    };
    const parsed = intentContract.parse(legacyIntent);
    expect(parsed.work_item_id).toBe('wi_legacy0001');
    expect(parsed.acceptance_criteria).toHaveLength(1);
    // round-trip: parsing the parsed (defaults-filled) object yields an equal object
    expect(intentContract.parse(parsed)).toEqual(parsed);
  });

  test('pushReadiness degrades on a legacy item: ready:false with reasons, no throw', () => {
    const legacyItem = workItem.parse(legacyWorkItemLiteral());
    const result = pushReadiness(legacyItem);
    // well-formed result, not a throw
    expect(typeof result.ready).toBe('boolean');
    expect(Array.isArray(result.reasons)).toBe(true);
    // a placeholder/unverified AC with no command evidence is simply not push-ready
    expect(result.ready).toBe(false);
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});

describe('work-lifecycle legacy compatibility — store-backed (ac-7 A)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ditto-legacy-compat-'));
    await mkdir(join(dir, '.ditto'), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('stem on a legacy item with no follows edge yields a one-member stem', async () => {
    const id = 'wi_legacy0001';
    // write a genuinely pre-existing on-disk legacy work-item.json (no follows edge)
    const wiPath = join(dir, '.ditto', 'local', 'work-items', id, 'work-item.json');
    await mkdir(dirname(wiPath), { recursive: true });
    await Bun.write(wiPath, JSON.stringify(legacyWorkItemLiteral(id)));

    const stem = await new WorkItemStore(dir).stem(id);
    expect(stem.members.map((m) => m.id)).toEqual([id]);
    expect(stem.members[0]?.follows).toBeUndefined();
    expect(stem.rolled_up).toBe('open');
  });
});
