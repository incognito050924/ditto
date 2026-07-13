import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineCommand } from 'citty';
import { findOrphanVariants, loadVariantCatalog } from '~/core/agent-variants';
import { collectCapabilityInventory } from '~/core/capability-inventory';
import { defaultDoctorDeps, inspectCodeqlTarget } from '~/core/codeql/doctor';
import { defaultInstallDeps, installCodeqlCli } from '~/core/codeql/install';
import {
  collectCompletionCoverageReport,
  defaultCompletionCoverageDeps,
} from '~/core/completion-coverage-doctor';
import {
  collectDistributionChecks,
  collectDistributionReport,
  defaultDistributionDeps,
} from '~/core/distribution-doctor';
import {
  type FixItem,
  applyDoctorFixes,
  defaultDoctorFixDeps,
  planInstructionFixes,
} from '~/core/doctor-fix';
import { resolveRepoRootForCreate } from '~/core/fs';
import {
  collectGithubConfigReport,
  defaultGithubConfigDoctorDeps,
} from '~/core/github-config-doctor';
import {
  type BuiltinHostId,
  type HostAdapter,
  InvalidHostError,
  getHostAdapter,
  listHostAdapters,
  parseHostId,
} from '~/core/hosts';
import { checkInstructionsForHosts } from '~/core/instruction-bridge';
import { collectIntentQualityReport, defaultIntentQualityDeps } from '~/core/intent-quality-doctor';
import { collectMcpInventory } from '~/core/mcp-inventory';
import { collectPermissionFindings } from '~/core/permission-inventory';
import { defaultPluginRootDeps, locatedStatus, resolvePluginRoot } from '~/core/plugin-root';
import {
  type MetricTrend,
  RetroMetricLedger,
  summarizeRetroTrend,
} from '~/core/retro-metric-ledger';
import { collectSurfaceInventory } from '~/core/surface-inventory';
import {
  InvalidOutputFormatError,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';
import { confirm } from '../wizard/prompt';
import { createStdioPromptIO } from '../wizard/prompt-io';

const DRIFT_EXIT = 1;
const DOCTOR_RUNTIME_ERROR_EXIT = 70;

function exitCodeForError(err: unknown): number {
  return err instanceof InvalidHostError || err instanceof InvalidOutputFormatError
    ? USAGE_ERROR_EXIT
    : DOCTOR_RUNTIME_ERROR_EXIT;
}

function selectedAdapters(host: string | undefined): HostAdapter[] {
  const parsed = parseHostId(host);
  return parsed ? [getHostAdapter(parsed)] : listHostAdapters();
}

function selectedHostIds(host: string | undefined): BuiltinHostId[] {
  return selectedAdapters(host)
    .map((adapter) => adapter.id)
    .filter((id): id is BuiltinHostId => id === 'codex' || id === 'claude-code');
}

function exitForFindings(count: number, advisory: boolean | undefined): void {
  if (count > 0 && advisory !== true) process.exit(DRIFT_EXIT);
}

/**
 * Run the repair flow for a planned set of fix items. Non-reversible repairs ask
 * for a TTY confirm (skipped with no prompt in non-TTY); reversible auto-apply.
 * Reports applied/skipped/nothing-to-fix and never raises a drift exit (a `--fix`
 * run that completes its reversible work is a success).
 */
async function runFix(repoRoot: string, items: FixItem[]): Promise<void> {
  const deps = defaultDoctorFixDeps(repoRoot, homedir());
  const io = createStdioPromptIO();
  try {
    const result = await applyDoctorFixes(
      {
        ...deps,
        // Non-reversible repairs (global ~/.claude host impact) confirm via TTY;
        // confirm() returns the default (false) when there is no TTY → skip.
        confirmNonReversible: (item) =>
          confirm(io, `Apply non-reversible repair? ${item.describe}`, false),
      },
      items,
    );
    if (result.nothingToFix) {
      writeHuman('fix: nothing to fix');
      return;
    }
    for (const item of result.applied) writeHuman(`fixed\t${item.describe}`);
    for (const item of result.skipped)
      writeHuman(`skipped (non-reversible, not confirmed)\t${item.describe}`);
  } finally {
    io.close();
  }
}

/**
 * Plan the ditto-allowlist fix from the already-computed distribution checks:
 * when `allowlisted` is false the project `.claude/settings.json` is missing the
 * `Bash(ditto:*)` rule. Project-level → reversible (auto-applies).
 */
function planAllowlistFixes(allowlisted: boolean, repoRoot: string): FixItem[] {
  if (allowlisted) return [];
  return [
    {
      kind: 'allowlist',
      reversible: true,
      targetPath: join(repoRoot, '.claude', 'settings.json'),
      describe: 'add Bash(ditto:*) to project .claude/settings.json allow',
    },
  ];
}

/**
 * Plan one register-variant fix per orphan, reusing the SAME orphan detection.
 * Each repair copies `.ditto/agents/<name>.md` → `.claude/agents/<name>.md`.
 * The target is project-local → reversible (auto-applies).
 */
function planVariantFixes(orphans: string[], repoRoot: string): FixItem[] {
  return orphans.map((name) => ({
    kind: 'register-variant' as const,
    reversible: true,
    targetPath: join(repoRoot, '.claude', 'agents', `${name}.md`),
    variantName: name,
    describe: `register orphan variant ${name} into .claude/agents`,
  }));
}

function parseCommon(args: { output?: string; host?: string }) {
  const format = parseOutputFormat(args.output);
  const adapters = selectedAdapters(args.host);
  return { format, adapters };
}

const instructionsCommand = defineCommand({
  meta: {
    name: 'instructions',
    description: 'Check AGENTS.md and host instruction projections for drift',
  },
  args: {
    host: { type: 'string', required: false, description: 'Host: codex|claude-code' },
    output: { type: 'string', default: 'human', description: 'Output format: human|json' },
    advisory: { type: 'boolean', default: false, description: 'Report drift but exit 0' },
    fix: {
      type: 'boolean',
      default: false,
      description: 'Repair detected instruction drift by re-projecting the managed block',
    },
  },
  run: async ({ args }) => {
    try {
      const format = parseOutputFormat(args.output);
      const hosts = selectedHostIds(args.host);
      const repoRoot = await resolveRepoRootForCreate();
      const report = await checkInstructionsForHosts(hosts, repoRoot);
      if (args.fix === true) {
        await runFix(repoRoot, planInstructionFixes(report.findings, homedir()));
        return; // --fix never raises a drift exit
      }
      if (format === 'json') {
        writeJson({
          status: report.findings.length === 0 ? 'ok' : 'drift',
          sourceSha256: report.sourceSha256,
          results: report.results,
          findings: report.findings,
        });
      } else if (report.findings.length === 0) {
        writeHuman('instructions: ok');
      } else {
        for (const finding of report.findings) {
          writeHuman(`${finding.host}\t${finding.kind}\t${finding.path}\t${finding.message}`);
        }
      }
      exitForFindings(report.findings.length, args.advisory);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(exitCodeForError(err));
    }
  },
});

const permissionsCommand = defineCommand({
  meta: {
    name: 'permissions',
    description: 'Check host permission settings for risky surfaces',
  },
  args: {
    host: { type: 'string', required: false, description: 'Host: codex|claude-code' },
    output: { type: 'string', default: 'human', description: 'Output format: human|json' },
    advisory: { type: 'boolean', default: false, description: 'Report drift but exit 0' },
  },
  run: async ({ args }) => {
    try {
      const { format, adapters } = parseCommon(args);
      const repoRoot = await resolveRepoRootForCreate();
      const findings = await collectPermissionFindings(adapters, repoRoot);
      const dangerousCount = findings.filter(
        (finding) => finding.label !== 'missing' && finding.label !== 'unverified',
      ).length;
      if (format === 'json') {
        writeJson({
          status: dangerousCount === 0 ? 'ok' : 'drift',
          dangerous_count: dangerousCount,
          findings,
        });
      } else if (findings.length === 0) {
        writeHuman('permissions: ok');
      } else {
        for (const finding of findings) {
          writeHuman(
            `${finding.host}\t${finding.label}\t${finding.source_file}\t${finding.message}`,
          );
        }
      }
      exitForFindings(dangerousCount, args.advisory);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(exitCodeForError(err));
    }
  },
});

const mcpCommand = defineCommand({
  meta: {
    name: 'mcp',
    description: 'Inventory host MCP server configuration',
  },
  args: {
    host: { type: 'string', required: false, description: 'Host: codex|claude-code' },
    output: { type: 'string', default: 'human', description: 'Output format: human|json' },
    advisory: {
      type: 'boolean',
      default: false,
      description: 'Not supported for mcp (informational only); rejected as usage error',
    },
  },
  run: async ({ args }) => {
    try {
      if (args.advisory === true) {
        writeError(
          'doctor mcp does not support --advisory; mcp is informational and always exits 0',
        );
        process.exit(USAGE_ERROR_EXIT);
      }
      const { format, adapters } = parseCommon(args);
      const repoRoot = await resolveRepoRootForCreate();
      const report = await collectMcpInventory(adapters, repoRoot);
      if (format === 'json') {
        writeJson(report);
      } else if (report.servers.length === 0) {
        writeHuman(`mcp: unverified (${report.unavailable_reason ?? 'no servers found'})`);
      } else {
        for (const server of report.servers) {
          writeHuman(`${server.host}\t${server.scope}\t${server.name}\t${server.source_file}`);
        }
      }
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(exitCodeForError(err));
    }
  },
});

const surfaceCommand = defineCommand({
  meta: {
    name: 'surface',
    description: 'Inventory host skills, agents, commands, and plugins',
  },
  args: {
    host: { type: 'string', required: false, description: 'Host: codex|claude-code' },
    output: { type: 'string', default: 'human', description: 'Output format: human|json' },
    advisory: { type: 'boolean', default: false, description: 'Report drift but exit 0' },
  },
  run: async ({ args }) => {
    try {
      const { format, adapters } = parseCommon(args);
      const repoRoot = await resolveRepoRootForCreate();
      const report = await collectSurfaceInventory(adapters, repoRoot);
      if (format === 'json') {
        writeJson(report);
      } else if (report.findings.length === 0) {
        writeHuman(`surface: ok (${report.surfaces.length} discovered)`);
      } else {
        for (const finding of report.findings) {
          writeHuman(`${finding.host}\t${finding.kind}\t${finding.mismatch}\t${finding.path}`);
        }
      }
      exitForFindings(report.mismatch_count, args.advisory);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(exitCodeForError(err));
    }
  },
});

const capabilityCommand = defineCommand({
  meta: {
    name: 'capability',
    description: 'Check host capability parity (required capabilities + hook drift)',
  },
  args: {
    host: { type: 'string', required: false, description: 'Host: codex|claude-code' },
    output: { type: 'string', default: 'human', description: 'Output format: human|json' },
    advisory: { type: 'boolean', default: false, description: 'Report findings but exit 0' },
  },
  run: async ({ args }) => {
    try {
      const { format, adapters } = parseCommon(args);
      const repoRoot = await resolveRepoRootForCreate();
      // claude-code hook parity is checked against the plugin's own hooks.json,
      // which lives at the plugin root — not the session target. Discover it so a
      // consumer install (target ships no hooks.json) is not falsely flagged.
      const resolution = resolvePluginRoot(defaultPluginRootDeps());
      const located = resolution !== null;
      const report = await collectCapabilityInventory(adapters, repoRoot, resolution?.root);
      // When the plugin root was not located, claude-code hook parity ran against a
      // fallback root that ships no plugin surface — those declared-not-registered
      // findings are unverifiable, not confirmed drift. Segregate them so a healthy-
      // but-unlocatable install exits 0 (unverified), not 1 (drift).
      const unverifiable = (finding: (typeof report.findings)[number]): boolean =>
        !located &&
        finding.host === 'claude-code' &&
        finding.kind === 'declared_hook_not_registered';
      const driftFindings = report.findings.filter((f) => !unverifiable(f));
      const suppressed = report.findings.length - driftFindings.length;
      const status: 'ok' | 'drift' | 'unverified' =
        driftFindings.length > 0 ? 'drift' : suppressed > 0 ? 'unverified' : 'ok';
      if (format === 'json') {
        writeJson({
          status,
          hosts: report.hosts.map((host) => ({
            host: host.host,
            capabilities: host.capabilities,
            hook_events: host.hook_events,
          })),
          findings: report.findings,
        });
      } else if (status === 'ok') {
        writeHuman(`capability: ok (${report.hosts.length} hosts)`);
      } else if (status === 'unverified') {
        writeHuman(
          'capability: unverified — could not locate the ditto plugin root; claude-code hook parity not checked (set CLAUDE_PLUGIN_ROOT or run from the plugin cache)',
        );
      } else {
        for (const finding of driftFindings) {
          writeHuman(`${finding.host}\t${finding.kind}\t${finding.capability}\t${finding.message}`);
        }
      }
      exitForFindings(driftFindings.length, args.advisory);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(exitCodeForError(err));
    }
  },
});

const codeqlCommand = defineCommand({
  meta: {
    name: 'codeql',
    description: 'Check target repo CodeQL suitability before analysis (fail-closed)',
  },
  args: {
    output: { type: 'string', description: 'Output format: human (default) or json' },
    'source-root': {
      type: 'string',
      description: 'Analysis source root (default: <repo>/src)',
    },
    'build-verified': {
      type: 'boolean',
      default: false,
      description: 'Assert that a clean build was reproduced (unblocks compiled languages)',
    },
    advisory: { type: 'boolean', default: false, description: 'Report findings but exit 0' },
    install: {
      type: 'boolean',
      default: false,
      description: 'Opt-in: install the CodeQL CLI (downloads the official bundle) if absent',
    },
  },
  async run({ args }) {
    try {
      const format = parseOutputFormat(args.output);
      if (args.install) {
        const result = await installCodeqlCli(defaultInstallDeps);
        if (format === 'json') {
          writeJson(result);
        } else {
          writeHuman(`codeql install: ${result.status} — ${result.message}`);
          if (result.manual) for (const line of result.manual) writeHuman(`  ${line}`);
        }
        // already-present / installed = 성공(0). failed / unsupported = 1.
        if (result.status === 'failed' || result.status === 'unsupported-platform') {
          process.exit(DRIFT_EXIT);
        }
        return;
      }
      const repoRoot = await resolveRepoRootForCreate();
      const sourceRoot = args['source-root'] ?? join(repoRoot, 'src');
      const report = await inspectCodeqlTarget(
        { sourceRoot, buildVerified: args['build-verified'] },
        defaultDoctorDeps,
      );
      if (format === 'json') {
        writeJson({
          status: report.finding_count === 0 ? 'ok' : 'unsuitable',
          ...report,
        });
      } else if (report.finding_count === 0) {
        const langs = report.detected_languages.map((l) => `${l.language}(${l.files})`).join(', ');
        writeHuman(`codeql: ok — ${langs || 'no source'}`);
      } else {
        for (const finding of report.findings) {
          writeHuman(`${finding.severity}\t${finding.kind}\t${finding.message}`);
        }
      }
      exitForFindings(report.finding_count, args.advisory);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(exitCodeForError(err));
    }
  },
});

const distributionCommand = defineCommand({
  meta: {
    name: 'distribution',
    description:
      'Check per-substrate-axis deployment contracts (Hooks/Skills/Agents/State) — install-status flags promoted to doctor',
  },
  args: {
    output: { type: 'string', default: 'human', description: 'Output format: human|json' },
    advisory: { type: 'boolean', default: false, description: 'Report findings but exit 0' },
    fix: {
      type: 'boolean',
      default: false,
      description: 'Repair the ditto allowlist drift (Bash(ditto:*) in project settings.json)',
    },
  },
  run: async ({ args }) => {
    try {
      const format = parseOutputFormat(args.output);
      const targetRoot = await resolveRepoRootForCreate();
      // Under session-rooting (ADR-0011 D2) the session is rooted at the target;
      // the plugin's own surface lives elsewhere. Discover it (env → self-locate →
      // registry); fall back to targetRoot when unlocatable, but remember that so a
      // "missing surface" finding degrades to `unverified`, not a false DRIFT.
      const resolution = resolvePluginRoot(defaultPluginRootDeps());
      const located = resolution !== null;
      const pluginRoot = resolution?.root ?? targetRoot;
      if (args.fix === true) {
        // Reuse the SAME detection (allowlisted check) — repair only the allowlist.
        const checks = collectDistributionChecks(defaultDistributionDeps(targetRoot, pluginRoot));
        await runFix(targetRoot, planAllowlistFixes(checks.allowlisted, targetRoot));
        return; // --fix never raises a drift exit
      }
      const report = collectDistributionReport(defaultDistributionDeps(targetRoot, pluginRoot));
      const status = locatedStatus(report.finding_count, located);
      if (format === 'json') {
        writeJson({
          status,
          plugin_root: pluginRoot,
          plugin_root_source: resolution?.source ?? null,
          target_root: targetRoot,
          checks: report.checks,
          axes: report.axes,
        });
      } else if (report.finding_count === 0) {
        writeHuman('distribution: ok — all substrate-axis deployment contracts satisfied');
      } else if (status === 'unverified') {
        writeHuman(
          'distribution: unverified — could not locate the ditto plugin root; run inside the plugin (CLAUDE_PLUGIN_ROOT set) or from the plugin cache',
        );
      } else {
        for (const axis of report.axes) {
          const mark = axis.satisfied ? 'ok' : 'DRIFT';
          writeHuman(
            `${axis.axis}\t${mark}\t${axis.contract}${axis.missing.length > 0 ? ` (missing: ${axis.missing.join(', ')})` : ''}`,
          );
        }
      }
      // Only a located plugin root yields confirmed drift; unverified exits 0.
      exitForFindings(located ? report.finding_count : 0, args.advisory);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(exitCodeForError(err));
    }
  },
});

const intentQualityCommand = defineCommand({
  meta: {
    name: 'intent-quality',
    description:
      'Aggregate deep-interview intent signal (questions/closure/readiness) vs downstream rework (fix nodes/retries/handoffs) per work item',
  },
  args: {
    'work-item': {
      type: 'string',
      required: false,
      description: 'Restrict to a single work item id',
    },
    output: { type: 'string', default: 'human', description: 'Output format: human|json' },
  },
  run: async ({ args }) => {
    try {
      const format = parseOutputFormat(args.output);
      const repoRoot = await resolveRepoRootForCreate();
      const report = await collectIntentQualityReport(defaultIntentQualityDeps(repoRoot));
      const rows = args['work-item']
        ? report.rows.filter((r) => r.work_item_id === args['work-item'])
        : report.rows;
      if (format === 'json') {
        writeJson(args['work-item'] ? { rows } : report);
      } else if (rows.length === 0) {
        writeHuman('intent-quality: no work items');
      } else {
        writeHuman(
          'work_item\tquestions\tclosure\treadiness\tfix\trework\tretry/switch\thandoff\tdrift\tpost_cost\ttspec_rounds\ttspec_q',
        );
        for (const r of rows) {
          writeHuman(
            `${r.work_item_id}\t${r.questions_asked ?? '-'}\t${r.closure_mode ?? '-'}\t${
              r.readiness_score ?? '-'
            }\t${r.fix_nodes}\t${r.rework_attempts}\t${r.retry_switch_decisions}\t${r.handoff_rounds}\t${r.drift_events}\t${r.post_cost}\t${r.question_rounds}\t${r.question_mean_answer_value ?? '-'}`,
          );
        }
        // D4 correlation only makes sense over the full interviewed set, so it is
        // omitted when the readout is scoped to a single work item.
        if (!args['work-item']) {
          writeHuman('\nquestions-quantile × avg post-cost (interviewed items):');
          for (const b of report.correlation) {
            const range = b.questions_range
              ? `${b.questions_range[0]}–${b.questions_range[1]}q`
              : '-';
            writeHuman(
              `  ${b.quantile}\t${b.work_items} items\t${range}\tavg_q=${b.avg_questions.toFixed(1)}\tavg_post_cost=${b.avg_post_cost.toFixed(1)}`,
            );
          }
        }
      }
      // Informational measurement readout; never a drift exit.
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(exitCodeForError(err));
    }
  },
});

const completionCoverageCommand = defineCommand({
  meta: {
    name: 'completion-coverage',
    description:
      'Aggregate completion-evidence coverage (evidence-closed acceptance / total acceptance) across work items + archive, from persisted completion.json (no new instrumentation)',
  },
  args: {
    'work-item': {
      type: 'string',
      required: false,
      description: 'Restrict to a single work item id',
    },
    output: { type: 'string', default: 'human', description: 'Output format: human|json' },
  },
  run: async ({ args }) => {
    try {
      const format = parseOutputFormat(args.output);
      const repoRoot = await resolveRepoRootForCreate();
      const report = await collectCompletionCoverageReport(defaultCompletionCoverageDeps(repoRoot));
      const rows = args['work-item']
        ? report.rows.filter((r) => r.work_item_id === args['work-item'])
        : report.rows;
      if (format === 'json') {
        writeJson(args['work-item'] ? { rows } : report);
      } else if (rows.length === 0) {
        writeHuman('completion-coverage: no work items');
      } else {
        writeHuman('work_item\tstatus\tcompletion\tclosed/total\tcoverage');
        for (const r of rows) {
          writeHuman(
            `${r.work_item_id}\t${r.status}\t${r.has_completion ? 'yes' : 'no'}\t${
              r.closed_acceptance
            }/${r.total_acceptance}\t${r.coverage.toFixed(2)}`,
          );
        }
        if (!args['work-item']) {
          const t = report.totals;
          writeHuman(
            `\ntotal\t${t.with_completion}/${t.work_items} with completion\t${t.closed_acceptance}/${t.total_acceptance} acceptance closed\tcoverage=${t.coverage.toFixed(2)}`,
          );
        }
      }
      // Informational measurement readout; never a drift exit.
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(exitCodeForError(err));
    }
  },
});

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'abandoned']);

