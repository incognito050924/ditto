import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { acgArchitectureSpec } from '~/schemas/acg-architecture-spec';
import { acgAssuranceSnapshot } from '~/schemas/acg-assurance-snapshot';
import { acgChangeContract } from '~/schemas/acg-change-contract';
import { acgFitnessFunction } from '~/schemas/acg-fitness-function';
import { acgImpactGraph } from '~/schemas/acg-impact-graph';
import { acgJourneyRun } from '~/schemas/acg-journey-run';
import { acgJourneySpec } from '~/schemas/acg-journey-spec';
import { acgReviewGraph } from '~/schemas/acg-review-graph';
import { acgSemanticCompatibility } from '~/schemas/acg-semantic-compatibility';
import { acgSemanticScanObservation } from '~/schemas/acg-semantic-scan-observation';
import { autopilot } from '~/schemas/autopilot';
import { completionContract } from '~/schemas/completion-contract';
import { convergence } from '~/schemas/convergence';
import { dialectic } from '~/schemas/dialectic';
import { e2eJourney } from '~/schemas/e2e-journey';
import { commandLogEntry, editLogEntry } from '~/schemas/evidence-log';
import { evidenceIndex, evidenceRecord } from '~/schemas/evidence-record';
import { glossary } from '~/schemas/glossary';
import { handoff } from '~/schemas/handoff';
import { intentContract } from '~/schemas/intent';
import { intentMetric } from '~/schemas/intent-metric';
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
  { name: 'edit-log-entry', schema: editLogEntry },
  { name: 'evidence-record', schema: evidenceRecord },
  { name: 'evidence-index', schema: evidenceIndex },
  { name: 'knowledge-record', schema: knowledgeRecord },
  { name: 'e2e-journey', schema: e2eJourney },
  { name: 'intent', schema: intentContract },
  { name: 'intent-metric', schema: intentMetric },
  { name: 'question-gate', schema: questionGate },
  { name: 'interview-state', schema: interviewState },
  { name: 'autopilot', schema: autopilot },
  { name: 'dialectic', schema: dialectic },
  { name: 'convergence', schema: convergence },
  { name: 'handoff', schema: handoff },
  { name: 'acg-change-contract', schema: acgChangeContract },
  { name: 'acg-impact-graph', schema: acgImpactGraph },
  { name: 'acg-architecture-spec', schema: acgArchitectureSpec },
  { name: 'acg-semantic-compatibility', schema: acgSemanticCompatibility },
  { name: 'acg-semantic-scan-observation', schema: acgSemanticScanObservation },
  { name: 'acg-review-graph', schema: acgReviewGraph },
  { name: 'acg-fitness-function', schema: acgFitnessFunction },
  { name: 'acg-assurance-snapshot', schema: acgAssuranceSnapshot },
  { name: 'acg-journey-spec', schema: acgJourneySpec },
  { name: 'acg-journey-run', schema: acgJourneyRun },
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
