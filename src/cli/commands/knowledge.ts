import { defineCommand } from 'citty';
import { z } from 'zod';
import { knowledgeUpdateGate } from '~/core/gates';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/**
 * `ditto knowledge gate` — surface the axis-4 durable-change trigger gate
 * (`knowledgeUpdateGate`) so the knowledge-update skill / knowledge-curator can
 * machine-check its recording decision instead of relying on prose heuristic.
 * The caller declares which of the three triggers fired and the per-update record
 * delta it produced; the gate rejects under-recording (a fired trigger with no
 * matching content) and over-recording (content with no trigger). A non-zero exit
 * means the recording is inconsistent — fix it before closing the knowledge node.
 */
const gateInput = z.object({
  triggers: z.object({
    adr_worthy_decision: z.boolean(),
    new_agreed_term: z.boolean(),
    repeated_pattern: z.boolean(),
  }),
  delta: z.object({
    decisions: z.number().int().nonnegative(),
    glossary_terms: z.number().int().nonnegative(),
    patterns: z.number().int().nonnegative(),
    learnings: z.number().int().nonnegative(),
  }),
});

const knowledgeGate = defineCommand({
  meta: {
    name: 'gate',
    description:
      'Check a durable-knowledge recording against the three axis-4 triggers (under/over-recording)',
  },
  args: {
    json: {
      type: 'string',
      description:
        'JSON: {triggers:{adr_worthy_decision,new_agreed_term,repeated_pattern}, delta:{decisions,glossary_terms,patterns,learnings}}',
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
    const result = knowledgeUpdateGate(parsed.data.triggers, parsed.data.delta);
    if (format === 'json') {
      writeJson({ pass: result.pass, reasons: result.reasons });
    } else {
      writeHuman(`knowledge gate: ${result.pass ? 'PASS' : 'FAIL'}`);
      for (const r of result.reasons) writeHuman(`  - ${r}`);
    }
    if (!result.pass) process.exit(RUNTIME_ERROR_EXIT);
  },
});

export const knowledgeCommand = defineCommand({
  meta: {
    name: 'knowledge',
    description: 'Durable-knowledge (axis-4) helpers: trigger gate for the recording decision',
  },
  subCommands: {
    gate: knowledgeGate,
  },
});