const backlogCommand = defineCommand({
  meta: {
    name: 'backlog',
    description:
      'Read-only backlog hygiene: stale drafts, completed-but-unclosed work items, and the open count. Definitions are structural (no wall-clock age — cross-PC clock skew would flap boundaries); reports only, never closes/archives anything.',
  },
  args: {
    output: { type: 'string', default: 'human', description: 'Output format: human|json' },
  },
  run: async ({ args }) => {
    try {
      const format = parseOutputFormat(args.output);
      const repoRoot = await resolveRepoRootForCreate();
      // R6 — reuse the completion-coverage scan (active + archive listing, completion
      // reads) instead of reinventing a parallel scan. The report rows already carry
      // per-WI status + has_completion; calling it first also populates the deps'
      // archive-label map so readCompletion below resolves archived completions.
      const deps = defaultCompletionCoverageDeps(repoRoot);
      const report = await collectCompletionCoverageReport(deps);

      // Stale draft (structural): status=draft ∧ no completion.json. A parked WI is
      // status partial/blocked (the schema requires re_entry for those), never
      // 'draft', so the draft restriction already excludes parked-with-reason items.
      const staleDrafts = report.rows
        .filter((r) => r.status === 'draft' && !r.has_completion)
        .map((r) => ({ work_item_id: r.work_item_id, title: r.title }));

      // Open = work items in a non-terminal status (done/abandoned excluded).
      const openCount = report.rows.filter((r) => !TERMINAL_STATUSES.has(r.status)).length;

      // Completed-but-unclosed: completion.final_verdict=pass while status is
      // non-terminal. Terminal (done/abandoned) is excluded — an abandoned WI that
      // carries a pass completion is not a hygiene item. final_verdict is not on the
      // coverage row, so read it from the same deps (only for rows with a completion).
      const completedUnclosed: { work_item_id: string; title: string; status: string }[] = [];
      for (const r of report.rows) {
        if (!r.has_completion || TERMINAL_STATUSES.has(r.status)) continue;
        const completion = await deps.readCompletion(r.work_item_id);
        if (completion?.final_verdict === 'pass') {
          completedUnclosed.push({
            work_item_id: r.work_item_id,
            title: r.title,
            status: r.status,
          });
        }
      }

      const findingCount = staleDrafts.length + completedUnclosed.length;
      // Advisory next-action per surfaced item (wi_260627pfa, idea ②-A residual):
      // the readout names the command the USER can run — it NEVER acts. A stale
      // draft is often real parked work, so the suggestion offers resume OR abandon
      // (never a silent auto-abandon — that would destroy real backlog, D4 boundary
      // ADR-20260627). completed-unclosed suggests the close that flips it to done.
      const staleAction = (id: string): string =>
        `resume (ditto work set-criteria/deep-interview ${id}) or abandon (ditto work abandon ${id} --reason "<why>")`;
      const closedAction = (id: string): string => `ditto work done ${id}`;
      if (format === 'json') {
        writeJson({
          status: findingCount === 0 ? 'ok' : 'hygiene',
          open_count: openCount,
          stale_drafts: staleDrafts.map((s) => ({
            ...s,
            suggested_action: staleAction(s.work_item_id),
          })),
          completed_unclosed: completedUnclosed.map((c) => ({
            ...c,
            suggested_action: closedAction(c.work_item_id),
          })),
        });
      } else {
        writeHuman(`open\t${openCount} non-terminal work items`);
        if (findingCount === 0) {
          writeHuman('backlog: ok (no stale drafts, no completed-but-unclosed)');
        } else {
          for (const s of staleDrafts) {
            writeHuman(`stale_draft\t${s.work_item_id}\t${s.title}`);
            writeHuman(`  → ${staleAction(s.work_item_id)}`);
          }
          for (const c of completedUnclosed) {
            writeHuman(`completed_unclosed\t${c.work_item_id}\t${c.status}\t${c.title}`);
            writeHuman(`  → ${closedAction(c.work_item_id)}`);
          }
        }
      }
      // Read-only hygiene readout; never a drift exit and never an auto-cleanup action.
      // The suggested_action strings are advisory text only — nothing is executed.
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(exitCodeForError(err));
    }
  },
});

