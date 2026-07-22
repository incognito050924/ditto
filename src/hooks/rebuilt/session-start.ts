import { resolve } from 'node:path';
import { collectModeReport, formatModeBanner } from '~/core/mode-doctor';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import { parseWorktreePath } from '~/core/worktree';
import type { HookHandler, HookInput } from '../runtime';

/**
 * SessionStart hook — rebuilt thin shell (increment 3). Advisory only: always
 * exit 0, never blocks. Two jobs, both preserved from the pinned behavior:
 *  1. worktree auto-bind: a session whose real cwd sits inside a per-work-item
 *     worktree (`…/.ditto/local/worktrees/<wi>/…`) binds its session pointer to
 *     `<wi>` in the MAIN workspace store; a phantom `<wi>` surfaces an advisory
 *     instead of silently binding. Non-worktree sessions are never auto-bound
 *     (no-auto-pick).
 *  2. mode banner: inside the ditto source repo, name which plugin copy this
 *     session loaded so a stale installed plugin is caught at the door.
 */
async function maybeBindWorktreeSession(input: HookInput): Promise<string | undefined> {
  const raw = input.raw as { cwd?: unknown; session_id?: unknown } | null;
  const cwd = typeof raw?.cwd === 'string' ? raw.cwd : undefined;
  const sessionId = typeof raw?.session_id === 'string' ? raw.session_id : undefined;
  if (!cwd || !sessionId) return undefined;
  const parsed = parseWorktreePath(resolve(cwd));
  if (parsed === null) return undefined; // non-worktree cwd: silent, never auto-bound
  const items = new WorkItemStore(input.repoRoot);
  if (!(await items.exists(parsed.workItemId))) {
    return `worktree 경로 같으나 work item(${parsed.workItemId}) 바인딩 못 함 — 수동 확인 필요`;
  }
  await new SessionPointerStore(input.repoRoot).set(sessionId, parsed.workItemId);
  return undefined; // bound successfully: silent
}

export const sessionStartHandler: HookHandler = async (input) => {
  const bindAdvisory = await maybeBindWorktreeSession(input);
  const { report, inDittoRepo } = collectModeReport(input.repoRoot, { env: input.env });
  const banner = formatModeBanner(report, { inDittoRepo });
  const text = [bindAdvisory, banner.text].filter(Boolean).join('\n');
  if (!text) return { exitCode: 0 };
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
    }),
  };
};
