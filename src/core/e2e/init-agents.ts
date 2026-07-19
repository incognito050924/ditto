import { dirname } from 'node:path';
import { z } from 'zod';
import { atomicWriteText, ensureDir } from '../fs';
import { writeBackupOnce } from '../managed-resource';

/**
 * Dual-host E2E test-agent install logic (wi_2607026qs ac-9, Contract 8).
 *
 * Pure, testable functions plus fs-effect functions behind an injectable
 * `FsSeam` — the CLI wiring (`ditto e2e init-agents --host …`) is a separate
 * node's job. This is optional-tool code (ADR-0018): it NEVER auto-installs
 * Playwright and NEVER crashes when Playwright is absent; a missing/too-old
 * Playwright routes to degrade (Contract 9) instead of failing. Backups reuse
 * `writeBackupOnce` (managed-resource.ts) so the user's own configs/agents are
 * always preserved before ditto overwrites anything.
 */

export type E2eHost = 'claude' | 'codex';
export type E2eLoop = 'claude' | 'codex';

export interface PlaywrightVersion {
  major: number;
  minor: number;
  patch: number;
  raw: string;
}

export interface McpServerDef {
  command: string;
  args?: string[];
  [k: string]: unknown;
}
export interface McpConfig {
  mcpServers: Record<string, unknown>;
  [k: string]: unknown;
}

export type VersionDecision = 'install' | 'refuse' | 'degrade';
export interface VersionGate {
  decision: VersionDecision;
  version: PlaywrightVersion | null;
  /** Non-null when install proceeds but the version is suboptimal (claude <1.61). */
  warn: string | null;
  /** Non-null when the install is refused/degraded — carries user guidance. */
  message: string | null;
}

export interface SkewResult {
  skew: boolean;
  action: 'ok' | 'degrade';
  warn: string | null;
}

/** Marker that identifies a ditto-authored agent file (safe to overwrite/refresh). */
export const DITTO_AGENT_MARKER = '<!-- ditto:playwright-agent v1 -->';
/** Plan format the installed agents/adapter agree on; a mismatch → degrade. */
export const PLAN_FORMAT_VERSION = 'v1';
/** Minimum Playwright: codex requires ≥ this; claude warns below it. */
export const PLAYWRIGHT_MIN_VERSION: PlaywrightVersion = {
  major: 1,
  minor: 61,
  patch: 0,
  raw: '1.61.0',
};

export const PLAYWRIGHT_TEST_MCP_KEY = 'playwright-test';
/**
 * Fresh playwright-test MCP server the claude loop merges into `.mcp.json`.
 * NOTE (unground): the exact command/args must be pinned against a live
 * Playwright by the generator node; the merge/preserve logic here is
 * independent of the exact value (callers may pass their own via `freshServer`).
 */
export const PLAYWRIGHT_TEST_MCP_SERVER: McpServerDef = {
  command: 'npx',
  args: ['-y', '@playwright/mcp@latest'],
};

/** Create-if-absent scaffold: a minimal Playwright config pointing at the generated dir. */
export const PLAYWRIGHT_CONFIG_STUB = `${DITTO_AGENT_MARKER}
import { defineConfig } from '@playwright/test';

// ditto scaffold — safe to edit. Generated specs live in e2e/generated/.
export default defineConfig({
  testDir: 'e2e/generated',
});
`;

/** Create-if-absent scaffold: a no-op seed spec authors can extend. */
export const SEED_SPEC_STUB = `${DITTO_AGENT_MARKER}
import { test as setup } from '@playwright/test';

// ditto scaffold — replace with real seeding/storageState for your app.
setup('seed', async () => {
  // no-op
});
`;

export const e2eAgentsRecordSchema = z
  .object({
    installed_at: z.string(),
    playwright_version: z.string(),
    loop: z.enum(['claude', 'codex']),
    // kept a general string (not a literal) so a SKEWED record can be READ and
    // then flagged by detectVersionSkew, rather than failing schema validation.
    plan_format_version: z.string(),
    healer: z.string(),
  })
  .strict();
export type E2eAgentsRecord = z.infer<typeof e2eAgentsRecordSchema>;

export interface FsSeam {
  exists(path: string): Promise<boolean>;
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  ensureDir(path: string): Promise<void>;
  backupOnce(path: string): Promise<string | null>;
}

/** Default seam over the real filesystem, reusing the repo's fs primitives. */
export const nodeFsSeam: FsSeam = {
  exists: (p) => Bun.file(p).exists(),
  readText: (p) => Bun.file(p).text(),
  writeText: (p, c) => atomicWriteText(p, c),
  ensureDir: (p) => ensureDir(p),
  backupOnce: (p) => writeBackupOnce(p),
};

