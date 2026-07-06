import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// WS0-T1 (wi_260706aka) node -n-cli-query: the expanded `ditto work list` view
// (the no-workId branch of `work status`). Filters (--status / --has-followups /
// --orphan-drafts, AND-combined), output modes (default 4-col / --wide / --output
// json full field set) and active-first grouping (--all reveals terminal). The
// widened fields are CONSUMED from the already-landed projectBacklog projection —
// this surface never recomputes them.

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
let dir: string;

function ditto(args: string[]) {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], { cwd: dir, env: { ...process.env } });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

interface RecordFields {
  title?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
  follows?: string;
  follow_ups?: unknown[];
  github_issue?: { repo: string; number: number };
}

// Write a committed Record (`.ditto/work-items/<id>/record.json`) directly. This is
// the tier projectBacklog reads (ac-5 determinism), and writing it lets tests control
// updated_at / follows / follow_ups precisely (needed for the age + lineage filters).
async function writeRecord(id: string, fields: RecordFields = {}): Promise<void> {
  const now = new Date().toISOString();
  const record = {
    schema_version: '0.1.0',
    id,
    title: fields.title ?? `title ${id}`,
    source_request: 'the original request',
    goal: 'an observable outcome',
    acceptance_criteria: [{ id: 'ac-1', statement: 'the command returns 0' }],
    status: fields.status ?? 'draft',
    owner_profile: 'workspace-write',
    child_ids: [],
    changed_files: [],
    worktrees: [],
    risks: [],
    runs: [],
    created_at: fields.created_at ?? now,
    updated_at: fields.updated_at ?? now,
    ...(fields.follows ? { follows: fields.follows } : {}),
    ...(fields.follow_ups ? { follow_ups: fields.follow_ups } : {}),
    ...(fields.github_issue ? { github_issue: fields.github_issue } : {}),
  };
  const p = join(dir, '.ditto', 'work-items', id, 'record.json');
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(record, null, 2));
}

