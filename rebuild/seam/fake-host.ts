import type { z } from 'zod';
import { decideGate, type GateResult } from '../schemas';
import {
  boundaryEnvelope,
  type AgentText,
  type BoundaryEnvelope,
  type DriveStepInput,
  type DriveStepOutput,
  type FanoutTask,
  type HostAdapter,
} from './host-adapter';

interface FakeHostScript {
  boundaries?: BoundaryEnvelope[];
  fanoutReturns?: string[];
  sidecars?: Record<string, string>; // path → raw JSON text
}

// A subagent's final message is opaque free text; this is the only place a plain
// string crosses into the sealed type, and it never becomes queue truth.
const seal = (s: string): AgentText => s as AgentText;

/**
 * In-memory HostAdapter for unit-testing the thin core without a live model.
 * Fully deterministic: an internal call counter drives session ids and
 * scripted-boundary selection — no wall clock, no randomness.
 */
export class FakeHost implements HostAdapter {
  private counter = 0;

  constructor(private readonly script: FakeHostScript = {}) {}

  // Fresh-context drive step; reuses --resume session id when given.
  driveStep(input: DriveStepInput): Promise<DriveStepOutput> {
    const boundaries = this.script.boundaries ?? [];
    const boundary = boundaries[this.counter];
    if (boundary === undefined) {
      throw new Error('FakeHost: no scripted boundary for this driveStep call');
    }
    this.counter += 1;
    const sessionId = input.resume ?? `sess-${this.counter}`;
    // Re-validate at the boundary; the queue oracle is only ever schema-valid.
    return Promise.resolve({
      sessionId,
      boundary: boundaryEnvelope.parse(boundary),
    });
  }

  // Per-turn completion gate — same fail-closed rule as any real adapter.
  stopGate(signal: { outcome?: 'pass' | 'fail'; grounds?: string }): GateResult {
    return decideGate(signal);
  }

  // Parallel isolated subagent fanout; returns opaque free text only.
  fanout(tasks: readonly FanoutTask[]): Promise<AgentText[]> {
    const raw =
      this.script.fanoutReturns ??
      tasks.map((task) => `fanout:${task.agentType}`);
    return Promise.resolve(raw.map(seal));
  }

  // Read an agent-written JSON sidecar and validate it fail-closed.
  readSidecar<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const raw = this.script.sidecars?.[path];
    if (raw === undefined) {
      throw new Error(`FakeHost: no scripted sidecar at ${path}`);
    }
    return Promise.resolve(schema.parse(JSON.parse(raw)));
  }
}
