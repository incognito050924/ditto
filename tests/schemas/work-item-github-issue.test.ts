import { describe, expect, test } from 'bun:test';
import { workItem } from '~/schemas/work-item';

// wi_260628d79 ac-8: the `github_issue` field is additive + OPTIONAL on the work
// item (singular 1 WI ↔ 1 issue link, v1). The contract: a work-item.json with NO
// github_issue field loads and operates unchanged (no schema_version bump), and a
// work item WITH a valid github_issue parses and preserves every sub-field.

// A minimal valid work item with the new field absent by default (legacy shape).
function workItemLiteral(extra: Record<string, unknown> = {}) {
  return {
    schema_version: '0.1.0',
    id: 'wi_test0001',
    title: 'a work item',
    source_request: 'do the thing',
    goal: 'the outcome is observable',
    acceptance_criteria: [
      {
        id: 'ac-1',
        statement: 'an observable behavior',
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
    ...extra,
  };
}

describe('workItem github_issue (wi_260628d79 ac-8)', () => {
  test('a work item with NO github_issue field parses unchanged (backward compat)', () => {
    const parsed = workItem.parse(workItemLiteral());
    expect(parsed.github_issue).toBeUndefined();
    // round-trip: the legacy shape re-parses to an equal object (no field injected)
    expect(workItem.parse(parsed)).toEqual(parsed);
  });

  test('a work item with a valid github_issue parses and preserves every sub-field', () => {
    const parsed = workItem.parse(
      workItemLiteral({
        github_issue: {
          repo: 'owner/name',
          number: 42,
          node_id: 'I_node123',
          project_item_id: 'PVTI_item456',
          posted_decision_ids: ['dec-1', 'dec-2'],
        },
      }),
    );
    expect(parsed.github_issue).toEqual({
      repo: 'owner/name',
      number: 42,
      node_id: 'I_node123',
      project_item_id: 'PVTI_item456',
      posted_decision_ids: ['dec-1', 'dec-2'],
    });
  });

  test('a github_issue with only repo+number parses (optional sub-fields omitted)', () => {
    const parsed = workItem.parse(
      workItemLiteral({ github_issue: { repo: 'owner/name', number: 7 } }),
    );
    expect(parsed.github_issue?.repo).toBe('owner/name');
    expect(parsed.github_issue?.number).toBe(7);
    expect(parsed.github_issue?.node_id).toBeUndefined();
    expect(parsed.github_issue?.project_item_id).toBeUndefined();
    expect(parsed.github_issue?.posted_decision_ids).toBeUndefined();
  });
});

// wi_2606287v9 (#5) ac-1: branch/session-grain CLAIM markers on the issue link.
// These record whether THIS session/branch posted a claim — so the same @me on a
// different branch is distinguishable. They are NOT a cache of the GitHub assignee
// (read-back stays SoT, ADR-20260628-github-backlog-sot); they store only what
// idempotency + branch-grain occupancy needs. Additive + OPTIONAL (no
// schema_version bump): a legacy github_issue omits them and parses unchanged.
describe('workItem github_issue claim markers (wi_2606287v9 ac-1)', () => {
  test('a github_issue WITHOUT claim markers parses unchanged (back-compat)', () => {
    const parsed = workItem.parse(
      workItemLiteral({ github_issue: { repo: 'owner/name', number: 7 } }),
    );
    expect(parsed.github_issue?.claimed_branch).toBeUndefined();
    expect(parsed.github_issue?.posted_claim_markers).toBeUndefined();
  });

  test('claimed_branch + posted_claim_markers parse and round-trip', () => {
    const parsed = workItem.parse(
      workItemLiteral({
        github_issue: {
          repo: 'owner/name',
          number: 42,
          claimed_branch: 'ditto/wi_2606287v9',
          posted_claim_markers: ['claim:ditto/wi_2606287v9'],
        },
      }),
    );
    expect(parsed.github_issue?.claimed_branch).toBe('ditto/wi_2606287v9');
    expect(parsed.github_issue?.posted_claim_markers).toEqual(['claim:ditto/wi_2606287v9']);
    expect(workItem.parse(parsed)).toEqual(parsed);
  });

  test('posted_claim_markers stays undefined when absent (no injected default)', () => {
    const parsed = workItem.parse(
      workItemLiteral({
        github_issue: { repo: 'owner/name', number: 7, claimed_branch: 'feature/x' },
      }),
    );
    expect(parsed.github_issue?.claimed_branch).toBe('feature/x');
    expect(parsed.github_issue?.posted_claim_markers).toBeUndefined();
  });
});
