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

const sampleRecord = (overrides: Record<string, unknown> = {}) => ({
  ref: { kind: 'command' as const, command: 'bun test', summary: 'passed' },
  captured_at: '2026-05-26T00:00:00.000Z',
  freshness: 'fresh' as const,
  portability: 'committed' as const,
  artifact_available: true,
  exit_code: 0,
  ...overrides,
});

describe('EvidenceStore evidence-index.json ledger', () => {
  const indexPath = (wi: string) =>
    join(workDir, '.ditto', 'work-items', wi, 'evidence-index.json');

  test('readIndex returns an empty index when the file does not exist', async () => {
    const idx = await store.readIndex('wi_noindex001');
    expect(idx.records).toEqual([]);
    expect(idx.work_item_id).toBe('wi_noindex001');
    // 부재 read 는 파일을 만들지 않는다.
    expect(await Bun.file(indexPath('wi_noindex001')).exists()).toBe(false);
  });

  test('appendRecord writes a committable ledger at the work-item root (not under evidence/)', async () => {
    await store.appendRecord('wi_idx00001', sampleRecord());
    expect(await Bun.file(indexPath('wi_idx00001')).exists()).toBe(true);
    // evidence/ 하위가 아님 — 커밋 대상 경로
    const underEvidence = join(
      workDir,
      '.ditto',
      'work-items',
      'wi_idx00001',
      'evidence',
      'evidence-index.json',
    );
    expect(await Bun.file(underEvidence).exists()).toBe(false);
  });

  test('appendRecord is append-only (preserves order across calls)', async () => {
    await store.appendRecord('wi_idx00002', sampleRecord({ ref: { kind: 'note', summary: 'a' } }));
    const idx = await store.appendRecord(
      'wi_idx00002',
      sampleRecord({ ref: { kind: 'note', summary: 'b' } }),
    );
    expect(idx.records.map((r) => r.ref.summary)).toEqual(['a', 'b']);
    expect((await store.readIndex('wi_idx00002')).records.length).toBe(2);
  });

  test('appendRecord applies record defaults (stale_reason null, key_lines [])', async () => {
    const idx = await store.appendRecord('wi_idx00003', sampleRecord());
    expect(idx.records[0]?.stale_reason).toBe(null);
    expect(idx.records[0]?.key_lines).toEqual([]);
  });

  test('appendRecord rejects a record violating cross-field rules (stale without reason)', async () => {
    let thrown: unknown;
    try {
      await store.appendRecord(
        'wi_idx00004',
        sampleRecord({ freshness: 'stale' }), // stale_reason 누락
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(await Bun.file(indexPath('wi_idx00004')).exists()).toBe(false);
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
