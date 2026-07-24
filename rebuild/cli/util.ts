import { stderr, stdout } from 'node:process';

/**
 * Thin CLI-output plumbing for the rebuild host surface. Engine-independent: no
 * rebuild capability contract lives here, only stdout/stderr framing and the
 * exit-code vocabulary every command shares. Kept separate from the old
 * `src/cli/util` (that tree imports the pre-rebuild engine via the `~/` alias,
 * which points at `src/`).
 */

export type OutputFormat = 'human' | 'json';

export class InvalidOutputFormatError extends Error {
  constructor(public readonly value: string) {
    super(`invalid --output value "${value}"; expected one of: human, json`);
    this.name = 'InvalidOutputFormatError';
  }
}

/**
 * Strict parser: only "human" or "json" are accepted. Undefined returns the
 * human default. Any other value throws so the caller renders a usage error
 * and exits USAGE_ERROR_EXIT.
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
