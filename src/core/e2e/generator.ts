import { join } from 'node:path';
import { localDir } from '../ditto-paths';
import { spawnProviderProcess } from '../hosts/spawn';
import { type BrowserProbe, probePlaywright } from './browser';
import { BROWSER_EVIDENCE_ACS, generateFallbackSpec } from './generator-fallback';
import {
  type E2eAgentsRecord,
  type E2eHost,
  PLAYWRIGHT_MIN_VERSION,
  type PlaywrightVersion,
  detectVersionSkew,
  gatePlaywrightVersion,
  readE2eAgentsRecord,
} from './init-agents';
import type { GeneratedHeaderInput } from './journey-digest';
import type { PlanAssertionMap, PlanStepMap } from './plan-adapter';
import { injectDittoMarkers } from './spec-postpass';

/**
 * E2E generator orchestration (wi_2607026qs ac-3, Contract 9 · N-generator note).
 *
 * `probeGenerator` decides whether the OFFICIAL Playwright test-generator is
 * usable and `runGenerator` routes accordingly:
 *  - usable  → drive the official generator over the LIVE browser from the plan
 *    (a runtime seam), then post-pass the raw spec into a traceable @ditto/@step
 *    spec (Contract 3). The init-agents + plan-format contract is asserted by the
 *    probe BEFORE the drive — a stale/absent agent record fails the probe and
 *    routes to degrade instead of emitting a non-conformant spec.
 *  - unusable → degrade to the e2e-scripter fallback over the SAME plan
 *    (Contract 9 · ADR-0018): a durable @ditto-unverified spec, the browser-
 *    evidence ACs (ac-3, ac-5) reported unverified, never a crash / auto-install
 *    / fabricated pass.
 *
 * Every real effect (browser probe, `playwright --version`, the e2e-agents
 * record, the MCP probe, and the live drive itself) sits behind an INJECTABLE
 * SEAM so the unit tests need no real browser/Playwright. The live drive over a
 * real app (the true ac-3/ac-5 evidence) is exercised by N-demonstrate, not here.
 */

export interface GeneratorAvailability {
  /** true only when EVERY check passes — any false routes to degrade. */
  usable: boolean;
  /** Human-readable verdict; on failure it names each failing check. */
  reason: string;
  checks: {
    /** A live browser is present (probePlaywright.available). */
    browser: boolean;
    /** Playwright is present and >= PLAYWRIGHT_MIN_VERSION (1.61). */
    playwrightVersionOk: boolean;
    /** e2e-agents.json present AND its plan_format matches (no skew). */
    agentsInstalled: boolean;
    /** The playwright-test MCP server is reachable (best-effort). */
    mcpAvailable: boolean;
  };
}

export interface GeneratorSeams {
  /** Live browser probe (default: probePlaywright). */
  probeBrowser?: (repoRoot: string) => Promise<BrowserProbe>;
  /** `playwright --version` output, or null when absent (default: real spawn). */
  readPlaywrightVersion?: (repoRoot: string) => Promise<string | null>;
  /** The installed e2e-agents record, or null (default: read .ditto/local/e2e-agents.json). */
  readAgentsRecord?: (repoRoot: string) => Promise<E2eAgentsRecord | null>;
  /** Best-effort MCP availability probe (default: optimistic true — see note). */
  probeMcp?: (repoRoot: string, host: E2eHost) => Promise<boolean>;
}

export interface RunGeneratorInput {
  repoRoot: string;
  host: E2eHost;
  /** Journey id — the owner prefix of every injected `// @step` marker. */
  journeyId: string;
  /** The official Playwright plan markdown (from projectJourneyToPlan). */
  plan: string;
  /** Plan sidecar join: scenario → case → plan-step-N → DSL step id. */
  planMap: PlanStepMap;
  /**
   * Parallel assertion channel: scenario → case → ordered `확인:` step ids (from
   * projectJourneyToPlan). Forwarded to the post-pass so each generated
   * `expect(...)` line gets its `확인:` @step marker — without this, assertion step
   * ids are non-conformant at runtime. Optional: a plan with no `확인:` steps omits it.
   */
  planAssertions?: PlanAssertionMap;
  /** The journey DSL text — post-pass marker source + digest input. */
  dslOriginal: string;
  /** Provenance header input for the generated/fallback spec. */
  header: GeneratedHeaderInput;
  /** Repo-relative path the spec is written to (e2e/generated/<slug>.spec.ts). */
  specPath: string;
  /** Repo-relative path of the plan the fallback scaffold references. */
  planPath: string;
}

