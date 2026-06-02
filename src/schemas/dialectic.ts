import { z } from 'zod';
import {
  evidenceRef,
  isoDateTime,
  providerName,
  reviewId,
  schemaVersion,
  severity,
} from './common';

export const dialecticMode = z
  .enum(['create', 'review', 'decision', 'proposal', 'document', 'final-answer'])
  .describe('What the three roles work on and produce');

export const reviewBudget = z.enum(['small', 'standard', 'thorough']);

// flag② — synthesizer verdict is its own enum, distinct from completion verdict.
export const dialecticVerdict = z
  .enum(['accept', 'revise', 'reject', 'blocked'])
  .describe('Synthesizer verdict on the deliberation');

export const opponentFallbackReason = z
  .enum(['auth', 'network', 'cost', 'runtime', 'none'])
  .describe('Why the opponent fell back from the preferred model');

export const dialecticInput = z
  .object({
    mode: dialecticMode,
    target_artifact: z.string().min(1).describe('Path or inline brief under deliberation'),
    question: z.string().min(1).describe('What must be agreed on'),
    intent_refs: z.array(z.string()).default([]),
    acceptance_refs: z.array(z.string()).default([]),
    evidence_refs: z.array(evidenceRef).default([]),
    constraints: z
      .object({
        scope_guard: z.array(z.string()).default([]),
        non_goals: z.array(z.string()).default([]),
        review_budget: reviewBudget.default('standard'),
        max_rounds: z.number().int().positive().default(1),
      })
      .default({}),
    model_policy: z
      .object({
        producer: z.string().min(1).default('current-host'),
        opponent_preferred: z.string().min(1).default('codex'),
        opponent_fallback: z.array(z.string()).default([]),
        synthesizer: z.string().min(1).default('claude-opus'),
      })
      .default({}),
  })
  .describe('Dialectic input (§5.2)');

export const dialecticProducer = z
  .object({
    position: z.string().min(1),
    proposal: z.string().min(1),
    evidence: z.array(evidenceRef).default([]),
    assumptions: z.array(z.string()).default([]),
    known_limits: z.array(z.string()).default([]),
  })
  .describe('Producer output: best argument for the draft (§5.3)');

export const opponentObjection = z
  .object({
    // flag① — reuse the common severity enum (info|low|medium|high|critical).
    // Admissible objections downstream are critical|high (stop.ts ADMISSIBLE_SEVERITIES).
    severity: severity,
    id: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Stable objection id; lets the synthesizer resolve by id instead of echoing claim verbatim',
      ),
    claim: z.string().min(1),
    evidence: z.array(evidenceRef).default([]),
    maps_to: z.string().min(1).describe('AC, file:line, intent, or doc the objection links to'),
    failure_mode: z.string().min(1),
    required_fix: z.string().min(1),
  })
  .describe('One opponent objection, linked to an oracle (§5.3, §6)');

export const dialecticOpponent = z
  .object({
    run: z.object({
      provider: providerName,
      model: z.string().min(1),
      command: z.string().min(1),
      timestamp: isoDateTime,
      fallback_from: providerName.nullable().default(null),
      fallback_reason: opponentFallbackReason.default('none'),
    }),
    objections: z.array(opponentObjection).default([]),
    missing_alternatives: z.array(z.string()).default([]),
    scope_creep_risks: z.array(z.string()).default([]),
    verification_gaps: z.array(z.string()).default([]),
  })
  .describe('Opponent output with run provenance (§5.3)');

export const dialecticSynthesizer = z
  .object({
    verdict: dialecticVerdict,
    synthesis: z.string().min(1),
    accepted_objections: z.array(z.string()).default([]),
    rejected_objections: z
      .array(
        z.object({
          objection: z.string().min(1),
          reason: z.string().min(1).describe('Why not accepted; as much grounding as a raise'),
          evidence: z.array(evidenceRef).default([]),
        }),
      )
      .default([]),
    required_edits: z.array(z.string()).default([]),
    remaining_open_questions: z.array(z.string()).default([]),
    evidence_refs: z.array(evidenceRef).default([]),
  })
  .describe('Synthesizer output: agreed final position (§5.3)');

export const dialectic = z
  .object({
    schema_version: schemaVersion,
    review_id: reviewId,
    input: dialecticInput,
    producer: dialecticProducer,
    opponent: dialecticOpponent,
    synthesizer: dialecticSynthesizer,
  })
  .describe('Full three-role dialectic deliberation artifact (§6.6)');

export type Dialectic = z.infer<typeof dialectic>;
