import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readDeepInterviewConfigDefaults,
  readGithubConfig,
  readQuestionConfigDefaults,
  writeGithubConfig,
} from '~/core/ditto-config';

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

describe('readDeepInterviewConfigDefaults — deep_interview block (wi_260621p6a)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-config-di-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function writeConfig(content: string): Promise<void> {
    const dir = join(repo, '.ditto', 'local');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'config.json'), content, 'utf8');
  }

  test('reads deep_interview back from the config file', async () => {
    await writeConfig(
      JSON.stringify({ deep_interview: { threshold: 0.85, question_cap: 5, generators: 3 } }),
    );
    expect(await readDeepInterviewConfigDefaults(repo)).toEqual({
      threshold: 0.85,
      question_cap: 5,
      generators: 3,
    });
  });

  test('absent file → {} (fail-open)', async () => {
    expect(await readDeepInterviewConfigDefaults(repo)).toEqual({});
  });

  test('malformed JSON → {} (fail-open, never throws)', async () => {
    await writeConfig('{ not json');
    expect(await readDeepInterviewConfigDefaults(repo)).toEqual({});
  });

  test('schema-invalid (threshold out of [0,1]) → {} (fail-open)', async () => {
    await writeConfig(JSON.stringify({ deep_interview: { threshold: 2 } }));
    expect(await readDeepInterviewConfigDefaults(repo)).toEqual({});
  });

  test('schema-invalid (question_cap non-positive) → {} (fail-open)', async () => {
    await writeConfig(JSON.stringify({ deep_interview: { question_cap: 0 } }));
    expect(await readDeepInterviewConfigDefaults(repo)).toEqual({});
  });

  test('config present but no deep_interview block → {}', async () => {
    await writeConfig(JSON.stringify({ tech_spec: { question: { generators: 3 } } }));
    expect(await readDeepInterviewConfigDefaults(repo)).toEqual({});
  });

  test('partial deep_interview (only generators) → only that key', async () => {
    await writeConfig(JSON.stringify({ deep_interview: { generators: 4 } }));
    expect(await readDeepInterviewConfigDefaults(repo)).toEqual({ generators: 4 });
  });

  test('onMalformed fires only when a present file fails to parse (not absent/valid)', async () => {
    let calls = 0;
    const onMalformed = () => {
      calls++;
    };
    await readDeepInterviewConfigDefaults(repo, onMalformed);
    expect(calls).toBe(0);
    await writeConfig(JSON.stringify({ deep_interview: { generators: 3 } }));
    await readDeepInterviewConfigDefaults(repo, onMalformed);
    expect(calls).toBe(0);
    await writeConfig('{ not json');
    expect(await readDeepInterviewConfigDefaults(repo, onMalformed)).toEqual({});
    expect(calls).toBe(1);
    await writeConfig(JSON.stringify({ deep_interview: { threshold: 9 } }));
    await readDeepInterviewConfigDefaults(repo, onMalformed);
    expect(calls).toBe(2);
  });
});

describe('readGithubConfig / writeGithubConfig — github block (wi_260628d79)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-config-gh-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  const sample = {
    project: { owner: 'incognito050924', number: 5 },
    status_map: { done: 'opt_done', abandoned: 'opt_dropped' },
    auto_reflect: false,
  } as const;

  test('absent file → undefined (fail-open)', async () => {
    expect(await readGithubConfig(repo)).toBeUndefined();
  });

  test('write then read round-trips the github block', async () => {
    await writeGithubConfig(repo, { ...sample });
    expect(await readGithubConfig(repo)).toEqual({ ...sample });
  });

  test('write is idempotent — same value twice yields identical file bytes', async () => {
    await writeGithubConfig(repo, { ...sample });
    const first = await Bun.file(join(repo, '.ditto', 'local', 'config.json')).text();
    await writeGithubConfig(repo, { ...sample });
    const second = await Bun.file(join(repo, '.ditto', 'local', 'config.json')).text();
    expect(second).toBe(first);
  });

  test('writing github PRESERVES an existing tech_spec block (single config store)', async () => {
    const dir = join(repo, '.ditto', 'local');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({ tech_spec: { question: { generators: 3 } } }),
      'utf8',
    );
    await writeGithubConfig(repo, { ...sample });
    expect(await readQuestionConfigDefaults(repo)).toEqual({ generators: 3 });
    expect(await readGithubConfig(repo)).toEqual({ ...sample });
  });

  test('schema-invalid github block (bad status_map key) → undefined (fail-open)', async () => {
    const dir = join(repo, '.ditto', 'local');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'config.json'),
      JSON.stringify({
        github: {
          project: { owner: 'o', number: 5 },
          status_map: { in_progress: 'x' },
          auto_reflect: false,
        },
      }),
      'utf8',
    );
    expect(await readGithubConfig(repo)).toBeUndefined();
  });
});
