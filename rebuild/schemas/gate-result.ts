import { z } from 'zod';

export const gateDecision = z.enum(['pass', 'block']);

export type GateDecision = z.infer<typeof gateDecision>;

export const gateResult = z
  .object({
    decision: gateDecision,
    grounds: z.string().optional(),
  })
  .strict();

export type GateResult = z.infer<typeof gateResult>;

/**
 * Invariant 3: fail-closed. Only an explicit pass outcome backed by non-empty
 * grounds opens the gate; uncertainty, undecidability, missing grounds, or a
 * fail outcome all block.
 */
export function decideGate(signal: {
  outcome?: 'pass' | 'fail';
  grounds?: string;
}): GateResult {
  if (
    signal.outcome === 'pass' &&
    signal.grounds &&
    signal.grounds.trim().length > 0
  ) {
    return { decision: 'pass', grounds: signal.grounds };
  }
  return { decision: 'block' };
}
