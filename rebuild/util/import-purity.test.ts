import { describe, expect, test } from 'bun:test';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Purity-by-injection contract: the rebuild CORE (pure decision logic in drive/,
 * state/, verify/, and hook/stop-gate.ts) must never import the environment-
 * coupled utils (util/fs, util/git, util/paths, util/config) directly. Real
 * I/O and filesystem-layout knowledge are wired only at entry points
 * (hook/stop-hook.ts) and in seam/ — the injected-boundary layer.
 */

const REBUILD_ROOT = join(import.meta.dir, '..');

const CORE_DIRS = ['drive', 'state', 'verify'] as const;
const CORE_FILES = [join('hook', 'stop-gate.ts')] as const;

// Any import path reaching into rebuild/util/ from a core module.
const UTIL_IMPORT = /from\s+['"][^'"]*\butil\/(fs|git|paths|config)['"]/;

async function coreSourceFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const dir of CORE_DIRS) {
    for (const name of await readdir(join(REBUILD_ROOT, dir))) {
      if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
        files.push(join(dir, name));
      }
    }
  }
  files.push(...CORE_FILES);
  return files;
}

describe('core import purity (injection principle)', () => {
  test('no core module imports util/fs or util/git directly', async () => {
    const offenders: string[] = [];
    for (const rel of await coreSourceFiles()) {
      const text = await readFile(join(REBUILD_ROOT, rel), 'utf8');
      if (UTIL_IMPORT.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test('the scan actually covers the core files (guard against a silent no-op)', async () => {
    const files = await coreSourceFiles();
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain(join('hook', 'stop-gate.ts'));
  });
});
