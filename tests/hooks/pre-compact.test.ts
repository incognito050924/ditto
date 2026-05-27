import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HandoffStore } from '~/core/handoff-store';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import { preCompactHandler } from '~/hooks/pre-compact';

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

  test('no session pointer => exit 0, no handoff', async () => {
    const out = await preCompactHandler({
      raw: { session_id: 'unknown' },
      repoRoot: repo,
      env: {},
    });
    expect(out.exitCode).toBe(0);
    expect(await new HandoffStore(repo).exists(wiId)).toBe(false);
  });
});
