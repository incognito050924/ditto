import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { decideGate, type GateResult } from '../schemas';
import {
  boundaryEnvelope,
  type AgentText,
  type BoundaryEnvelope,
  type DriveStepInput,
  type DriveStepOutput,
  type FanoutTask,
  type HostAdapter,
} from './host-adapter';

// Injected I/O boundary — the ONLY place real process/disk I/O happens. Keeping
// the crossings behind this seam lets LiveHost's validation/sealing logic be
// unit-tested with a fake, exactly like CodexDeps does for codexCrossCheck.
export interface HostDeps {
  runDrive(input: DriveStepInput): { sessionId: string; boundaryJson: string };
  runFanout(tasks: readonly FanoutTask[]): string[]; // raw free-text per agent
  readFile(path: string): string;
}

// A subagent's final message is opaque free text; this is the only place a plain
// string crosses into the sealed type (mirrors FakeHost's `seal`), and it never
// becomes queue truth.
const seal = (s: string): AgentText => s as AgentText;

/**
 * Live HostAdapter: carries the validation/sealing logic, delegating every real
 * process/disk crossing to an injected HostDeps. The structured boundary is the
 * ONLY queue oracle, so it is schema-validated fail-closed on any drift.
 */
export class LiveHost implements HostAdapter {
  constructor(private readonly deps: HostDeps) {}

  // Fresh-context CLI drive step; the structured boundary is the queue oracle.
  async driveStep(input: DriveStepInput): Promise<DriveStepOutput> {
    const { sessionId, boundaryJson } = this.deps.runDrive(input);
    // Validate at the boundary → fail-closed on schema drift (rejects).
    const boundary: BoundaryEnvelope = boundaryEnvelope.parse(
      JSON.parse(boundaryJson),
    );
    return { sessionId, boundary };
  }

  // Per-turn completion gate — same fail-closed rule as any adapter.
  stopGate(signal: { outcome?: 'pass' | 'fail'; grounds?: string }): GateResult {
    return decideGate(signal);
  }

  // Parallel isolated subagent fanout; returns opaque free text only.
  async fanout(tasks: readonly FanoutTask[]): Promise<AgentText[]> {
    return this.deps.runFanout(tasks).map(seal);
  }

  // Read an agent-written JSON sidecar and validate it fail-closed (rejects).
  async readSidecar<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return schema.parse(JSON.parse(this.deps.readFile(path)));
  }
}

// The boundary JSON Schema handed to `claude --json-schema` is DERIVED from the
// zod boundaryEnvelope (schema SoT, invariant 9) — never hand-duplicated. Refs
// are inlined so the CLI's structured-output enforcement needs no $ref resolver.
const BOUNDARY_JSON_SCHEMA = JSON.stringify(
  zodToJsonSchema(boundaryEnvelope, { $refStrategy: 'none' }),
);

// `claude --print --output-format json` prefixes an OSC terminal-title escape
// before the JSON object; slice from the first brace to get parseable JSON.
function parseCliJson(raw: string): {
  session_id?: string;
  structured_output?: unknown;
  result?: string;
} {
  const start = raw.indexOf('{');
  if (start < 0) throw new Error('claude CLI returned no JSON object');
  return JSON.parse(raw.slice(start));
}

// Injectable process crossing so the flag/opts construction is unit-testable
// without a real CLI (mirrors HostDeps: the ONE place real spawning happens).
export interface ClaudeSpawnOpts {
  cwd?: string;
  timeoutMs?: number;
}
export type ClaudeSpawn = (args: string[], opts: ClaudeSpawnOpts) => string;

const realClaudeSpawn: ClaudeSpawn = (args, opts) =>
  execFileSync('claude', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
  });

/**
 * Per-workspace drive knobs. When a nested AUTONOMOUS session must run inside an
 * ephemeral workspace that carries its OWN Stop-hook settings, these inject that
 * hook + headless autonomy spawn-scoped — WITHOUT ever editing the repo-global
 * .claude/settings.json. All optional: the repo-global default (liveHostDeps)
 * leaves them off, so an ordinary drive step is unchanged.
 */
export interface LiveDriveConfig {
  cwd?: string; // spawn cwd = the ephemeral workspace dir
  settingsPath?: string; // --settings <path>: spawn-scoped hook injection
  skipPermissions?: boolean; // --dangerously-skip-permissions: headless autonomy
  timeoutMs?: number; // per-subprocess timeout (cost/hang bound)
}

/**
 * Live HostDeps backed by the real Claude Code CLI (verified live, #63).
 * - runDrive: a fresh/resumed `--print` step whose `--json-schema` forces the
 *   structured boundary (the queue oracle); returns session_id + that boundary.
 *   When `config` carries workspace knobs it also injects --settings (the Stop
 *   hook), --dangerously-skip-permissions, and spawn cwd — all driven by the
 *   injected config so the flag construction is unit-testable.
 * - runFanout: one isolated `--print` call per task, returning its free text
 *   (agentType-to-subagent mapping is later orchestration, out of this scope).
 * - readFile: the real readFileSync.
 */
export function makeLiveHostDeps(
  config: LiveDriveConfig = {},
  spawn: ClaudeSpawn = realClaudeSpawn,
): HostDeps {
  const spawnOpts: ClaudeSpawnOpts = {};
  if (config.cwd !== undefined) spawnOpts.cwd = config.cwd;
  if (config.timeoutMs !== undefined) spawnOpts.timeoutMs = config.timeoutMs;
  return {
    runDrive: (input) => {
      const args = [
        '--print',
        '--output-format',
        'json',
        '--json-schema',
        BOUNDARY_JSON_SCHEMA,
      ];
      if (config.settingsPath) args.push('--settings', config.settingsPath);
      if (config.skipPermissions) args.push('--dangerously-skip-permissions');
      if (input.resume) args.push('--resume', input.resume);
      args.push(input.prompt);
      const json = parseCliJson(spawn(args, spawnOpts));
      return {
        sessionId: json.session_id ?? '',
        boundaryJson: JSON.stringify(json.structured_output),
      };
    },
    runFanout: (tasks) =>
      tasks.map((task) => {
        const json = parseCliJson(
          spawn(['--print', '--output-format', 'json', task.prompt], spawnOpts),
        );
        return json.result ?? '';
      }),
    readFile: (path) => readFileSync(path, 'utf8'),
  };
}

// Repo-global default: no workspace knobs (ordinary drive step, verified #63).
export const liveHostDeps: HostDeps = makeLiveHostDeps();
