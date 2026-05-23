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
