import { z } from 'zod';
import { relativePath } from './common';

/**
 * Journey DSL v2 front-matter (wi_2607026qs, clean break — no v1 back-compat).
 *
 * Source files live under `e2e/journeys/<slug>.journey.md` (blocks under
 * `e2e/journeys/blocks/<block-id>.block.md`) with a YAML front-matter block.
 * v2 moves the rich, machine-validatable context (implementation intent,
 * constraints, edge/failure cases, auth/seed/initial-state) INTO the
 * front-matter so the DSL→plan adapter can project it; the markdown BODY stays
 * structural-only (step ids, `블록:` calls, `## 케이스` table) — body semantics
 * remain human-authored, never machine-interpreted (design boundary, ADR-0014).
 * Every NESTED object is `.strict()` so a typo'd field inside rich context fails
 * loud rather than being silently dropped. The TOP-LEVEL front-matter is
 * intentionally NON-strict (forward-compat, wi_2607095fz finding 10): an OLD
 * ditto bundle reading a NEWER journey with an unknown top-level key STRIPS it
 * instead of hard-throwing (which would poison every e2e op on that journey) —
 * mirrors the ditto-config non-strict-parent-strips-unknowns fix; additive fields
 * are carried without a DSL version bump. Credentials are NEVER literal: they are
 * env/secret references only (envRef), resolved at run time — no secret enters the DSL.
 */

const kebab = '[a-z0-9]+(?:-[a-z0-9]+)*';

export const journeyDslId = z
  .string()
  .regex(new RegExp(`^jrn-${kebab}$`), 'journey id must be jrn-<kebab-case>')
  .describe('Journey id: jrn- prefix + kebab-case (machine identity of the journey)');

// Surfaces declare WHERE the journey touches the product, with exactly 3 forms:
// `page:<path>` / `api:<METHOD> <path>` / `component:<repo path|glob>`.
const surfacePattern = /^(?:page:\S.*|api:[A-Z]+ \S.*|component:\S.*)$/;

export const journeySurface = z
  .string()
  .regex(
    surfacePattern,
    'surface must be page:<path> | api:<METHOD> <path> | component:<repo path|glob>',
  )
  .describe('A product surface the journey touches (page:/api:/component: prefixed)');

// Credential/secret indirection: a reference to a process-env or secret var,
// never a literal value. Matches env:VAR / secret:VAR with SCREAMING_SNAKE names.
export const envRef = z
  .string()
  .regex(
    /^(env|secret):[A-Z_][A-Z0-9_]*$/,
    'must be env:<VAR> or secret:<VAR> (no literal credentials)',
  )
  .describe('Env/secret reference (env:VAR | secret:VAR); credentials are never literal');

export const flakyHistoryEntry = z
  .object({
    date: z.string().min(1).describe('When the flake was observed (e.g. 2026-06-01)'),
    case: z.string().min(1).describe('Which case/step flaked'),
    note: z.string().min(1).describe('Context for the next author (env, suspicion, workaround)'),
  })
  .describe('One recorded flaky occurrence of this journey');

export const edgeCase = z
  .object({
    case: z.string().min(1).describe('The edge condition being handled'),
    handling: z.string().min(1).describe('Expected handling / outcome for this edge condition'),
  })
  .strict()
  .describe('A boundary condition the journey must handle gracefully');

export const failureState = z
  .object({
    trigger: z.string().min(1).describe('What triggers the failure path'),
    expected: z.string().min(1).describe('Expected error / recovery behaviour'),
  })
  .strict()
  .describe('A failure path the journey must surface predictably');

export const journeyAuth = z
  .object({
    credentials: z
      .record(envRef)
      .default({})
      .describe('role → env/secret reference (never a literal credential)'),
    login_block: z.string().min(1).optional().describe('Block id performing the login flow'),
    storage_state: relativePath.optional().describe('Repo-relative Playwright storageState file'),
  })
  .strict()
  .describe('Authentication context for the journey (credential-indirected)');

