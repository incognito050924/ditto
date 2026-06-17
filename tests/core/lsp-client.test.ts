import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  test('a present-but-mute server (exits without diagnostics) → [] without throwing', async () => {
    const file = join(dir, 'bad.ts');
    await writeFile(file, 'const x: number = "str";\n');
    // The unified detection (provision/lsp-servers) falls a set-but-missing env
    // through to PATH, so genuine absence is covered by the `no server` case
    // below; here a present-but-mute server (spawns, exits 0, emits no diagnostics
    // → stdout closes) forces the stdout-close degrade. The +x is load-bearing:
    // without it Bun.spawn fails EACCES and the spawn-failure path runs instead.
    const stub = join(dir, 'stub-lsp');
    await writeFile(stub, '#!/bin/sh\nexit 0\n');
    await chmod(stub, 0o755);
    process.env.TYPESCRIPT_LSP_BIN = stub;
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
