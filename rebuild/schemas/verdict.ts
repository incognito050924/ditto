import { z } from 'zod';

export const verdict = z.enum(['pass', 'fail', 'partial', 'unverified']);

export type Verdict = z.infer<typeof verdict>;
