import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { autopilot } from '~/schemas/autopilot';
import { completionContract } from '~/schemas/completion-contract';
import { convergence } from '~/schemas/convergence';
import { dialectic } from '~/schemas/dialectic';
import { e2eJourney } from '~/schemas/e2e-journey';
import { commandLogEntry } from '~/schemas/evidence-log';
import { evidenceIndex, evidenceRecord } from '~/schemas/evidence-record';
import { glossary } from '~/schemas/glossary';
import { handoff } from '~/schemas/handoff';
import { intentContract } from '~/schemas/intent';
import { interviewState } from '~/schemas/interview-state';
import { knowledgeRecord } from '~/schemas/knowledge-record';
import { languageLedger } from '~/schemas/language-ledger';
import { questionGate } from '~/schemas/question-gate';
import { reviewerOutput } from '~/schemas/reviewer-output';
import { runManifest } from '~/schemas/run-manifest';
import { workItem } from '~/schemas/work-item';

/**
 * Authoritative export registry. Kept manual (one entry per exported JSON
 * schema) but consumed by both the exporter below and the registration test
 * so a schema missing here is caught instead of silently skipped.
 */
export const schemaExports: ReadonlyArray<{ name: string; schema: ZodTypeAny }> = [
  { name: 'work-item', schema: workItem },
  { name: 'run-manifest', schema: runManifest },
  { name: 'completion-contract', schema: completionContract },
  { name: 'reviewer-output', schema: reviewerOutput },
  { name: 'glossary', schema: glossary },
  { name: 'language-ledger', schema: languageLedger },
  { name: 'command-log-entry', schema: commandLogEntry },
  { name: 'evidence-record', schema: evidenceRecord },
  { name: 'evidence-index', schema: evidenceIndex },
  { name: 'knowledge-record', schema: knowledgeRecord },
  { name: 'e2e-journey', schema: e2eJourney },
  { name: 'intent', schema: intentContract },
  { name: 'question-gate', schema: questionGate },
  { name: 'interview-state', schema: interviewState },
  { name: 'autopilot', schema: autopilot },
  { name: 'dialectic', schema: dialectic },
  { name: 'convergence', schema: convergence },
  { name: 'handoff', schema: handoff },
];

export async function exportSchemas(outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  for (const { name, schema } of schemaExports) {
    const json = zodToJsonSchema(schema, { name, $refStrategy: 'none', target: 'jsonSchema7' });
    const path = join(outDir, `${name}.schema.json`);
    await writeFile(path, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
    console.log(`wrote ${path}`);
  }
}

if (import.meta.main) {
  const here = dirname(fileURLToPath(import.meta.url));
  await exportSchemas(resolve(here, '..', 'schemas'));
}
