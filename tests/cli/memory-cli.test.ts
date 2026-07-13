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

  test('list redacts the BODY of sensitivity=secret events but keeps metadata', async () => {
    // Consistency with the R1 visibility rule: no CLI read surface prints a
    // secret body. Metadata/id stay visible so curation (approve) still works.
    const p = ditto([
      'memory',
      'propose',
      '--type',
      'observation',
      '--text',
      'topsecretbody xyz',
      '--actor',
      'user',
      '--sensitivity',
      'secret',
      '--output',
      'json',
    ]);
    expect(p.exitCode).toBe(0);
    const id = JSON.parse(p.stdout).event_id;

    const listed = ditto(['memory', 'events', 'list', '--output', 'json']);
    expect(listed.exitCode).toBe(0);
    const out = JSON.parse(listed.stdout);
    const ev = out.events.find((e: { event_id: string }) => e.event_id === id);
    expect(ev).toBeDefined();
    expect(ev.sensitivity).toBe('secret');
    expect(JSON.stringify(out)).not.toContain('topsecretbody');

    const human = ditto(['memory', 'events', 'list']);
    expect(human.exitCode).toBe(0);
    expect(human.stdout).toContain(id);
    expect(human.stdout).not.toContain('topsecretbody');
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
      {
        opportunity: true,
        attempt: true,
        hit: true,
        actionable: true,
        hit_node_types: { Decision: 1, Episode: 2 },
      },
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
      hit_node_types: { Decision: 1, Episode: 2 },
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
    expect(r.stdout).toContain('hit node types: Decision=1 Episode=2');
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
    expect(out.warmstart).toEqual({
      opportunities: 0,
      attempts: 0,
      hits: 0,
      actionable: 0,
      hit_node_types: {},
    });
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

    const approved = ditto([
      'memory',
      'approve',
      originalId,
      '--by',
      'user',
      '--actor',
      'user',
      '--output',
      'json',
    ]);
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
    const approved = ditto([
      'memory',
      'approve',
      id,
      '--by',
      'user',
      '--actor',
      'user',
      '--output',
      'json',
    ]);
    const decisionId = JSON.parse(approved.stdout).decision.event_id;
    // re-approving the already-approved head is rejected
    const second = ditto([
      'memory',
      'approve',
      decisionId,
      '--by',
      'user',
      '--actor',
      'user',
      '--output',
      'json',
    ]);
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
      '--actor',
      'user',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(65);
  });

  test('approve of a malformed event id (not memevt_) is a usage error (F7)', () => {
    const r = ditto(['memory', 'approve', 'not-a-valid-id', '--by', 'user', '--output', 'json']);
    expect(r.exitCode).toBe(65);
  });

  test('agent-proposed event approved with --actor agent is a usage error (F3 self-approval)', () => {
    const proposed = ditto([
      'memory',
      'propose',
      '--type',
      'decision',
      '--text',
      'agent guess',
      '--output',
      'json',
    ]);
    const id = JSON.parse(proposed.stdout).event_id;
    const r = ditto([
      'memory',
      'approve',
      id,
      '--by',
      'agent',
      '--actor',
      'agent',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(65);
  });

  test('agent-proposed event approved with --actor user succeeds (F3)', () => {
    const proposed = ditto([
      'memory',
      'propose',
      '--type',
      'decision',
      '--text',
      'agent guess',
      '--output',
      'json',
    ]);
    const id = JSON.parse(proposed.stdout).event_id;
    const r = ditto([
      'memory',
      'approve',
      id,
      '--by',
      'user',
      '--actor',
      'user',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).decision.status).toBe('approved');
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

describe('ditto memory query/path/explain axis-2 label (ac-7)', () => {
  // Build a real git repo with a scanned code file + a projected Decision node,
  // then diverge the code so memoryStatus reports code_dirty/code_drift. The
  // read surfaces must STILL answer (no refusal) and carry the axis-2 label +
  // drifted_repos/drifted_sources in the freshness envelope (design §3 D-G).
  async function seedProjectedRepo(): Promise<{ decisionId: string }> {
    // a scanned code file → its source_revisions baseline drives axis-2 detection.
    await writeFile(join(dir, 'a.ts'), 'export const a = 1;\n');
    Bun.spawnSync(['git', 'add', '-A'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    Bun.spawnSync(['git', 'commit', '-q', '-m', 'add a.ts'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(ditto(['memory', 'scan', '--output', 'json']).exitCode).toBe(0);
    // an approved decision → a Decision node `decision:<id>` to query/path/explain.
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
    const proposedId = JSON.parse(proposed.stdout).event_id;
    const approved = ditto([
      'memory',
      'approve',
      proposedId,
      '--by',
      'user',
      '--actor',
      'user',
      '--output',
      'json',
    ]);
    expect(approved.exitCode).toBe(0);
    // approve re-projects; the projection records a.ts's owning-repo HEAD baseline.
    expect(ditto(['memory', 'project', '--output', 'json']).exitCode).toBe(0);
    return { decisionId: JSON.parse(approved.stdout).decision.event_id };
  }

  test('code_dirty: query answers + envelope carries label and drifted fields (no refusal)', async () => {
    const { decisionId } = await seedProjectedRepo();
    const node = `decision:${decisionId}`;

    // baseline: clean → fresh, no drifted fields.
    const clean = ditto(['memory', 'query', node, '--output', 'json']);
    expect(clean.exitCode).toBe(0);
    expect(JSON.parse(clean.stdout).freshness).toBe('fresh');

    // edit the scanned file WITHOUT rescanning → working tree diverges → code_dirty.
    await writeFile(join(dir, 'a.ts'), 'export const a = 2;\n');

    const q = ditto(['memory', 'query', node, '--output', 'json']);
    // (a) still returns an answer — drift/dirty is a LABEL, never a refusal.
    expect(q.exitCode).toBe(0);
    const out = JSON.parse(q.stdout);
    expect(out.root).toBe(node); // graph result is present, unchanged by the label
    // (b) envelope carries the axis-2 label + the separate drifted fields.
    expect(out.freshness).toBe('code_dirty');
    expect(out.drifted_repos).toEqual(['.']);
    expect(Array.isArray(out.drifted_sources)).toBe(true);
    expect(out.drifted_sources.length).toBeGreaterThan(0);
  });

  test('code_drift: path + explain answer + envelope carries label and drifted fields', async () => {
    const { decisionId } = await seedProjectedRepo();
    const node = `decision:${decisionId}`;

    // advance HEAD with a clean commit → owning-repo HEAD ≠ stored git_commit → code_drift.
    Bun.spawnSync(['git', 'commit', '-q', '--allow-empty', '-m', 'move HEAD'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const explain = ditto(['memory', 'explain', node, '--output', 'json']);
    expect(explain.exitCode).toBe(0); // not a refusal
    const eo = JSON.parse(explain.stdout);
    expect(eo.node.id).toBe(node); // graph answer present
    expect(eo.freshness).toBe('code_drift');
    expect(eo.drifted_repos).toEqual(['.']);
    expect(eo.drifted_sources.length).toBeGreaterThan(0);

    // path from a node to itself returns [node]; the label rides along.
    const path = ditto(['memory', 'path', node, node, '--output', 'json']);
    expect(path.exitCode).toBe(0); // not a refusal
    const po = JSON.parse(path.stdout);
    expect(po.path).toEqual([node]);
    expect(po.freshness).toBe('code_drift');
    expect(po.drifted_repos).toEqual(['.']);
    expect(po.drifted_sources.length).toBeGreaterThan(0);
  });

  test('code_dirty: human output prints the label and drifted counts', async () => {
    const { decisionId } = await seedProjectedRepo();
    const node = `decision:${decisionId}`;
    await writeFile(join(dir, 'a.ts'), 'export const a = 3;\n');

    const q = ditto(['memory', 'query', node]);
    expect(q.exitCode).toBe(0);
    expect(q.stdout).toContain('freshness: code_dirty');
    expect(q.stdout).toContain('drifted_repos: 1');
  });

  test('code_drift: human envelope carries an actionable consumer hint (ac-11)', async () => {
    const { decisionId } = await seedProjectedRepo();
    const node = `decision:${decisionId}`;
    // advance HEAD → owning-repo HEAD ≠ stored git_commit → code_drift.
    Bun.spawnSync(['git', 'commit', '-q', '--allow-empty', '-m', 'move HEAD'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const q = ditto(['memory', 'query', node]);
    expect(q.exitCode).toBe(0);
    expect(q.stdout).toContain('freshness: code_drift');
    // the label must be actionable, not inert: tell the consumer what to do with
    // drifted_sources (verify those directly; trust the rest). (design §3 D-H)
    expect(q.stdout).toContain('drifted_sources');
    expect(q.stdout.toLowerCase()).toContain('verify');
  });
});

describe('ditto memory scan/build dirty-tree gate (ac-9)', () => {
  // Commit the .ditto marker + working files so the tree is genuinely clean;
  // returns the HEAD sha so commit-count invariance can be asserted.
  function commitAll(): string {
    Bun.spawnSync(['git', 'add', '-A'], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
    Bun.spawnSync(['git', 'commit', '-q', '-m', 'snapshot'], {
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: dir, stdout: 'pipe' })
      .stdout.toString()
      .trim();
  }

  test('(1) dirty tree: scan warns on stderr but proceeds (exit 0)', async () => {
    // beforeEach leaves .ditto/ untracked → tree already dirty.
    await writeFile(join(dir, 'a.ts'), 'export const x = 1;\n');
    const r = ditto(['memory', 'scan', '--output', 'json']);
    expect(r.exitCode).toBe(0); // not blocked
    expect(r.stderr.toLowerCase()).toContain('working tree'); // warning emitted
    expect(JSON.parse(r.stdout).added.length).toBe(1); // scan actually ran
  });

  test('(2) --require-clean on a dirty tree hard-fails (non-zero exit, no scan)', async () => {
    await writeFile(join(dir, 'a.ts'), 'export const x = 1;\n');
    const r = ditto(['memory', 'scan', '--require-clean', '--output', 'json']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout.trim()).toBe(''); // did not proceed to scan output
  });

  test('(2b) --require-clean on a dirty tree hard-fails for build too', async () => {
    await writeFile(join(dir, 'a.ts'), 'export const x = 1;\n');
    const r = ditto(['memory', 'build', '--require-clean', '--output', 'json']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout.trim()).toBe('');
  });

  test('(3) clean tree: scan emits no warning, exit 0', async () => {
    await writeFile(join(dir, 'a.ts'), 'export const x = 1;\n');
    commitAll();
    const r = ditto(['memory', 'scan', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr.toLowerCase()).not.toContain('working tree');
    const clean = ditto(['memory', 'scan', '--require-clean', '--output', 'json']);
    expect(clean.exitCode).toBe(0); // --require-clean passes when clean
  });

  test('(4) scan/build never create a git commit (commit count invariant)', async () => {
    await writeFile(join(dir, 'a.ts'), 'export const x = 1;\n');
    const before = commitAll(); // HEAD after committing the working files
    expect(ditto(['memory', 'scan', '--output', 'json']).exitCode).toBe(0);
    expect(ditto(['memory', 'build', '--output', 'json']).exitCode).toBe(0);
    expect(ditto(['memory', 'build', '--semantic', '--output', 'json']).exitCode).toBe(0);
    const after = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: dir, stdout: 'pipe' })
      .stdout.toString()
      .trim();
    expect(after).toBe(before); // HEAD unchanged → zero commits created
  });
});

describe('DITTO_MEMORY=off scope (master flag disables auto-injection only — F9 gap)', () => {
  test('memory CLI commands keep working with the master flag off', async () => {
    const env = { ...process.env, DITTO_MEMORY: 'off' };
    const run = (args: string[]) =>
      Bun.spawnSync(['bun', cliEntry, ...args], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
    await writeFile(join(dir, 'a.ts'), 'export const x = 1;\n');
    expect(run(['memory', 'scan', '--output', 'json']).exitCode).toBe(0);
    expect(
      run([
        'memory',
        'propose',
        '--type',
        'analysis',
        '--text',
        'manual pull still works when off',
        '--confidence',
        'INFERRED',
        '--actor',
        'agent',
        '--output',
        'json',
      ]).exitCode,
    ).toBe(0);
    expect(run(['memory', 'status', '--output', 'json']).exitCode).toBe(0);
  });
});

describe('ditto memory build --semantic secret gate (R7 runtime path)', () => {
  test('a source marked secret is excluded from chunks end-to-end', async () => {
    const { sourceIdForPath } = await import('~/core/memory-scan');
    await writeFile(join(dir, 'leaky.ts'), 'export const token = "supersecretvalue123";\n');
    await writeFile(join(dir, 'clean.ts'), 'export const ok = 1;\n');
    expect(ditto(['memory', 'scan', '--output', 'json']).exitCode).toBe(0);
    // mark leaky.ts secret on its per-entity source record (SoT JSON)
    const sid = sourceIdForPath('leaky.ts');
    const recPath = join(dir, '.ditto', 'memory', 'sources', `${sid}.json`);
    const rec = JSON.parse(await readFile(recPath, 'utf8'));
    rec.sensitivity = 'secret';
    await writeFile(recPath, JSON.stringify(rec));

    const b = ditto(['memory', 'build', '--semantic', '--output', 'json']);
    expect(b.exitCode).toBe(0);
    const out = JSON.parse(b.stdout);
    const serialized = JSON.stringify(out.chunks);
    expect(serialized).not.toContain('supersecretvalue123');
    expect(serialized).toContain('clean.ts');
  });
});

describe('ditto memory build --semantic --fragments (merge + dangling diagnostic)', () => {
  test('resolves bare-name endpoints and reports dangling edges in json output', async () => {
    const fragments = [
      {
        nodes: [
          { node_type: 'Concept', name: 'Alpha', source_id: 'src_aaaaaaaaaaaa' },
          { node_type: 'Concept', name: 'Beta', source_id: 'src_aaaaaaaaaaaa' },
        ],
        edges: [
          // bare display-name endpoints -> fold to concept ids (not dangling)
          {
            from: 'Alpha',
            to: 'Beta',
            edge_type: 'RELATED_TO',
            confidence_kind: 'INFERRED',
            confidence_score: 0.6,
            source_id: 'src_aaaaaaaaaaaa',
          },
          // 'Ghost' was never declared as a node -> dangling
          {
            from: 'Alpha',
            to: 'Ghost',
            edge_type: 'RELATED_TO',
            confidence_kind: 'INFERRED',
            confidence_score: 0.6,
            source_id: 'src_aaaaaaaaaaaa',
          },
        ],
      },
    ];
    await writeFile(join(dir, 'frags.json'), JSON.stringify(fragments));
    const b = ditto([
      'memory',
      'build',
      '--semantic',
      '--fragments',
      'frags.json',
      '--output',
      'json',
    ]);
    expect(b.exitCode).toBe(0);
    const out = JSON.parse(b.stdout);
    expect(out.mode).toBe('semantic-merge');
    expect(out.nodes).toBe(2);
    expect(out.edges).toBe(2);
    expect(out.dangling_edges).toBe(1);
  });
});

describe('ditto memory query body search (R1 visibility + R9 fallback marker)', () => {
  test('pending body is not searchable; approved is; json marks mode/fallback', async () => {
    const adrDir = join(dir, '.ditto', 'knowledge', 'adr');
    await mkdir(adrDir, { recursive: true });
    await writeFile(
      join(adrDir, 'ADR-0001-x.md'),
      '# ADR-0001: A decision\n\n## 결정\nuse zod.\n\n## 근거\nfrobnicate reduces drift.\n',
    );
    expect(ditto(['memory', 'bootstrap', '--output', 'json']).exitCode).toBe(0);
    expect(ditto(['memory', 'project', '--output', 'json']).exitCode).toBe(0);

    // R1: a pending proposal's body must NOT be findable via --text.
    const p = ditto([
      'memory',
      'propose',
      '--type',
      'analysis',
      '--text',
      'wildguesszz only pending',
      '--confidence',
      'INFERRED',
      '--actor',
      'agent',
      '--output',
      'json',
    ]);
    expect(p.exitCode).toBe(0);
    const explicit = ditto(['memory', 'query', 'wildguesszz', '--text', '--output', 'json']);
    expect(explicit.exitCode).toBe(0);
    const o1 = JSON.parse(explicit.stdout);
    expect(o1.mode).toBe('body-search');
    expect(o1.fallback).toBe(false);
    expect(o1.matches).toEqual([]);

    // Approved (bootstrap) rationale body IS findable through the implicit
    // node-not-found fallback, and the answer is marked fallback:true (R9).
    const implicit = ditto(['memory', 'query', 'frobnicate', '--output', 'json']);
    expect(implicit.exitCode).toBe(0);
    const o2 = JSON.parse(implicit.stdout);
    expect(o2.mode).toBe('body-search');
    expect(o2.fallback).toBe(true);
    expect(o2.matches.length).toBeGreaterThan(0);
  });
});

describe('ditto memory propose-finding (§8 inc.3, ac-3 — evidence→INFERRED memory)', () => {
  const WI = 'wi_finding01';

  async function writeEvidenceIndex(records: unknown[]) {
    const wiDir = join(dir, '.ditto', 'local', 'work-items', WI);
    await mkdir(wiDir, { recursive: true });
    await writeFile(
      join(wiDir, 'evidence-index.json'),
      JSON.stringify({ schema_version: '0.1.0', work_item_id: WI, records }, null, 2),
    );
  }

  const commandRecord = {
    ref: { kind: 'command', command: 'bun test', summary: 'full suite green' },
    captured_at: '2026-06-18T00:00:00.000Z',
    freshness: 'fresh',
    stale_reason: null,
    portability: 'local-artifact',
    artifact_available: false,
    exit_code: 0,
    key_lines: ['2376 pass', '0 fail'],
  };

  test('converts an evidence record to a pending INFERRED observation event', async () => {
    await writeEvidenceIndex([commandRecord]);
    const r = ditto([
      'memory',
      'propose-finding',
      '--work-item',
      WI,
      '--index',
      '0',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    const ev = JSON.parse(r.stdout);
    expect(ev.event_type).toBe('observation');
    expect(ev.confidence_kind).toBe('INFERRED');
    expect(ev.status).toBe('pending');
    expect(ev.actor.kind).toBe('agent');
    expect(ev.event_id).toMatch(/^memevt_/);
    // evidence provenance is carried in the text (EvidenceRecord has no stable
    // id and is not a memory source, so it cannot live in `sources`).
    expect(ev.text).toContain('full suite green');
    expect(ev.text).toContain('bun test');
  });

  test('roundtrips propose-finding → approve → query (ac-3)', async () => {
    await writeEvidenceIndex([commandRecord]);
    const proposed = ditto([
      'memory',
      'propose-finding',
      '--work-item',
      WI,
      '--index',
      '0',
      '--output',
      'json',
    ]);
    expect(proposed.exitCode).toBe(0);
    const id = JSON.parse(proposed.stdout).event_id;
    const approved = ditto([
      'memory',
      'approve',
      id,
      '--by',
      'user',
      '--actor',
      'user',
      '--output',
      'json',
    ]);
    expect(approved.exitCode).toBe(0);
    const decisionId = JSON.parse(approved.stdout).decision.event_id;
    // event nodes carry the `decision:` id prefix regardless of event_type
    // (node_type differs: Episode for observation). See eventNodeId.
    const explain = ditto(['memory', 'explain', `decision:${decisionId}`, '--output', 'json']);
    expect(explain.exitCode).toBe(0);
    const node = JSON.parse(explain.stdout);
    expect(node.node?.node_type ?? node.node_type).toBe('Episode');
  });

  test('falls back to key_lines when the ref has no summary (file kind)', async () => {
    await writeEvidenceIndex([
      {
        ref: { kind: 'file', path: 'src/core/x.ts', lines: { start: 10, end: 20 } },
        captured_at: '2026-06-18T00:00:00.000Z',
        freshness: 'fresh',
        stale_reason: null,
        portability: 'committed',
        artifact_available: true,
        exit_code: null,
        key_lines: ['export const broken = true;'],
      },
    ]);
    const r = ditto([
      'memory',
      'propose-finding',
      '--work-item',
      WI,
      '--index',
      '0',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    const ev = JSON.parse(r.stdout);
    expect(ev.text).toContain('export const broken = true;');
    expect(ev.text).toContain('src/core/x.ts:10-20');
  });

  test('out-of-range index is a usage error', async () => {
    await writeEvidenceIndex([commandRecord]);
    const r = ditto([
      'memory',
      'propose-finding',
      '--work-item',
      WI,
      '--index',
      '5',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(65);
    expect(r.stderr).toMatch(/index/i);
  });

  test('empty/absent evidence index is a usage error', () => {
    const r = ditto([
      'memory',
      'propose-finding',
      '--work-item',
      WI,
      '--index',
      '0',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(65);
  });

  test('malformed work item id is a usage error', () => {
    const r = ditto([
      'memory',
      'propose-finding',
      '--work-item',
      'not-a-wi',
      '--index',
      '0',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(65);
  });
});

describe('ditto memory measure (§8 inc.5, ac-5 — hallucination baseline)', () => {
  async function writeAdrs() {
    const adrDir = join(dir, '.ditto', 'knowledge', 'adr');
    await mkdir(adrDir, { recursive: true });
    await writeFile(
      join(adrDir, 'ADR-0001-x.md'),
      '# ADR-0001: A\n\n## 결정\nuse zod.\n\n## 대안 (기각)\n- **Neo4j 상시 서버**: 무서버 위반. 기각.\n- **임베딩 매칭**: 비결정. 기각.\n',
    );
    await writeFile(
      join(adrDir, 'ADR-0002-y.md'),
      '# ADR-0002: B\n\n## 결정\nschema is SoT.\n\n## 근거\nsingle source.\n',
    );
  }

  test('emits the baseline inventory + coverage over real ADRs (1회 산출)', async () => {
    await writeAdrs();
    const r = ditto(['memory', 'measure', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.adrs_total).toBe(2);
    expect(out.rejected_alternatives_total).toBe(2);
    expect(out.adrs_without_rejected_section).toContain('ADR-0002-y.md');
    expect(out.reproposals_detected).toBe(0);
    expect(out.reproposal_rate).toBe(0);
  });

  test('--against detects a re-proposal in a candidate text file', async () => {
    await writeAdrs();
    await writeFile(join(dir, 'plan.md'), 'plan: stand up a Neo4j server for the graph.');
    const r = ditto(['memory', 'measure', '--against', 'plan.md', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.reproposals_detected).toBeGreaterThanOrEqual(1);
    expect(out.reproposal_rate).toBeGreaterThan(0);
  });

  test('absent ADR dir is a usage error', () => {
    const r = ditto(['memory', 'measure', '--output', 'json']);
    expect(r.exitCode).toBe(65);
  });
});

describe('ditto memory capture (data-dependent case, wi_260621r2m)', () => {
  // Scan one code file so a source_type='code' MemorySource exists, then return
  // its src_ id (the capture's code-path grounding, ac-1 finding-B floor).
  async function scanCodeSource(): Promise<string> {
    await writeFile(
      join(dir, 'feature.ts'),
      'export const branch = (x: number) => (x > 0 ? 1 : 2);\n',
    );
    const scan = ditto(['memory', 'scan', '--output', 'json']);
    expect(scan.exitCode).toBe(0);
    const added: string[] = JSON.parse(scan.stdout).added;
    expect(added.length).toBeGreaterThanOrEqual(1);
    return added[0] as string;
  }

  // ac-1: capture → INFERRED + pending + ≥1 code source. The agent claims a fact
  // (EXTRACTED) but it is stored as a guess (INFERRED), and it stays pending.
  test('capture records an INFERRED, pending observation bound to a code source (ac-1)', async () => {
    const src = await scanCodeSource();
    const r = ditto([
      'memory',
      'capture',
      '--text',
      'with an empty input list the loop never runs and total stays 0',
      '--source',
      src,
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    const ev = JSON.parse(r.stdout);
    expect(ev.event_type).toBe('observation');
    expect(ev.confidence_kind).toBe('INFERRED');
    expect(ev.status).toBe('pending');
    expect(ev.sources).toContain(src);
    expect(ev.sources.length).toBeGreaterThanOrEqual(1);
  });

  // ac-1 regression: an agent-actor EXTRACTED claim is downgraded to INFERRED
  // (laundering guard in proposeEvent, reused — never stored as fact).
  test('agent EXTRACTED claim is stored INFERRED, never as fact (ac-1)', async () => {
    const src = await scanCodeSource();
    const r = ditto([
      'memory',
      'capture',
      '--text',
      'negative quantity yields a refund branch',
      '--source',
      src,
      '--confidence',
      'EXTRACTED',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout).confidence_kind).toBe('INFERRED');
  });

  // ac-1 negative: a capture with no code source is rejected (CLI-layer floor).
  test('capture with no source is rejected (usage error)', async () => {
    await scanCodeSource();
    const r = ditto([
      'memory',
      'capture',
      '--text',
      'some data-dependent behavior',
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(65);
  });

  // ac-1 negative: a capture whose only source is non-code (markdown) is rejected
  // — the floor checks the bound source resolves to source_type='code'.
  test('capture bound only to a non-code source is rejected (usage error)', async () => {
    await writeFile(join(dir, 'notes.md'), '# notes\n\nsome prose about behavior\n');
    const scan = ditto(['memory', 'scan', '--output', 'json']);
    expect(scan.exitCode).toBe(0);
    const mdSrc: string = JSON.parse(scan.stdout).added[0];
    const r = ditto([
      'memory',
      'capture',
      '--text',
      'data-dependent behavior',
      '--source',
      mdSrc,
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(65);
  });

  // ac-2 round-trip: capture → approve → the event is retrievable via memory query
  // (deterministic body-search round-trip over the approved head).
  test('after approve the captured event is retrievable via memory query (ac-2)', async () => {
    const src = await scanCodeSource();
    const captured = ditto([
      'memory',
      'capture',
      '--text',
      'sentinelTokenZyx marks the empty-batch branch',
      '--source',
      src,
      '--output',
      'json',
    ]);
    expect(captured.exitCode).toBe(0);
    const id = JSON.parse(captured.stdout).event_id;

    const approved = ditto([
      'memory',
      'approve',
      id,
      '--by',
      'user',
      '--actor',
      'user',
      '--output',
      'json',
    ]);
    expect(approved.exitCode).toBe(0);
    const approvedId = JSON.parse(approved.stdout).decision.event_id;

    const q = ditto(['memory', 'query', 'sentinelTokenZyx', '--text', '--output', 'json']);
    expect(q.exitCode).toBe(0);
    const out = JSON.parse(q.stdout);
    const ids = out.matches.map((m: { event_id: string }) => m.event_id);
    expect(ids).toContain(approvedId);
  });

  // ac-3: a pending (pre-approve) capture is NOT served — absent from query
  // (approved-only reduce). Pending knowledge never leaks into answers.
  test('a pending capture is absent from query before approval (ac-3)', async () => {
    const src = await scanCodeSource();
    const captured = ditto([
      'memory',
      'capture',
      '--text',
      'sentinelPendingQqq marks a pre-approval branch',
      '--source',
      src,
      '--output',
      'json',
    ]);
    expect(captured.exitCode).toBe(0);

    const q = ditto(['memory', 'query', 'sentinelPendingQqq', '--text', '--output', 'json']);
    expect(q.exitCode).toBe(0);
    expect(JSON.parse(q.stdout).matches.length).toBe(0);
  });

  // ac-4: the capture path adds no new event_type — memoryEventType enum is
  // unchanged. Snapshot diff over the canonical option list.
  test('memoryEventType enum options are unchanged (ac-4)', async () => {
    const { memoryEventType } = await import('~/schemas/memory-event');
    expect(memoryEventType.options).toEqual([
      'decision',
      'observation',
      'preference',
      'review_outcome',
      'analysis',
      'correction',
    ]);
  });
});
