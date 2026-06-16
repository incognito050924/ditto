import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDiagnostics, resolveServer } from '~/core/lsp/client';

const TS_SERVER = resolveServer('typescript');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-lsp-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('resolveServer', () => {
  test('unknown language → null, no throw', () => {
    expect(resolveServer('cobol')).toBeNull();
  });

  test('env override wins when the path exists', async () => {
    const fake = join(dir, 'fake-lsp');
    await writeFile(fake, '#!/bin/sh\n');
    process.env.TYPESCRIPT_LSP_BIN = fake;
    try {
      expect(resolveServer('typescript')).toBe(fake);
    } finally {
      // biome-ignore lint/performance/noDelete: env var must be unset via delete; assigning undefined coerces to the string "undefined"
      delete process.env.TYPESCRIPT_LSP_BIN;
    }
  });
});

// Diagnostics against the real typescript-language-server. Skipped (not failed)
// when the server is not installed, so the suite stays green on machines without it.
describe.if(TS_SERVER !== null)('getDiagnostics (real typescript-language-server)', () => {
  test('a TS file with a type error yields ≥1 diagnostic', async () => {
    const file = join(dir, 'bad.ts');
    await writeFile(file, 'const x: number = "str";\nexport { x };\n');
    const diags = await getDiagnostics(file, { timeoutMs: 15000 });
    expect(diags.length).toBeGreaterThanOrEqual(1);
    expect(diags[0]?.message.length).toBeGreaterThan(0);
  }, 20000);

  test('a clean TS file yields 0 diagnostics', async () => {
    const file = join(dir, 'clean.ts');
    await writeFile(file, 'export const n: number = 42;\n');
    const diags = await getDiagnostics(file, { timeoutMs: 15000 });
    expect(diags).toEqual([]);
  }, 20000);
});

describe('getDiagnostics degrade path (ADR-0018 optional tool)', () => {
  test('non-existent server bin → [] without throwing', async () => {
    const file = join(dir, 'bad.ts');
    await writeFile(file, 'const x: number = "str";\n');
    process.env.TYPESCRIPT_LSP_BIN = '/nonexistent/typescript-language-server';
    try {
      const diags = await getDiagnostics(file, { timeoutMs: 2000 });
      expect(diags).toEqual([]);
    } finally {
      // biome-ignore lint/performance/noDelete: env var must be unset via delete; assigning undefined coerces to the string "undefined"
      delete process.env.TYPESCRIPT_LSP_BIN;
    }
  });

  test('language with no server → [] without throwing', async () => {
    const file = join(dir, 'thing.cob');
    await writeFile(file, 'IDENTIFICATION DIVISION.\n');
    const diags = await getDiagnostics(file, { language: 'cobol', timeoutMs: 2000 });
    expect(diags).toEqual([]);
  });
});
