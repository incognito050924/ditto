import { AutopilotStore } from '~/core/autopilot-store';
import { HandoffStore, buildHandoff } from '~/core/handoff-store';
import { SessionPointerStore } from '~/core/session-pointer';
import { WorkItemStore } from '~/core/work-item-store';
import type { HookHandler, HookInput } from './runtime';

/**
 * PreCompact handler (M4.2). Before context is compacted, persist a handoff
 * artifact for the active work item so intent/state/evidence survive the
 * compaction. Observational — never blocks (exit 0); fail-open on any error.
 *
 * §6.10 autopilot continuity: when an autopilot graph exists for the active
 * work item, its `autopilot_id` is propagated into the handoff so the next
 * session resumes the SAME orchestration cycle instead of starting a fresh one.
 */
export const preCompactHandler: HookHandler = async (input: HookInput) => {
  const raw = (input.raw ?? {}) as Record<string, unknown>;
  const sessionId = typeof raw.session_id === 'string' ? raw.session_id : undefined;
  if (!sessionId) return { exitCode: 0 };

  const pointer = await new SessionPointerStore(input.repoRoot).get(sessionId);
  if (!pointer) return { exitCode: 0 };

  const items = new WorkItemStore(input.repoRoot);
  if (!(await items.exists(pointer))) return { exitCode: 0 };
  const workItem = await items.get(pointer);

  // Read autopilot_id (best-effort; malformed autopilot.json must not break
  // PreCompact — fail-open per §M4.2 observational rule).
  let autopilotId: string | undefined;
  try {
    const pilots = new AutopilotStore(input.repoRoot);
    if (await pilots.exists(pointer)) {
      autopilotId = (await pilots.get(pointer)).autopilot_id;
    }
  } catch {
    // malformed autopilot.json → omit from handoff
  }

  const trigger = typeof raw.trigger === 'string' ? raw.trigger : 'auto';
  const handoff = buildHandoff({
    workItem,
    ...(autopilotId ? { autopilotId } : {}),
    fromContext: `claude-code session ${sessionId} at PreCompact (${trigger})`,
    currentState: `work item status=${workItem.status} at compaction`,
    nextFirstCheck: 'Re-read the work item and its acceptance criteria, then resume the open node.',
    ...(workItem.re_entry?.command ? { openThreads: [workItem.re_entry.command] } : {}),
  });
  await new HandoffStore(input.repoRoot).write(handoff);

  return { exitCode: 0 };
};