// ── host/loop mapping ───────────────────────────────────────────────────────

/**
 * Map a host to its generator loop (claude→claude, codex→codex). When an
 * explicit `--loop` is supplied it MUST match the host — a wrong pairing is a
 * user error, so we throw with guidance rather than silently coercing.
 */
export function resolveLoop(host: E2eHost, explicitLoop?: E2eLoop): E2eLoop {
  const derived: E2eLoop = host === 'codex' ? 'codex' : 'claude';
  if (explicitLoop !== undefined && explicitLoop !== derived) {
    throw new Error(
      `--host ${host} pins --loop=${derived}; got --loop=${explicitLoop}. Drop --loop or set it to ${derived}.`,
    );
  }
  return derived;
}

// ── Playwright version gate ─────────────────────────────────────────────────

/** Parse the first `MAJOR.MINOR.PATCH` in a `playwright --version` string. */
export function parsePlaywrightVersion(raw: string | null | undefined): PlaywrightVersion | null {
  if (raw == null) return null;
  const m = raw.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    raw: m[0],
  };
}

function compareVersion(a: PlaywrightVersion, b: PlaywrightVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Gate the install on the detected Playwright version, per host:
 * - absent/unparseable → `degrade` (route to Contract 9, never install/crash);
 * - codex below MIN → `refuse` (hard requirement) with guidance;
 * - claude below MIN → `install` with a warn; at/above MIN → clean `install`.
 */
export function gatePlaywrightVersion(
  host: E2eHost,
  versionOutput: string | null | undefined,
): VersionGate {
  const version = parsePlaywrightVersion(versionOutput);
  if (version === null) {
    return {
      decision: 'degrade',
      version: null,
      warn: null,
      message:
        'Playwright not detected — not auto-installing (ADR-0018). E2E generation will run in degrade mode until Playwright is installed and `ditto e2e init-agents` is re-run.',
    };
  }
  const below = compareVersion(version, PLAYWRIGHT_MIN_VERSION) < 0;
  if (!below) {
    return { decision: 'install', version, warn: null, message: null };
  }
  if (host === 'codex') {
    return {
      decision: 'refuse',
      version,
      warn: null,
      message: `Playwright ${version.raw} < ${PLAYWRIGHT_MIN_VERSION.raw}; the codex loop requires >= ${PLAYWRIGHT_MIN_VERSION.raw}. Upgrade Playwright (e.g. npm i -D @playwright/test@latest) and re-run.`,
    };
  }
  return {
    decision: 'install',
    version,
    warn: `Playwright ${version.raw} < ${PLAYWRIGHT_MIN_VERSION.raw}; the claude loop will install but generation may be less reliable. Upgrade to >= ${PLAYWRIGHT_MIN_VERSION.raw} when possible.`,
    message: null,
  };
}

// ── .mcp.json backup + merge (claude loop) ──────────────────────────────────

/**
 * Merge the fresh playwright-test server into any existing `.mcp.json` content,
 * preserving every user-defined server and top-level key. Absent/empty content
 * yields a fresh config carrying only playwright-test. Malformed JSON throws
 * (fail-closed) so a config we cannot parse is never clobbered.
 */
export function mergeMcpServers(
  existingContent: string | null | undefined,
  freshServer: McpServerDef = PLAYWRIGHT_TEST_MCP_SERVER,
): McpConfig {
  const trimmed = existingContent?.trim();
  const parsed: Record<string, unknown> =
    trimmed && trimmed.length > 0 ? (JSON.parse(trimmed) as Record<string, unknown>) : {};
  const existingServers =
    parsed.mcpServers && typeof parsed.mcpServers === 'object'
      ? (parsed.mcpServers as Record<string, unknown>)
      : {};
  return {
    ...parsed,
    mcpServers: { ...existingServers, [PLAYWRIGHT_TEST_MCP_KEY]: freshServer },
  };
}

/**
 * Claude loop `.mcp.json` install: compute the merged config first (throws on
 * malformed → nothing is touched), back the original up ONCE, then write.
 */
export async function writeMergedMcpJson(
  mcpPath: string,
  freshServer: McpServerDef = PLAYWRIGHT_TEST_MCP_SERVER,
  seam: FsSeam = nodeFsSeam,
): Promise<{ mcpPath: string; backupPath: string | null; servers: string[] }> {
  const exists = await seam.exists(mcpPath);
  const existing = exists ? await seam.readText(mcpPath) : null;
  const merged = mergeMcpServers(existing, freshServer);
  const backupPath = exists ? await seam.backupOnce(mcpPath) : null;
  await seam.ensureDir(dirname(mcpPath));
  await seam.writeText(mcpPath, `${JSON.stringify(merged, null, 2)}\n`);
  return { mcpPath, backupPath, servers: Object.keys(merged.mcpServers) };
}

// ── agent-file overwrite guard ──────────────────────────────────────────────

/** True when the content already carries the ditto agent marker (ours to refresh). */
export function hasDittoAgentMarker(content: string): boolean {
  return content.includes(DITTO_AGENT_MARKER);
}

/**
 * Install an agent file, mirroring the push-gate hook posture: a fresh path is
 * `installed`; a ditto-marked file is `refreshed` in place; a pre-existing
 * NON-ditto file is backed up ONCE (writeBackupOnce) then overwritten.
 */
export async function installAgentFile(
  destPath: string,
  content: string,
  seam: FsSeam = nodeFsSeam,
): Promise<{ action: 'installed' | 'refreshed' | 'backed-up'; backupPath: string | null }> {
  const exists = await seam.exists(destPath);
  if (!exists) {
    await seam.ensureDir(dirname(destPath));
    await seam.writeText(destPath, content);
    return { action: 'installed', backupPath: null };
  }
  const current = await seam.readText(destPath);
  if (hasDittoAgentMarker(current)) {
    await seam.writeText(destPath, content);
    return { action: 'refreshed', backupPath: null };
  }
  const backupPath = await seam.backupOnce(destPath);
  await seam.writeText(destPath, content);
  return { action: 'backed-up', backupPath };
}

// ── scaffold create-if-absent ───────────────────────────────────────────────

/** Write `content` only when `path` is absent; never overwrite a user file. */
export async function scaffoldIfAbsent(
  path: string,
  content: string,
  seam: FsSeam = nodeFsSeam,
): Promise<'created' | 'skipped-exists'> {
  if (await seam.exists(path)) return 'skipped-exists';
  await seam.ensureDir(dirname(path));
  await seam.writeText(path, content);
  return 'created';
}

// ── version-skew record ─────────────────────────────────────────────────────

/** Build the e2e-agents.json record stamped with the current plan format + healer. */
export function buildE2eAgentsRecord(input: {
  playwrightVersion: string;
  loop: E2eLoop;
  installedAt?: string;
}): E2eAgentsRecord {
  return e2eAgentsRecordSchema.parse({
    installed_at: input.installedAt ?? new Date().toISOString(),
    playwright_version: input.playwrightVersion,
    loop: input.loop,
    plan_format_version: PLAN_FORMAT_VERSION,
    healer: 'constrained',
  });
}

/**
 * Detect a plan-format skew between the installed agents and the current
 * adapter format. A mismatch means the installed test-agents are stale: signal
 * a loud warn and route to degrade rather than silently emit non-conformant tests.
 */
export function detectVersionSkew(
  record: E2eAgentsRecord,
  expectedPlanFormat: string = PLAN_FORMAT_VERSION,
): SkewResult {
  if (record.plan_format_version !== expectedPlanFormat) {
    return {
      skew: true,
      action: 'degrade',
      warn: `e2e-agents.json plan_format_version=${record.plan_format_version} != expected ${expectedPlanFormat}: installed test-agents are stale. Re-run \`ditto e2e init-agents\` before generating; routing to degrade to avoid non-conformant output.`,
    };
  }
  return { skew: false, action: 'ok', warn: null };
}

/** Write the validated record to `path` (default `.ditto/local/e2e-agents.json`). */
export async function writeE2eAgentsRecord(
  path: string,
  record: E2eAgentsRecord,
  seam: FsSeam = nodeFsSeam,
): Promise<void> {
  const validated = e2eAgentsRecordSchema.parse(record);
  await seam.ensureDir(dirname(path));
  await seam.writeText(path, `${JSON.stringify(validated, null, 2)}\n`);
}

/**
 * Read the record; returns null when absent (graceful — caller degrades).
 * A present-but-malformed record throws (fail-closed on corruption).
 */
export async function readE2eAgentsRecord(
  path: string,
  seam: FsSeam = nodeFsSeam,
): Promise<E2eAgentsRecord | null> {
  if (!(await seam.exists(path))) return null;
  const text = await seam.readText(path);
  return e2eAgentsRecordSchema.parse(JSON.parse(text));
}
