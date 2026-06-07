import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import { postToolUseHandler } from '~/hooks/post-tool-use';
import { commandLogEntry, editLogEntry } from '~/schemas/evidence-log';

let repo: string;
let wiId: string;
const SESSION = 'sess-ptu';

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-ptu-'));
  const wi = await new WorkItemStore(repo).create({
    title: 't',
    source_request: 's',
    goal: 'g',
    acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
  });
  wiId = wi.id;
  await new SessionPointerStore(repo).set(SESSION, wiId);
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const run = (raw: Record<string, unknown>) =>
  postToolUseHandler({ raw: { session_id: SESSION, ...raw }, repoRoot: repo, env: {} });

const logPath = () =>
  join(repo, '.ditto', 'local', 'work-items', wiId, 'evidence', 'commands.jsonl');
async function logLines(): Promise<string[]> {
  const text = await readFile(logPath(), 'utf8');
  return text.split('\n').filter((l) => l.trim().length > 0);
}
const logExists = () => Bun.file(logPath()).exists();

describe('postToolUseHandler', () => {
  test('records a Bash command to commands.jsonl (schema-valid), exit 0', async () => {
    const out = await run({
      tool_name: 'Bash',
      tool_input: { command: 'bun test' },
      tool_response: { exit_code: 0 },
    });
    expect(out.exitCode).toBe(0);
    const lines = await logLines();
    expect(lines).toHaveLength(1);
    const entry = commandLogEntry.parse(JSON.parse(lines[0] ?? '{}'));
    expect(entry.command).toBe('bun test');
    expect(entry.exit_code).toBe(0);
    expect(entry.work_item_id).toBe(wiId);
  });

  test('best-effort exit code from an error response', async () => {
    await run({
      tool_name: 'Bash',
      tool_input: { command: 'false' },
      tool_response: { is_error: true },
    });
    const entry = commandLogEntry.parse(JSON.parse((await logLines())[0] ?? '{}'));
    expect(entry.exit_code).toBe(1);
  });

  test('non-Bash tools are ignored (no log file)', async () => {
    const out = await run({ tool_name: 'Read', tool_input: { file_path: 'x' } });
    expect(out.exitCode).toBe(0);
    expect(await logExists()).toBe(false);
  });

  test('no session pointer => exit 0, nothing recorded', async () => {
    const out = await postToolUseHandler({
      raw: { session_id: 'unknown', tool_name: 'Bash', tool_input: { command: 'ls' } },
      repoRoot: repo,
      env: {},
    });
    expect(out.exitCode).toBe(0);
    expect(await logExists()).toBe(false);
  });

  test('appends across calls (multiple commands accumulate)', async () => {
    await run({ tool_name: 'Bash', tool_input: { command: 'echo a' }, tool_response: {} });
    await run({ tool_name: 'Bash', tool_input: { command: 'echo b' }, tool_response: {} });
    expect(await logLines()).toHaveLength(2);
  });

  // V6: Edit/Write/MultiEdit recorded to edits.jsonl so evidence is not command-only.
  const editsPath = () =>
    join(repo, '.ditto', 'local', 'work-items', wiId, 'evidence', 'edits.jsonl');
  async function editLines(): Promise<string[]> {
    const text = await readFile(editsPath(), 'utf8');
    return text.split('\n').filter((l) => l.trim().length > 0);
  }

  test.each(['Edit', 'Write', 'MultiEdit'])(
    'records a %s tool use to edits.jsonl (schema-valid), exit 0',
    async (tool) => {
      const out = await run({ tool_name: tool, tool_input: { file_path: 'src/x.ts' } });
      expect(out.exitCode).toBe(0);
      const lines = await editLines();
      expect(lines).toHaveLength(1);
      const entry = editLogEntry.parse(JSON.parse(lines[0] ?? '{}'));
      expect(entry.tool).toBe(tool as 'Edit' | 'Write' | 'MultiEdit');
      expect(entry.file_path).toBe('src/x.ts');
      expect(entry.work_item_id).toBe(wiId);
    },
  );

  test('a file-mutation tool without file_path records nothing', async () => {
    const out = await run({ tool_name: 'Edit', tool_input: {} });
    expect(out.exitCode).toBe(0);
    expect(await Bun.file(editsPath()).exists()).toBe(false);
  });
});