export interface RunGeneratorSeams extends GeneratorSeams {
  /**
   * Drive the official playwright-test-generator over the LIVE browser from the
   * plan, returning the raw spec (plain `// N.` comments, no header). This is the
   * real MCP/browser drive — supplied at runtime, mocked in unit tests, and
   * exercised for real (ac-3/ac-5) by N-demonstrate.
   */
  driveOfficialGenerator: (input: {
    plan: string;
    planMap: PlanStepMap;
    repoRoot: string;
    host: E2eHost;
  }) => Promise<string>;
}

export interface GeneratorResult {
  /** The final spec: post-passed @ditto-generated (primary) OR @ditto-unverified fallback. */
  spec: string;
  /** true → degraded to the fallback; false → drove the official generator. */
  used_fallback: boolean;
  /** The availability verdict that decided the route. */
  availability: GeneratorAvailability;
  /** Browser-evidence ACs that stay UNVERIFIED (empty on the primary path). */
  unverified_acs: string[];
  /** Routing reason (primary rationale or the fallback's degrade reason). */
  reason: string;
  /** Where the spec should be written. */
  specPath: string;
  /** How many `// @step` markers were injected (primary path only). */
  injected?: number;
  /** Journey step refs that got no marker — caller fails loud (primary path only). */
  unmatched?: string[];
  /** Loud unverified warning to surface (fallback path only). */
  warn?: string;
}

/** Whether a parsed Playwright version meets the primary-path floor (>= 1.61). */
function meetsMinVersion(v: PlaywrightVersion | null): boolean {
  if (!v) return false;
  const min = PLAYWRIGHT_MIN_VERSION;
  if (v.major !== min.major) return v.major > min.major;
  if (v.minor !== min.minor) return v.minor > min.minor;
  return v.patch >= min.patch;
}

/**
 * Default `playwright --version` reader: spawn `bunx --no-install playwright
 * --version` and return its stdout. Never auto-installs (ADR-0018) and never
 * throws — a spawn/read failure yields null so the version check degrades.
 */
async function defaultReadPlaywrightVersion(repoRoot: string): Promise<string | null> {
  try {
    const proc = spawnProviderProcess({
      binary: 'bunx',
      args: ['--no-install', 'playwright', '--version'],
      repoRoot,
      cwd: '.',
      env: { set: {}, unset: [] },
    });
    const [completion, out] = await Promise.all([
      proc.completion,
      new Response(proc.stdout).text().catch(() => ''),
    ]);
    if (completion.exit_code !== 0) return null;
    return out.trim() || null;
  } catch {
    return null;
  }
}

/** Run an async seam, mapping any rejection to `onError` so probing never throws. */
async function safe<T>(fn: () => Promise<T>, onError: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return onError;
  }
}

/**
 * Probe whether the official Playwright test-generator is usable. usable = live
 * browser AND Playwright >= 1.61 AND agents installed (record present + plan
 * format matches) AND MCP available. ANY false → not usable (route to degrade).
 * Total over its inputs: a rejecting seam counts as a failed check, never a throw.
 */
