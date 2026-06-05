import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import { stopHandler } from '~/hooks/stop';

// S1 (wi_260605aw1) — Stop AX nudge wired end-to-end (real git, no CodeQL).
// A work item allowed to stop with source changes but no semantic artifact gets
// a non-blocking reminder; exit code stays 0.

let repo: string;
let wiId: string;
let store: WorkItemStore;
const SESSION = 'sess-nudge';

const git = (args: string[]) =>
  execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'ignore', 'pipe'] });

const completion = () => ({
  schema_version: '0.1.0',
  work_item_id: wiId,
  declared_by: 'main',
  declared_at: '2026-06-05T00:00:00.000Z',
  summary: 'done',
  changed_files: [],
  verifications: [{ command: 'bun test', exit_code: 0 }],
  unverified: [],
  remaining_risks: [],
  final_verdict: 'pass',
  acceptance: [{ criterion_id: 'ac-1', verdict: 'pass' }],
});

const run = () => stopHandler({ raw: { session_id: SESSION }, repoRoot: repo, env: {} });
const writeWi = (name: string, obj: unknown) =>
  writeFile(join(repo, '.ditto', 'work-items', wiId, name), JSON.stringify(obj));

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-nudge-'));
  git(['init']);
  git(['config', 'user.email', 't@t.t']);
  git(['config', 'user.name', 't']);
  await writeFile(join(repo, 'user.ts'), 'export function getUser(id: string): User | null {}\n');
  git(['add', '-A']);
  git(['commit', '-m', 'base']);

  store = new WorkItemStore(repo);
  const created = await store.create({
    title: 'pw',
    source_request: 'change',
    goal: 'g',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'returns user', verdict: 'unverified', evidence: [] },
    ],
  });
  wiId = created.id;
  // → in_progress backfills started_at_sha = current HEAD (the base commit).
  await store.update(wiId, (c) => ({ ...c, status: 'in_progress' }));
  await new SessionPointerStore(repo).set(SESSION, wiId);
  await writeWi('completion.json', completion());

  // Uncommitted signature change vs the work item's start sha.
  await writeFile(join(repo, 'user.ts'), 'export function getUser(id: string): User {}\n');
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('Stop semantic-scan nudge (S1)', () => {
  test('nudges (non-blocking) when source changed and no semantic artifact', async () => {
    const out = await run();
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain('ditto semantic scan');
    expect(out.stderr).toContain(wiId);
  });

  test('no nudge once a semantic-compatibility.json exists', async () => {
    await writeWi('semantic-compatibility.json', {
      schema_version: '0.1.0',
      kind: 'acg.semantic-compatibility.v1',
      work_item_id: wiId,
      produced_by: 'agent',
      produced_at: '2026-06-05T00:00:00Z',
      change: { before: 'a', after: 'b' },
      old_meaning: 'm',
      compatibility: 'breaking',
      verdict: { type_safe: true, semantic_safe: 'no', intended_breaking: true },
    });
    const out = await run();
    expect(out.exitCode).toBe(0);
    expect(out.stderr ?? '').not.toContain('ditto semantic scan');
  });

  test('no nudge for a terminal (done) work item', async () => {
    await store.update(wiId, (c) => ({ ...c, status: 'done' }));
    const out = await run();
    expect(out.stderr ?? '').not.toContain('ditto semantic scan');
  });
});
