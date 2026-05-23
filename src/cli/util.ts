import { stderr, stdout } from 'node:process';

export type OutputFormat = 'human' | 'json';

export class InvalidOutputFormatError extends Error {
  constructor(public readonly value: string) {
    super(`invalid --output value "${value}"; expected one of: human, json`);
    this.name = 'InvalidOutputFormatError';
  }
}

/**
 * Strict parser: only "human" or "json" are accepted. Undefined returns
 * the human default. Any other value throws InvalidOutputFormatError so
 * the caller can render a usage error and exit 65.
 */
export function parseOutputFormat(value: string | undefined): OutputFormat {
  if (value === undefined) return 'human';
  if (value === 'human' || value === 'json') return value;
  throw new InvalidOutputFormatError(value);
}

export function writeJson(value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function writeHuman(text: string): void {
  stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

export function writeError(text: string): void {
  stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

export const NOT_IMPLEMENTED_EXIT = 64;
export const USAGE_ERROR_EXIT = 65;
export const RUNTIME_ERROR_EXIT = 1;

/**
 * Extract args after `--` from process.argv. Returns null if `--` is absent.
 * Used by `ditto verify` to pass through arbitrary user commands without
 * shell escaping.
 */
export function extractDashDashTail(argv: readonly string[] = process.argv): string[] | null {
  const idx = argv.indexOf('--');
  if (idx === -1) return null;
  return argv.slice(idx + 1);
}
