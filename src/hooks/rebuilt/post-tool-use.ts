import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import { commandLogEntry, editLogEntry } from '~/schemas/evidence-log';
import { mutatedPaths } from '../envelope';
import type { HookHandler, HookInput } from '../runtime';

/**
 * PostToolUse hook — rebuilt thin shell (increment 3). Observational only —
 * records Bash executions to evidence/commands.jsonl and file-mutation tool use
 * (Edit / Write / MultiEdit; Codex apply_patch per mutated path) to
 * evidence/edits.jsonl. Never blocks (always exit 0); a missing work item just
 * means there is nothing to attach to. State-file contracts unchanged.
 */

const FILE_MUTATION_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

/** Best-effort exit code from a Bash tool_response across shapes. */
function exitCodeOf(response: unknown): number {
  if (typeof response !== 'object' || response === null) return 0;
  const r = response as Record<string, unknown>;
  if (typeof r.exit_code === 'number') return r.exit_code;
  if (typeof r.exitCode === 'number') return r.exitCode;
  if (r.is_error === true || r.error != null || r.interrupted === true) return 1;
  return 0;
}

export const postToolUseHandler: HookHandler = async (input: HookInput) => {
  const raw = (input.raw ?? {}) as Record<string, unknown>;
  const toolName = typeof raw.tool_name === 'string' ? raw.tool_name : undefined;
  const isCodexPatch = input.host === 'codex' && toolName === 'apply_patch';
  if (toolName !== 'Bash' && !FILE_MUTATION_TOOLS.has(toolName ?? '') && !isCodexPatch)
    return { exitCode: 0 };

  const sessionId = typeof raw.session_id === 'string' ? raw.session_id : undefined;
  if (!sessionId) return { exitCode: 0 };

  const pointer = await new SessionPointerStore(input.repoRoot).get(sessionId);
  if (!pointer) return { exitCode: 0 };

  const toolInput = (raw.tool_input ?? {}) as Record<string, unknown>;
  const store = new WorkItemStore(input.repoRoot);

  if (toolName === 'Bash') {
    const command = typeof toolInput.command === 'string' ? toolInput.command : undefined;
    if (!command) return { exitCode: 0 };
    const entry = commandLogEntry.parse({
      ts: new Date().toISOString(),
      kind: 'command',
      command,
      exit_code: exitCodeOf(raw.tool_response),
      work_item_id: pointer,
    });
    await store.appendCommandLogLine(pointer, JSON.stringify(entry));
    return { exitCode: 0 };
  }

  // Codex apply_patch: record EVERY mutated path (tool recorded as 'Edit', the
  // closest host-neutral enum value).
  if (isCodexPatch) {
    for (const path of mutatedPaths('codex', raw)) {
      const entry = editLogEntry.parse({
        ts: new Date().toISOString(),
        kind: 'edit',
        tool: 'Edit',
        file_path: path,
        work_item_id: pointer,
      });
      await store.appendEditLogLine(pointer, JSON.stringify(entry));
    }
    return { exitCode: 0 };
  }

  // File-mutation tools: record which file was touched by which tool.
  const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : undefined;
  if (!filePath) return { exitCode: 0 };
  const entry = editLogEntry.parse({
    ts: new Date().toISOString(),
    kind: 'edit',
    tool: toolName as 'Edit' | 'Write' | 'MultiEdit',
    file_path: filePath,
    work_item_id: pointer,
  });
  await store.appendEditLogLine(pointer, JSON.stringify(entry));
  return { exitCode: 0 };
};
