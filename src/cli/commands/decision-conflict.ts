import { defineCommand } from 'citty';
import { z } from 'zod';
import { decisionConflictGate } from '~/core/gates';
import { decisionConflict } from '~/schemas/decision-conflict-carrier';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/**
 * `ditto decision-conflict gate` — route detected ADR conflicts (ADR-0020).
 * The producer (an agent that judged conflicts while processing a request)
 * declares each conflict (adr_id, kind, level, basis) and the mode; the gate
 * returns per-conflict dispositions and whether the run is blocked / needs
 * approval, and ALWAYS echoes the basis (D2 transparency — a conflict is never
 * resolved silently). A non-zero exit means a conflict must not silently proceed
 * (an intent conflict: `block` under autopilot, `ask_user` when interactive) —
 * align with the ADR or deliberately supersede it before closing the node.
 *
 * WHETHER a conflict exists and its (kind, level) is the caller's judgement
 * (host-delegated, ADR-0001); this command is the deterministic routing surface.
 */
const gateInput = z.object({
  mode: z.enum(['interactive', 'autopilot']).default('autopilot'),
  conflicts: z.array(decisionConflict).default([]),
});

const decisionConflictGateCmd = defineCommand({
  meta: {
    name: 'gate',
    description:
      'Route detected ADR conflicts by (kind, level, mode); block intent conflicts, disclose all',
  },
  args: {
    json: {
      type: 'string',
      description:
        'JSON: {mode:"interactive"|"autopilot", conflicts:[{adr_id,kind:forbid|require|prefer,level:intent|method,basis}]}',
      required: true,
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
      return;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(args.json);
    } catch (err) {
      writeError(`--json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const parsed = gateInput.safeParse(raw);
    if (!parsed.success) {
      writeError('--json failed schema validation:');
      for (const issue of parsed.error.issues) {
        writeError(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    const result = decisionConflictGate(parsed.data.conflicts, parsed.data.mode);
    const status = result.blocked
      ? 'BLOCKED'
      : result.needsApproval
        ? 'NEEDS APPROVAL'
        : result.disclose
          ? 'DISCLOSE'
          : 'CLEAR';
    if (format === 'json') {
      writeJson(result);
    } else {
      writeHuman(`decision-conflict gate: ${status}`);
      for (const d of result.dispositions) {
        writeHuman(
          `  - ${d.conflict.adr_id} (${d.conflict.kind}/${d.conflict.level}) → ${d.route}: ${d.conflict.basis}`,
        );
      }
    }
    if (result.blocked || result.needsApproval) process.exit(RUNTIME_ERROR_EXIT);
  },
});

export const decisionConflictCommand = defineCommand({
  meta: {
    name: 'decision-conflict',
    description:
      'ADR decision-conflict guardrail (ADR-0020): route + disclose detected ADR conflicts',
  },
  subCommands: {
    gate: decisionConflictGateCmd,
  },
});
