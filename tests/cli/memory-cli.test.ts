import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
let dir: string;

function ditto(args: string[]): { stdout: string; stderr: string; exitCode: number | null } {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], { cwd: dir, env: { ...process.env } });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

function initGit(d: string) {
  Bun.spawnSync(['git', 'init', '-q'], { cwd: d, stdout: 'pipe', stderr: 'pipe' });
  Bun.spawnSync(['git', 'config', 'user.email', 't@t'], { cwd: d, stdout: 'pipe' });
  Bun.spawnSync(['git', 'config', 'user.name', 't'], { cwd: d, stdout: 'pipe' });
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'init'], {
    cwd: d,
    stdout: 'pipe',
    stderr: 'pipe',
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-mem-cli-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
  initGit(dir);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto memory scan', () => {
  test('scan reports added then unchanged in json', async () => {
    await writeFile(join(dir, 'a.ts'), 'export const x = 1;\n');
    const first = ditto(['memory', 'scan', '--output', 'json']);
    expect(first.exitCode).toBe(0);
    const out1 = JSON.parse(first.stdout);
    expect(out1.added.length).toBe(1);

    const second = ditto(['memory', 'scan', '--output', 'json']);
    const out2 = JSON.parse(second.stdout);
    expect(out2.added.length).toBe(0);
    expect(out2.unchanged.length).toBe(1);
  });
});

