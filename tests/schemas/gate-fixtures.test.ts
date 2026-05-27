import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ZodTypeAny } from 'zod';
import { completionContract } from '~/schemas/completion-contract';
import { convergence } from '~/schemas/convergence';
import { dialectic } from '~/schemas/dialectic';
import { handoff } from '~/schemas/handoff';
import { intentContract } from '~/schemas/intent';
import { interviewState } from '~/schemas/interview-state';
import { workItem } from '~/schemas/work-item';

const ROOT = join(import.meta.dir, '..', 'fixtures', 'gates');

function load(rel: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
}

// Each entry: schema, valid fixtures (must parse), invalid fixtures (must throw).
const cases: Array<{ schema: ZodTypeAny; valid: string[]; invalid: string[] }> = [
  {
    schema: interviewState,
    valid: ['interview-state/ready.json', 'interview-state/blocked.json'],
    invalid: ['interview-state/invalid.json'],
  },
  {
    schema: intentContract,
    valid: ['intent/observable-ac.json', 'intent/vague-ac.json'],
    invalid: ['intent/invalid.json'],
  },
  {
    schema: completionContract,
    valid: [
      'completion/pass.json',
      'completion/partial.json',
      'completion/unverified.json',
      'completion-crosscheck/completion-match.json',
      'completion-crosscheck/completion-missing.json',
      'completion-crosscheck/completion-extra.json',
      'completion-crosscheck/completion-duplicate.json',
    ],
    invalid: ['completion/invalid.json'],
  },
  {
    schema: workItem,
    valid: ['completion-crosscheck/workitem.json'],
    invalid: [],
  },
  {
    schema: convergence,
    valid: [
      'convergence/converged.json',
      'convergence/treadmill.json',
      'convergence/early-converge.json',
    ],
    invalid: ['convergence/invalid.json'],
  },
  {
    schema: dialectic,
    valid: ['dialectic/valid.json'],
    invalid: ['dialectic/invalid.json'],
  },
  {
    schema: handoff,
    valid: ['handoff/valid.json'],
    invalid: ['handoff/invalid.json'],
  },
];

describe('gate fixtures parse as expected', () => {
  for (const { schema, valid, invalid } of cases) {
    for (const rel of valid) {
      test(`valid: ${rel}`, () => {
        expect(() => schema.parse(load(rel))).not.toThrow();
      });
    }
    for (const rel of invalid) {
      test(`invalid: ${rel}`, () => {
        expect(() => schema.parse(load(rel))).toThrow();
      });
    }
  }
});
