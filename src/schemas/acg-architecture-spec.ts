import { z } from 'zod';
import { acgCatalogEnvelope } from './acg-common';

/**
 * ACG ArchitectureSpec (20-contracts §3) — Clean Architecture's Dependency Rule
 * fixed as a machine-checkable, per-repo declaration. A catalog artifact built
 * once and reused; consumed by the boundary gate (out of v0 scope) and fitness.
 */

export const acgConventions = z
  .object({
    formatter: z
      .object({ cmd: z.string().min(1), on_violation: z.enum(['block', 'warn']).default('block') })
      .optional(),
    linter: z
      .object({ cmd: z.string().min(1), on_violation: z.enum(['block', 'warn']).default('block') })
      .optional(),
    naming: z
      .object({ rule: z.string().min(1), evaluator: z.enum(['deterministic', 'llm_judged']) })
      .optional(),
    approved_patterns: z.array(z.string().min(1)).default([]),
    exceptions: z
      .array(
        z.object({ rule: z.string().min(1), path: z.string().min(1), reason: z.string().min(1) }),
      )
      .default([]),
  })
  .describe('Style/quality consistency policy — deterministic enforcement substrate (§1.1(1))');

export const acgInternalPackage = z
  .object({
    type: z.enum(['glob', 'path']),
    value: z.string().min(1),
  })
  .describe(
    'Internal sibling-module descriptor — `glob`: package-name glob for cross_repo classification; ' +
      '`path`: repo-relative glob locating the local sibling artifact (JAR) for the JVM guard',
  );

export type AcgInternalPackage = z.infer<typeof acgInternalPackage>;

export const acgArchitectureSpec = z
  .object({
    ...acgCatalogEnvelope('acg.architecture-spec.v1'),
    layers: z
      .record(z.string(), z.object({ can_call: z.array(z.string()).default([]) }))
      .default({})
      .describe('Layer name → allowed call targets'),
    public_surfaces: z.array(z.string().min(1)).default([]),
    internal_packages: z
      .array(acgInternalPackage)
      .default([])
      .describe(
        'Internal sibling-module descriptors. `glob` entries are package-name globs (e.g. ' +
          '"kr.co.ecoletree.boxwood.domain.**"): a statically unresolved dep (NOT fromSource) whose ' +
          'package matches one is a sibling module absent from this single-module DB → recorded as ' +
          'ImpactGraph.unresolved{cross_repo}; non-matching packages are third-party (Spring/JDK) and ' +
          'ignored. `path` entries are repo-relative globs locating the local sibling artifacts ' +
          '(e.g. "**/libs/*.jar"): the JVM guard blocks when such a JAR exists but the declaration ' +
          'has a gap (no glob, or a JAR not covered by a path entry).',
      ),
    forbidden_dependencies: z
      .array(
        z.object({ from: z.string().min(1), to: z.string().min(1), reason: z.string().min(1) }),
      )
      .default([]),
    ownership: z
      .array(z.object({ module: z.string().min(1), owner: z.string().min(1) }))
      .default([]),
    module_invariants: z
      .array(z.string().min(1))
      .default([])
      .describe('Generalizable invariants — FitnessFunction promotion candidates'),
    conventions: acgConventions.optional(),
  })
  .describe('ACG ArchitectureSpec — layers, surfaces, forbidden deps, conventions');

export type AcgArchitectureSpec = z.infer<typeof acgArchitectureSpec>;