export const journeyInitialState = z
  .object({
    description: z.string().min(1).describe('Human description of the required starting state'),
    setup_ref: z
      .string()
      .min(1)
      .optional()
      .describe('Reference to the setup step/script establishing the state'),
  })
  .strict()
  .describe('Precondition/state the journey assumes before its first step');

export const journeySeed = z
  .object({
    spec_ref: relativePath
      .default('e2e/seed.spec.ts')
      .describe('Repo-relative seed spec run before the journey'),
    data_ref: z
      .union([envRef, relativePath])
      .optional()
      .describe('Seed data source: env/secret ref or a repo-relative file'),
  })
  .strict()
  .describe('Data-seeding context for the journey');

// Per-journey gate control (ac-2, wi_2607095fz): an author can EXCLUDE a journey
// from the e2e gate directly in its committed front-matter (journeys are
// git-tracked repo assets → author self-service, no out-of-band config). exclude
// defaults false (not-excluded); when set true it REQUIRES a non-empty reason so
// an opt-out is never silent. Kept `.strict()` (nested object) so a typo'd key
// inside gate fails loud — see the top-level non-strict decision below.
export const journeyGate = z
  .object({
    exclude: z
      .boolean()
      .default(false)
      .describe('Exclude this journey from the e2e gate (default false = not excluded)'),
    exclude_reason: z
      .string()
      .min(1)
      .optional()
      .describe('Why the journey is excluded (required when exclude=true)'),
  })
  .strict()
  .refine((g) => !g.exclude || (g.exclude_reason?.length ?? 0) > 0, {
    message: 'gate.exclude=true requires a non-empty gate.exclude_reason',
  })
  .describe('Per-journey e2e-gate control (author-settable exclude + reason)');

export const journeyFrontMatter = z
  .object({
    ditto_journey: z
      .literal('v2')
      .describe('Literal DSL marker + version; how a journey file is mechanically identified'),
    id: journeyDslId,
    name: z.string().min(1).describe('Human-facing journey name'),
    description: z.string().min(1).describe('Purpose/value of the journey'),
    surfaces: z.array(journeySurface).min(1).describe('Surfaces the journey touches (≥1)'),
    implementation_intent: z
      .string()
      .min(1)
      .describe('Prose intent → the plan Application Overview (required)'),
    constraints: z
      .array(z.string().min(1))
      .default([])
      .describe('Invariants/constraints → plan Overview bullets'),
    edge_cases: z.array(edgeCase).default([]).describe('Boundary conditions to handle'),
    failure_states: z.array(failureState).default([]).describe('Failure paths to surface'),
    secret_vars: z
      .array(z.string().min(1))
      .default([])
      .describe('Case-table columns holding secrets to mask'),
    auth: journeyAuth.optional().describe('Auth context (credential-indirected)'),
    initial_state: journeyInitialState.optional().describe('Assumed starting state'),
    seed: journeySeed.optional().describe('Data-seeding context'),
    uses_blocks: z
      .array(z.string().min(1))
      .default([])
      .describe('Block ids (blocks/<id>.block.md) this journey composes'),
    flaky_history: z.array(flakyHistoryEntry).default([]).describe('Recorded flaky occurrences'),
    gate: journeyGate.optional().describe('Per-journey e2e-gate control (author-settable exclude)'),
  })
  .describe('Front-matter of an e2e/journeys/<slug>.journey.md file (DSL v2)');

export type JourneyFrontMatter = z.infer<typeof journeyFrontMatter>;

export const blockFrontMatter = z
  .object({
    ditto_block: z
      .literal('v2')
      .describe('Literal DSL marker + version; how a block file is mechanically identified'),
    id: z.string().min(1).describe('Block id (= blocks/<id>.block.md filename stem)'),
    name: z.string().min(1).describe('Human-facing block name'),
    params: z.array(z.string().min(1)).default([]).describe('Parameter names the block accepts'),
  })
  .strict()
  .describe('Front-matter of an e2e/journeys/blocks/<block-id>.block.md file (DSL v2)');

export type BlockFrontMatter = z.infer<typeof blockFrontMatter>;
