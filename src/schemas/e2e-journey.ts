import { z } from 'zod';
import { relativePath, schemaVersion, sha256, workItemId } from './common';

/**
 * E2EJourneyContract (설계서 §6 line 145, §10 "E2E 테스트 설계 (post-v0)").
 *
 * Real-browser user-journey verification — distinct from code-level tests. The
 * executor is direct Playwright/Chromium (not MCP, §10). Artifacts (screenshots,
 * trace, console, network) live under `.ditto/runs/<id>/` (gitignored raw) and
 * are referenced here by path + optional sha256 — never embedded.
 *
 * v0 status: *design-locked contract*. The `playwright-e2e` agent / `/ditto:e2e`
 * skill / actual browser capture are post-v0 (M5) runtime (설계서 §0/§10; M1.5b
 * asserts the agent absent in v0). See `reports/design/contracts/e2e-journey-contract.md`.
 */

export const e2eResult = z
  .enum(['pass', 'fail', 'blocked'])
  .describe('Journey outcome: pass, fail (assertion/step failed), or blocked (could not run)');

export const e2eStep = z
  .object({
    action: z.string().min(1).describe('User action performed, e.g. "click Login"'),
    target: z.string().optional().describe('Selector/URL/element the action targets'),
    expectation: z.string().optional().describe('What should be observable after the action'),
  })
  .describe('One step in the user journey');

export const e2eAssertion = z
  .object({
    description: z.string().min(1).describe('What is being asserted about the journey'),
    satisfied: z.boolean().describe('Whether the assertion held when the journey ran'),
  })
  .describe('A checked assertion about the journey outcome');

const artifactRef = z
  .object({
    path: relativePath.describe('Repo-relative path under .ditto/runs/<id>/'),
    sha256: sha256.optional(),
  })
  .describe('Pointer to a captured artifact (path + optional hash; raw stays under .ditto/runs)');

export const e2eArtifacts = z
  .object({
    screenshots: z.array(artifactRef).default([]),
    trace: artifactRef.nullable().default(null),
    console: artifactRef.nullable().default(null),
    network: artifactRef.nullable().default(null),
  })
  .describe('Captured browser artifacts (§10)');

export const e2eJourney = z
  .object({
    schema_version: schemaVersion,
    journey: z.string().min(1).describe('User journey name'),
    // ACG binding (WU-5, D4): link an e2eJourney to its ACG JourneySpec and work
    // item WITHOUT overloading `journey` (the human name). Both optional, so every
    // pre-ACG e2eJourney stays valid and existing consumers see no change (acc-b).
    journey_id: z
      .string()
      .min(1)
      .optional()
      .describe('ACG JourneySpec.id this run realizes (D4; distinct from `journey` name)'),
    work_item_id: workItemId.optional().describe('Work item this journey run belongs to (D4)'),
    url: z.string().min(1).describe('Target URL or dev-server entry under test'),
    steps: z.array(e2eStep).default([]),
    assertions: z.array(e2eAssertion).default([]),
    result: e2eResult,
    artifacts: e2eArtifacts.default({}),
    reproduction: z
      .string()
      .min(1)
      .nullable()
      .default(null)
      .describe('Reproduction steps; required when result=fail (설계서 §10 "실패 시 재현 절차")'),
  })
  .superRefine((value, ctx) => {
    if (value.result === 'fail' && value.reproduction === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'result=fail requires reproduction steps',
        path: ['reproduction'],
      });
    }
    if (value.result === 'pass' && value.assertions.some((a) => !a.satisfied)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'result=pass but an assertion is not satisfied',
        path: ['result'],
      });
    }
  })
  .describe('A browser user-journey verification result (§10)');

export type E2EJourney = z.infer<typeof e2eJourney>;