const retroTrendCommand = defineCommand({
  meta: {
    name: 'retro-trend',
    description:
      'Read the cross-WI retro-metric ledger and surface the per-metric trend (coverage / unit_only_closures / escape_recurrence / post_cost) so the ADR-0024 floor retract condition can be evaluated from real data',
  },
  args: {
    output: { type: 'string', default: 'human', description: 'Output format: human|json' },
  },
  run: async ({ args }) => {
    try {
      const format = parseOutputFormat(args.output);
      const repoRoot = await resolveRepoRootForCreate();
      const rows = await new RetroMetricLedger(repoRoot).readAll();
      const summary = summarizeRetroTrend(rows);
      if (format === 'json') {
        writeJson({ rows, summary });
      } else if (rows.length === 0) {
        writeHuman('retro-trend: no measurements (the retro-metric ledger is empty)');
      } else {
        const num = (v: number | undefined, digits = 0): string =>
          typeof v === 'number' ? v.toFixed(digits) : '-';
        writeHuman('work_item\trecorded_at\tcoverage\tunit_only\tescape\tpost_cost');
        for (const r of rows) {
          const o = r.metrics.outcome_floor;
          const p = r.metrics.process_health;
          const marker = r.metrics.no_measurable_signal ? '\t(no measurable signal)' : '';
          writeHuman(
            `${r.work_item_id}\t${r.recorded_at}\t${num(o?.coverage, 2)}\t${num(
              o?.unit_only_closures,
            )}\t${num(o?.escape_recurrence)}\t${num(p?.post_cost)}${marker}`,
          );
        }
        // Per-metric trend: present only for grounded metrics (anti-SLOP), with the
        // chronological first→last delta the retract condition reads.
        writeHuman(
          `\ntrend (${summary.work_items} work items, ${summary.no_measurable_signal} no_measurable_signal):`,
        );
        const trendLine = (label: string, t: MetricTrend | undefined, digits = 0): void => {
          if (!t) return;
          writeHuman(
            `  ${label}\tn=${t.n}\tfirst=${t.first.toFixed(digits)}\tlast=${t.last.toFixed(
              digits,
            )}\tmean=${t.mean.toFixed(2)}\t[${t.min.toFixed(digits)}, ${t.max.toFixed(digits)}]`,
          );
        };
        trendLine('coverage', summary.coverage, 2);
        trendLine('unit_only_closures', summary.unit_only_closures);
        trendLine('escape_recurrence', summary.escape_recurrence);
        trendLine('post_cost', summary.post_cost);
      }
      // Informational measurement readout; never a drift exit.
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(exitCodeForError(err));
    }
  },
});

