/**
 * ICL tokenizer — turns source text into a flat token stream.
 *
 * Tokens (30 §2 EBNF terminals):
 *  - `string`  : double-quoted, no escape handling needed for v1 (no `"` inside).
 *  - `ident`   : keywords + enum values (bare words: intent, allow, path, ...).
 *  - `note`    : `# <string>` → a note token whose value is the following string.
 *  - `punct`   : one of `{ } ( ) :`
 *  - line comments: `//` to end of line are skipped.
 *
 * Note distinction: `#` introduces a note that, per EBNF `note = "#" , string`,
 * is followed by a quoted string. We emit it as a single `note` token so the
 * parser can attach it to the preceding scope_ref.
 */

export type IclTokenType = 'string' | 'ident' | 'punct' | 'note';

export interface IclToken {
  type: IclTokenType;
  value: string;
  line: number;
}

export class IclTokenizeError extends Error {
  constructor(
    message: string,
    public readonly line: number,
  ) {
    super(message);
    this.name = 'IclTokenizeError';
  }
}

const PUNCT = new Set(['{', '}', '(', ')', ':']);

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_.\-]/.test(ch);
}

export function tokenize(source: string): IclToken[] {
  const tokens: IclToken[] = [];
  let i = 0;
  let line = 1;
  const n = source.length;

  const readString = (): string => {
    // assumes source[i] === '"'
    i += 1; // skip opening quote
    const start = i;
    while (i < n && source[i] !== '"') {
      if (source[i] === '\n') {
        throw new IclTokenizeError('unterminated string literal', line);
      }
      i += 1;
    }
    if (i >= n) {
      throw new IclTokenizeError('unterminated string literal', line);
    }
    const value = source.slice(start, i);
    i += 1; // skip closing quote
    return value;
  };

  while (i < n) {
    const ch = source[i] as string;

    if (ch === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
      continue;
    }

    // line comment
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }

    if (ch === '"') {
      const startLine = line;
      const value = readString();
      tokens.push({ type: 'string', value, line: startLine });
      continue;
    }

    // note: `# "string"`
    if (ch === '#') {
      const startLine = line;
      i += 1;
      // skip spaces between # and the string
      while (i < n && (source[i] === ' ' || source[i] === '\t')) i += 1;
      if (source[i] !== '"') {
        throw new IclTokenizeError('# note must be followed by a quoted string', startLine);
      }
      const value = readString();
      tokens.push({ type: 'note', value, line: startLine });
      continue;
    }

    if (PUNCT.has(ch)) {
      tokens.push({ type: 'punct', value: ch, line });
      i += 1;
      continue;
    }

    if (isIdentChar(ch)) {
      const start = i;
      while (i < n && isIdentChar(source[i] as string)) i += 1;
      tokens.push({ type: 'ident', value: source.slice(start, i), line });
      continue;
    }

    throw new IclTokenizeError(`unexpected character '${ch}'`, line);
  }

  return tokens;
}
