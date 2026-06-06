import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { defineCommand } from 'citty';
import { z } from 'zod';
import { defaultApplicabilityDeps, evaluateAxis3FromRepo } from '~/core/e2e/applicability';
import { runJourney } from '~/core/e2e/browser';
import { atomicWriteText, resolveRepoRootForCreate } from '~/core/fs';
import { e2eStep } from '~/schemas/e2e-journey';
import {
  RUNTIME_ERROR_EXIT,
  USAGE_ERROR_EXIT,
  parseOutputFormat,
  writeError,
  writeHuman,
  writeJson,
} from '../util';

/**
 * `ditto e2e run` — surface the M5 browser runtime (`runJourney`) as a thin CLI so
 * the `playwright-e2e` agent (Bash-only; cannot call a TS function) can drive ONE
 * direct-URL journey and persist the `e2eJourney` artifact. No browser present →
 * a schema-legal `result='blocked'` journey (never a download, never a hard fail).
 */
const e2eRunSpec = z.object({
  journey: z.string().min(1),
  url: z.string().min(1),
  steps: z.array(e2eStep).default([]),
  assertions: z.array(z.object({ description: z.string().min(1) })).default([]),
});

const e2eRun = defineCommand({
  meta: {
    name: 'run',
    description: 'Run one browser user journey and write its e2eJourney artifact',
  },
  args: {
    runId: { type: 'string', description: 'Run id → .ditto/runs/<runId>/', required: true },
    json: {
      type: 'string',
      description: 'JSON spec: {journey,url,steps,assertions}',
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
    const parsed = e2eRunSpec.safeParse(raw);
    if (!parsed.success) {
      writeError('--json failed schema validation:');
      for (const issue of parsed.error.issues) {
        writeError(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
      }
      process.exit(USAGE_ERROR_EXIT);
      return;
    }
    try {
      const repoRoot = await resolveRepoRootForCreate();
      const result = await runJourney(repoRoot, args.runId, parsed.data);
      const runDir = join(repoRoot, '.ditto', 'runs', args.runId);
      await mkdir(runDir, { recursive: true });
      await atomicWriteText(
        join(runDir, 'journey.json'),
        `${JSON.stringify(result.journey, null, 2)}\n`,
      );
      if (format === 'json') {
        writeJson(result);
      } else {
        writeHuman(`e2e run ${result.run_id}: ${result.journey.result}`);
        writeHuman(`  artifact: .ditto/runs/${result.run_id}/journey.json`);
        if (!result.probe.available) writeHuman(`  (blocked: ${result.probe.reason})`);
      }
    } catch (err) {
      writeError(`e2e run failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

const e2eApplicable = defineCommand({
  meta: {
    name: 'applicable',
    description:
      'Decide whether axis-3 (browser E2E) applies to this target, or is N/A (no web UI)',
  },
  args: {
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
    try {
      const repoRoot = await resolveRepoRootForCreate();
      const result = evaluateAxis3FromRepo(defaultApplicabilityDeps(repoRoot));
      if (format === 'json') {
        writeJson(result);
      } else {
        writeHuman(`axis-3 e2e: ${result.applicable ? 'APPLICABLE' : 'N/A'} — ${result.reason}`);
        if (!result.applicable) {
          writeHuman(`  covered by: ${result.covered_by.join('; ')}`);
        }
      }
    } catch (err) {
      writeError(`e2e applicable failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(RUNTIME_ERROR_EXIT);
    }
  },
});

export const e2eCommand = defineCommand({
  meta: {
    name: 'e2e',
    description: 'Run a real-browser user journey and capture its evidence artifact',
  },
  subCommands: {
    run: e2eRun,
    applicable: e2eApplicable,
  },
});
