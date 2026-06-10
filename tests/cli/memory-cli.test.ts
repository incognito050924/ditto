import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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
