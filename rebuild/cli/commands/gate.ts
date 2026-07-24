import { defineCommand } from 'citty';

import type { BarrierRun } from '../../gate/barrier';
import {
  closeWorkItemWithGates,
  MissingReEntryError,
  type CloseInputs,
} from '../../gate/close';
import {
  decisionConflictGate,
  type ConflictKind,
  type ConflictLevel,
  type DecisionConflict,
  type GateMode,
} from '../../gate/decision-conflict';
import {
  execPushGate,
  type PushGateConfig,
  type RunTest,
} from '../../gate/push-gate';
import { acOracle, type AcOracle } from '../../schemas/oracle';
import type { ReEntry } from '../../schemas/work-item-record';
import { WorkItemNotFoundError } from '../../record/store';
import { findRepoRoot } from '../../util/fs';
import { RUNTIME_ERROR_EXIT, USAGE_ERROR_EXIT, parseOutputFormat, writeError, writeHuman, writeJson } from '../util';

/**
 * `ditto gate` (rebuild host surface) — a thin front over the REBUILT gate
 * engine only. It exposes exactly the capabilities the rebuild backs today with
 * plain (host-free) inputs:
 *  - push     : execPushGate            (fail-closed pre-push gate)
 *  - close    : closeWorkItemWithGates  (multi-gate completion close)
 *  - conflict : decisionConflictGate    (pure ADR-conflict routing)
 *
 * The old `push-gate` command was recipe-driven (loadResolvedRecipe +
 * resolvePushGateRoot) and used the shared `runTestCommand` runner. The rebuild
 * engine ships NEITHER a recipe loader NOR a test-runner, so this surface takes
 * the resolved gate directly from flags and provides the injected `runTest` as a
 * small spawner at the CLI boundary — the engine keeps spawning as a seam on
 * purpose (the core is pure). The green-tree cache wiring
 * (treeState/greenCache/recordGreen) is OMITTED: it needs git-tree computation +
 * a cache file with no rebuild construction, and absent = "no cache" (never a
 * false skip), which is faithful.
 */

const CONFLICT_KINDS: readonly ConflictKind[] = ['forbid', 'require', 'prefer'];
const CONFLICT_LEVELS: readonly ConflictLevel[] = ['intent', 'method'];

function parseMode(value: string): GateMode {
  if (value === 'interactive' || value === 'autopilot') return value;
  throw new Error(`--mode must be interactive|autopilot; got "${value}"`);
}

/** Parse a JSON array of DecisionConflict, validating the discriminant fields. */
function parseConflicts(json: string): DecisionConflict[] {
  const raw: unknown = JSON.parse(json);
  if (!Array.isArray(raw)) throw new Error('conflicts JSON must be an array');
  return raw.map((c, i) => {
    if (typeof c !== 'object' || c === null) throw new Error(`conflicts[${i}] is not an object`);
    const o = c as Record<string, unknown>;
    if (typeof o.adr !== 'string' || o.adr.length === 0) throw new Error(`conflicts[${i}].adr must be a non-empty string`);
    if (typeof o.basis !== 'string') throw new Error(`conflicts[${i}].basis must be a string`);
    if (!CONFLICT_KINDS.includes(o.kind as ConflictKind)) throw new Error(`conflicts[${i}].kind must be forbid|require|prefer`);
    if (!CONFLICT_LEVELS.includes(o.level as ConflictLevel)) throw new Error(`conflicts[${i}].level must be intent|method`);
    return { adr: o.adr, kind: o.kind as ConflictKind, level: o.level as ConflictLevel, basis: o.basis };
  });
}

/** Read all of stdin (git pre-push feeds the ref lines here); empty on failure. */
async function readStdin(): Promise<string> {
  try {
    return await Bun.stdin.text();
  } catch {
    return '';
  }
}

/**
 * `ditto gate push` — the rebuilt fail-closed pre-push gate. Reads git pre-push
 * stdin, takes the resolved gate from flags (--test-command + --protected-branches),
 * and runs the command before allowing a push to a protected branch. Blocks
 * (non-zero exit) on a failing/unrunnable gate or a --malformed-recipe signal;
 * exits 0 otherwise. No gate flags → no gate here → PASS.
 */
