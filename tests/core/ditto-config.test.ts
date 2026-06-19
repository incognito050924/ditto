import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readQuestionConfigDefaults } from '~/core/ditto-config';

describe('readQuestionConfigDefaults — per-user .ditto/local/config.json (wi_260619jmu)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-config-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function writeConfig(content: string): Promise<void> {
    const dir = join(repo, '.ditto', 'local');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'config.json'), content, 'utf8');
  }

  test('reads tech_spec.question back from the config file', async () => {
    await writeConfig(
      JSON.stringify({ tech_spec: { question: { performance: 'exhaustive', generators: 5 } } }),
    );
    expect(await readQuestionConfigDefaults(repo)).toEqual({
      performance: 'exhaustive',
      generators: 5,
    });
  });

  test('absent file → {} (fail-open)', async () => {
    expect(await readQuestionConfigDefaults(repo)).toEqual({});
  });

  test('malformed JSON → {} (fail-open, never throws)', async () => {
    await writeConfig('{ not json');
    expect(await readQuestionConfigDefaults(repo)).toEqual({});
  });

  test('schema-invalid (out-of-bounds) → {} (fail-open)', async () => {
    // generators 99 violates the 1..6 bound → whole config rejected, returns {}
    await writeConfig(JSON.stringify({ tech_spec: { question: { generators: 99 } } }));
    expect(await readQuestionConfigDefaults(repo)).toEqual({});
  });

  test('config present but no tech_spec.question block → {}', async () => {
    await writeConfig(JSON.stringify({ tech_spec: {} }));
    expect(await readQuestionConfigDefaults(repo)).toEqual({});
  });

  test('onMalformed fires only when a present file fails to parse (not absent/valid)', async () => {
    let calls = 0;
    const onMalformed = () => {
      calls++;
    };
    // absent file → fail-open, NOT malformed (no warning)
    await readQuestionConfigDefaults(repo, onMalformed);
    expect(calls).toBe(0);
    // valid config → no warning
    await writeConfig(JSON.stringify({ tech_spec: { question: { generators: 3 } } }));
    await readQuestionConfigDefaults(repo, onMalformed);
    expect(calls).toBe(0);
    // present + invalid JSON → warning (fail-open still returns {})
    await writeConfig('{ not json');
    expect(await readQuestionConfigDefaults(repo, onMalformed)).toEqual({});
    expect(calls).toBe(1);
    // present + schema-invalid → warning
    await writeConfig(JSON.stringify({ tech_spec: { question: { generators: 99 } } }));
    await readQuestionConfigDefaults(repo, onMalformed);
    expect(calls).toBe(2);
  });
});
