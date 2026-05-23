import { stderr, stdout } from 'node:process';

export type OutputFormat = 'human' | 'json';

export function parseOutputFormat(value: string | undefined): OutputFormat {
  if (value === 'json') return 'json';
  return 'human';
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
