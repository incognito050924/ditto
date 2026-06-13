// Codex host surface: apply_patch safety + evidence integration (N6, wi_260613f9d).
//
// THE load-bearing safety fixture (ac-5). dialectic-review's core defect: a Codex
// apply_patch edit must NOT bypass the Claude-side Edit/Write gates — if it did,
// the safety gate (forbidden_scope / secret) and the edit-evidence trail would be
// a silent no-op for Codex. N4 implemented apply_patch path extraction
// (envelope.parseApplyPatchPaths) plus the PreToolUse gate / PostToolUse evidence
// branches; this verifies them END-TO-END through `ditto hook --host codex`.
//
// Unlike the unit tests (which call the handler in-process), this drives the real
// CLI the way a Codex plugin hook would: event JSON on stdin with Codex `cwd` as
// the repo root, no CLAUDE_PROJECT_DIR, kill-switch stripped. Work item / contract
// / session pointer are scaffolded into the temp project dir with the SAME stores
// the unit tests use (ChangeContractStore / SessionPointerStore / WorkItemStore),
// so the gate reads a real contract and the evidence lands on a real work item.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChangeContractStore } from '~/core/change-contract-store';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import { acgChangeContract } from '~/schemas/acg-change-contract';

const HARNESS_REPO = join(import.meta.dir, '..', '..', '..');
const CLI = join(HARNESS_REPO, 'src', 'cli', 'index.ts');

const SESSION = 'codex-applypatch';

let projectDir: string;
let wiId: string;

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), 'ditto-host-codex-applypatch-'));
  const wi = await new WorkItemStore(projectDir).create({
    title: 't',
    source_request: 's',
    goal: 'g',
    acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
  });
  wiId = wi.id;
  await new SessionPointerStore(projectDir).set(SESSION, wiId);
});
afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

/** Write a change-contract whose forbidden_scope protects the given paths. */
async function forbid(...paths: string[]): Promise<void> {
  const contract = acgChangeContract.parse({
    schema_version: '0.1.0',
    kind: 'acg.change-contract.v1',
    work_item_id: wiId,
    produced_by: 'agent',
    produced_at: '2026-06-13T00:00:00Z',
    purpose: 'apply_patch forbidden_scope fixture',
    allowed_scope: [],
    forbidden_scope: paths.map((ref) => ({ kind: 'path' as const, ref })),
    invariants: [],
    acceptance: [{ criterion: 'green', evidence_kind: 'test' }],
    risk_default: 'low',
    decision_ref: null,
  });
  await new ChangeContractStore(projectDir).write(wiId, contract);
}

/**
 * Run `ditto hook <event> --host codex` as a Codex plugin hook would: the event
 * JSON on stdin (Codex `cwd` = repo root), NO CLAUDE_PROJECT_DIR, kill-switch
 * stripped, so neither host env nor the bypass can pollute the verdict.
 */
function runCodexHook(event: string, payload: Record<string, unknown>) {
  const env = { ...process.env };
  env.CLAUDE_PROJECT_DIR = undefined;
  env.DITTO_SKIP_HOOKS = undefined;
  return Bun.spawnSync(['bun', 'run', CLI, 'hook', event, '--host', 'codex'], {
    stdin: Buffer.from(JSON.stringify({ cwd: projectDir, session_id: SESSION, ...payload })),
    stdout: 'pipe',
    stderr: 'pipe',
    env,
  });
}

/** An apply_patch tool call carrying the given patch command text. */
const patch = (event: string, command: string) =>
  runCodexHook(event, { tool_name: 'apply_patch', tool_input: { command } });

/** Patch body that updates a single file. */
const updateFile = (p: string) =>
  `*** Begin Patch\n*** Update File: ${p}\n@@\n-old\n+new\n*** End Patch`;

const editsPath = () =>
  join(projectDir, '.ditto', 'local', 'work-items', wiId, 'evidence', 'edits.jsonl');

async function editPaths(): Promise<string[]> {
  const text = await readFile(editsPath(), 'utf8');
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l).file_path as string);
}

