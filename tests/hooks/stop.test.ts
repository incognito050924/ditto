import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import { autopilotForcesContinuation, stopHandler } from '~/hooks/stop';

let repo: string;
let store: WorkItemStore;
let wiId: string;
const SESSION = 'sess-stop';

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-stop-'));
  store = new WorkItemStore(repo);
  const created = await store.create({
    title: 'pw',
    source_request: 'add endpoint',
    goal: 'endpoint returns score',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'returns 200', verdict: 'unverified', evidence: [] },
      { id: 'ac-2', statement: 'rejects empty', verdict: 'unverified', evidence: [] },
      { id: 'ac-3', statement: 'score 0..100', verdict: 'unverified', evidence: [] },
    ],
  });
  wiId = created.id;
  await new SessionPointerStore(repo).set(SESSION, wiId);
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const artifactPath = (name: string) => join(repo, '.ditto', 'work-items', wiId, name);
const writeArtifact = (name: string, obj: unknown) =>
  writeFile(artifactPath(name), typeof obj === 'string' ? obj : JSON.stringify(obj));
const run = (raw: Record<string, unknown>) =>
  stopHandler({ raw: { session_id: SESSION, ...raw }, repoRoot: repo, env: {} });

const completion = (overrides: Record<string, unknown>) => ({
  schema_version: '0.1.0',
  work_item_id: wiId,
  declared_by: 'main',
  declared_at: '2026-05-26T02:00:00.000Z',
  summary: 'claim',
  changed_files: [],
  verifications: [],
  unverified: [],
  remaining_risks: [],
  final_verdict: 'pass',
  ...overrides,
});

const autopilot = (overrides: Record<string, unknown>) => ({
  schema_version: '0.1.0',
  autopilot_id: 'orch_test0001',
  work_item_id: wiId,
  mode: 'autopilot',
  root_goal: 'g',
  completion_boundary: 'entire_work_item',
  approval_gate: {
    status: 'not_required',
    source: null,
    approved_at: null,
    approved_by: null,
    evidence_refs: [],
  },
  nodes: [],
  caps: { fix_per_node: 2, switch_per_node: 1 },
  continue_policy: {},
  stop_conditions: [],
  user_interrupt_policy: 'ask_only_for_user_owned_decisions',
  ...overrides,
});

const node = (overrides: Record<string, unknown>) => ({
  id: 'N1',
  kind: 'implement',
  owner: 'implementer',
  purpose: 'do',
  status: 'pending',
  depends_on: [],
  acceptance_refs: [],
  evidence_refs: [],
  attempts: { fix: 0, switch: 0 },
  ...overrides,
});

describe('stopHandler', () => {
  test('stop_hook_active=true short-circuits to exit 0 (8-iter guard)', async () => {
    await writeArtifact(
      'completion.json',
      completion({ acceptance: [{ criterion_id: 'ac-1', verdict: 'pass' }] }),
    );
    expect((await run({ stop_hook_active: true })).exitCode).toBe(0);
  });

  test('no session pointer => exit 0', async () => {
    const out = await stopHandler({ raw: { session_id: 'unknown' }, repoRoot: repo, env: {} });
    expect(out.exitCode).toBe(0);
  });

  test('completion claims pass but misses a criterion => exit 2 with reasons', async () => {
    await writeArtifact(
      'completion.json',
      completion({
        acceptance: [
          { criterion_id: 'ac-1', verdict: 'pass' },
          { criterion_id: 'ac-2', verdict: 'pass' },
        ],
      }),
    );
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('missing');
  });

  test('completion with exact passing AC-set => exit 0', async () => {
    await writeArtifact(
      'completion.json',
      completion({
        acceptance: [
          { criterion_id: 'ac-1', verdict: 'pass' },
          { criterion_id: 'ac-2', verdict: 'pass' },
          { criterion_id: 'ac-3', verdict: 'pass' },
        ],
      }),
    );
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  test('no completion artifact + active autopilot has a ready node => exit 2', async () => {
    await writeArtifact('autopilot.json', autopilot({ nodes: [node({ status: 'pending' })] }));
    expect((await run({ stop_hook_active: false })).exitCode).toBe(2);
  });

  test('all three ledgers absent + NON_TERMINAL work item => exit 2 (§M1.4 strong-block 2026-05-31)', async () => {
    // Default work item from beforeEach is status=draft → NON_TERMINAL.
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('no completion.json');
    expect(out.stderr).toContain('done/abandoned');
  });

  test('all three ledgers absent + terminal work item (done) => exit 0', async () => {
    // Take the draft work item to in_progress (re_entry not needed for that)
    // then directly to done. Avoids the partial/unverified/blocked guards.
    await store.update(wiId, (current) => ({ ...current, status: 'in_progress' }));
    await store.update(wiId, (current) => ({
      ...current,
      status: 'done',
      closed_at: '2026-05-31T00:00:00.000Z',
    }));
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  test('all three ledgers absent + terminal work item (abandoned) => exit 0', async () => {
    await store.update(wiId, (current) => ({ ...current, status: 'abandoned' }));
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  test('approval_gate pending (with remaining nodes) => exit 0 (yield to surface plan)', async () => {
    await writeArtifact(
      'autopilot.json',
      autopilot({
        approval_gate: {
          status: 'pending',
          source: null,
          approved_at: null,
          approved_by: null,
          evidence_refs: [],
        },
        nodes: [node({ status: 'pending' })],
      }),
    );
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  test('only blocked node remains (external/user/safety) => exit 0', async () => {
    await writeArtifact('autopilot.json', autopilot({ nodes: [node({ status: 'blocked' })] }));
    expect((await run({ stop_hook_active: false })).exitCode).toBe(0);
  });

  test('malformed completion.json => exit 2 (fail-closed, not fail-open)', async () => {
    await writeArtifact('completion.json', '{ this is not valid json');
    const out = await run({ stop_hook_active: false });
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('malformed');
  });
});

describe('autopilotForcesContinuation', () => {
  const base = autopilot({});
  test('runnable pending node (deps passed) forces continuation', () => {
    expect(
      autopilotForcesContinuation({ ...base, nodes: [node({ status: 'pending' })] } as never),
    ).toBe(true);
  });
  test('approval pending never forces continuation', () => {
    expect(
      autopilotForcesContinuation({
        ...base,
        approval_gate: {
          status: 'pending',
          source: null,
          approved_at: null,
          approved_by: null,
          evidence_refs: [],
        },
        nodes: [node({ status: 'pending' })],
      } as never),
    ).toBe(false);
  });
  test('pending node with unmet deps is not runnable', () => {
    expect(
      autopilotForcesContinuation({
        ...base,
        nodes: [
          node({ id: 'N1', status: 'failed' }),
          node({ id: 'N2', status: 'pending', depends_on: ['N1'] }),
        ],
      } as never),
    ).toBe(false);
  });
  test('all terminal nodes => no continuation', () => {
    expect(
      autopilotForcesContinuation({ ...base, nodes: [node({ status: 'passed' })] } as never),
    ).toBe(false);
  });
});