export async function probeGenerator(
  repoRoot: string,
  host: E2eHost,
  seams: GeneratorSeams = {},
): Promise<GeneratorAvailability> {
  const probeBrowser = seams.probeBrowser ?? probePlaywright;
  const readVersion = seams.readPlaywrightVersion ?? defaultReadPlaywrightVersion;
  const readAgents =
    seams.readAgentsRecord ??
    ((root: string) => readE2eAgentsRecord(join(localDir(root), 'e2e-agents.json')));
  // best-effort MCP probe (unground): install-time (Contract 8) merges the
  // playwright-test server into .mcp.json, so at run time we optimistically
  // assume it is reachable and let the live drive surface a real MCP failure.
  const probeMcp = seams.probeMcp ?? (async () => true);

  const probe = await safe(() => probeBrowser(repoRoot), {
    available: false,
    reason: 'browser probe failed',
  } as BrowserProbe);
  const browser = probe.available;

  const versionOutput = await safe(() => readVersion(repoRoot), null);
  const gate = gatePlaywrightVersion(host, versionOutput);
  const playwrightVersionOk = meetsMinVersion(gate.version);

  const record = await safe(() => readAgents(repoRoot), null);
  const skew = record ? detectVersionSkew(record) : null;
  const agentsInstalled = record !== null && skew !== null && !skew.skew;

  const mcpAvailable = await safe(() => probeMcp(repoRoot, host), false);

  const checks = { browser, playwrightVersionOk, agentsInstalled, mcpAvailable };
  const usable = browser && playwrightVersionOk && agentsInstalled && mcpAvailable;

  if (usable) {
    return {
      usable: true,
      reason: `official generator usable: live browser + Playwright ${gate.version?.raw ?? '?'} (>= ${PLAYWRIGHT_MIN_VERSION.raw}) + agents installed + MCP available`,
      checks,
    };
  }

  const details: string[] = [];
  if (!browser) details.push(`browser unavailable: ${probe.reason}`);
  if (!playwrightVersionOk) {
    details.push(
      `Playwright version below required ${PLAYWRIGHT_MIN_VERSION.raw} (got ${gate.version?.raw ?? 'none'})`,
    );
  }
  if (!agentsInstalled) {
    details.push(
      record === null
        ? 'e2e-agents.json record absent — run `ditto e2e init-agents`'
        : (skew?.warn ?? 'e2e-agents plan-format skew — re-run `ditto e2e init-agents`'),
    );
  }
  if (!mcpAvailable) details.push('MCP playwright-test server not available (best-effort probe)');

  return {
    usable: false,
    reason: `official generator unusable — ${details.join('; ')}`,
    checks,
  };
}

/**
 * Drive the E2E generator pipeline. Probes first (which asserts the init-agents +
 * plan-format contract); on usable it drives the official generator over the live
 * browser from the plan then post-passes into a traceable @ditto-generated spec;
 * otherwise it degrades to the e2e-scripter fallback over the SAME plan. Never
 * crashes/auto-installs/fabricates a pass (ADR-0018).
 */
export async function runGenerator(
  input: RunGeneratorInput,
  seams: RunGeneratorSeams,
): Promise<GeneratorResult> {
  const availability = await probeGenerator(input.repoRoot, input.host, seams);

  if (availability.usable) {
    // Contract assertion satisfied by the probe (agents record present + plan
    // format matches) — drive the official generator, then post-pass.
    const raw = await seams.driveOfficialGenerator({
      plan: input.plan,
      planMap: input.planMap,
      repoRoot: input.repoRoot,
      host: input.host,
    });
    const { spec, injected, unmatched } = injectDittoMarkers({
      generated: raw,
      journeyId: input.journeyId,
      header: input.header,
      planMap: input.planMap,
      ...(input.planAssertions ? { assertions: input.planAssertions } : {}),
      dslOriginal: input.dslOriginal,
    });
    return {
      spec,
      used_fallback: false,
      availability,
      unverified_acs: [],
      reason: availability.reason,
      specPath: input.specPath,
      injected,
      unmatched,
    };
  }

  // Not usable → degrade. Force the fallback branch regardless of WHICH check
  // failed (e.g. browser present but agents stale): we have already decided to
  // degrade, so signal the fallback with the availability reason as the cause.
  const fb = generateFallbackSpec({
    probe: { available: false, reason: availability.reason },
    plan: input.plan,
    header: input.header,
    specPath: input.specPath,
    planPath: input.planPath,
  });
  return {
    spec: fb.spec ?? '',
    used_fallback: true,
    availability,
    unverified_acs: fb.unverified_acs.length ? fb.unverified_acs : [...BROWSER_EVIDENCE_ACS],
    reason: fb.reason,
    specPath: fb.specPath ?? input.specPath,
    ...(fb.warn ? { warn: fb.warn } : {}),
  };
}