describe('Codex apply_patch — PreToolUse safety gate (forbidden_scope / secret)', () => {
  // Case 1: single-file Update File: in forbidden_scope → block (exit 2).
  test('Case 1: forbidden_scope path in *** Update File: blocks (exit 2)', async () => {
    await forbid('src/core/locked.ts');
    const proc = patch('pre-tool-use', updateFile('src/core/locked.ts'));
    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain('forbidden-scope');
  });

  // Case 2: multi-file patch (Add File + Update File) where one path is forbidden.
  test('Case 2: multi-file patch with one forbidden path blocks (exit 2)', async () => {
    await forbid('src/core/locked.ts');
    const command = [
      '*** Begin Patch',
      '*** Add File: src/core/new.ts',
      '+export const x = 1',
      '*** Update File: src/core/locked.ts',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    const proc = patch('pre-tool-use', command);
    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain('forbidden-scope');
  });

  // Case 3: a dotenv-style secret path in the patch → secret gate blocks (exit 2).
  test('Case 3: secret file path (.env) in the patch blocks (exit 2)', async () => {
    const proc = patch('pre-tool-use', updateFile('config/.env'));
    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain('secret');
  });

  // Case 4: every touched path allowed → passes (exit 0).
  test('Case 4: all-allowed paths pass (exit 0)', async () => {
    await forbid('src/core/locked.ts');
    const command = [
      '*** Begin Patch',
      '*** Add File: src/core/new.ts',
      '+export const x = 1',
      '*** Update File: src/core/free.ts',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    const proc = patch('pre-tool-use', command);
    expect(proc.exitCode).toBe(0);
  });

  // Case 5: *** Move to: rename — block when either old or new path is forbidden.
  test('Case 5: rename whose new (*** Move to:) path is forbidden blocks (exit 2)', async () => {
    await forbid('src/core/locked.ts');
    const command = [
      '*** Begin Patch',
      '*** Update File: src/core/free.ts',
      '*** Move to: src/core/locked.ts',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    const proc = patch('pre-tool-use', command);
    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain('forbidden-scope');
  });

  test('Case 5b: rename whose old (*** Update File:) path is forbidden blocks (exit 2)', async () => {
    await forbid('src/core/locked.ts');
    const command = [
      '*** Begin Patch',
      '*** Update File: src/core/locked.ts',
      '*** Move to: src/core/renamed.ts',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    const proc = patch('pre-tool-use', command);
    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain('forbidden-scope');
  });
});

describe('Codex apply_patch — PostToolUse records edit evidence', () => {
  // Case 6 (single): the touched path lands in evidence/edits.jsonl.
  test('Case 6a: a single-file patch records its path to edits.jsonl', async () => {
    const proc = patch('post-tool-use', updateFile('src/core/free.ts'));
    expect(proc.exitCode).toBe(0);
    expect(await editPaths()).toEqual(['src/core/free.ts']);
  });

  // Case 6 (multi): every touched path is recorded, in header order.
  test('Case 6b: a multi-file patch records every touched path to edits.jsonl', async () => {
    const command = [
      '*** Begin Patch',
      '*** Add File: src/core/new.ts',
      '+export const x = 1',
      '*** Update File: src/core/free.ts',
      '@@',
      '-old',
      '+new',
      '*** Delete File: src/core/old.ts',
      '*** End Patch',
    ].join('\n');
    const proc = patch('post-tool-use', command);
    expect(proc.exitCode).toBe(0);
    expect(await editPaths()).toEqual(['src/core/new.ts', 'src/core/free.ts', 'src/core/old.ts']);
  });

  // Case 6 (rename): both old and new rename paths are recorded.
  test('Case 6c: a rename records both the old and the *** Move to: path', async () => {
    const command = [
      '*** Begin Patch',
      '*** Update File: src/core/free.ts',
      '*** Move to: src/core/renamed.ts',
      '@@',
      '-old',
      '+new',
      '*** End Patch',
    ].join('\n');
    const proc = patch('post-tool-use', command);
    expect(proc.exitCode).toBe(0);
    expect(await editPaths()).toEqual(['src/core/free.ts', 'src/core/renamed.ts']);
  });
});
