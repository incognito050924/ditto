import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readDeepInterviewConfigDefaults,
  readGithubConfig,
  readQuestionConfigDefaults,
  seedGithubConfigIfAbsent,
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

describe('seedGithubConfigIfAbsent — bootstrap-once github seed (wi_260629vnt)', () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ditto-config-seed-'));
  });
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  // Full team-shared backlog block: coordinates + status_map + claim_status_map + auto_reflect.
  const backlog = {
    project: { owner: 'team-org', number: 7, node_id: 'PVT_abc' },
    status_map: { done: 'opt_done', abandoned: 'opt_dropped' },
    claim_status_map: { in_progress: 'opt_ip', blocked: 'opt_blk' },
    auto_reflect: true,
  } as const;

  async function writeConfig(content: string): Promise<void> {
    const dir = join(repo, '.ditto', 'local');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'config.json'), content, 'utf8');
  }

  function configPath(): string {
    return join(repo, '.ditto', 'local', 'config.json');
  }

  test('absent config file → seeds full block (ac-1, reason absent)', async () => {
    const r = await seedGithubConfigIfAbsent(repo, { ...backlog });
    expect(r).toEqual({ seeded: true, reason: 'absent' });
    // ac-4: consumer reads the FULL block — coordinates + status_map + claim_status_map + auto_reflect.
    expect(await readGithubConfig(repo)).toEqual({ ...backlog });
  });

  test('config present but no github field → seeds, PRESERVES tech_spec/deep_interview siblings (ac-4)', async () => {
    await writeConfig(
      JSON.stringify({
        tech_spec: { question: { generators: 3 } },
        deep_interview: { generators: 4 },
      }),
    );
    const r = await seedGithubConfigIfAbsent(repo, { ...backlog });
    expect(r).toEqual({ seeded: true, reason: 'absent' });
    expect(await readGithubConfig(repo)).toEqual({ ...backlog });
    expect(await readQuestionConfigDefaults(repo)).toEqual({ generators: 3 });
    expect(await readDeepInterviewConfigDefaults(repo)).toEqual({ generators: 4 });
  });

  test('existing personal github config → NOT overwritten, 개인 우선 (ac-2, reason existing)', async () => {
    const personal = {
      project: { owner: 'me', number: 1 },
      status_map: { done: 'mine_done' },
      auto_reflect: false,
    } as const;
    await writeGithubConfig(repo, { ...personal });
    const r = await seedGithubConfigIfAbsent(repo, { ...backlog });
    expect(r).toEqual({ seeded: false, reason: 'existing' });
    expect(await readGithubConfig(repo)).toEqual({ ...personal });
  });

  test('idempotent — seeding twice yields byte-identical file (ac-2 멱등)', async () => {
    await seedGithubConfigIfAbsent(repo, { ...backlog });
    const first = await Bun.file(configPath()).text();
    const second = await seedGithubConfigIfAbsent(repo, { ...backlog });
    const afterBytes = await Bun.file(configPath()).text();
    // Second call sees the now-present github block → keeps it, writes nothing.
    expect(second).toEqual({ seeded: false, reason: 'existing' });
    expect(afterBytes).toBe(first);
  });

  test('malformed JSON existing → fail-closed (no seed), onMalformed warns, file untouched (C1)', async () => {
    const raw = '{ tech_spec is here but not valid json';
    await writeConfig(raw);
    let warned = 0;
    const r = await seedGithubConfigIfAbsent(repo, { ...backlog }, () => {
      warned++;
    });
    expect(r).toEqual({ seeded: false, reason: 'malformed' });
    expect(warned).toBe(1);
    // siblings NOT clobbered — the malformed file is left exactly as it was.
    expect(await Bun.file(configPath()).text()).toBe(raw);
  });

  test('schema-invalid existing (valid tech_spec + invalid github) → fail-closed, sibling preserved (C1)', async () => {
    const raw = JSON.stringify({
      tech_spec: { question: { generators: 3 } },
      github: {
        project: { owner: 'o', number: 5 },
        status_map: { in_progress: 'x' },
        auto_reflect: false,
      },
    });
    await writeConfig(raw);
    let warned = 0;
    const r = await seedGithubConfigIfAbsent(repo, { ...backlog }, () => {
      warned++;
    });
    expect(r).toEqual({ seeded: false, reason: 'malformed' });
    expect(warned).toBe(1);
    // tech_spec sibling NOT destroyed by a seed write — the whole file stays byte-identical.
    expect(await Bun.file(configPath()).text()).toBe(raw);
  });
});
