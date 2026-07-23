import { z } from 'zod';

/**
 * The completion currency: an oracle is a machine-re-evaluable statement of
 * intended behavior/property. An AC closes when its oracle is SATISFIED —
 * "the LLM says it's done" is never the currency.
 *
 * Three verification classes: `dynamic_test` (run something), `static_scan`
 * (re-scan an anchored artifact), `soft_judgment` (review / user decision).
 *
 * Direction rule: forward oracles (authored before the change) may not anchor
 * to code pointers — file:line breaks as the change lands; only backward
 * (finding-based) oracles may point at code.
 */

export const verificationMethod = z.enum([
  'dynamic_test',
  'static_scan',
  'soft_judgment',
]);
export type VerificationMethod = z.infer<typeof verificationMethod>;

export const oracleDirection = z.enum(['forward', 'backward']);
export type OracleDirection = z.infer<typeof oracleDirection>;

export const oracleMapsTo = z
  .object({
    kind: z.enum(['ac', 'intent', 'doc', 'code']),
    ref: z.string().min(1),
  })
  .strict();
export type OracleMapsTo = z.infer<typeof oracleMapsTo>;

export const acOracle = z
  .object({
    criterion_id: z.string().min(1),
    statement: z.string().min(1),
    verification_method: verificationMethod,
    direction: oracleDirection,
    maps_to: oracleMapsTo,
  })
  .strict()
  .refine((o) => !(o.direction === 'forward' && o.maps_to.kind === 'code'), {
    message:
      'forward oracles may not anchor to code pointers — they break on change; only backward findings may map to code',
  });
export type AcOracle = z.infer<typeof acOracle>;
