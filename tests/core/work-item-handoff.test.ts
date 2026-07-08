import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { utimesSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleCompletionFromGraph } from '~/core/autopilot-complete';
import { AutopilotStore } from '~/core/autopilot-store';
import { HandoffStore, buildHandoff } from '~/core/handoff-store';
import {
  InvalidBaseRefError,
  InvalidHeadRefError,
  writeWorkItemHandoff,
} from '~/core/work-item-handoff';
import { WorkItemStore } from '~/core/work-item-store';
import { autopilot } from '~/schemas/autopilot';

let workDir: string;
let store: WorkItemStore;

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'ditto-hand-'));
  store = new WorkItemStore(workDir);
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function makeInput() {
  return {
    title: 'sample',
    source_request: 'req',
    goal: 'goal',
    acceptance_criteria: [
      { id: 'ac-1', statement: 's', verdict: 'unverified' as const, evidence: [] },
    ],
  };
}

describe('writeWorkItemHandoff', () => {
  test('pass path: status=done, no re_entry, no resume in handoff.md', async () => {
    const created = await store.create(makeInput());
    // mark ac-1 as pass
    await store.update(created.id, (cur) => ({
      ...cur,
      acceptance_criteria: cur.acceptance_criteria.map((c) =>
        c.id === 'ac-1' ? { ...c, verdict: 'pass' as const } : c,
      ),
    }));
    const result = await writeWorkItemHandoff(workDir, store, created.id);
    expect(result.completion.final_verdict).toBe('pass');
    const updated = await store.get(created.id);
    expect(updated.status).toBe('done');
    expect(updated.re_entry).toBeUndefined();
    expect(updated.closed_at).toBeDefined();
    const handoffText = await Bun.file(result.handoffPath).text();
    expect(handoffText).not.toContain('다음 명령');
    expect(handoffText).not.toContain('다음 fresh evidence');
    expect(handoffText).not.toContain('ditto work resume');
  });

  test('partial path: status=partial, re_entry set, resume hint in handoff.md', async () => {
    const created = await store.create(makeInput());
    // ac-1 stays unverified → final_verdict=partial
    const result = await writeWorkItemHandoff(workDir, store, created.id);
    expect(result.completion.final_verdict).toBe('partial');
    const updated = await store.get(created.id);
    expect(updated.status).toBe('partial');
    expect(updated.re_entry).toBeDefined();
    // wi_260708xgo: the re_entry command points to a REAL command — the manual
    // handoff read — not the non-existent `ditto work resume`.
    expect(updated.re_entry?.command).toBe(`ditto work handoff ${created.id} --show`);
    const handoffText = await Bun.file(result.handoffPath).text();
    // partial → active handoff; re_entry 명령은 open_threads 로 운반된다.
    expect(handoffText).toContain('## 열린 스레드');
    expect(handoffText).toContain(`ditto work handoff ${created.id} --show`);
    expect(handoffText).not.toContain('ditto work resume');
  });

  test('changed_files: when work item has runs/evidence but no diff base, unverified entry is added in-scope', async () => {
    const created = await store.create(makeInput());
    // mark ac-1 pass and add an evidence entry so the item has "evidence"
    await store.update(created.id, (cur) => ({
      ...cur,
      acceptance_criteria: cur.acceptance_criteria.map((c) =>
        c.id === 'ac-1'
          ? {
              ...c,
              verdict: 'pass' as const,
              evidence: [{ kind: 'command' as const, command: 'echo' }],
            }
          : c,
      ),
    }));
    // workDir is not a git repo → no base, no changed_files collectable
    const result = await writeWorkItemHandoff(workDir, store, created.id);
    // unverified should include changed_files entry; final_verdict can't be pass
    const inScopeUnverified = result.completion.unverified.filter((u) => !u.out_of_scope);
    const hasChangedFilesEntry = inScopeUnverified.some(
      (u) => u.item === 'changed_files not recorded',
    );
    expect(hasChangedFilesEntry).toBe(true);
    expect(result.completion.final_verdict).not.toBe('pass');
  });

  test('explicit --base that does not resolve throws InvalidBaseRefError', async () => {
    const created = await store.create(makeInput());
    let thrown: unknown;
    try {
      await writeWorkItemHandoff(workDir, store, created.id, {
        base: '__definitely_missing_ref__',
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidBaseRefError);
    // completion.json must not have been written
    const completionPath = join(
      workDir,
      '.ditto',
      'local',
      'work-items',
      created.id,
      'completion.json',
    );
    expect(await Bun.file(completionPath).exists()).toBe(false);
  });

  test('default base candidates falling through to null is allowed (no explicit --base)', async () => {
    const created = await store.create(makeInput());
    // workDir is not a git repo → all default candidates fail, baseUsed=null,
    // but this is NOT an error. Handoff still succeeds (partial path due to
    // unverified ac and changed_files heuristic).
    const result = await writeWorkItemHandoff(workDir, store, created.id);
    expect(result.baseUsed).toBeNull();
  });

  test('base priority: --base wins over started_at_sha', async () => {
    Bun.spawnSync(['git', 'init', '-q'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'config', 'user.email', 't@t'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'config', 'user.name', 't'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'one'], {
      cwd: workDir,
      stdout: 'pipe',
    });
    const oneSha = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: workDir, stdout: 'pipe' })
      .stdout.toString()
      .trim();
    Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'two'], {
      cwd: workDir,
      stdout: 'pipe',
    });
    const twoSha = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: workDir, stdout: 'pipe' })
      .stdout.toString()
      .trim();
    const created = await store.create(makeInput());
    await store.update(created.id, (cur) => ({
      ...cur,
      started_at_sha: oneSha,
      acceptance_criteria: cur.acceptance_criteria.map((c) =>
        c.id === 'ac-1' ? { ...c, verdict: 'pass' as const } : c,
      ),
    }));
    const result = await writeWorkItemHandoff(workDir, store, created.id, { base: twoSha });
    expect(result.baseUsed).toBe(twoSha);
  });

  test('base priority: started_at_sha wins over default fallback when --base omitted', async () => {
    Bun.spawnSync(['git', 'init', '-q'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'config', 'user.email', 't@t'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'config', 'user.name', 't'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'one'], {
      cwd: workDir,
      stdout: 'pipe',
    });
    const sha = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: workDir, stdout: 'pipe' })
      .stdout.toString()
      .trim();
    const created = await store.create(makeInput());
    await store.update(created.id, (cur) => ({
      ...cur,
      started_at_sha: sha,
      acceptance_criteria: cur.acceptance_criteria.map((c) =>
        c.id === 'ac-1' ? { ...c, verdict: 'pass' as const } : c,
      ),
    }));
    // origin/main 등 fallback ref가 없는 임시 repo에서도 started_at_sha가 사용됨
    const result = await writeWorkItemHandoff(workDir, store, created.id);
    expect(result.baseUsed).toBe(sha);
  });

  test('--head narrows diff to a past commit range, excluding later changes', async () => {
    Bun.spawnSync(['git', 'init', '-q'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'config', 'user.email', 't@t'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'config', 'user.name', 't'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'init'], {
      cwd: workDir,
      stdout: 'pipe',
    });
    const baseSha = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: workDir, stdout: 'pipe' })
      .stdout.toString()
      .trim();
    await Bun.write(join(workDir, 'wave-1.txt'), 'one\n');
    Bun.spawnSync(['git', 'add', 'wave-1.txt'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'commit', '-q', '-m', 'wave 1'], { cwd: workDir, stdout: 'pipe' });
    const headSha = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: workDir, stdout: 'pipe' })
      .stdout.toString()
      .trim();
    await Bun.write(join(workDir, 'wave-2.txt'), 'two\n');
    Bun.spawnSync(['git', 'add', 'wave-2.txt'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'commit', '-q', '-m', 'wave 2'], { cwd: workDir, stdout: 'pipe' });

    const created = await store.create(makeInput());
    await store.update(created.id, (cur) => ({
      ...cur,
      acceptance_criteria: cur.acceptance_criteria.map((c) =>
        c.id === 'ac-1' ? { ...c, verdict: 'pass' as const } : c,
      ),
    }));
    const result = await writeWorkItemHandoff(workDir, store, created.id, {
      base: baseSha,
      head: headSha,
    });
    expect(result.completion.changed_files).toContain('wave-1.txt');
    expect(result.completion.changed_files).not.toContain('wave-2.txt');
  });

  test('handoff includes its own outputs (completion.json/work-item.json) in changed_files', async () => {
    Bun.spawnSync(['git', 'init', '-q'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'config', 'user.email', 't@t'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'config', 'user.name', 't'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'init'], {
      cwd: workDir,
      stdout: 'pipe',
    });
    const created = await store.create(makeInput());
    await store.update(created.id, (cur) => ({
      ...cur,
      acceptance_criteria: cur.acceptance_criteria.map((c) =>
        c.id === 'ac-1' ? { ...c, verdict: 'pass' as const } : c,
      ),
    }));
    const result = await writeWorkItemHandoff(workDir, store, created.id);
    // handoff 본문은 work-item 밖(.ditto/local/handoff/)으로 옮겨졌고 소비되면 archive로
    // 이동하므로, stale 경로가 되지 않도록 changed_files self-union에서 제외한다.
    const expectedSelf = [
      `.ditto/local/work-items/${created.id}/completion.json`,
      `.ditto/local/work-items/${created.id}/work-item.json`,
    ];
    for (const path of expectedSelf) {
      expect(result.completion.changed_files).toContain(path);
    }
  });

  test('re-handoff preserves a prior completion.json verifications/remaining_risks/summary (same verdict)', async () => {
    const created = await store.create(makeInput());
    await store.update(created.id, (cur) => ({
      ...cur,
      acceptance_criteria: cur.acceptance_criteria.map((c) =>
        c.id === 'ac-1' ? { ...c, verdict: 'pass' as const } : c,
      ),
    }));
    // First handoff → pass verdict, completion.json written.
    await writeWorkItemHandoff(workDir, store, created.id);
    // A verifier enriches the completion.json with real verifications + risks + summary.
    const completionPath = join(
      workDir,
      '.ditto',
      'local',
      'work-items',
      created.id,
      'completion.json',
    );
    const enriched = JSON.parse(await Bun.file(completionPath).text());
    enriched.verifications = [{ command: 'bun test', exit_code: 0 }];
    enriched.remaining_risks = ['r1'];
    enriched.summary = 'verifier-authored richer summary';
    await Bun.write(completionPath, JSON.stringify(enriched));
    // Re-handoff: prior non-empty fields must survive (built defaults are empty).
    const result = await writeWorkItemHandoff(workDir, store, created.id);
    expect(result.completion.final_verdict).toBe('pass');
    expect(result.completion.verifications.length).toBeGreaterThan(0);
    expect(result.completion.remaining_risks).toContain('r1');
    expect(result.completion.summary).toBe('verifier-authored richer summary');
  });

  test('re-handoff with a malformed prior completion.json still succeeds with built defaults', async () => {
    const created = await store.create(makeInput());
    await store.update(created.id, (cur) => ({
      ...cur,
      acceptance_criteria: cur.acceptance_criteria.map((c) =>
        c.id === 'ac-1' ? { ...c, verdict: 'pass' as const } : c,
      ),
    }));
    const completionPath = join(
      workDir,
      '.ditto',
      'local',
      'work-items',
      created.id,
      'completion.json',
    );
    await Bun.write(completionPath, '{ this is not valid json');
    const result = await writeWorkItemHandoff(workDir, store, created.id);
    expect(result.completion.final_verdict).toBe('pass');
    expect(result.completion.verifications).toEqual([]);
  });

  test('--head with invalid ref throws InvalidHeadRefError', async () => {
    const created = await store.create(makeInput());
    let thrown: unknown;
    try {
      await writeWorkItemHandoff(workDir, store, created.id, {
        head: '__missing_head_ref__',
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(InvalidHeadRefError);
  });

  test('graph exists: handoff uses graph-derived verdicts and AGREES with autopilot complete (no clobber to partial)', async () => {
    const created = await store.create(makeInput());
    // Work item AC stays `unverified` — the stale source that used to drag the
    // handoff completion to `partial`. The graph, however, closes ac-1 with a
    // passed addressing node carrying evidence.
    const graph = autopilot.parse({
      schema_version: '0.1.0',
      autopilot_id: 'orch_handofftest',
      work_item_id: created.id,
      root_goal: 'goal',
      approval_gate: { status: 'not_required', source: 'small_reversible_policy' },
      nodes: [
        {
          id: 'N3',
          kind: 'verify',
          owner: 'verifier',
          purpose: 'verify ac-1',
          status: 'passed',
          acceptance_refs: ['ac-1'],
          evidence_refs: [{ kind: 'file', path: 't.log', summary: 'verify log' }],
        },
      ],
      caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: 3 },
      continue_policy: {},
      stop_conditions: [],
    });
    await new AutopilotStore(workDir).write(created.id, graph);

    // The graph-based path (what `ditto autopilot complete` produces).
    const fromComplete = assembleCompletionFromGraph(graph, await store.get(created.id));
    expect(fromComplete.final_verdict).toBe('pass');

    // The handoff path must now derive from the SAME graph → also pass.
    const result = await writeWorkItemHandoff(workDir, store, created.id);
    expect(result.completion.final_verdict).toBe('pass');
    // Per-AC verdicts agree between the two paths.
    expect(result.completion.acceptance.map((a) => a.verdict)).toEqual(
      fromComplete.acceptance.map((a) => a.verdict),
    );
    const updated = await store.get(created.id);
    expect(updated.status).toBe('done');
  });

  test('graph + oracle: handoff threads the AC oracle and AGREES with complete (N10 gate↔score)', async () => {
    const created = await store.create(makeInput());
    // ac-1 carries a static_scan oracle: closure needs file/artifact/command evidence.
    await store.update(created.id, (cur) => ({
      ...cur,
      acceptance_criteria: cur.acceptance_criteria.map((c) =>
        c.id === 'ac-1'
          ? {
              ...c,
              oracle: {
                verification_method: 'static_scan' as const,
                maps_to: 'src/x.ts:10',
                direction: 'backward' as const,
              },
            }
          : c,
      ),
    }));
    // The graph closes ac-1 with a PASSED node, but its only evidence is a `note` —
    // which does NOT satisfy a static_scan oracle (needs file/artifact/command). The
    // oracle-gated verdict must therefore downgrade from pass.
    const graph = autopilot.parse({
      schema_version: '0.1.0',
      autopilot_id: 'orch_oracletest',
      work_item_id: created.id,
      root_goal: 'goal',
      approval_gate: { status: 'not_required', source: 'small_reversible_policy' },
      nodes: [
        {
          id: 'N3',
          kind: 'verify',
          owner: 'verifier',
          purpose: 'verify ac-1',
          status: 'passed',
          acceptance_refs: ['ac-1'],
          evidence_refs: [{ kind: 'note', summary: 'looks fine' }],
        },
      ],
      caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: 3 },
      continue_policy: {},
      stop_conditions: [],
    });
    await new AutopilotStore(workDir).write(created.id, graph);

    // `ditto autopilot complete` threads the oracle (→ downgrade). The handoff path
    // MUST thread the SAME oracle or the two completion verdicts silently diverge.
    const fromComplete = assembleCompletionFromGraph(graph, await store.get(created.id));
    const result = await writeWorkItemHandoff(workDir, store, created.id);
    // No gate↔score gap: both paths produce identical per-AC verdicts.
    expect(result.completion.acceptance.map((a) => a.verdict)).toEqual(
      fromComplete.acceptance.map((a) => a.verdict),
    );
  });

  test('no graph: handoff still uses work-item AC verdicts (unchanged fallback)', async () => {
    const created = await store.create(makeInput());
    // ac-1 stays unverified, no graph → fallback path → partial (regression guard).
    const result = await writeWorkItemHandoff(workDir, store, created.id);
    expect(result.completion.final_verdict).toBe('partial');
  });

  test('replace (not union): stale changed_files give way to git collected on re-handoff', async () => {
    Bun.spawnSync(['git', 'init', '-q'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'config', 'user.email', 't@t'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'config', 'user.name', 't'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'commit', '--allow-empty', '-q', '-m', 'init'], {
      cwd: workDir,
      stdout: 'pipe',
    });
    const initSha = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: workDir, stdout: 'pipe' })
      .stdout.toString()
      .trim();
    await Bun.write(join(workDir, 'real-change.txt'), 'hello\n');
    Bun.spawnSync(['git', 'add', 'real-change.txt'], { cwd: workDir, stdout: 'pipe' });
    Bun.spawnSync(['git', 'commit', '-q', '-m', 'real change'], {
      cwd: workDir,
      stdout: 'pipe',
    });

    const created = await store.create(makeInput());
    // work item에 가짜 entry를 박고 started_at_sha를 init commit으로 박는다.
    await store.update(created.id, (cur) => ({
      ...cur,
      started_at_sha: initSha,
      changed_files: ['never-existed.txt'],
      acceptance_criteria: cur.acceptance_criteria.map((c) =>
        c.id === 'ac-1' ? { ...c, verdict: 'pass' as const } : c,
      ),
    }));
    const result = await writeWorkItemHandoff(workDir, store, created.id);
    // collected만 남고 가짜 entry는 사라진다.
    expect(result.completion.changed_files).toContain('real-change.txt');
    expect(result.completion.changed_files).not.toContain('never-existed.txt');
    const handoffText = await Bun.file(result.handoffPath).text();
    expect(handoffText).toContain('## 변경 파일');
    expect(handoffText).toContain('real-change.txt');
    expect(handoffText).not.toContain('never-existed.txt');
    // work-item.json도 갱신되어 가짜 entry가 사라져야 한다.
    const after = await store.get(created.id);
    expect(after.changed_files).not.toContain('never-existed.txt');
  });
});

