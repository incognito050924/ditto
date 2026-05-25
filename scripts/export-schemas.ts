import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ZodTypeAny } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { completionContract } from '~/schemas/completion-contract';
import { commandLogEntry } from '~/schemas/evidence-log';
import { glossary } from '~/schemas/glossary';
import { languageLedger } from '~/schemas/language-ledger';
import { reviewerOutput } from '~/schemas/reviewer-output';
import { runManifest } from '~/schemas/run-manifest';
import { workItem } from '~/schemas/work-item';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'schemas');

const exports: Array<{ name: string; schema: ZodTypeAny }> = [
  { name: 'work-item', schema: workItem },
  { name: 'run-manifest', schema: runManifest },
  { name: 'completion-contract', schema: completionContract },
  { name: 'reviewer-output', schema: reviewerOutput },
  { name: 'glossary', schema: glossary },
  { name: 'language-ledger', schema: languageLedger },
  { name: 'command-log-entry', schema: commandLogEntry },
];

await mkdir(outDir, { recursive: true });

for (const { name, schema } of exports) {
  const json = zodToJsonSchema(schema, {
    name,
    $refStrategy: 'none',
    target: 'jsonSchema7',
  });
  const path = join(outDir, `${name}.schema.json`);
  await writeFile(path, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  console.log(`wrote ${path}`);
}
