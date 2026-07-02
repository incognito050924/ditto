import type { BrowserProbe } from './browser';
import { type GeneratedHeaderInput, renderGeneratedHeader } from './journey-digest';

/**
 * E2E generator fallback branch (wi_2607026qs, Contract 9 · ADR-0018 graceful
 * degrade).
 *
 * When the official Playwright generator is unusable (no live browser / agents
 * not installed) the pipeline must NOT crash, auto-install, or fabricate a pass.
 * Instead it degrades: it routes the SAME `specs/<slug>.plan.md` markdown to an
 * e2e-scripter-style conversion (single conversion authority = the plan, never a
 * re-interpretation of the raw DSL) and produces a fallback spec scaffold.
 *
 * The real e2e-scripter is an AGENT — it is not callable from this process — so
 * the live conversion + the browser-evidence ACs (ac-3, ac-5) are owned by the
 * N-generator/runtime orchestration. This module owns ONLY the deterministic,
 * in-process part of the fallback branch:
 *  - the routing decision given an injected availability probe (browser present
 *    → signal "use primary"; absent → degrade),
 *  - the durable scaffold: the plan embedded as the conversion authority plus a
 *    DURABLE `@ditto-unverified fallback:e2e-scripter …` header marker so a later
 *    reader can never mistake a guessed fallback spec for a live-verified one,
 *  - a structured verdict naming the ACs that stay unverified + a loud warning.
 */

/** The durable header marker that brands a spec as an unverified fallback. */
export const FALLBACK_UNVERIFIED_MARKER =
  '@ditto-unverified fallback:e2e-scripter (no live browser at generation)';

/** ACs whose evidence is a live browser run — unverifiable on the fallback path. */
export const BROWSER_EVIDENCE_ACS = ['ac-3', 'ac-5'] as const;

export interface FallbackInput {
  /** Availability probe (injected by N-generator, e.g. from `probePlaywright`). */
  probe: Pick<BrowserProbe, 'available' | 'reason'>;
  /** The official Playwright plan markdown — the single conversion authority. */
  plan: string;
  /** Provenance header input (same shape the primary post-pass uses). */
  header: GeneratedHeaderInput;
  /** Repo-relative path the fallback spec is written to (e2e/generated/<slug>.spec.ts). */
  specPath: string;
  /** Repo-relative path of the plan the scaffold is derived from (specs/<slug>.plan.md). */
  planPath: string;
}

export interface FallbackResult {
  /** true → the fallback branch produced a scaffold; false → caller uses primary. */
  used_fallback: boolean;
  /** Human-readable routing reason (carries the probe reason on degrade). */
  reason: string;
  /** Browser-evidence ACs that remain UNVERIFIED (empty on the use-primary path). */
  unverified_acs: string[];
  /** The durable fallback spec scaffold (only when used_fallback). */
  spec?: string;
  /** Where the scaffold should be written (echoed only when used_fallback). */
  specPath?: string;
  /** Loud unverified warning for the caller to surface (only when used_fallback). */
  warn?: string;
}

/** Insert the durable @ditto-unverified marker inside the provenance block. */
function stampUnverified(baseHeader: string): string {
  const marker = ` * ${FALLBACK_UNVERIFIED_MARKER}`;
  const lines = baseHeader.split('\n');
  const closeIdx = lines.lastIndexOf(' */');
  // Live above the closing fence so the marker sits in the same block a reader
  // already trusts. The else keeps the safety marker even if the reused header
  // helper's shape ever changes — it must never be silently dropped.
  if (closeIdx >= 0) lines.splice(closeIdx, 0, marker);
  else lines.push(marker);
  return lines.join('\n');
}

/** Embed the plan as line comments so it travels with the scaffold verbatim. */
function planAsComment(plan: string): string {
  return plan
    .split('\n')
    .map((l) => (l.length > 0 ? `// ${l}` : '//'))
    .join('\n');
}

function renderFallbackSpec(input: FallbackInput): string {
  const header = stampUnverified(renderGeneratedHeader(input.header));
  const title = `${input.header.id} — awaiting live e2e-scripter conversion (no browser at generation)`;
  return [
    header,
    "import { test } from '@playwright/test';",
    '',
    '// FALLBACK SCAFFOLD (ADR-0018 graceful degrade): produced WITHOUT a live',
    '// browser because the official Playwright generator was unusable. The single',
    '// conversion authority is the plan embedded below — a live e2e-scripter run',
    '// over this SAME plan must replace this scaffold. Until then ac-3 + ac-5',
    '// (browser evidence) are UNVERIFIED; nothing here asserts an observed pass.',
    `// Plan source: ${input.planPath}`,
    '//',
    '// ---- BEGIN PLAN ----',
    planAsComment(input.plan),
    '// ---- END PLAN ----',
    '',
    `test.fixme(${JSON.stringify(title)}, async () => {`,
    '  // Intentionally unimplemented: synthesising assertions here would fabricate',
    '  // a pass the fallback never observed. Skipped until a live run generates it.',
    '});',
    '',
  ].join('\n');
}

/**
 * Given an availability probe, either signal "use the primary generator" (browser
 * present) or degrade to the fallback scaffold. Total over its typed inputs — it
 * never crashes, auto-installs, or fabricates a pass (Contract 9 / ADR-0018).
 */
export function generateFallbackSpec(input: FallbackInput): FallbackResult {
  if (input.probe.available) {
    return {
      used_fallback: false,
      reason: 'browser available — route to the primary official generator, not the fallback',
      unverified_acs: [],
    };
  }
  return {
    used_fallback: true,
    reason: `official generator unusable (${input.probe.reason}) — degraded to the e2e-scripter fallback over the plan; no live browser at generation`,
    unverified_acs: [...BROWSER_EVIDENCE_ACS],
    spec: renderFallbackSpec(input),
    specPath: input.specPath,
    warn: `UNVERIFIED FALLBACK SPEC: ${input.specPath} was scaffolded from ${input.planPath} without a live browser (ADR-0018 degrade). It is stamped @ditto-unverified; ac-3 + ac-5 (browser evidence) remain UNVERIFIED and MUST NOT be reported as passing until a live e2e-scripter run replaces it.`,
  };
}

// Marker must START a line (modulo comment decoration) — a mid-line mention in
// prose or a string literal does not brand a file as an unverified fallback.
// Mirrors the `@ditto-generated` detector convention in journey-digest.ts.
const fallbackMarker = /^\s*(?:\/\/|\/?\*+)?\s*@ditto-unverified\s+fallback:e2e-scripter\b/m;

/** Whether a spec is a DURABLE unverified fallback (Contract 9 D2 detector). */
export function isFallbackUnverified(content: string): boolean {
  return fallbackMarker.test(content);
}