// wi_2607069bk WS0-T0 n5 — D1 terminal chokepoint (ac-5). The handoff was the last
// path doing a DIRECT `status:'done'` write, bypassing the R1 already-terminal guard
// that store.close() enforces. These prove the handoff now routes the terminal
// transition through the single chokepoint (§2.3 line 90 / V6 line 172).
describe('writeWorkItemHandoff terminal chokepoint (ac-5)', () => {
  // (b) A pass-handoff on a WI that ALREADY raced to a different terminal must be
  // REJECTED, not silently overwritten. Under the old direct `status:'done'` write
  // the handoff resolved silently (the reducer kept `abandoned` but the handoff
  // returned success + wrote a spurious done event); routing through close() surfaces
  // the collision as an error instead.
  test('pass-handoff on an already-terminal (abandoned) WI is rejected (no silent overwrite)', async () => {
    const created = await store.create(makeInput());
    await store.update(created.id, (cur) => ({
      ...cur,
      acceptance_criteria: cur.acceptance_criteria.map((c) =>
        c.id === 'ac-1' ? { ...c, verdict: 'pass' as const } : c,
      ),
    }));
    // A racing terminal (e.g. user `work abandon`) lands FIRST.
    await store.close(created.id, 'abandoned');
    // The pass-handoff must go through the R1 chokepoint, which rejects an
    // already-terminal transition rather than silently flipping to done.
    await expect(writeWorkItemHandoff(workDir, store, created.id)).rejects.toThrow(/terminal/);
    // status unchanged on disk (no silent overwrite of the abandoned terminal).
    expect((await store.get(created.id)).status).toBe('abandoned');
  });

  // (a)/(b) tied to the handoff: after the handoff completes the terminal (done)
  // via the close()/event path, a SECOND competing terminal transition through
  // close() is rejected — first-terminal-wins, the chokepoint holds.
  test('after pass-handoff completes done via the chokepoint, a competing close() is rejected', async () => {
    const created = await store.create(makeInput());
    await store.update(created.id, (cur) => ({
      ...cur,
      acceptance_criteria: cur.acceptance_criteria.map((c) =>
        c.id === 'ac-1' ? { ...c, verdict: 'pass' as const } : c,
      ),
    }));
    const result = await writeWorkItemHandoff(workDir, store, created.id);
    expect(result.completion.final_verdict).toBe('pass');
    // Terminal status arrived via the close()/event path (not a direct write).
    expect((await store.get(created.id)).status).toBe('done');
    // A second terminal transition is rejected by the R1 chokepoint.
    await expect(store.close(created.id, 'done')).rejects.toThrow(/terminal/);
  });
});

