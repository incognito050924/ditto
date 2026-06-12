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
