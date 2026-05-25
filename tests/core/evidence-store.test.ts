import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EvidenceStore, sha256Hex } from '~/core/evidence-store';

let workDir: string;
let store: EvidenceStore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'ditto-es-'));
  store = new EvidenceStore(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const sampleEntry = (overrides: Record<string, unknown> = {}) => ({
  ts: '2026-05-24T15:00:00+09:00',
  kind: 'command' as const,
  command: 'echo hi',
  exit_code: 0,
  ...overrides,
});

describe('EvidenceStore', () => {
  test('appendCommand creates evidence/commands.jsonl and writes a line', async () => {
    await store.appendCommand('wi_demo00001', sampleEntry());
    const path = join(
      workDir,
      '.ditto',
      'work-items',
      'wi_demo00001',
      'evidence',
      'commands.jsonl',
    );
    const text = await Bun.file(path).text();
    expect(text.endsWith('\n')).toBe(true);
    const lines = text.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
  });

  test('appendCommand is additive (two entries become two lines)', async () => {
    await store.appendCommand('wi_demo00002', sampleEntry({ command: 'a' }));
    await store.appendCommand('wi_demo00002', sampleEntry({ command: 'b' }));
    const entries = await store.readAll('wi_demo00002');
    expect(entries.map((e) => e.command)).toEqual(['a', 'b']);
  });

  test('appendCommand rejects entries that fail schema (missing command)', async () => {
    let thrown: unknown;
    try {
      await store.appendCommand('wi_demo00003', {
        ts: '2026-05-24T15:00:00+09:00',
        kind: 'command',
        exit_code: 0,
        // command missing
      } as never);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    // file should not have been created
    const path = join(
      workDir,
      '.ditto',
      'work-items',
      'wi_demo00003',
      'evidence',
      'commands.jsonl',
    );
    expect(await Bun.file(path).exists()).toBe(false);
  });

  test('readAll returns empty when file does not exist', async () => {
    const entries = await store.readAll('wi_nonexist01');
    expect(entries).toEqual([]);
  });

  test('readAll throws with line context when a line is malformed', async () => {
    // Write a file by hand with one valid + one invalid line
    const path = join(
      workDir,
      '.ditto',
      'work-items',
      'wi_corrupt001',
      'evidence',
      'commands.jsonl',
    );
    await store.appendCommand('wi_corrupt001', sampleEntry());
    // Manually append a bad line
    const existing = await Bun.file(path).text();
    await Bun.write(path, `${existing}{"ts":"bad","kind":"command","command":"x"}\n`);
    let thrown: unknown;
    try {
      await store.readAll('wi_corrupt001');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown)).toContain('commands.jsonl');
  });
});

describe('sha256Hex', () => {
  test('produces 64-char lowercase hex', () => {
    const h = sha256Hex('hello');
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });

  test('is deterministic', () => {
    expect(sha256Hex('hello')).toBe(sha256Hex('hello'));
  });
});