const variantsCommand = defineCommand({
  meta: {
    name: 'variants',
    description:
      'Check that every .ditto/agents variant has a .claude/agents host registration (un-spawnable orphans = drift)',
  },
  args: {
    output: { type: 'string', default: 'human', description: 'Output format: human|json' },
    advisory: { type: 'boolean', default: false, description: 'Report drift but exit 0' },
    fix: {
      type: 'boolean',
      default: false,
      description: 'Register orphan variants into .claude/agents (copy from .ditto/agents)',
    },
  },
  run: async ({ args }) => {
    try {
      const format = parseOutputFormat(args.output);
      const repoRoot = await resolveRepoRootForCreate();
      const variantNames = (await loadVariantCatalog(repoRoot)).map((v) => v.name);
      // A variant only routes if the claude-code host can spawn it: its name must
      // have a `.claude/agents` registration. loadSurfaceInventory collects those
      // as kind:'agent' local surfaces.
      const inventory = await getHostAdapter('claude-code').loadSurfaceInventory(repoRoot);
      const hostAgentNames = inventory.localSurfaces
        .filter((surface) => surface.kind === 'agent')
        .map((surface) => surface.id);
      const orphans = findOrphanVariants(variantNames, hostAgentNames);
      if (args.fix === true) {
        // Reuse the SAME orphan detection — repair only the detected orphans.
        await runFix(repoRoot, planVariantFixes(orphans, repoRoot));
        return; // --fix never raises a drift exit
      }
      if (format === 'json') {
        writeJson({
          status: orphans.length === 0 ? 'ok' : 'drift',
          variant_count: variantNames.length,
          orphan_count: orphans.length,
          orphans,
        });
      } else if (orphans.length === 0) {
        writeHuman(`variants: ok (${variantNames.length} variants, all host-registered)`);
      } else {
        for (const name of orphans) {
          writeHuman(`claude-code\torphan_variant\t${name}\tno .claude/agents registration`);
        }
      }
      exitForFindings(orphans.length, args.advisory);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(exitCodeForError(err));
    }
  },
});

