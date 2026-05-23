import { describe, expect, test } from 'bun:test';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { completionContract } from '~/schemas/completion-contract';
import { commandLogEntry } from '~/schemas/evidence-log';
import { glossary } from '~/schemas/glossary';
import { languageLedger } from '~/schemas/language-ledger';
import { runManifest } from '~/schemas/run-manifest';
import { workItem } from '~/schemas/work-item';

const REPO_ROOT = process.env.DITTO_REPO_ROOT ?? join(import.meta.dir, '..', '..');
const DITTO_DIR = join(REPO_ROOT, '.ditto');

async function loadJson(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8');
  return JSON.parse(text);
}

async function listWorkItemDirs(): Promise<string[]> {
  const base = join(DITTO_DIR, 'work-items');
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const name of entries) {
    const dir = join(base, name);
    const s = await stat(dir);
    if (s.isDirectory()) result.push(dir);
  }
  return result;
}

async function listRunDirs(): Promise<string[]> {
  const base = join(DITTO_DIR, 'runs');
  try {
    const entries = await readdir(base);
    const result: string[] = [];
    for (const name of entries) {
      const dir = join(base, name);
      const s = await stat(dir);
      if (s.isDirectory()) result.push(dir);
    }
    return result;
  } catch {
    return [];
  }
}

describe('repo .ditto self-validation', () => {
  test('glossary.json conforms to schema if present', async () => {
    const path = join(DITTO_DIR, 'knowledge', 'glossary.json');
    if (!(await Bun.file(path).exists())) return;
    const data = await loadJson(path);
    glossary.parse(data);
  });

  test('every work-items/<id>/work-item.json conforms to schema', async () => {
    const dirs = await listWorkItemDirs();
    for (const dir of dirs) {
      const data = await loadJson(join(dir, 'work-item.json'));
      const parsed = workItem.parse(data);
      const dirId = dir.split('/').at(-1);
      expect(parsed.id).toBe(dirId ?? '');
    }
  });

  test('every work-items/<id>/language-ledger.json conforms to schema if present', async () => {
    const dirs = await listWorkItemDirs();
    for (const dir of dirs) {
      const path = join(dir, 'language-ledger.json');
      const file = Bun.file(path);
      if (!(await file.exists())) continue;
      const data = JSON.parse(await file.text());
      languageLedger.parse(data);
    }
  });

  test('every work-items/<id>/completion.json conforms to schema if present', async () => {
    const dirs = await listWorkItemDirs();
    for (const dir of dirs) {
      const path = join(dir, 'completion.json');
      const file = Bun.file(path);
      if (!(await file.exists())) continue;
      const data = JSON.parse(await file.text());
      completionContract.parse(data);
    }
  });

  test('every runs/<id>/manifest.json conforms to schema if present', async () => {
    const dirs = await listRunDirs();
    for (const dir of dirs) {
      const data = await loadJson(join(dir, 'manifest.json'));
      runManifest.parse(data);
    }
  });

  test('every work-items/<id>/evidence/commands.jsonl line conforms to schema if present', async () => {
    const dirs = await listWorkItemDirs();
    for (const dir of dirs) {
      const path = join(dir, 'evidence', 'commands.jsonl');
      const file = Bun.file(path);
      if (!(await file.exists())) continue;
      const text = await file.text();
      const lines = text.split('\n').filter((line) => line.length > 0);
      lines.forEach((line, idx) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (err) {
          throw new Error(`commands.jsonl ${path}:${idx + 1} is not valid JSON: ${String(err)}`);
        }
        commandLogEntry.parse(parsed);
      });
    }
  });
});

const isDittoSourceRepo = process.env.DITTO_REPO_ROOT === undefined;

describe.if(isDittoSourceRepo)('ditto source repo identity', () => {
  test('glossary project_name is ditto', async () => {
    const data = await loadJson(join(DITTO_DIR, 'knowledge', 'glossary.json'));
    const parsed = glossary.parse(data);
    expect(parsed.project_name).toBe('ditto');
    expect(parsed.entries.length).toBeGreaterThan(0);
  });

  test('at least one work item exists', async () => {
    const dirs = await listWorkItemDirs();
    expect(dirs.length).toBeGreaterThan(0);
  });

  test('wi_v01bootstrap and wi_v01implement exist', async () => {
    const dirs = await listWorkItemDirs();
    const ids = dirs.map((d) => d.split('/').at(-1));
    expect(ids).toContain('wi_v01bootstrap');
    expect(ids).toContain('wi_v01implement');
  });
});
