import { resolve } from 'node:path';
import { collectModeReport, formatModeBanner } from '~/core/mode-doctor';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import { parseWorktreePath } from '~/core/worktree';
import type { HookHandler, HookInput } from './runtime';

/**
 * ac-2 (wi_260626zzx): when the session's real cwd is inside a per-work-item
 * worktree (`…/.ditto/local/worktrees/<wi>/…`), auto-bind the session pointer to
 * `<wi>` — so evidence/leases attribute to it without the user naming it. The
 * worktree is judged from `raw.cwd` (the actual cwd), NOT `input.repoRoot`, because
 * ac-1 has already rerouted `repoRoot` to the owning workspace `<ws>`, which is no
 * longer itself inside the worktree path. `repoRoot` is the MAIN workspace, so the
 * pointer (and the existence check) land in the main `.ditto/local` — the single
 * state source. A non-worktree session matches nothing and is never auto-bound
 * (no-auto-pick preserved). A phantom `<wi>` not present in the main work-item store
 * is skipped, so we never bind to a non-existent work item.
 */
async function maybeBindWorktreeSession(input: HookInput): Promise<void> {
  const raw = input.raw as { cwd?: unknown; session_id?: unknown } | null;
  const cwd = typeof raw?.cwd === 'string' ? raw.cwd : undefined;
  const sessionId = typeof raw?.session_id === 'string' ? raw.session_id : undefined;
  if (!cwd || !sessionId) return;
  const parsed = parseWorktreePath(resolve(cwd));
  if (parsed === null) return;
  const items = new WorkItemStore(input.repoRoot);
  if (!(await items.exists(parsed.workItemId))) return;
  await new SessionPointerStore(input.repoRoot).set(sessionId, parsed.workItemId);
}

/**
 * SessionStart guard (WI-A). At session open inside the ditto source repo, inject
 * a one-line banner naming which plugin this session loaded — so a plain session
 * on the stale installed plugin (your edits silently not taking effect) is caught
 * at the door, not mid-task. Advisory only: always exit 0, never blocks. Silent
 * outside the ditto repo (a normal project using npx ditto has nothing to warn).
 */
export const sessionStartHandler: HookHandler = async (input) => {
  await maybeBindWorktreeSession(input);
  const { report, inDittoRepo } = collectModeReport(input.repoRoot, { env: input.env });
  const banner = formatModeBanner(report, { inDittoRepo });
  if (!banner.text) return { exitCode: 0 };
  return {
    exitCode: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: banner.text },
    }),
  };
};
