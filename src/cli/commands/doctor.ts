import { join } from 'node:path';
import { defineCommand } from 'citty';
import { collectCapabilityInventory } from '~/core/capability-inventory';
import { defaultDoctorDeps, inspectCodeqlTarget } from '~/core/codeql/doctor';
import { collectDistributionReport, defaultDistributionDeps } from '~/core/distribution-doctor';
import { resolveRepoRootForCreate } from '~/core/fs';
import {
  type BuiltinHostId,
  type HostAdapter,
  InvalidHostError,
  getHostAdapter,
  listHostAdapters,
  parseHostId,
} from '~/core/hosts';
import { checkInstructionsForHosts } from '~/core/instruction-bridge';
import { collectMcpInventory } from '~/core/mcp-inventory';
import { collectPermissionFindings } from '~/core/permission-inventory';
import { collectSurfaceInventory } from '~/core/surface-inventory';
import {
  InvalidOutputFormatError,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

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
  },
  run: async ({ args }) => {
    try {
      const format = parseOutputFormat(args.output);
      const hosts = selectedHostIds(args.host);
      const repoRoot = await resolveRepoRootForCreate();
      const report = await checkInstructionsForHosts(hosts, repoRoot);
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
      const report = await collectCapabilityInventory(adapters, repoRoot);
      if (format === 'json') {
        writeJson({
          status: report.finding_count === 0 ? 'ok' : 'drift',
          hosts: report.hosts.map((host) => ({
            host: host.host,
            capabilities: host.capabilities,
            hook_events: host.hook_events,
          })),
          findings: report.findings,
        });
      } else if (report.finding_count === 0) {
        writeHuman(`capability: ok (${report.hosts.length} hosts)`);
      } else {
        for (const finding of report.findings) {
          writeHuman(`${finding.host}\t${finding.kind}\t${finding.capability}\t${finding.message}`);
        }
      }
      exitForFindings(report.finding_count, args.advisory);
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
  },
  async run({ args }) {
    try {
      const format = parseOutputFormat(args.output);
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
  },
  run: async ({ args }) => {
    try {
      const format = parseOutputFormat(args.output);
      const targetRoot = await resolveRepoRootForCreate();
      // Under session-rooting (ADR-0011 D2) the session is rooted at the target;
      // the plugin lives at ${CLAUDE_PLUGIN_ROOT}. Fall back to targetRoot when the
      // env is unset (self-host / co-located layout), preserving prior behavior.
      const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ?? targetRoot;
      const report = collectDistributionReport(defaultDistributionDeps(targetRoot, pluginRoot));
      if (format === 'json') {
        writeJson({
          status: report.finding_count === 0 ? 'ok' : 'drift',
          plugin_root: pluginRoot,
          target_root: targetRoot,
          checks: report.checks,
          axes: report.axes,
        });
      } else if (report.finding_count === 0) {
        writeHuman('distribution: ok — all substrate-axis deployment contracts satisfied');
      } else {
        for (const axis of report.axes) {
          const mark = axis.satisfied ? 'ok' : 'DRIFT';
          writeHuman(
            `${axis.axis}\t${mark}\t${axis.contract}${axis.missing.length > 0 ? ` (missing: ${axis.missing.join(', ')})` : ''}`,
          );
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
  },
});