function daysAgo(n: number): string {
  return new Date(Date.now() - n * 86400000).toISOString();
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-worklist-'));
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('work list (work status, no workId) — default output (ac-3 backward-compat)', () => {
  test('default human output is byte-identical 4 tab columns id/status/updated_at/title', async () => {
    const ts = daysAgo(1);
    await writeRecord('wi_aaaa0001', { title: 'first', status: 'draft', updated_at: ts });
    const r = ditto(['work', 'status']);
    expect(r.exitCode).toBe(0);
    const lines = r.stdout.trimEnd().split('\n');
    expect(lines).toContain(`wi_aaaa0001\tdraft\t${ts}\tfirst`);
    // No added columns in the default view: every row is exactly 4 tab-separated fields.
    for (const line of lines) expect(line.split('\t').length).toBe(4);
  });

  test('default human view hides terminal (done/abandoned) items', async () => {
    await writeRecord('wi_active001', { status: 'draft' });
    await writeRecord('wi_doneone01', { status: 'done', updated_at: daysAgo(2) });
    const r = ditto(['work', 'status']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('wi_active001');
    expect(r.stdout).not.toContain('wi_doneone01');
  });

  test('--output json keeps the {items:[…]} shape', async () => {
    await writeRecord('wi_aaaa0001', { status: 'draft' });
    const r = ditto(['work', 'status', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(Array.isArray(out.items)).toBe(true);
    expect(out.items.length).toBe(1);
    expect(out.items[0].id).toBe('wi_aaaa0001');
  });
});

describe('work list — filters (ac-2, AND-combined)', () => {
  test('--status narrows to exactly that status', async () => {
    await writeRecord('wi_draftone1', { status: 'draft' });
    await writeRecord('wi_inprog001', { status: 'in_progress' });
    const r = ditto(['work', 'status', '--status', 'draft', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const ids = JSON.parse(r.stdout).items.map((x: { id: string }) => x.id);
    expect(ids).toEqual(['wi_draftone1']);
  });

  test('invalid --status value is rejected with a clear error (not silent empty)', async () => {
    await writeRecord('wi_draftone1', { status: 'draft' });
    const r = ditto(['work', 'status', '--status', 'bogus']);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain('invalid');
    expect(r.stderr).toContain('bogus');
    // the valid enum is spelled out so a typo can self-correct
    expect(r.stderr).toContain('draft');
  });

  test('--has-followups keeps only items with ≥1 unresolved follow-up', async () => {
    await writeRecord('wi_withfu001', {
      status: 'draft',
      follow_ups: [{ kind: 'idea', note: 'a discovered idea' }],
    });
    await writeRecord('wi_nofu0001', { status: 'draft' });
    await writeRecord('wi_resolved1', {
      status: 'draft',
      follow_ups: [{ kind: 'idea', note: 'already handled', resolved: true }],
    });
    const r = ditto(['work', 'status', '--has-followups', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const ids = JSON.parse(r.stdout).items.map((x: { id: string }) => x.id);
    expect(ids).toEqual(['wi_withfu001']);
  });

  test('--orphan-drafts keeps only old, un-chained drafts', async () => {
    await writeRecord('wi_oldorph01', { status: 'draft', updated_at: daysAgo(20) }); // orphan
    await writeRecord('wi_freshdrf1', { status: 'draft', updated_at: daysAgo(2) }); // too fresh
    await writeRecord('wi_olddone01', { status: 'done', updated_at: daysAgo(20) }); // not draft
    // an old draft that continues a chain is NOT an orphan (has lineage)
    await writeRecord('wi_chainpre1', { status: 'draft', updated_at: daysAgo(30) });
    await writeRecord('wi_chained01', {
      status: 'draft',
      updated_at: daysAgo(20),
      follows: 'wi_chainpre1',
    });
    const r = ditto(['work', 'status', '--orphan-drafts', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const ids = JSON.parse(r.stdout)
      .items.map((x: { id: string }) => x.id)
      .sort();
    expect(ids).toEqual(['wi_oldorph01']);
  });

  test('multiple filters AND-combine', async () => {
    await writeRecord('wi_match0001', {
      status: 'draft',
      follow_ups: [{ kind: 'bug', note: 'a bug', severity: 'low' }],
    });
    // right status, no follow-up → excluded by --has-followups
    await writeRecord('wi_nofustat', { status: 'draft' });
    // has follow-up, wrong status → excluded by --status draft
    await writeRecord('wi_wrongsts', {
      status: 'in_progress',
      follow_ups: [{ kind: 'bug', note: 'a bug', severity: 'low' }],
    });
    const r = ditto(['work', 'status', '--status', 'draft', '--has-followups', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const ids = JSON.parse(r.stdout).items.map((x: { id: string }) => x.id);
    expect(ids).toEqual(['wi_match0001']);
  });
});

describe('work list — output modes (ac-3)', () => {
  test('--wide shows the expanded fields', async () => {
    await writeRecord('wi_widerow01', {
      status: 'draft',
      follow_ups: [{ kind: 'idea', note: 'an idea' }],
      github_issue: { repo: 'octo/repo', number: 42 },
    });
    const r = ditto(['work', 'status', '--wide']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('wi_widerow01');
    expect(r.stdout).toContain('followups=1');
    expect(r.stdout).toContain('push_ready=');
    expect(r.stdout).toContain('issue=octo/repo#42');
  });

  test('--output json emits the full widened field set additively (explicit key-set)', async () => {
    await writeRecord('wi_jsonrow01', {
      status: 'draft',
      follow_ups: [{ kind: 'idea', note: 'an idea' }],
    });
    const r = ditto(['work', 'status', '--output', 'json']);
    expect(r.exitCode).toBe(0);
    const item = JSON.parse(r.stdout).items[0];
    // old keys stay unbroken
    for (const k of ['id', 'title', 'status', 'updated_at']) expect(item).toHaveProperty(k);
    // widened keys are present additively
    expect(item).toHaveProperty('unresolved_follow_ups');
    expect(item).toHaveProperty('push_ready');
    expect(item.unresolved_follow_ups).toBe(1);
    expect(typeof item.push_ready).toBe('boolean');
  });
});

describe('work list — active-first grouping (ac-4)', () => {
  test('active items are grouped by status; --all reveals terminal', async () => {
    await writeRecord('wi_draftgrp1', { status: 'draft', updated_at: daysAgo(1) });
    await writeRecord('wi_inprggrp1', { status: 'in_progress', updated_at: daysAgo(1) });
    await writeRecord('wi_donegrp01', { status: 'done', updated_at: daysAgo(1) });

    const base = ditto(['work', 'status']);
    expect(base.exitCode).toBe(0);
    expect(base.stdout).toContain('wi_draftgrp1');
    expect(base.stdout).toContain('wi_inprggrp1');
    expect(base.stdout).not.toContain('wi_donegrp01');
    // grouped by status: the draft row precedes the in_progress row
    const idxDraft = base.stdout.indexOf('wi_draftgrp1');
    const idxInprog = base.stdout.indexOf('wi_inprggrp1');
    expect(idxDraft).toBeLessThan(idxInprog);

    const all = ditto(['work', 'status', '--all']);
    expect(all.exitCode).toBe(0);
    expect(all.stdout).toContain('wi_donegrp01');
    // terminal is grouped after the active rows
    expect(all.stdout.indexOf('wi_inprggrp1')).toBeLessThan(all.stdout.indexOf('wi_donegrp01'));
  });

  test('an explicit --status for a terminal status is not suppressed by grouping', async () => {
    await writeRecord('wi_doneshow1', { status: 'done' });
    const r = ditto(['work', 'status', '--status', 'done']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('wi_doneshow1');
  });
});
