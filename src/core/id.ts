import { randomBytes } from 'node:crypto';

export type IdPrefix = 'wi' | 'run' | 'rv';

const SUFFIX_LENGTH = 9;
const SUFFIX_CHARSET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function randomSuffix(length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) {
    const byte = bytes[i] ?? 0;
    out += SUFFIX_CHARSET[byte % SUFFIX_CHARSET.length] ?? 'a';
  }
  return out;
}

/**
 * Generate an id like `wi_yyMMddxxx` where xxx is random lowercase alphanumeric.
 * The full suffix (date + random) is always at least 9 chars to satisfy the
 * schema regex `[a-z0-9]{8,}`.
 *
 * `existsCheck` is called for collision detection. If it returns true the
 * generator retries up to `maxAttempts` times before throwing.
 */
export async function generateId(
  prefix: IdPrefix,
  existsCheck: (candidate: string) => Promise<boolean>,
  options: { now?: Date; maxAttempts?: number } = {},
): Promise<string> {
  const now = options.now ?? new Date();
  const maxAttempts = options.maxAttempts ?? 8;
  const yy = String(now.getUTCFullYear() % 100).padStart(2, '0');
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(now.getUTCDate()).padStart(2, '0');
  const datePart = `${yy}${mm}${dd}`;
  // datePart is 6 chars; pad with random to reach SUFFIX_LENGTH minimum
  const randomLen = Math.max(SUFFIX_LENGTH - datePart.length, 3);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidate = `${prefix}_${datePart}${randomSuffix(randomLen)}`;
    if (!(await existsCheck(candidate))) return candidate;
  }
  throw new Error(
    `failed to generate unique ${prefix}_ id after ${maxAttempts} attempts; likely a clock or RNG issue`,
  );
}
