/**
 * L2 effect-interception core (ADR-0018, wi_260615t8o) — the runtime mechanism that lets
 * the L2 trace differential witness UNMODIFIED side-effecting code. `l2-differential.ts`'s
 * trace mode requires the target to route effects through an injected `EffectRecorder`;
 * standing code does not. This module instead patches a WHITELIST of effect channels
 * (object + method) at runtime, records the ordered (channel, args) trace of calls that
 * pass through while a function runs, then ALWAYS restores the originals.
 *
 * This is runtime instrumentation, NOT static analysis — it uses no TS compiler / AST, so
 * it does not conflict with ADR-0006 (which forbids TS-AST-coupled tooling). Determinism
 * limits (time/random/concurrency) are handled by the differential layer, not here: this
 * core only captures what the whitelisted channels saw.
 *
 * APPLICABILITY BOUNDARY (ADR-0018 §정직한 한계): interception patches a method ON A
 * MUTABLE OBJECT reached at call time. It therefore observes effects routed through a
 * patchable reference (a CJS-`require`d module object, a passed-in handle, a service
 * object) — NOT effects bound at import (`import { readFileSync } from 'node:fs'` captures
 * the function directly; a frozen `import * as fs` namespace is read-only and cannot be
 * patched at all). Code whose effects aren't reachable via a patched channel produces an
 * incomplete trace; the L2 layer treats that as un-witnessed → degraded (diff-only), never
 * a false refute (ac-3). The win is for code that takes its effect deps as objects.
 */

/** One recorded effect: which channel, and the args it was called with (shallow-copied). */
export interface EffectCall {
  channel: string;
  args: unknown[];
}

/** A patchable effect channel: a method on an object, plus a stable label for the trace. */
export interface EffectChannel {
  // biome-ignore lint/suspicious/noExplicitAny: a channel is any object exposing a method to patch
  obj: Record<string, any>;
  method: string;
  /** Stable label recorded in the trace (e.g. 'fs.readFileSync'). */
  name: string;
}

export interface InterceptResult {
  /** Ordered effect calls observed on the whitelisted channels. */
  trace: EffectCall[];
  /** The function's return value (absent when it threw). */
  returned?: unknown;
  /** Set when the function threw (the original effects still ran up to that point). */
  threw?: { message: string };
}

/**
 * Patch each channel to record its calls, run `fn`, and restore every channel afterward
 * (even if `fn` throws). Interception is transparent: the original method still runs, so
 * behavior is unchanged — we only observe. Returns the ordered trace plus the fn outcome.
 */
export function interceptEffects(channels: EffectChannel[], fn: () => unknown): InterceptResult {
  const trace: EffectCall[] = [];
  const restores: Array<() => void> = [];

  for (const ch of channels) {
    const original = ch.obj[ch.method] as (...a: unknown[]) => unknown;
    restores.push(() => {
      ch.obj[ch.method] = original;
    });
    ch.obj[ch.method] = (...args: unknown[]) => {
      trace.push({ channel: ch.name, args: [...args] });
      return original.apply(ch.obj, args);
    };
  }

  try {
    const returned = fn();
    return { trace, returned };
  } catch (err) {
    return { trace, threw: { message: err instanceof Error ? err.message : String(err) } };
  } finally {
    for (const restore of restores) restore();
  }
}

/** Verdict of comparing an OLD-vs-NEW effect trace. */
export interface TraceDiff {
  /** True when the traces differ — behavior was NOT preserved (a confirmed regression). */
  refuted: boolean;
  /** Index of the first call that diverged (or where one trace ran out). */
  firstDivergence?: number;
  reason?: string;
}

/** Stable, comparison-safe rendering of one effect call (channel + serialized args). */
function callKey(c: EffectCall): string {
  let args: string;
  try {
    args = JSON.stringify(c.args) ?? String(c.args);
  } catch {
    args = String(c.args);
  }
  return `${c.channel}(${args})`;
}

/**
 * Compare an OLD and NEW effect trace (pure). Behavior is preserved iff the two traces are
 * identical in order, channel, and args. The first divergent index (or the point where one
 * trace is longer) is reported. A non-refuted result is "unrefuted" (regression not
 * detected), NOT proof of equivalence — nondeterminism handling lives in the L2 layer.
 */
export function compareTraces(oldTrace: EffectCall[], newTrace: EffectCall[]): TraceDiff {
  const n = Math.max(oldTrace.length, newTrace.length);
  for (let i = 0; i < n; i++) {
    const a = oldTrace[i];
    const b = newTrace[i];
    if (a === undefined || b === undefined) {
      return {
        refuted: true,
        firstDivergence: i,
        reason: `effect count differs (old=${oldTrace.length}, new=${newTrace.length})`,
      };
    }
    if (callKey(a) !== callKey(b)) {
      return {
        refuted: true,
        firstDivergence: i,
        reason: `effect #${i} differs: old=${callKey(a)} new=${callKey(b)}`,
      };
    }
  }
  return { refuted: false };
}