const gatePush = defineCommand({
  meta: {
    name: 'push',
    description:
      'Fail-closed pre-push gate: read git pre-push stdin, run the gate test command before a push to a protected branch. Blocks (non-zero) on a failing/unrunnable command or --malformed-recipe; exits 0 otherwise.',
  },
  args: {
    'test-command': {
      type: 'string',
      description: 'The gate test command that must pass. Absent → no gate here (PASS).',
      required: false,
    },
    'protected-branches': {
      type: 'string',
      description: 'Comma-separated protected branch names, or "*" for all. Defaults to "*" when --test-command is set.',
      required: false,
    },
    'malformed-recipe': {
      type: 'boolean',
      description: 'Fail-closed signal: a recipe existed but could not be evaluated → BLOCK.',
      default: false,
    },
    cwd: { type: 'string', description: 'Directory to run the gate command in (default: process.cwd())', required: false },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
    }
    const gate: PushGateConfig | undefined =
      args['test-command'] !== undefined
        ? {
            test_command: args['test-command'],
            protected_branches: (args['protected-branches'] ?? '*')
              .split(',')
              .map((b) => b.trim())
              .filter((b) => b.length > 0),
          }
        : undefined;
    const cwd = args.cwd ?? process.cwd();
    const runTest: RunTest = async (testCommand, runCwd) => {
      try {
        const proc = Bun.spawnSync(['sh', '-c', testCommand], {
          cwd: runCwd,
          stdout: 'inherit',
          stderr: 'inherit',
          stdin: 'ignore',
        });
        return { command: testCommand, exitCode: proc.exitCode };
      } catch {
        return { command: testCommand, spawnFailed: true };
      }
    };
    const stdin = await readStdin();
    try {
      const result = await execPushGate({
        stdin,
        gate,
        malformedRecipe: args['malformed-recipe'],
        runTest,
        cwd,
      });
      if (format === 'json') {
        writeJson(result);
      } else {
        writeHuman(`push gate: ${result.gate.decision.toUpperCase()}${result.cacheHit ? ' (cache hit)' : ''}`);
        if (result.gate.grounds) writeHuman(`  grounds: ${result.gate.grounds}`);
      }
      if (result.gate.decision === 'block') process.exit(RUNTIME_ERROR_EXIT);
    } catch (err) {
      writeError(`push gate failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto gate close` — the rebuilt multi-gate completion close. A PASS-close
 * (final_status=done) is admissible only when every gate agrees: barrier passed
 * AND no blocking conflict AND zero in-scope residue AND every AC oracle
 * satisfied. Anything less lands honestly as blocked/partial/unverified, which
 * REQUIRES a re_entry contract (--re-entry-command or --re-entry-evidence).
 * Exits non-zero when the landing is not `done` so a caller can gate on it.
 */
const gateClose = defineCommand({
  meta: {
    name: 'close',
    description:
      'Close a work item through the completion gates (barrier + conflicts + residual + per-AC oracles). Lands done only when all pass; else parks as blocked/partial/unverified (requires a re_entry) and exits non-zero.',
  },
  args: {
    id: { type: 'positional', description: 'Work item id', required: true },
    actor: { type: 'string', description: 'Actor performing the close', required: true },
    mode: { type: 'string', description: 'Gate mode: interactive|autopilot (default autopilot)', default: 'autopilot' },
    'barrier-command': { type: 'string', description: 'The barrier (unit/mock) test command that was run', required: false },
    'barrier-exit-code': { type: 'string', description: 'Exit code of the barrier run (integer)', required: false },
    'barrier-spawn-failed': { type: 'boolean', description: 'The barrier command failed to spawn', default: false },
    'conflicts-json': {
      type: 'string',
      description: 'JSON array of decision conflicts: [{adr,kind:forbid|require|prefer,level:intent|method,basis}]',
      required: false,
    },
    'oracles-json': {
      type: 'string',
      description: 'JSON array of per-AC oracles overriding the record (see AcOracle schema)',
      required: false,
    },
    'open-risks': { type: 'string', description: 'Comma-separated undisposed risk statements', required: false },
    're-entry-command': { type: 'string', description: 'Re-entry command (required when landing is non-pass)', required: false },
    're-entry-evidence': {
      type: 'string',
      description: 'Comma-separated fresh-evidence descriptions for re-entry (alternative to --re-entry-command)',
      required: false,
    },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
    }

    let mode: GateMode;
    try {
      mode = parseMode(args.mode);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
    }

    let barrierExitCode: number | undefined;
    if (args['barrier-exit-code'] !== undefined) {
      const n = Number(args['barrier-exit-code']);
      if (!Number.isInteger(n)) {
        writeError(`--barrier-exit-code must be an integer; got "${args['barrier-exit-code']}"`);
        process.exit(USAGE_ERROR_EXIT);
      }
      barrierExitCode = n;
    }
    const barrier: BarrierRun = {
      ...(args['barrier-command'] !== undefined ? { command: args['barrier-command'] } : {}),
      ...(barrierExitCode !== undefined ? { exitCode: barrierExitCode } : {}),
      ...(args['barrier-spawn-failed'] ? { spawnFailed: true } : {}),
    };

    let conflicts: DecisionConflict[] | undefined;
    if (args['conflicts-json'] !== undefined) {
      try {
        conflicts = parseConflicts(args['conflicts-json']);
      } catch (err) {
        writeError(`--conflicts-json invalid: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(USAGE_ERROR_EXIT);
      }
    }

    let oracles: AcOracle[] | undefined;
    if (args['oracles-json'] !== undefined) {
      let raw: unknown;
      try {
        raw = JSON.parse(args['oracles-json']);
      } catch (err) {
        writeError(`--oracles-json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(USAGE_ERROR_EXIT);
      }
      const parsed = acOracle.array().safeParse(raw);
      if (!parsed.success) {
        writeError('--oracles-json failed schema validation:');
        for (const issue of parsed.error.issues) writeError(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
        process.exit(USAGE_ERROR_EXIT);
      }
      oracles = parsed.data;
    }

    const openRisks = (args['open-risks'] ?? '')
      .split(',')
      .map((r) => r.trim())
      .filter((r) => r.length > 0);

    const freshEvidence = (args['re-entry-evidence'] ?? '')
      .split(',')
      .map((e) => e.trim())
      .filter((e) => e.length > 0);
    const reEntry: ReEntry | undefined =
      args['re-entry-command'] !== undefined || freshEvidence.length > 0
        ? {
            ...(args['re-entry-command'] !== undefined ? { command: args['re-entry-command'] } : {}),
            ...(freshEvidence.length > 0 ? { fresh_evidence_needed: freshEvidence } : {}),
          }
        : undefined;

    const inputs: CloseInputs = {
      actor: args.actor,
      mode,
      barrier,
      ...(oracles !== undefined ? { oracles } : {}),
      ...(conflicts !== undefined ? { conflicts } : {}),
      ...(openRisks.length > 0 ? { open_risks: openRisks } : {}),
      ...(reEntry !== undefined ? { re_entry: reEntry } : {}),
    };

    const repoRoot = await findRepoRoot();
    try {
      const outcome = await closeWorkItemWithGates(repoRoot, args.id, inputs);
      if (format === 'json') {
        writeJson(outcome);
      } else {
        writeHuman(`gate close ${args.id}: ${outcome.final_status}`);
        writeHuman(`  barrier:   ${outcome.gates.barrier.outcome}`);
        writeHuman(`  conflicts: ${outcome.gates.conflicts.decision}`);
        writeHuman(`  residual:  ${outcome.gates.residual.decision}`);
        for (const [cid, res] of Object.entries(outcome.gates.oracles)) {
          writeHuman(`  oracle ${cid}: ${res.decision}`);
        }
      }
      if (outcome.final_status !== 'done') process.exit(RUNTIME_ERROR_EXIT);
    } catch (err) {
      if (err instanceof MissingReEntryError) {
        writeError(err.message);
        process.exit(USAGE_ERROR_EXIT);
      }
      if (err instanceof WorkItemNotFoundError) {
        writeError(err.message);
        process.exit(RUNTIME_ERROR_EXIT);
      }
      writeError(`gate close failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

/**
 * `ditto gate conflict` — the pure ADR decision-conflict routing gate. WHETHER a
 * conflict exists and its (kind, level) is the caller's judgement; this command
 * only routes deterministically and always discloses the basis. Exits non-zero
 * when any conflict blocks (an intent conflict under autopilot, or an ask_user
 * under interactive).
 */
const gateConflict = defineCommand({
  meta: {
    name: 'conflict',
    description:
      'Route detected ADR conflicts by (kind, level, mode) and always disclose the basis. Blocks (non-zero) on an intent conflict (autopilot) or an interactive ask_user.',
  },
  args: {
    json: {
      type: 'string',
      description: 'JSON array of conflicts: [{adr,kind:forbid|require|prefer,level:intent|method,basis}]',
      required: true,
    },
    mode: { type: 'string', description: 'Gate mode: interactive|autopilot (default autopilot)', default: 'autopilot' },
    output: { type: 'string', description: 'Output format: human|json', default: 'human' },
  },
  run: async ({ args }) => {
    let format: ReturnType<typeof parseOutputFormat>;
    try {
      format = parseOutputFormat(args.output);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
    }
    let mode: GateMode;
    try {
      mode = parseMode(args.mode);
    } catch (err) {
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
    }
    let conflicts: DecisionConflict[];
    try {
      conflicts = parseConflicts(args.json);
    } catch (err) {
      writeError(`--json invalid: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
    }
    let result: ReturnType<typeof decisionConflictGate>;
    try {
      result = decisionConflictGate(conflicts, mode);
    } catch (err) {
      // routeDecisionConflict refuses an empty basis (silent auto-compliance).
      writeError(err instanceof Error ? err.message : String(err));
      process.exit(USAGE_ERROR_EXIT);
    }
    if (format === 'json') {
      writeJson(result);
    } else {
      writeHuman(`conflict gate: ${result.decision.toUpperCase()}`);
      for (const r of result.routed) {
        writeHuman(`  - ${r.conflict.adr} (${r.conflict.kind}/${r.conflict.level}) → ${r.disposition}: ${r.basis}`);
      }
    }
    if (result.decision === 'block') process.exit(RUNTIME_ERROR_EXIT);
  },
});

export const gateCommand = defineCommand({
  meta: {
    name: 'gate',
    description: 'Rebuilt gates — fail-closed pre-push (push), multi-gate completion close (close), ADR-conflict routing (conflict)',
  },
  subCommands: {
    push: gatePush,
    close: gateClose,
    conflict: gateConflict,
  },
});
