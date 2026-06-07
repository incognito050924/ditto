import { describe, expect, test } from 'bun:test';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { completionContract } from '~/schemas/completion-contract';
import { e2eJourney } from '~/schemas/e2e-journey';
import { commandLogEntry } from '~/schemas/evidence-log';
import { glossary } from '~/schemas/glossary';
import { languageLedger } from '~/schemas/language-ledger';
import { runManifest } from '~/schemas/run-manifest';
import { surfaceCatalog } from '~/schemas/surface-catalog';
import { workItem } from '~/schemas/work-item';

const REPO_ROOT = process.env.DITTO_REPO_ROOT ?? join(import.meta.dir, '..', '..');
const DITTO_DIR = join(REPO_ROOT, '.ditto');
// Per-developer runtime (work-items, runs, surfaces) lives under .ditto/local;
// knowledge stays at .ditto/ direct (project-global tier).
const LOCAL_DIR = join(DITTO_DIR, 'local');

async function loadJson(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8');
  return JSON.parse(text);
}

async function listWorkItemDirs(): Promise<string[]> {
  const base = join(LOCAL_DIR, 'work-items');
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
  const base = join(LOCAL_DIR, 'runs');
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
      // `.ditto/runs/<id>/` is shared by two run kinds: a provider/command run
      // (`ditto run`) writes `manifest.json` (a runManifest), while an e2e capture
      // run (`ditto e2e run`) writes `journey.json` + captures and NO manifest.
      // Honor this test's own "if present" contract — skip a run dir without a
      // manifest (an e2e capture), exactly like the sibling completion.json check.
      const path = join(dir, 'manifest.json');
      if (!(await Bun.file(path).exists())) continue;
      const data = await loadJson(path);
      runManifest.parse(data);
    }
  });

  test('every runs/<id>/journey.json conforms to schema if present', async () => {
    // The other run kind: an e2e capture run writes `journey.json` (an e2eJourney).
    // Validate it so e2e run dirs are covered, not a self-validation blind spot.
    const dirs = await listRunDirs();
    for (const dir of dirs) {
      const path = join(dir, 'journey.json');
      if (!(await Bun.file(path).exists())) continue;
      const data = await loadJson(path);
      e2eJourney.parse(data);
    }
  });

  test('.ditto/surfaces.json conforms to schema if present', async () => {
    const path = join(LOCAL_DIR, 'surfaces.json');
    if (!(await Bun.file(path).exists())) return;
    const data = await loadJson(path);
    surfaceCatalog.parse(data);
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
