import { describe, expect, test } from 'bun:test';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { autopilot } from '~/schemas/autopilot';
import { completionContract } from '~/schemas/completion-contract';
import { convergence } from '~/schemas/convergence';
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

  // ADR-0024 Decision 6 (wi_260623u0d): autopilot.json is the artifact the
  // loop-discipline change most plausibly breaks (it added optional caps:
  // oracle_failures_to_block / loop_rounds). Validate any ON-DISK autopilot.json so
  // an additive-but-mis-shaped schema change is caught against real in-flight state
  // (readJson hard-throws on a mismatch — this is the migration guard, exercised).
  test('every work-items/<id>/autopilot.json conforms to schema if present', async () => {
    const dirs = await listWorkItemDirs();
    for (const dir of dirs) {
      const path = join(dir, 'autopilot.json');
      const file = Bun.file(path);
      if (!(await file.exists())) continue;
      const data = JSON.parse(await file.text());
      autopilot.parse(data);
    }
  });

  test('every work-items/<id>/convergence.json conforms to schema if present', async () => {
    const dirs = await listWorkItemDirs();
    for (const dir of dirs) {
      const path = join(dir, 'convergence.json');
      const file = Bun.file(path);
      if (!(await file.exists())) continue;
      const data = JSON.parse(await file.text());
      convergence.parse(data);
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

  // ADR-0024 Decision 6 migration guard (wi_260623u0d): a LEGACY autopilot.json
  // written before the loop-discipline caps (oracle_failures_to_block / loop_rounds)
  // MUST still parse — the new fields are `.default()`, never required. This is the
  // non-vacuous floor of the two "if present" cases above: it asserts the additive
  // change does not break in-flight on-disk state (readJson hard-throws otherwise).
  test('legacy autopilot.json (no loop-discipline caps) parses via .default() — migration safe', () => {
    const legacy = {
      schema_version: '0.1.0',
      autopilot_id: 'orch_legacy01',
      work_item_id: 'wi_legacy01',
      mode: 'autopilot',
      root_goal: 'legacy goal',
      completion_boundary: 'entire_work_item',
      approval_gate: {
        status: 'not_required',
        source: 'small_reversible_policy',
        approved_at: null,
        approved_by: null,
        evidence_refs: [],
      },
      nodes: [],
      // caps WITHOUT converge_rounds / oracle_failures_to_block / loop_rounds — the
      // legacy shape a graph on disk carries before this change.
      caps: { fix_per_node: 2, switch_per_node: 1 },
      continue_policy: {
        continue_after_approval: true,
        continue_after_checkpoint: true,
        continue_after_fixable_failure: true,
        ask_user_only_for_user_owned_decisions: true,
      },
      stop_conditions: [],
      user_interrupt_policy: 'ask_only_for_user_owned_decisions',
    };
    const parsed = autopilot.parse(legacy);
    expect(parsed.caps.oracle_failures_to_block).toBe(3);
    expect(parsed.caps.loop_rounds).toBe(12);
  });
});

const isDittoSourceRepo = process.env.DITTO_REPO_ROOT === undefined;

describe.if(isDittoSourceRepo)('ditto source repo identity', () => {
  // Identity must be asserted on GIT-TRACKED state only. The earlier work-item
  // assertions here ("at least one work item", "wi_v01bootstrap/implement
  // exist") read gitignored per-developer runtime (.ditto/local/work-items) and
  // therefore failed on any fresh checkout — a test-design defect flagged by
  // the memory round-1 review, removed (round-2 leftovers, wi_260610767).
  test('glossary project_name is ditto', async () => {
    const data = await loadJson(join(DITTO_DIR, 'knowledge', 'glossary.json'));
    const parsed = glossary.parse(data);
    expect(parsed.project_name).toBe('ditto');
    expect(parsed.entries.length).toBeGreaterThan(0);
  });
});
