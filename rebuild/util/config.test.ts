import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { readLocalConfig } from './config';
import { localDir } from './paths';

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'rebuild-config-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeConfig(repoRoot: string, content: string): Promise<void> {
  const path = localDir(repoRoot, 'config.json');
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

const schema = z.object({ threshold: z.number().min(0).max(1) });
const defaults = { threshold: 0.5 };

describe('readLocalConfig', () => {
  test('absent file returns defaults WITHOUT firing onMalformed', async () => {
    await withTempDir(async (repoRoot) => {
      let fired = false;
      const result = await readLocalConfig(repoRoot, schema, defaults, () => {
        fired = true;
      });
      expect(result).toEqual(defaults);
      expect(fired).toBe(false);
    });
  });

  test('malformed JSON returns defaults AND fires onMalformed', async () => {
    await withTempDir(async (repoRoot) => {
      await writeConfig(repoRoot, '{ not json');
      let fired = false;
      const result = await readLocalConfig(repoRoot, schema, defaults, () => {
        fired = true;
      });
      expect(result).toEqual(defaults);
      expect(fired).toBe(true);
    });
  });

  test('schema-invalid content returns defaults AND fires onMalformed', async () => {
    await withTempDir(async (repoRoot) => {
      await writeConfig(repoRoot, JSON.stringify({ threshold: 7 }));
      let fired = false;
      const result = await readLocalConfig(repoRoot, schema, defaults, () => {
        fired = true;
      });
      expect(result).toEqual(defaults);
      expect(fired).toBe(true);
    });
  });

  test('valid content returns the schema-parsed value', async () => {
    await withTempDir(async (repoRoot) => {
      await writeConfig(repoRoot, JSON.stringify({ threshold: 0.9 }));
      let fired = false;
      const result = await readLocalConfig(repoRoot, schema, defaults, () => {
        fired = true;
      });
      expect(result).toEqual({ threshold: 0.9 });
      expect(fired).toBe(false);
    });
  });

  test('onMalformed is optional (malformed without callback still returns defaults)', async () => {
    await withTempDir(async (repoRoot) => {
      await writeConfig(repoRoot, '{ not json');
      const result = await readLocalConfig(repoRoot, schema, defaults);
      expect(result).toEqual(defaults);
    });
  });
});