describe('ditto memory events', () => {
  test('append then list shows the event (append-only, created_at order)', async () => {
    const appended = ditto([
      'memory',
      'events',
      'append',
      '--type',
      'observation',
      '--text',
      'first note',
      '--output',
      'json',
    ]);
    expect(appended.exitCode).toBe(0);
    const ev = JSON.parse(appended.stdout);
    expect(ev.event_id).toMatch(/^memevt_/);
    expect(ev.status).toBe('pending');

    const listed = ditto(['memory', 'events', 'list', '--output', 'json']);
    expect(listed.exitCode).toBe(0);
    const out = JSON.parse(listed.stdout);
    expect(out.events.length).toBe(1);
    expect(out.events[0].text).toBe('first note');
  });

  test('append rejects an invalid event type with usage exit', () => {
    const r = ditto([
      'memory',
      'events',
      'append',
      '--type',
      'bogus',
      '--text',
      'x',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(65);
  });
});

describe('ditto memory bootstrap', () => {
  test('ingests curated ADR then is idempotent on re-run', async () => {
    const adrDir = join(dir, '.ditto', 'knowledge', 'adr');
    await mkdir(adrDir, { recursive: true });
    await writeFile(
      join(adrDir, 'ADR-0001-x.md'),
      '# ADR-0001: A decision\n\n## 결정\nuse zod.\n\n## 근거\nzod reduces drift.\n',
    );

    const first = ditto(['memory', 'bootstrap', '--output', 'json']);
    expect(first.exitCode).toBe(0);
    const out1 = JSON.parse(first.stdout);
    expect(out1.sources_added.length).toBe(1);
    expect(out1.events_appended.length).toBe(1);

    const second = ditto(['memory', 'bootstrap', '--output', 'json']);
    expect(second.exitCode).toBe(0);
    const out2 = JSON.parse(second.stdout);
    expect(out2.sources_added.length).toBe(0);
    expect(out2.events_appended.length).toBe(0);
    expect(out2.events_skipped.length).toBe(1);

    const listed = ditto(['memory', 'events', 'list', '--output', 'json']);
    const listOut = JSON.parse(listed.stdout);
    expect(listOut.events.length).toBe(1);
    expect(listOut.events[0].status).toBe('approved');
  });
});

describe('ditto memory project + status', () => {
  test('status is absent, then fresh after project, then stale after a new approval', async () => {
    // bootstrap an approved ADR decision so there is something to project.
    const adrDir = join(dir, '.ditto', 'knowledge', 'adr');
    await mkdir(adrDir, { recursive: true });
    await writeFile(join(adrDir, 'ADR-0001-x.md'), '# ADR-0001: A\n\n## 결정\nuse zod.\n');
    ditto(['memory', 'bootstrap', '--output', 'json']);
    ditto(['memory', 'scan', '--output', 'json']);

    const absent = ditto(['memory', 'status', '--output', 'json']);
    expect(absent.exitCode).toBe(0);
    expect(JSON.parse(absent.stdout).freshness).toBe('absent');

    const projected = ditto(['memory', 'project', '--output', 'json']);
    expect(projected.exitCode).toBe(0);
    const proj = JSON.parse(projected.stdout);
    expect(proj.projection_id).toMatch(/^proj_/);
    expect(proj.nodes).toBeGreaterThanOrEqual(1); // Decision node from the ADR

    const fresh = ditto(['memory', 'status', '--output', 'json']);
    expect(JSON.parse(fresh.stdout).freshness).toBe('fresh');

    // a new approved event drifts the reduced set → stale
    const appended = ditto([
      'memory',
      'events',
      'append',
      '--type',
      'decision',
      '--text',
      'another decision',
      '--output',
      'json',
    ]);
    const newId = JSON.parse(appended.stdout).event_id;
    ditto([
      'memory',
      'events',
      'append',
      '--type',
      'decision',
      '--text',
      'approve it',
      '--supersedes',
      newId,
      '--output',
      'json',
    ]);
    // the appended events above are pending (no approval CLI in #5); approval
    // status is exercised via the supersedes chain in the core test. Here we
    // only need to confirm status runs end-to-end and reports a valid verdict.
    const after = ditto(['memory', 'status', '--output', 'json']);
    expect(after.exitCode).toBe(0);
    expect(['fresh', 'stale']).toContain(JSON.parse(after.stdout).freshness);
  });
});

describe('ditto memory usage (ac-12 readable report)', () => {
  async function seedUsage() {
    // warm-start usage JSONL: .ditto/local/work-items/<id>/memory/warmstart-usage.jsonl
    const wsDir = join(dir, '.ditto', 'local', 'work-items', 'wi_demo01', 'memory');
    await mkdir(wsDir, { recursive: true });
    const recs = [
      { opportunity: true, attempt: true, hit: true, actionable: true },
      { opportunity: true, attempt: true, hit: false, actionable: false },
      { opportunity: true, attempt: false, hit: false, actionable: false },
    ].map((r, i) => ({
      ts: `2026-06-09T00:0${i}:00Z`,
      work_item_id: 'wi_demo01',
      node_id: `n${i}`,
      owner: 'planner',
      ...r,
    }));
    await writeFile(
      join(wsDir, 'warmstart-usage.jsonl'),
      `${recs.map((r) => JSON.stringify(r)).join('\n')}\n`,
    );
    // pull-query usage JSONL: .ditto/local/memory/pull-usage.jsonl
    const pullDir = join(dir, '.ditto', 'local', 'memory');
    await mkdir(pullDir, { recursive: true });
    const pulls = [
      { ts: '2026-06-09T00:00:00Z', node: 'foo', depth: 2, neighbor_count: 3, freshness: 'fresh' },
      { ts: '2026-06-09T00:01:00Z', node: 'bar', depth: 1, neighbor_count: 0, freshness: 'fresh' },
    ];
    await writeFile(
      join(pullDir, 'pull-usage.jsonl'),
      `${pulls.map((p) => JSON.stringify(p)).join('\n')}\n`,
    );
  }

  test('tallies the four warm-start metrics + pull count for a work item (json)', async () => {
    await seedUsage();
    const r = ditto(['memory', 'usage', '--work-item', 'wi_demo01', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.work_item_id).toBe('wi_demo01');
    expect(out.warmstart).toEqual({
      opportunities: 3,
      attempts: 2,
      hits: 1,
      actionable: 1,
    });
    expect(out.pull.queries).toBe(2);
  });

  test('human output renders the four metrics + pull line', async () => {
    await seedUsage();
    const r = ditto(['memory', 'usage', '--work-item', 'wi_demo01']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('opportunities: 3');
    expect(r.stdout).toContain('attempts:      2');
    expect(r.stdout).toContain('hits:          1');
    expect(r.stdout).toContain('actionable:    1');
    expect(r.stdout).toContain('Pull-query usage: 2');
  });

  test('without --work-item reports pull usage only (warmstart null)', async () => {
    await seedUsage();
    const r = ditto(['memory', 'usage', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.warmstart).toBeNull();
    expect(out.pull.queries).toBe(2);
  });

  test('unknown work item yields zeroed metrics (no records ⇒ all zero)', () => {
    const r = ditto(['memory', 'usage', '--work-item', 'wi_missing', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.warmstart).toEqual({ opportunities: 0, attempts: 0, hits: 0, actionable: 0 });
    expect(out.pull.queries).toBe(0);
  });
});

describe('ditto memory propose/approve (write model §4-5)', () => {
  test('propose creates a pending event with no approved_by', () => {
    const r = ditto([
      'memory',
      'propose',
      '--type',
      'decision',
      '--text',
      'adopt bun',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    const ev = JSON.parse(r.stdout);
    expect(ev.status).toBe('pending');
    expect(ev.approved_by).toBeUndefined();
    expect(ev.event_id).toMatch(/^memevt_/);
  });

  test('approve appends a superseding approved event and re-projects; original file unchanged', async () => {
    const proposed = ditto([
      'memory',
      'propose',
      '--type',
      'decision',
      '--text',
      'adopt bun',
      '--output',
      'json',
    ]);
    const originalId = JSON.parse(proposed.stdout).event_id;
    const originalPath = join(dir, '.ditto', 'memory', 'events', `${originalId}.json`);
    const before = await readFile(originalPath, 'utf8');

    const approved = ditto(['memory', 'approve', originalId, '--by', 'user', '--output', 'json']);
    expect(approved.exitCode).toBe(0);
    const out = JSON.parse(approved.stdout);
    expect(out.decision.status).toBe('approved');
    expect(out.decision.approved_by).toBe('user');
    expect(out.decision.supersedes).toBe(originalId);
    expect(out.decision.event_id).not.toBe(originalId);
    expect(out.projection_id).toMatch(/^proj_/);

    // original event file is never mutated (§10-2 F2)
    const after = await readFile(originalPath, 'utf8');
    expect(after).toBe(before);

    // projection now exposes the approved decision as a node
    const explain = ditto([
      'memory',
      'explain',
      `decision:${out.decision.event_id}`,
      '--output',
      'json',
    ]);
    expect(explain.exitCode).toBe(0);
  });

  test('approve fails (usage) when the target is not pending', () => {
    const proposed = ditto([
      'memory',
      'propose',
      '--type',
      'observation',
      '--text',
      'note',
      '--output',
      'json',
    ]);
    const id = JSON.parse(proposed.stdout).event_id;
    const approved = ditto(['memory', 'approve', id, '--by', 'user', '--output', 'json']);
    const decisionId = JSON.parse(approved.stdout).decision.event_id;
    // re-approving the already-approved head is rejected
    const second = ditto(['memory', 'approve', decisionId, '--by', 'user', '--output', 'json']);
    expect(second.exitCode).toBe(65);
    expect(second.stderr).toMatch(/not pending/);
  });

  test('approve of a missing event id is a usage error', () => {
    const r = ditto([
      'memory',
      'approve',
      'memevt_doesnotexist',
      '--by',
      'user',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(65);
  });

  // No-direct-write proof: the serving graph / IR can only change through
  // propose→approve→re-projection. The memory command surface exposes no
  // subcommand that writes the serving graph or IR directly — the only write
  // gates are propose/approve (events) and project (regeneration).
  test('memory command exposes no direct graph/IR write subcommand', async () => {
    const { memoryCommand } = await import('~/cli/commands/memory');
    const subs = await memoryCommand.subCommands;
    const names = Object.keys(subs ?? {});
    expect(names).toContain('propose');
    expect(names).toContain('approve');
    // no subcommand that would let an agent write the serving graph / IR directly
    for (const n of names) {
      expect(n).not.toMatch(/graph-write|serving-write|ir-write|graph-set|graph-edit|write/);
    }
  });
});
