import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import { commandLogEntry } from '~/schemas/evidence-log';
import type { HookHandler, HookInput } from './runtime';

/**
 * PostToolUse evidence collection (M3.1). Observational only — records Bash tool
 * executions to the active work item's evidence/commands.jsonl. Never blocks
 * (always exit 0); a missing work item just means there is nothing to attach to.
 */

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
  if (raw.tool_name !== 'Bash') return { exitCode: 0 };

  const sessionId = typeof raw.session_id === 'string' ? raw.session_id : undefined;
  if (!sessionId) return { exitCode: 0 };

  const toolInput = (raw.tool_input ?? {}) as Record<string, unknown>;
  const command = typeof toolInput.command === 'string' ? toolInput.command : undefined;
  if (!command) return { exitCode: 0 };

  const pointer = await new SessionPointerStore(input.repoRoot).get(sessionId);
  if (!pointer) return { exitCode: 0 };

  const entry = commandLogEntry.parse({
    ts: new Date().toISOString(),
    kind: 'command',
    command,
    exit_code: exitCodeOf(raw.tool_response),
    work_item_id: pointer,
  });
  await new WorkItemStore(input.repoRoot).appendCommandLogLine(pointer, JSON.stringify(entry));

  return { exitCode: 0 };
};
