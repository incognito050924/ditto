import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Distribution doctor (재평가 §3.5(C), 4e) — promotes the install-status flags to
 * `ditto doctor distribution`, a per-substrate-axis deployment-contract checker.
 *
 * The substrate 4-axis (Hooks/Skills/Agents/State) only works on a target when its
 * deployment contract is met (§3.5 (A) table). The canonical INSTALLER lives in
 * `scripts/install-plugin.mjs`; this module re-runs the same checks from the CLI's
 * runtime vantage so `ditto doctor` can diagnose a broken deployment in place,
 * mapping each atomic check to the axis whose contract it backs.
 */

// Mirrored from scripts/install-plugin.mjs (the canonical installer).
const MARKETPLACE = 'ditto-local';
const PLUGIN_NAME = 'ditto';
const ALLOW_RULE = 'Bash(ditto:*)';
const IS_WIN = process.platform === 'win32';

/** The five deployment-contract atomic checks (the promoted install-status flags). */
export interface DistributionChecks {
  /** A self-contained binary was built at <repo>/bin/ditto (hooks need it). */
  binary_built: boolean;
  /** `ditto` resolves on PATH (skills/agents call the bare command). */
  binary_on_path: boolean;
  /** The plugin is enabled in the global Claude settings. */
  plugin_enabled: boolean;
  /** The plugin hooks manifest (hooks/hooks.json) is present. */
  hooks_registered: boolean;
  /** The target carries an initialized `.ditto/` State (glossary seed present). */
  target_initialized: boolean;
  /** The target project allowlists `Bash(ditto:*)` (skills run without a prompt). */
  allowlisted: boolean;
}

type CheckKey = keyof DistributionChecks;

export interface AxisContract {
  axis: 'Hooks' | 'Skills' | 'Agents' | 'State';
  contract: string;
  /** Atomic checks this axis's deployment contract requires. */
  requires: CheckKey[];
  satisfied: boolean;
  /** The required checks that are not met (empty when satisfied). */
  missing: CheckKey[];
}

// §3.5 (A) deployment-contract table: which atomic checks each substrate axis needs.
const AXIS_CONTRACTS: Array<Pick<AxisContract, 'axis' | 'contract' | 'requires'>> = [
  {
    axis: 'Hooks',
    contract: 'self-contained binary built + hooks.json registered',
    requires: ['binary_built', 'hooks_registered'],
  },
  {
    axis: 'Skills',
    contract: 'plugin enabled + CLI on PATH',
    requires: ['plugin_enabled', 'binary_on_path'],
  },
  {
    axis: 'Agents',
    contract: 'plugin enabled + CLI on PATH + target State',
    requires: ['plugin_enabled', 'binary_on_path', 'target_initialized'],
  },
  {
    axis: 'State',
    contract: 'explicit `ditto init` scaffold',
    requires: ['target_initialized'],
  },
];

export interface DistributionReport {
  checks: DistributionChecks;
  axes: AxisContract[];
  /** Axes whose deployment contract is not satisfied. */
  finding_count: number;
}

/**
 * Pure mapping from atomic checks to per-axis contract verdicts. An axis is
 * satisfied only when every atomic check its deployment contract requires holds.
 */
export function evaluateDistribution(checks: DistributionChecks): DistributionReport {
  const axes: AxisContract[] = AXIS_CONTRACTS.map((a) => {
    const missing = a.requires.filter((k) => !checks[k]);
    return { ...a, satisfied: missing.length === 0, missing };
  });
  return { checks, axes, finding_count: axes.filter((a) => !a.satisfied).length };
}

export interface DistributionDeps {
  /**
   * Where the plugin's own artifacts live (`bin/ditto`, `hooks/hooks.json`) —
   * `${CLAUDE_PLUGIN_ROOT}` at runtime. Distinct from `targetRoot`: under
   * session-rooting (ADR-0011 D2) the session is rooted at the target, so the
   * plugin install dir is elsewhere and must be checked at its own root.
   */
  pluginRoot: string;
  /**
   * The session's target repo root carrying `.ditto/` State and the project
   * `.claude/settings.json` allowlist.
   */
  targetRoot: string;
  /** Resolve `ditto` on PATH; returns a path or null. */
  whichDitto: () => string | null;
  readGlobalSettings: () => Record<string, unknown>;
  readProjectSettings: () => Record<string, unknown>;
  exists: (path: string) => boolean;
}

function readJsonObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, 'utf8').trim();
  if (!text) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function defaultDistributionDeps(targetRoot: string, pluginRoot: string): DistributionDeps {
  return {
    pluginRoot,
    targetRoot,
    whichDitto: () => Bun.which('ditto'),
    readGlobalSettings: () => readJsonObject(join(homedir(), '.claude', 'settings.json')),
    readProjectSettings: () => readJsonObject(join(targetRoot, '.claude', 'settings.json')),
    exists: (p) => existsSync(p),
  };
}

function pluginEnabled(settings: Record<string, unknown>): boolean {
  const enabled = settings.enabledPlugins;
  return (
    typeof enabled === 'object' &&
    enabled !== null &&
    (enabled as Record<string, unknown>)[`${PLUGIN_NAME}@${MARKETPLACE}`] === true
  );
}

function allowlisted(settings: Record<string, unknown>): boolean {
  const permissions = settings.permissions;
  const allow =
    permissions && typeof permissions === 'object'
      ? (permissions as Record<string, unknown>).allow
      : undefined;
  return Array.isArray(allow) && allow.includes(ALLOW_RULE);
}

/** Run the five deployment-contract checks from the current runtime vantage. */
export function collectDistributionChecks(deps: DistributionDeps): DistributionChecks {
  const binaryName = IS_WIN ? 'ditto.exe' : 'ditto';
  return {
    // plugin-root artifacts: the plugin ships these at its own install dir.
    binary_built: deps.exists(join(deps.pluginRoot, 'bin', binaryName)),
    hooks_registered: deps.exists(join(deps.pluginRoot, 'hooks', 'hooks.json')),
    // root-independent: PATH resolution and global Claude settings.
    binary_on_path: deps.whichDitto() !== null,
    plugin_enabled: pluginEnabled(deps.readGlobalSettings()),
    // target-root artifacts: scaffolded into the session's target project.
    target_initialized: deps.exists(join(deps.targetRoot, '.ditto', 'knowledge', 'glossary.json')),
    allowlisted: allowlisted(deps.readProjectSettings()),
  };
}

export function collectDistributionReport(deps: DistributionDeps): DistributionReport {
  return evaluateDistribution(collectDistributionChecks(deps));
}
