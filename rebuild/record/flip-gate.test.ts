import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertRebuildRecorderEnabled,
  LegacyRecorderActiveError,
  readRecorderGate,
} from './flip-gate';

async function freshRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'ditto-flip-'));
}

async function writeGate(root: string, content: string): Promise<void> {
  await mkdir(join(root, '.ditto'), { recursive: true });
  await writeFile(join(root, '.ditto', 'recorder.json'), content, 'utf8');
}

describe('flip gate — the single switch for the real recorder', () => {
  test('default (no switch file) is legacy: the old src stays sole recorder', async () => {
    const root = await freshRepo();
    expect(await readRecorderGate(root)).toBe('legacy');
  });

  test('the flipped switch reads rebuild', async () => {
    const root = await freshRepo();
    await writeGate(root, '{"recorder": "rebuild"}');
    expect(await readRecorderGate(root)).toBe('rebuild');
  });

  test('malformed or unknown values fail closed to legacy', async () => {
    const root = await freshRepo();
    await writeGate(root, '{not json');
    expect(await readRecorderGate(root)).toBe('legacy');

    await writeGate(root, '{"recorder": "both"}');
    expect(await readRecorderGate(root)).toBe('legacy');

    await writeGate(root, '{"recorder": 1}');
    expect(await readRecorderGate(root)).toBe('legacy');
  });

  test('assertRebuildRecorderEnabled throws until flipped, passes after', async () => {
    const root = await freshRepo();
    await expect(assertRebuildRecorderEnabled(root)).rejects.toThrow(
      LegacyRecorderActiveError,
    );

    await writeGate(root, '{"recorder": "rebuild"}');
    await expect(assertRebuildRecorderEnabled(root)).resolves.toBeUndefined();
  });
});
