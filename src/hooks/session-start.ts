import { collectModeReport, formatModeBanner } from '~/core/mode-doctor';
import type { HookHandler } from './runtime';

/**
 * SessionStart guard (WI-A). At session open inside the ditto source repo, inject
 * a one-line banner naming which plugin this session loaded — so a plain session
 * on the stale installed plugin (your edits silently not taking effect) is caught
 * at the door, not mid-task. Advisory only: always exit 0, never blocks. Silent
 * outside the ditto repo (a normal project using npx ditto has nothing to warn).
 */
export const sessionStartHandler: HookHandler = (input) => {
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
