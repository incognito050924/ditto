import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { preCompactHandler as legacyPreCompactHandler } from '~/hooks/pre-compact';
import { preCompactHandler as rebuiltPreCompactHandler } from '~/hooks/rebuilt/pre-compact';

/**
 * Handler under test: the REBUILT handler by default (what the dispatch table
 * routes), the legacy handler under DITTO_HOOKS_LEGACY=1 — the same env flip
 * `ditto hook` uses. Run BOTH paths to prove parity.
 */
const preCompactHandler =
  process.env.DITTO_HOOKS_LEGACY === '1' ? legacyPreCompactHandler : rebuiltPreCompactHandler;

/**
 * WHY THIS TEST EXISTS (ac-split, wi_260722g7h): handoff issuance is severed
 * from every automatic path — handoffs are strictly user-initiated. The
 * PreCompact hook used to persist a work-item handoff before compaction; that
 * write is REMOVED. This test pins the new behavior:
 *
 *   - even with a live session→work-item binding (the exact precondition that
 *     used to trigger the write), PreCompact writes NOTHING under
 *     `.ditto/local/handoff/`;
 *   - the hook stays observational (exit 0), so compaction is never blocked.
 *
 * Edge pinned: the "active work item present" case is the ONLY case that ever
 * wrote — if this case writes nothing, no PreCompact path writes a handoff.
 */

const WI = 'wi_precompact01';
const SESSION = 'pre-compact-test-session';
const NOW = () => new Date().toISOString();

const roots: string[] = [];

function newRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'ditto-pre-compact-'));
  roots.push(root);
  return root;
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const wiDir = (root: string) => join(root, '.ditto', 'local', 'work-items', WI);

/** Bind SESSION → WI the way SessionPointerStore persists it. */
function writeSessionPointer(root: string): void {
  writeJsonFile(join(root, '.ditto', 'local', 'sessions', `${SESSION}.json`), {
    schema_version: '0.1.0',
    session_id: SESSION,
    work_item_id: WI,
    updated_at: NOW(),
  });
}

function writeWorkItem(root: string): void {
  writeJsonFile(join(wiDir(root), 'work-item.json'), {
    schema_version: '0.1.0',
    id: WI,
    title: 'pre-compact no-handoff fixture',
    source_request: 'assert PreCompact writes no handoff',
    goal: 'handoffs are strictly user-initiated',
    acceptance_criteria: [{ id: 'ac-1', statement: 'criterion ac-1' }],
    status: 'in_progress',
    created_at: NOW(),
    updated_at: NOW(),
  });
}

/** Every handoff write (active or archived) lands under `.ditto/local/handoff/`. */
function handoffArtifacts(root: string): string[] {
  const dir = join(root, '.ditto', 'local', 'handoff');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true }).map(String);
}

function run(root: string, raw: unknown) {
  return preCompactHandler({ raw, repoRoot: root, env: {} });
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('PreCompact — no handoff issuance (ac-split)', () => {
  test('active session→work-item binding: exit 0 and NO handoff written', async () => {
    const root = newRepo();
    writeSessionPointer(root);
    writeWorkItem(root);
    const out = await run(root, { session_id: SESSION, trigger: 'auto' });
    expect(out.exitCode).toBe(0);
    expect(handoffArtifacts(root)).toEqual([]);
  });

  test('no session_id: exit 0 and NO handoff written', async () => {
    const root = newRepo();
    const out = await run(root, {});
    expect(out.exitCode).toBe(0);
    expect(handoffArtifacts(root)).toEqual([]);
  });
});
