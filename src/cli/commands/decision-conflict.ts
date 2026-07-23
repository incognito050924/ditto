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
 *
 * Surface split: this is a PURE offline gate with no repo root — a per-conflict
 * `resolution` record is accepted by the shared schema but NOT verified here.
 * HEAD verification (superseded-at-HEAD demotion via `splitResolvedConflicts`)
 * belongs to the stop-gate surfaces that own a repo root; this command routes
 * every conflict as if unresolved and says so when a resolution is present.
 */
const gateInput = z.object({
  mode: z.enum(['interactive', 'autopilot']).default('autopilot'),
  conflicts: z.array(decisionConflict).default([]),
});

const decisionConflictGateCmd = defineCommand({
  meta: {
    name: 'gate',
    description:
      "Route detected ADR conflicts by (kind, level, mode); block intent conflicts, disclose all. Pure offline gate: a `resolution` record is accepted but NOT verified here — HEAD verification is the stop gate's job",
  },
  args: {
    json: {
      type: 'string',
      description:
        'JSON: {mode:"interactive"|"autopilot", conflicts:[{adr_id,kind:forbid|require|prefer,level:intent|method,basis,resolution?}]} — resolution is routed as unresolved here (unverified)',
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
      // Surface-split disclosure: this pure gate has no repo root, so it never
      // verifies a resolution claim — it must say so instead of silently routing.
      if (parsed.data.conflicts.some((c) => c.resolution !== undefined)) {
        writeHuman(
          '  note: 해소 기록(resolution)은 stop 게이트가 HEAD 검증으로 판정 — 이 순수 게이트는 미검증 라우팅만 표시',
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
