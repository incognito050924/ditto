import { z } from 'zod';
import { gateResult, queueItem, type GateResult } from '../schemas';

// Structured boundary output = the queue oracle. The ONLY place the drive loop
// reads the disposition queue from. Produced by the CLI `--json-schema` forced
// structured_output, so it is schema-validated at the harness boundary.
export const boundaryEnvelope = z
  .object({
    queue: z.array(queueItem),
    gate: gateResult.optional(),
  })
  .strict();
export type BoundaryEnvelope = z.infer<typeof boundaryEnvelope>;

// Subagent free text is OPAQUE — nominally sealed so it can never be used as the
// queue oracle. A subagent's final message may only inform logs or trigger a
// sidecar read; it is not structured queue truth.
export type AgentText = string & { readonly __opaque: 'subagent-free-text' };

export interface DriveStepInput {
  prompt: string;
  resume?: string; // session id to --resume; absent = fresh-context session
}
export interface DriveStepOutput {
  sessionId: string; // captured from --output-format json, for the next --resume
  boundary: BoundaryEnvelope; // already validated; queue oracle comes only from here
}

export interface FanoutTask {
  agentType: string;
  prompt: string;
}

// The single host seam. Core depends only on this interface, never on harness
// APIs directly — so the core is unit-testable with no live model.
export interface HostAdapter {
  // Fresh-context CLI drive step; captures/reuses the session id.
  driveStep(input: DriveStepInput): Promise<DriveStepOutput>;
  // Per-turn completion gate: evidence outcome in → fail-closed block/pass.
  stopGate(signal: { outcome?: 'pass' | 'fail'; grounds?: string }): GateResult;
  // Parallel isolated subagent fanout; returns opaque free text only.
  fanout(tasks: readonly FanoutTask[]): Promise<AgentText[]>;
  // Read an agent-written JSON sidecar file and validate it fail-closed.
  readSidecar<T>(path: string, schema: z.ZodType<T>): Promise<T>;
}

// Sample thin-core predicate proving the seam is testable without a live model.
// Completion-as-fixpoint: the queue is drained only when every item has taken
// one of its exit doors. The full drive loop is out of scope here.
export function isQueueDrained(env: BoundaryEnvelope): boolean {
  return env.queue.every((item) => item.exit !== undefined);
}
