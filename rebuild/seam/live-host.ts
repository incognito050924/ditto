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

// Injected I/O boundary — the ONLY place real process/disk I/O happens. Keeping
// the crossings behind this seam lets LiveHost's validation/sealing logic be
// unit-tested with a fake, exactly like CodexDeps does for codexCrossCheck.
export interface HostDeps {
  runDrive(input: DriveStepInput): { sessionId: string; boundaryJson: string };
  runFanout(tasks: readonly FanoutTask[]): string[]; // raw free-text per agent
  readFile(path: string): string;
}

// A subagent's final message is opaque free text; this is the only place a plain
// string crosses into the sealed type (mirrors FakeHost's `seal`), and it never
// becomes queue truth.
const seal = (s: string): AgentText => s as AgentText;

/**
 * Live HostAdapter: carries the validation/sealing logic, delegating every real
 * process/disk crossing to an injected HostDeps. The structured boundary is the
 * ONLY queue oracle, so it is schema-validated fail-closed on any drift.
 */
export class LiveHost implements HostAdapter {
  constructor(private readonly deps: HostDeps) {}

  // Fresh-context CLI drive step; the structured boundary is the queue oracle.
  async driveStep(input: DriveStepInput): Promise<DriveStepOutput> {
    const { sessionId, boundaryJson } = this.deps.runDrive(input);
    // Validate at the boundary → fail-closed on schema drift (rejects).
    const boundary: BoundaryEnvelope = boundaryEnvelope.parse(
      JSON.parse(boundaryJson),
    );
    return { sessionId, boundary };
  }

  // Per-turn completion gate — same fail-closed rule as any adapter.
  stopGate(signal: { outcome?: 'pass' | 'fail'; grounds?: string }): GateResult {
    return decideGate(signal);
  }

  // Parallel isolated subagent fanout; returns opaque free text only.
  async fanout(tasks: readonly FanoutTask[]): Promise<AgentText[]> {
    return this.deps.runFanout(tasks).map(seal);
  }

  // Read an agent-written JSON sidecar and validate it fail-closed (rejects).
  async readSidecar<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return schema.parse(JSON.parse(this.deps.readFile(path)));
  }
}

/**
 * Live HostDeps backed by the real Claude Code CLI. `readFile` is the real
 * `readFileSync`. The exact headless CLI flags for a fresh-context drive step
 * and subagent fanout cannot be verified in this environment, so those two
 * crossings throw a clear "not wired" error rather than fabricating arg strings;
 * the live-CLI smoke test is deferred to an integration environment.
 */
export const liveHostDeps: HostDeps = {
  runDrive: () => {
    throw new Error('live-CLI integration not wired in this environment');
  },
  runFanout: () => {
    throw new Error('live-CLI integration not wired in this environment');
  },
  readFile: (path) => require('node:fs').readFileSync(path, 'utf8'),
};