// wi_2606289nt: work-done also sweeps STALE active handoffs into archive
// (move-not-delete), fail-open.
describe('writeWorkItemHandoff stale active sweep', () => {
  const DAY = 24 * 60 * 60 * 1000;

  // ac-4: the work-done path actually invokes sweepStaleActive — effect-observable.
  // A stale sibling handoff (created long ago) is gone from active after work-done;
  // only sweepStaleActive removes it (work-done writes a handoff for ITS own item).
  test('a stale sibling active handoff is swept out on work-done (invocation effect)', async () => {
    const subject = await store.create(makeInput());
    const sibling = await store.create(makeInput());
    const hstore = new HandoffStore(workDir);
    const now = new Date('2026-06-29T00:00:00.000Z');
    const siblingItem = await store.get(sibling.id);
    await hstore.write(
      buildHandoff({
        workItem: siblingItem,
        fromContext: 'prev',
        currentState: 'sibling-stale',
        nextFirstCheck: 'c',
        now: new Date(now.getTime() - 30 * DAY),
      }),
    );
    // WS-HND-T1: the stale sweep keys on filesystem mtime, so age the file on
    // disk too (created_at alone no longer triggers the sweep).
    const aged = new Date(now.getTime() - 30 * DAY);
    utimesSync(join(workDir, `.ditto/local/handoff/${sibling.id}.md`), aged, aged);
    expect(await hstore.exists(sibling.id)).toBe(true); // present before

    await writeWorkItemHandoff(workDir, store, subject.id, {}, now);

    expect(await hstore.exists(sibling.id)).toBe(false); // swept into archive
  });

  // ac-5: a sweep error does not break work-done (fail-open).
  test('a sweep failure does not break work-done', async () => {
    const created = await store.create(makeInput());
    const spy = spyOn(HandoffStore.prototype, 'sweepStaleActive').mockRejectedValue(
      new Error('sweep boom'),
    );
    try {
      const result = await writeWorkItemHandoff(workDir, store, created.id);
      expect(result.completion.final_verdict).toBe('partial'); // completed despite sweep throwing
    } finally {
      spy.mockRestore();
    }
  });
});
