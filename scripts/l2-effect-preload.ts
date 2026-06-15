/**
 * L2 effect-interception PRELOAD (ADR-0018 D1/D4, wi_260615t8o) — loaded via
 * `bun test --preload` by the standing-code L2 differential (`l2-worktree-differential.ts`).
 * It patches a WHITELIST of patchable effect channels (the `Bun.spawn*` globals and
 * `node:child_process`) before the unit's characterization tests run, and appends an
 * ordered, path-NORMALIZED `(channel, args)` trace to the file named by
 * `DITTO_L2_TRACE_OUT`. Paths are normalized by replacing `DITTO_L2_NORM_ROOT` (the run's
 * cwd — a HEAD worktree for OLD, the repo root for NEW) with `<ROOT>` so the OLD and NEW
 * traces are comparable (the worktree abs path must not read as a divergence).
 *
 * Only globally/CJS-reachable channels are patchable; `node:fs` named imports bind the
 * function at import and are intentionally NOT traced — a unit that only uses them yields
 * an empty trace and is degraded by the differential (D5), never falsely passed.
 *
 * This file is NOT part of the shipped bundle; it is spawned as a preload only.
 */
import { appendFileSync } from 'node:fs';

const OUT = process.env.DITTO_L2_TRACE_OUT;
const NORM_ROOT = process.env.DITTO_L2_NORM_ROOT ?? '';

// No output target → do nothing (the preload is inert outside an L2 run).
if (OUT) {
  const normalize = (v: unknown): unknown => {
    if (typeof v === 'string') return NORM_ROOT ? v.split(NORM_ROOT).join('<ROOT>') : v;
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = normalize(val);
      return out;
    }
    return v;
  };

  const record = (channel: string, args: unknown[]): void => {
    try {
      appendFileSync(OUT, `${JSON.stringify({ channel, args: args.map(normalize) })}\n`);
    } catch {
      // a trace-write failure must never break the unit under test (best-effort).
    }
  };

  const patchMethod = (
    // biome-ignore lint/suspicious/noExplicitAny: patching arbitrary host objects
    obj: Record<string, any>,
    method: string,
    channel: string,
  ): void => {
    const original = obj[method];
    if (typeof original !== 'function') return;
    obj[method] = (...args: unknown[]) => {
      record(channel, args);
      return original.apply(obj, args);
    };
  };

  // Bun.spawn* globals — the dominant patchable effect surface in this repo.
  // biome-ignore lint/suspicious/noExplicitAny: Bun global is host-typed
  const bun = (globalThis as any).Bun;
  if (bun) {
    patchMethod(bun, 'spawnSync', 'Bun.spawnSync');
    patchMethod(bun, 'spawn', 'Bun.spawn');
  }

  // node:child_process via the CJS module object (require'd code is patchable; named
  // ESM imports are not — that gap is the D5 degrade, not a bug).
  try {
    const cp = require('node:child_process');
    for (const m of ['execFileSync', 'execSync', 'spawnSync', 'execFile', 'exec', 'spawn']) {
      patchMethod(cp, m, `child_process.${m}`);
    }
  } catch {
    // child_process unavailable — nothing to patch.
  }
}
