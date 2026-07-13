import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutopilotStore } from '~/core/autopilot-store';
import { HandoffStore } from '~/core/handoff-store';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import { preCompactHandler } from '~/hooks/pre-compact';
import type { Autopilot } from '~/schemas/autopilot';

let repo: string;
let wiId: string;
const SESSION = 'sess-pc';

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-pc-'));
  const wi = await new WorkItemStore(repo).create({
    title: 't',
    source_request: 'do the thing',
    goal: 'g',
    acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
  });
  wiId = wi.id;
  await new SessionPointerStore(repo).set(SESSION, wiId);
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('preCompactHandler', () => {
  test('writes a handoff for the active work item, exit 0', async () => {
    const out = await preCompactHandler({
      raw: { session_id: SESSION, trigger: 'auto' },
      repoRoot: repo,
      env: {},
    });
    expect(out.exitCode).toBe(0);
    expect(await new HandoffStore(repo).exists(wiId)).toBe(true);
    expect((await new HandoffStore(repo).get(wiId)).original_intent).toBe('do the thing');
  });

  test('from_context carries the actual host (codex), not a hardcoded claude-code (OBJ-9)', async () => {
    const out = await preCompactHandler({
      raw: { session_id: SESSION, trigger: 'auto' },
      repoRoot: repo,
      env: {},
      host: 'codex',
    });
    expect(out.exitCode).toBe(0);
    const handoff = await new HandoffStore(repo).get(wiId);
    expect(handoff.from_context).toContain('codex session');
    expect(handoff.from_context).not.toContain('claude-code');
  });

  test('from_context defaults to claude-code when host is absent', async () => {
    await preCompactHandler({
      raw: { session_id: SESSION, trigger: 'auto' },
      repoRoot: repo,
      env: {},
    });
    const handoff = await new HandoffStore(repo).get(wiId);
    expect(handoff.from_context).toContain('claude-code session');
  });

  test('no session pointer => exit 0, no handoff', async () => {
    const out = await preCompactHandler({
      raw: { session_id: 'unknown' },
      repoRoot: repo,
      env: {},
    });
    expect(out.exitCode).toBe(0);
    expect(await new HandoffStore(repo).exists(wiId)).toBe(false);
  });

  test('autopilot present => handoff.autopilot_id matches autopilot.autopilot_id (§6.10)', async () => {
    const graph: Autopilot = {
      schema_version: '0.1.0',
      autopilot_id: 'orch_260531abc',
      work_item_id: wiId,
      mode: 'autopilot',
      root_goal: 'g',
      completion_boundary: 'entire_work_item',
      approval_gate: {
        status: 'not_required',
        source: 'small_reversible_policy',
        approved_at: null,
        approved_by: null,
        evidence_refs: [],
      },
      nodes: [
        {
          id: 'N1',
          kind: 'design',
          owner: 'planner',
          purpose: 'design',
          acceptance_refs: ['ac-1'],
          depends_on: [],
          status: 'pending',
          evidence_refs: [],
          ac_verdicts: [],
          attempts: { fix: 0, switch: 0 },
        },
      ],
      caps: {
        fix_per_node: 2,
        switch_per_node: 1,
        converge_rounds: 3,
        oracle_failures_to_block: 3,
        loop_rounds: 12,
        no_progress_rounds: 3,
        progress_continuation_cap: 24,
      },
      continue_policy: {
        continue_after_approval: true,
        continue_after_checkpoint: true,
        continue_after_fixable_failure: true,
        ask_user_only_for_user_owned_decisions: true,
      },
      stop_conditions: ['all_acceptance_criteria_passed_or_explicitly_closed'],
      user_interrupt_policy: 'ask_only_for_user_owned_decisions',
    };
    await new AutopilotStore(repo).write(wiId, graph);

    const out = await preCompactHandler({
      raw: { session_id: SESSION, trigger: 'auto' },
      repoRoot: repo,
      env: {},
    });
    expect(out.exitCode).toBe(0);
    const handoff = await new HandoffStore(repo).get(wiId);
    expect(handoff.autopilot_id).toBe('orch_260531abc');
  });

  test('autopilot absent => handoff.autopilot_id omitted (backward compat)', async () => {
    const out = await preCompactHandler({
      raw: { session_id: SESSION, trigger: 'auto' },
      repoRoot: repo,
      env: {},
    });
    expect(out.exitCode).toBe(0);
    const handoff = await new HandoffStore(repo).get(wiId);
    expect(handoff.autopilot_id).toBeUndefined();
  });

  test('autopilot.json malformed => fail-open, handoff written without autopilot_id', async () => {
    await writeFile(
      join(repo, '.ditto', 'local', 'work-items', wiId, 'autopilot.json'),
      '{ this is not valid json',
    );
    const out = await preCompactHandler({
      raw: { session_id: SESSION, trigger: 'auto' },
      repoRoot: repo,
      env: {},
    });
    expect(out.exitCode).toBe(0); // PreCompact must never block (§M4.2)
    const handoff = await new HandoffStore(repo).get(wiId);
    expect(handoff.autopilot_id).toBeUndefined();
  });
});
