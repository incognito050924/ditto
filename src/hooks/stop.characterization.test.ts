import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { stopHandler as rebuiltStopHandler } from './rebuilt/stop';
import { stopHandler as legacyStopHandler } from './stop';

/**
 * Handler under test: the REBUILT handler by default (what the dispatch table
 * now routes), the legacy handler under DITTO_HOOKS_LEGACY=1 — the same env
 * flip `ditto hook` uses. Run BOTH paths to prove decision parity.
 */
const stopHandler = process.env.DITTO_HOOKS_LEGACY === '1' ? legacyStopHandler : rebuiltStopHandler;

/**
 * Stop hook CHARACTERIZATION tests — pin the handler's OUTER decision surface
 * before any hook rewiring (the prior hook test suite was deleted in commit
 * 6f298c8). Green against the CURRENT legacy handler.
 *
 * Scope: only the observable exit behavior of the handler is pinned —
 * stop_hook_active yield, missing-session yield, no-pointer/no-work-item
 * yield, malformed-ledger fail-closed, one completion-gate block, the
 * no-verification-path strong block, and one clean pass. The gate library
 * internals (src/core/gates.ts) are deliberately NOT re-tested here.
 *
 * Fixtures are real files in a temp repo laid out exactly where the stores
 * persist them (`.ditto/local/sessions/`, `.ditto/local/work-items/<wi>/`);
 * the handler is invoked in-process with a constructed HookInput.
 */

const WI = 'wi_stopparity01';
const SESSION = 'stop-parity-session';
const NOW = () => new Date().toISOString();

const roots: string[] = [];

function newRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'ditto-stop-parity-'));
  roots.push(root);
  return root;
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

const wiDir = (root: string) => join(root, '.ditto', 'local', 'work-items', WI);

function writeSessionPointer(root: string): void {
  writeJsonFile(join(root, '.ditto', 'local', 'sessions', `${SESSION}.json`), {
    schema_version: '0.1.0',
    session_id: SESSION,
    work_item_id: WI,
    updated_at: NOW(),
  });
}

/** Legacy-mirror work item (record.json absent → the store reads this). */
function writeWorkItem(root: string, acceptanceIds: string[]): void {
  writeJsonFile(join(wiDir(root), 'work-item.json'), {
    schema_version: '0.1.0',
    id: WI,
    title: 'stop characterization fixture',
    source_request: 'characterize the legacy stop hook',
    goal: 'pin the stop hook outer decision surface',
    acceptance_criteria: acceptanceIds.map((id) => ({
      id,
      statement: `criterion ${id}`,
    })),
    status: 'in_progress',
    created_at: NOW(),
    updated_at: NOW(),
  });
}

/** A completion.json reporting the given ACs as pass, with a real verification. */
function writeCompletion(root: string, acceptanceIds: string[]): void {
  writeJsonFile(join(wiDir(root), 'completion.json'), {
    schema_version: '0.1.0',
    work_item_id: WI,
    declared_by: 'verifier',
    declared_at: NOW(),
    summary: 'stop characterization fixture completion',
    changed_files: [],
    acceptance: acceptanceIds.map((id) => ({ criterion_id: id, verdict: 'pass' })),
    verifications: [{ command: 'bun test fixture.test.ts', exit_code: 0 }],
    final_verdict: 'pass',
  });
}

function run(root: string, raw: unknown) {
  return stopHandler({ raw, repoRoot: root, env: {} });
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('Stop characterization — yield (exit 0) preconditions', () => {
  test('stop_hook_active=true yields immediately (8-iteration guard)', async () => {
    const out = await run(newRepo(), { stop_hook_active: true, session_id: SESSION });
    expect(out.exitCode).toBe(0);
  });

  test('missing session_id yields with a did-not-run notice', async () => {
    const out = await run(newRepo(), {});
    expect(out.exitCode).toBe(0);
    expect(out.stderr ?? '').toContain('session_id');
  });

  test('session with no pointer yields silently', async () => {
    const out = await run(newRepo(), { session_id: SESSION });
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toBeUndefined();
  });

  test('pointer to a non-loadable work item yields', async () => {
    const root = newRepo();
    writeSessionPointer(root); // pointer exists, but no work-item.json
    const out = await run(root, { session_id: SESSION });
    expect(out.exitCode).toBe(0);
  });
});

describe('Stop characterization — fail-closed on malformed ledgers (exit 2)', () => {
  test('malformed completion.json blocks and names the file', async () => {
    const root = newRepo();
    writeSessionPointer(root);
    writeWorkItem(root, ['ac-1']);
    mkdirSync(wiDir(root), { recursive: true });
    writeFileSync(join(wiDir(root), 'completion.json'), '{ this is not json');
    const out = await run(root, { session_id: SESSION });
    expect(out.exitCode).toBe(2);
    expect(out.stderr ?? '').toContain('completion.json');
    expect(out.stderr ?? '').toContain('malformed');
  });

  test('malformed autopilot.json blocks and names the file', async () => {
    const root = newRepo();
    writeSessionPointer(root);
    writeWorkItem(root, ['ac-1']);
    mkdirSync(wiDir(root), { recursive: true });
    writeFileSync(join(wiDir(root), 'autopilot.json'), '{"nodes": "nope"}');
    const out = await run(root, { session_id: SESSION });
    expect(out.exitCode).toBe(2);
    expect(out.stderr ?? '').toContain('autopilot.json');
  });
});

describe('Stop characterization — completion-gate verdicts through the ledgers', () => {
  test('completion missing an acceptance criterion blocks (exit 2)', async () => {
    const root = newRepo();
    writeSessionPointer(root);
    writeWorkItem(root, ['ac-1', 'ac-2']);
    writeCompletion(root, ['ac-1']); // ac-2 never reported
    const out = await run(root, { session_id: SESSION });
    expect(out.exitCode).toBe(2);
    expect(out.stderr ?? '').toContain('ac-2');
  });

  test('non-terminal work item with NO verification path strong-blocks (exit 2)', async () => {
    const root = newRepo();
    writeSessionPointer(root);
    writeWorkItem(root, ['ac-1']); // no completion / convergence / autopilot at all
    const out = await run(root, { session_id: SESSION });
    expect(out.exitCode).toBe(2);
    expect(out.stderr ?? '').toContain('no real verification path');
  });

  test('clean pass: full completion with executed verification yields (exit 0)', async () => {
    const root = newRepo();
    writeSessionPointer(root);
    writeWorkItem(root, ['ac-1']);
    writeCompletion(root, ['ac-1']);
    const out = await run(root, { session_id: SESSION });
    expect(out.exitCode).toBe(0);
  });
});
