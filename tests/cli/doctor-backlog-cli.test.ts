import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `ditto doctor backlog` (wi_2606264rm ac-4) — a READ-ONLY backlog-hygiene
 * readout: stale drafts, completed-but-unclosed work items, and the open count.
 *
 * Hygiene definitions are STRUCTURAL, never wall-clock age based (cross-PC clock
 * skew would flap boundaries):
 *   - stale draft        = status=draft ∧ no completion.json ∧ not parked-with-reason
 *   - completed-unclosed = completion.final_verdict=pass ∧ status≠done, excluding
 *                          terminal (done/abandoned) — an abandoned WI with a pass
 *                          completion is NOT a hygiene item.
 *   - open-count         = work items in a non-terminal status.
 * It performs NO cleanup/close action; output only.
 */
const cliEntry = join(process.cwd(), 'src/cli/index.ts');

let dir: string;

function git(args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'ignore', 'pipe'] });
}

function spawnDitto(args: string[]): { stdout: string; stderr: string; exitCode: number | null } {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], { cwd: dir, env: { ...process.env } });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

function workItemDoc(id: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    schema_version: '0.1.0',
    id,
    title: `title ${id}`,
    source_request: 'verbatim request',
    goal: 'observable outcome',
    acceptance_criteria: [
      { id: 'ac-1', statement: 'do a thing', verdict: 'unverified', evidence: [] },
    ],
    status,
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    ...extra,
  };
}

function completionDoc(id: string, finalVerdict: 'pass' | 'partial') {
  const acVerdict = finalVerdict === 'pass' ? 'pass' : 'partial';
  return {
    schema_version: '0.1.0',
    work_item_id: id,
    declared_by: 'implementer',
    declared_at: '2026-06-01T00:00:00.000Z',
    summary: 'did the thing',
    changed_files: [],
    acceptance: [
      {
        criterion_id: 'ac-1',
        verdict: acVerdict,
        evidence: [{ kind: 'note', summary: 'ok' }],
      },
    ],
    final_verdict: finalVerdict,
    ...(finalVerdict === 'pass' ? {} : { next_handoff_path: 'handoff.md' }),
  };
}

async function seedWorkItem(
  id: string,
  status: string,
  opts: { wiExtra?: Record<string, unknown>; completion?: 'pass' | 'partial' } = {},
): Promise<void> {
  const d = join(dir, '.ditto', 'local', 'work-items', id);
  await mkdir(d, { recursive: true });
  await writeFile(join(d, 'work-item.json'), JSON.stringify(workItemDoc(id, status, opts.wiExtra)));
  if (opts.completion) {
    await writeFile(join(d, 'completion.json'), JSON.stringify(completionDoc(id, opts.completion)));
  }
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-doctor-backlog-'));
  git(['init']);
  git(['config', 'user.email', 't@t.test']);
  git(['config', 'user.name', 't']);
  await mkdir(join(dir, '.ditto'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ditto doctor backlog', () => {
  test('detects stale draft, completed-unclosed, open-count; excludes parked + terminal (json)', async () => {
    // draft, no completion → stale
    await seedWorkItem('wi_stale001', 'draft');
    // parked: partial + re_entry, no completion → NOT stale, but open
    await seedWorkItem('wi_parked01', 'partial', {
      wiExtra: { re_entry: { command: 'resume here', fresh_evidence_needed: [] } },
    });
    // pass completion but still in_progress → completed-unclosed
    await seedWorkItem('wi_unclosed1', 'in_progress', { completion: 'pass' });
    // abandoned with a pass completion → NOT a hygiene item (terminal)
    await seedWorkItem('wi_abandon01', 'abandoned', { completion: 'pass' });
    // done with a pass completion → terminal, not open, not unclosed
    await seedWorkItem('wi_done0001', 'done', { completion: 'pass' });

    const res = spawnDitto(['doctor', 'backlog', '--output', 'json']);
    expect(res.exitCode).toBe(0);
    const payload = JSON.parse(res.stdout);

    const staleIds = payload.stale_drafts.map((r: { work_item_id: string }) => r.work_item_id);
    expect(staleIds).toContain('wi_stale001');
    expect(staleIds).not.toContain('wi_parked01');

    const unclosedIds = payload.completed_unclosed.map(
      (r: { work_item_id: string }) => r.work_item_id,
    );
    expect(unclosedIds).toContain('wi_unclosed1');
    expect(unclosedIds).not.toContain('wi_abandon01');
    expect(unclosedIds).not.toContain('wi_done0001');

    // open = non-terminal: stale(draft) + parked(partial) + unclosed(in_progress)
    expect(payload.open_count).toBe(3);
  });

  test('clean backlog → empty hygiene lists, exit 0 (human)', async () => {
    await seedWorkItem('wi_done0001', 'done', { completion: 'pass' });
    const res = spawnDitto(['doctor', 'backlog']);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toContain('open');
  });

  test('invalid --output is a usage error (exit 65)', async () => {
    const res = spawnDitto(['doctor', 'backlog', '--output', 'xml']);
    expect(res.exitCode).toBe(65);
  });

  // idea ②-A residual (wi_260627pfa): advisory next-action per surfaced item.
  // Read-only — the suggestion names a command, the readout never runs it.
  test('surfaced items carry an advisory suggested_action (json + human), read-only', async () => {
    await seedWorkItem('wi_stale001', 'draft');
    await seedWorkItem('wi_unclosed1', 'in_progress', { completion: 'pass' });

    const json = spawnDitto(['doctor', 'backlog', '--output', 'json']);
    expect(json.exitCode).toBe(0);
    const payload = JSON.parse(json.stdout);
    const stale = payload.stale_drafts.find(
      (r: { work_item_id: string }) => r.work_item_id === 'wi_stale001',
    );
    // stale draft suggests resume OR abandon — never a silent auto-abandon.
    expect(stale.suggested_action).toContain('ditto work abandon wi_stale001');
    expect(stale.suggested_action.toLowerCase()).toContain('resume');
    const unclosed = payload.completed_unclosed.find(
      (r: { work_item_id: string }) => r.work_item_id === 'wi_unclosed1',
    );
    expect(unclosed.suggested_action).toContain('ditto work done wi_unclosed1');

    // human output carries the same hints.
    const human = spawnDitto(['doctor', 'backlog']);
    expect(human.stdout).toContain('ditto work abandon wi_stale001');
    expect(human.stdout).toContain('ditto work done wi_unclosed1');

    // read-only: the draft is still a draft after the readout (nothing acted).
    const after = spawnDitto(['work', 'status', 'wi_stale001']);
    expect(after.stdout).toContain('draft');
  });
});
