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
