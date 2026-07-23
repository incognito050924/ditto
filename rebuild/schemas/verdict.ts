import { z } from 'zod';

export const verdict = z.enum(['pass', 'fail', 'unverified']);

export type Verdict = z.infer<typeof verdict>;
