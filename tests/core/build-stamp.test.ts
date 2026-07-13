import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { STAMP_PREFIX, computeSourceStamp, readEmbeddedStamp } from '~/core/build-stamp';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-stamp-'));
  await mkdir(join(dir, 'src', 'sub'), { recursive: true });
  await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(join(dir, 'src', 'sub', 'b.ts'), 'export const b = 2;\n');
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('computeSourceStamp (R5 build drift stamp)', () => {
  test('deterministic across calls', async () => {
    expect(computeSourceStamp(dir)).toBe(computeSourceStamp(dir));
    expect(computeSourceStamp(dir)).toMatch(/^[a-f0-9]{64}$/);
  });

  test('changes when a source file content changes', async () => {
    const before = computeSourceStamp(dir);
    await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
    expect(computeSourceStamp(dir)).not.toBe(before);
  });

  test('changes when a source file is added; ignores non-.ts files', async () => {
    const before = computeSourceStamp(dir);
    await writeFile(join(dir, 'src', 'notes.md'), '# not source\n');
    expect(computeSourceStamp(dir)).toBe(before);
    await writeFile(join(dir, 'src', 'c.ts'), 'export const c = 3;\n');
    expect(computeSourceStamp(dir)).not.toBe(before);
  });
});

describe('builder ↔ doctor algorithm sync', () => {
  test('scripts/build-bin.mjs sourceStamp equals computeSourceStamp over the real repo', async () => {
    // The two implementations are duplicated (mjs cannot import TS); this pins
    // them byte-for-byte — if one changes alone, the drift guard itself drifts.
    // @ts-expect-error -- no declaration file for the plain-ESM .mjs module (allowJs off)
    const { sourceStamp } = await import('../../scripts/build-bin.mjs');
    expect(sourceStamp()).toBe(computeSourceStamp(process.cwd()));
  });
});

describe('readEmbeddedStamp', () => {
  test('roundtrip: extracts the stamp the builder appends', () => {
    const stamp = computeSourceStamp(dir);
    const bundle = `#!/usr/bin/env bun\nbundle()\n${STAMP_PREFIX}${stamp}\n`;
    expect(readEmbeddedStamp(bundle)).toBe(stamp);
  });

  test('null when no marker is present (pre-stamp build)', () => {
    expect(readEmbeddedStamp('#!/usr/bin/env bun\nbundle()\n')).toBeNull();
  });

  test('uses the LAST marker (a bundle may quote the prefix in source strings)', () => {
    const real = 'f'.repeat(64);
    const bundle = `const STAMP_PREFIX = '${STAMP_PREFIX}';\n${STAMP_PREFIX}${real}\n`;
    expect(readEmbeddedStamp(bundle)).toBe(real);
  });
});
