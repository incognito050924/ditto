import { createHash } from 'node:crypto';

/**
 * Red-first guard. Proves a completion round earned its green honestly:
 *   (1) the completion-judging test was observed RED before it went green,
 *   (2) the loop did NOT self-author its own success test (maker≠checker), and
 *   (3) the frozen red test was neither deleted nor weakened between capture and
 *       completion — its content hash must still match the one frozen at capture.
 *
 * fail-closed: a round is ACCEPTED only when every condition holds; any doubt
 * (missing red run, self-authored test, deleted/altered frozen test) rejects.
 *
 * Pure/unit-testable: content is INJECTED, never read from disk here.
 */

/** SHA-256 hex of test content — the freeze taken at capture and re-derived at
 *  completion. A pure function over content; identical content ⇒ identical hash. */
export function hashTestContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface CompletionTestRecord {
  /** Provenance of the completion-judging test. Only 'external' is admissible;
   *  'loop' means the loop wrote its own success test → rejected. */
  author: 'external' | 'loop';
  /** Exit code of the FIRST (pre-implementation) run. Must be non-zero — a real
   *  RED. null means no red run was ever recorded. */
  redRunExitCode: number | null;
  /** Exit code of the post-implementation run. Green is exit 0. */
  greenRunExitCode: number | null;
}

export interface FrozenTest {
  /** hashTestContent(...) of the frozen test, taken at approval/capture. */
  capturedHash: string;
  /** Current on-disk content of the frozen test, injected (null = deleted). */
  currentContent: string | null;
}

export interface RedFirstInput {
  test: CompletionTestRecord;
  frozen: FrozenTest;
}

export interface RedFirstDecision {
  accepted: boolean;
  reasons: string[];
}

export function checkRedFirst(input: RedFirstInput): RedFirstDecision {
  const reasons: string[] = [];
  const { test, frozen } = input;

  // (2) A self-authored success test cannot certify itself.
  if (test.author !== 'external') {
    reasons.push(
      `completion test self-authored by the loop (author=${test.author}) — inadmissible`,
    );
  }

  // (1) Must have gone RED before green.
  if (test.redRunExitCode === null || test.redRunExitCode === 0) {
    reasons.push(
      `completion test never observed RED (redRunExitCode=${test.redRunExitCode}) — cannot prove red-before-green`,
    );
  }
  if (test.greenRunExitCode !== 0) {
    reasons.push(
      `completion test not green (greenRunExitCode=${test.greenRunExitCode}) — red-before-green incomplete`,
    );
  }

  // (3) The frozen red test must survive intact: no deletion, no weakening.
  if (frozen.currentContent === null) {
    reasons.push('frozen red test was deleted — rejected');
  } else if (hashTestContent(frozen.currentContent) !== frozen.capturedHash) {
    reasons.push(
      'frozen red test content changed (hash mismatch) — deletion/weakening rejected',
    );
  }

  return { accepted: reasons.length === 0, reasons };
}