const githubConfigCommand = defineCommand({
  meta: {
    name: 'github',
    description:
      'Check the local github config for a 구버전 shape missing claim_status_map.in_progress (claim-time board move to "In progress" silently skipped). Local-only (no gh/network probe), read-only (no auto-fix).',
  },
  args: {
    output: { type: 'string', default: 'human', description: 'Output format: human|json' },
    advisory: { type: 'boolean', default: false, description: 'Report findings but exit 0' },
  },
  run: async ({ args }) => {
    try {
      const format = parseOutputFormat(args.output);
      const repoRoot = await resolveRepoRootForCreate();
      // Local-only: reads only `.ditto/local/config.json` (no board probe), so it
      // never hangs or false-fails offline.
      const report = await collectGithubConfigReport(defaultGithubConfigDoctorDeps(repoRoot));
      if (format === 'json') {
        writeJson({
          status: report.finding_count === 0 ? 'ok' : 'drift',
          github_configured: report.github_configured,
          claim_in_progress_mapped: report.claim_in_progress_mapped,
          finding_count: report.finding_count,
          findings: report.findings,
        });
      } else if (report.finding_count === 0) {
        writeHuman(
          report.github_configured
            ? 'github: ok (claim_status_map.in_progress mapped)'
            : 'github: ok (no github integration configured)',
        );
      } else {
        for (const finding of report.findings) {
          writeHuman(`github	${finding.kind}	${finding.message}`);
          writeHuman(`  → ${finding.remediation}`);
        }
      }
      exitForFindings(report.finding_count, args.advisory);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(exitCodeForError(err));
    }
  },
});

export const doctorCommand = defineCommand({
  meta: {
    name: 'doctor',
    description:
      'Diagnose host instruction, permission, MCP, surface, capability, and distribution drift',
  },
  subCommands: {
    instructions: instructionsCommand,
    permissions: permissionsCommand,
    mcp: mcpCommand,
    surface: surfaceCommand,
    capability: capabilityCommand,
    codeql: codeqlCommand,
    distribution: distributionCommand,
    'intent-quality': intentQualityCommand,
    'completion-coverage': completionCoverageCommand,
    backlog: backlogCommand,
    'retro-trend': retroTrendCommand,
    variants: variantsCommand,
    github: githubConfigCommand,
  },
});
