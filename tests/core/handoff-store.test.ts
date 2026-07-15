import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { utimesSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import * as fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BlockedHandoffMissingDecisionError,
  HandoffRemoteWriteError,
  HandoffStore,
  buildHandoff,
  buildSessionHandoff,
  renderHandoff,
} from '~/core/handoff-store';
import { WorkItemStore } from '~/core/work-item-store';
import { handoff as handoffSchema } from '~/schemas/handoff';

let repo: string;
async function workItem() {
  return new WorkItemStore(repo).create({
    title: 'pw',
    source_request: 'add a password strength endpoint',
    goal: 'g',
    acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
  });
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-ho-'));
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('buildHandoff', () => {
  test('assembles a schema-valid handoff from work item state', async () => {
    const wi = await workItem();
    const h = buildHandoff({
      workItem: wi,
      fromContext: 'session X at 60%',
      currentState: 'implement done',
      nextFirstCheck: 'run bun test',
      autopilotId: 'orch_handoff01',
      evidenceRefs: [{ kind: 'command', command: 'bun test', summary: '2 passed' }],
    });
    expect(h.scope).toEqual({ kind: 'work_item', work_item_id: wi.id });
    expect(h.original_intent).toBe('add a password strength endpoint');
    expect(h.autopilot_id).toBe('orch_handoff01');
    expect(h.evidence_refs).toHaveLength(1);
  });
});

// wi_2607148yg (ac-9): the additive/optional user-decision block on the handoff
// schema. Field shape only here (the required-when-blocked superRefine lands in
// n2-handoff); these tests pin the shape + backward-compat.
describe('handoff schema user_decision_block (wi_2607148yg ac-9)', () => {
  const baseHandoff = {
    schema_version: '0.1.0',
    work_item_id: 'wi_2607148yg',
    from_context: 'autopilot loop, condition-(b) blocked',
    original_intent: 'do the thing',
    current_state: 'blocked on a design-intent decision',
    next_first_check: 'read the decision block',
    created_at: '2026-07-14T00:00:00.000Z',
  };

  test('accepts a fail/condition-(b) handoff carrying a user_decision_block and round-trips it', () => {
    const parsed = handoffSchema.parse({
      ...baseHandoff,
      user_decision_block: [
        {
          decision: 'Which auth boundary to weaken?',
          options: ['A: relax at gateway', 'B: relax at service'],
          agent_interpretation: 'A is smaller-blast but touches a security seam — leaning defer',
        },
      ],
    });
    expect(parsed.user_decision_block).toHaveLength(1);
    expect(parsed.user_decision_block[0]?.decision).toBe('Which auth boundary to weaken?');
    expect(parsed.user_decision_block[0]?.options).toEqual([
      'A: relax at gateway',
      'B: relax at service',
    ]);
    expect(parsed.user_decision_block[0]?.agent_interpretation).toContain('leaning defer');
  });

  test('a legacy handoff WITHOUT user_decision_block still parses (backward-compat, defaults to [])', () => {
    const parsed = handoffSchema.parse(baseHandoff);
    expect(parsed.user_decision_block).toEqual([]);
  });
});

// wi_2607148yg (ac-9): buildHandoff render + required-when-blocked guard.
// Discriminator = the build-input `blocked` flag (a fail / condition-(b) handoff);
// the persisted schema stays statusless so a legacy on-disk handoff is never
// retro-rejected. Guard = guardBlockedHandoffDecision (throws
// BlockedHandoffMissingDecisionError). See handoff-store.ts.
describe('buildHandoff blocked user_decision_block (wi_2607148yg ac-9)', () => {
  test('a fail/condition-(b) blocked handoff renders the decision block with options + interpretation', async () => {
    const wi = await workItem();
    const h = buildHandoff({
      workItem: wi,
      fromContext: 'autopilot loop, condition-(b)',
      currentState: 'blocked on a design-intent decision',
      nextFirstCheck: 'read the decision block',
      blocked: true,
      userDecisionBlock: [
        {
          decision: 'Weaken the auth boundary?',
          options: ['A: relax at gateway', 'B: relax at service'],
          agent_interpretation: 'leaning defer — touches a security seam',
        },
      ],
    });
    expect(h.user_decision_block).toHaveLength(1);
    const body = renderHandoff(h);
    // the block surfaces the decision the USER must make — distinct from a resume pointer
    expect(body).toContain('사용자 결정 필요');
    expect(body).toContain('Weaken the auth boundary?');
    expect(body).toContain('A: relax at gateway');
    expect(body).toContain('B: relax at service');
    expect(body).toContain('leaning defer');
  });

  test('building a fail/condition-(b) blocked handoff with an EMPTY user_decision_block is rejected', async () => {
    const wi = await workItem();
    expect(() =>
      buildHandoff({
        workItem: wi,
        fromContext: 'autopilot loop, condition-(b)',
        currentState: 'blocked',
        nextFirstCheck: 'x',
        blocked: true,
        // no userDecisionBlock supplied
      }),
    ).toThrow(BlockedHandoffMissingDecisionError);
    // an explicit empty array is rejected the same way
    expect(() =>
      buildHandoff({
        workItem: wi,
        fromContext: 'autopilot loop, condition-(b)',
        currentState: 'blocked',
        nextFirstCheck: 'x',
        blocked: true,
        userDecisionBlock: [],
      }),
    ).toThrow(BlockedHandoffMissingDecisionError);
  });

  test('a normal (non-blocked) handoff without a user_decision_block still builds (backward-compat)', async () => {
    const wi = await workItem();
    const h = buildHandoff({
      workItem: wi,
      fromContext: 'c',
      currentState: 's',
      nextFirstCheck: 'c',
    });
    expect(h.user_decision_block).toEqual([]);
    expect(renderHandoff(h)).not.toContain('사용자 결정 필요');
  });
});

describe('HandoffStore', () => {
  test('write persists an active handoff (.ditto/local/handoff/) and links work item handoff_path', async () => {
    const wi = await workItem();
    const h = buildHandoff({
      workItem: wi,
      fromContext: 'ctx',
      currentState: 'midway',
      nextFirstCheck: 'check X',
    });
    const store = new HandoffStore(repo);
    await store.write(h);
    expect(await store.exists(wi.id)).toBe(true);
    expect((await store.get(wi.id)).current_state).toBe('midway');
    const reloaded = await new WorkItemStore(repo).get(wi.id);
    expect(reloaded.handoff_path).toBe(`.ditto/local/handoff/${wi.id}.md`);
  });

  // wi_260626r3f ac-1: per-work-item scoped pickup so a concurrent worktree
  // session (sharing the main .ditto/local) never steals a sibling's handoff.
  test('getActive returns the active handoff body or null', async () => {
    const wi = await workItem();
    const store = new HandoffStore(repo);
    expect(await store.getActive(wi.id)).toBeNull();
    await store.write(
      buildHandoff({ workItem: wi, fromContext: 'c', currentState: 'mid', nextFirstCheck: 'c' }),
    );
    const got = await store.getActive(wi.id);
    expect(got?.handoff.scope).toEqual({ kind: 'work_item', work_item_id: wi.id });
    expect(got?.body).toContain('mid');
  });

  // wi_260708xgo: manual handoff read — active if present, else the latest
  // archived copy, else null. Read-only (never consumes/moves).
  test('readLatest returns the active handoff, else the latest archived, else null', async () => {
    const wi = await workItem();
    const store = new HandoffStore(repo);
    expect(await store.readLatest(wi.id)).toBeNull();
    await store.write(
      buildHandoff({
        workItem: wi,
        fromContext: 'c',
        currentState: 'ACTIVE-marker',
        nextFirstCheck: 'c',
      }),
    );
    expect((await store.readLatest(wi.id))?.body).toContain('ACTIVE-marker');
    // HARD cleanup (age-sweep, not consume) moves active → archive; readLatest then
    // falls back to the archived copy. (consume is SOFT now — it no longer moves.)
    const path = join(repo, `.ditto/local/handoff/${wi.id}.md`);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(path, old, old);
    await store.sweepStaleActive();
    expect(await store.getActive(wi.id)).toBeNull();
    expect((await store.readLatest(wi.id))?.body).toContain('ACTIVE-marker');
  });

  // ac-7: consumeFor is SOFT — it returns the body + writes a per-recipient
  // consumed-marker WITHOUT moving the file, so a failed resume never loses the
  // handoff (the age-sweep is the sole hard cleanup).
  test('consumeFor is soft — returns body + consumed-marker, leaves the file (no-loss)', async () => {
    const a = await workItem();
    const b = await new WorkItemStore(repo).create({
      title: 'pw2',
      source_request: 'r2',
      goal: 'g2',
      acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
    });
    const store = new HandoffStore(repo);
    await store.write(
      buildHandoff({ workItem: a, fromContext: 'c', currentState: 'a-state', nextFirstCheck: 'c' }),
    );
    await store.write(
      buildHandoff({ workItem: b, fromContext: 'c', currentState: 'b-state', nextFirstCheck: 'c' }),
    );
    const consumed = await store.consumeFor(a.id, 'alice');
    expect(consumed?.handoff.scope).toEqual({ kind: 'work_item', work_item_id: a.id });
    expect(consumed?.body).toContain('a-state');
    // SOFT: the file is NOT moved — a failed resume can re-read it.
    expect(await store.exists(a.id)).toBe(true);
    expect(await store.exists(b.id)).toBe(true); // sibling untouched
    // a per-recipient consumed-marker was recorded (only for a, not the sibling).
    expect(await store.hasConsumedMarker('alice', `local-${a.id}`)).toBe(true);
    expect(await store.hasConsumedMarker('alice', `local-${b.id}`)).toBe(false);
    // no-loss idempotence: a second soft consume still returns the body.
    expect((await store.consumeFor(a.id, 'alice'))?.body).toContain('a-state');
  });

  // wi_2606289nt: stale active sweep — an active handoff no session ever picked
  // up, once older than the retention limit, is MOVED into archive (never deleted)
  // so it can never re-inject into an unrelated session's context.
  const DAY = 24 * 60 * 60 * 1000;
  async function writeAged(workItemId: string, currentState: string, createdAt: Date) {
    const items = new WorkItemStore(repo);
    const wi = await items.create({
      title: workItemId,
      source_request: `r-${workItemId}`,
      goal: 'g',
      acceptance_criteria: [{ id: 'ac-1', statement: 's', verdict: 'unverified', evidence: [] }],
    });
    const store = new HandoffStore(repo);
    await store.write(
      buildHandoff({
        workItem: wi,
        fromContext: 'c',
        currentState,
        nextFirstCheck: 'c',
        now: createdAt,
      }),
    );
    // WS-HND-T1: the stale sweep is content-blind — it keys staleness on the
    // filesystem mtime, not the parsed created_at. Age the file itself so the
    // written handoff is genuinely old on disk (createdAt alone is not enough).
    utimesSync(join(repo, `.ditto/local/handoff/${wi.id}.md`), createdAt, createdAt);
    return wi;
  }

  test('ac-1: sweepStaleActive moves an age>7d active to archive, keeps a recent (<7d) active', async () => {
    const now = new Date('2026-06-29T00:00:00.000Z');
    const stale = await writeAged('stale', 'old-marker', new Date(now.getTime() - 8 * DAY));
    const recent = await writeAged('recent', 'fresh-marker', new Date(now.getTime() - 1 * DAY));
    const store = new HandoffStore(repo);

    const swept = await store.sweepStaleActive(now);

    expect(swept).toHaveLength(1);
    expect(swept[0]?.handoff?.scope).toEqual({ kind: 'work_item', work_item_id: stale.id });
    // move-not-delete: stale gone from active, recent still active
    expect(await store.exists(stale.id)).toBe(false);
    expect(await store.exists(recent.id)).toBe(true);
    // and it lives in archive/ (moved, not deleted)
    const archived = await readdir(join(repo, '.ditto/local/handoff/archive'));
    expect(archived.some((n) => n.startsWith(`${stale.id}__`))).toBe(true);
  });

  test('ac-1 boundary: an active exactly at the limit (not strictly older) stays active', async () => {
    const now = new Date('2026-06-29T00:00:00.000Z');
    const edge = await writeAged('edge', 'edge-marker', new Date(now.getTime() - 7 * DAY));
    const store = new HandoffStore(repo);
    const swept = await store.sweepStaleActive(now);
    expect(swept).toHaveLength(0);
    expect(await store.exists(edge.id)).toBe(true);
  });

  // WS-HND-T1 (wi_2607065tn): content-blind stale sweep. A malformed / non-WI
  // handoff file (parse-fails, no work_item_id, no created_at) must ALSO retire
  // by age — otherwise a hand-authored file (e.g. the real lingering
  // session_260622_risks_processed.md) stays active forever and re-injects into
  // unrelated sessions. Age is decided by the filesystem mtime, not the parsed
  // created_at, so a file that never parses is still sweepable.
  async function writeRawActive(basename: string, body: string, mtime: Date): Promise<string> {
    const dir = join(repo, '.ditto/local/handoff');
    await mkdir(dir, { recursive: true });
    const path = join(dir, basename);
    await writeFile(path, body);
    utimesSync(path, mtime, mtime);
    return path;
  }

  test('ac-1 content-blind: a malformed active file older than 7d (by mtime) is swept to archive', async () => {
    const now = new Date('2026-07-06T00:00:00.000Z');
    // reproduces the real lingering file: hand-authored, no frontmatter → parse-fails
    const path = await writeRawActive(
      'session_260622_risks_processed.md',
      '# risks processed\n\nhand-authored notes, no JSON frontmatter, not a work item.\n',
      new Date(now.getTime() - 8 * DAY),
    );
    const store = new HandoffStore(repo);

    const swept = await store.sweepStaleActive(now);

    // move-not-delete: gone from active/, present under archive/
    expect(await Bun.file(path).exists()).toBe(false);
    const archived = await readdir(join(repo, '.ditto/local/handoff/archive'));
    expect(archived.some((n) => n.startsWith('session_260622_risks_processed__'))).toBe(true);
    // reported as swept even though it never parsed (handoff === null, no work item)
    expect(swept).toHaveLength(1);
    expect(swept[0]?.handoff).toBeNull();
  });

  test('ac-2 content-blind: a malformed active file within 7d (by mtime) is preserved', async () => {
    const now = new Date('2026-07-06T00:00:00.000Z');
    const path = await writeRawActive(
      'session_recent_notes.md',
      'not a handoff: no frontmatter, freshly written\n',
      new Date(now.getTime() - 1 * DAY),
    );
    const store = new HandoffStore(repo);

    const swept = await store.sweepStaleActive(now);

    // recent → safe-preserve (still active, not moved)
    expect(swept).toHaveLength(0);
    expect(await Bun.file(path).exists()).toBe(true);
  });

  // ac-3: context non-injection invariant. After sweep the handoff is in archive/,
  // which listActive() excludes → it can never be injected into any session again.
  test('ac-3: a swept handoff is excluded from listActive (never re-injectable)', async () => {
    const now = new Date('2026-06-29T00:00:00.000Z');
    await writeAged('ghost', 'ghost-marker', new Date(now.getTime() - 30 * DAY));
    const store = new HandoffStore(repo);
    expect(await store.listActive()).toHaveLength(1);
    await store.sweepStaleActive(now);
    expect(await store.listActive()).toHaveLength(0);
  });

  // ac-5: fail-open at store level — a rename failure leaves the file active and
  // does not throw (mirror consume()'s best-effort try/catch).
  test('ac-5: a rename failure leaves the stale file active and does not throw', async () => {
    const now = new Date('2026-06-29T00:00:00.000Z');
    const stale = await writeAged('stuck', 'stuck-marker', new Date(now.getTime() - 30 * DAY));
    const store = new HandoffStore(repo);
    const spy = spyOn(fsp, 'rename').mockRejectedValue(new Error('boom'));
    try {
      const swept = await store.sweepStaleActive(now);
      expect(swept).toHaveLength(0); // nothing successfully swept
    } finally {
      spy.mockRestore();
    }
    expect(await store.exists(stale.id)).toBe(true); // still active, not lost
  });

  // ac-7: consume is SOFT — it returns the bodies + writes consumed-markers but does
  // NOT move the files (the age-sweep is the sole hard cleanup), so a failed resume
  // never loses a handoff.
  test('consume is soft — returns bodies + consumed-markers, leaving files active', async () => {
    const wi = await workItem();
    const store = new HandoffStore(repo);
    await store.write(
      buildHandoff({ workItem: wi, fromContext: 'ctx', currentState: 's', nextFirstCheck: 'c' }),
    );
    const active = await store.listActive();
    expect(active).toHaveLength(1);
    expect(active[0]?.body).toContain('# Handoff');
    const consumed = await store.consume('alice');
    expect(consumed).toHaveLength(1);
    // SOFT: still active (no move) + a per-recipient consumed-marker recorded.
    expect(await store.exists(wi.id)).toBe(true);
    expect(await store.hasConsumedMarker('alice', `local-${wi.id}`)).toBe(true);
  });
});

// ac-6 (wi_260627jhh): critical_decisions + irreversible_risks as SEPARATE
// structural fields, additive (old-format handoff still parses).
describe('handoff critical_decisions / irreversible_risks (ac-6)', () => {
  test('backward-compat: an old-shape handoff (neither new field) still parses, no drop, new fields default []', () => {
    // A serialized OLD handoff — predates the two new fields entirely.
    const old = {
      schema_version: '0.1.0',
      work_item_id: 'wi_oldshape0',
      from_context: 'old session',
      original_intent: 'do the thing',
      current_state: 'midway',
      decisions_made: ['kept this decision'],
      changed_files: ['src/a.ts'],
      evidence_refs: [],
      failed_or_unverified: [],
      open_threads: [],
      next_first_check: 'run tests',
      forbidden_scope_creep: [],
      created_at: '2026-06-27T00:00:00.000Z',
    };
    const parsed = handoffSchema.parse(old);
    // No silent drop of existing fields.
    expect(parsed.decisions_made).toEqual(['kept this decision']);
    expect(parsed.changed_files).toEqual(['src/a.ts']);
    // New fields default to [].
    expect(parsed.critical_decisions).toEqual([]);
    expect(parsed.irreversible_risks).toEqual([]);
  });

  test('new fields round-trip as DISTINCT fields (not folded into decisions_made)', async () => {
    const wi = await workItem();
    const h = buildHandoff({
      workItem: wi,
      fromContext: 'c',
      currentState: 's',
      nextFirstCheck: 'c',
      decisionsMade: ['ordinary decision'],
      criticalDecisions: [{ decision: 'chose option B', rationale: 'A is irreversible' }],
      irreversibleRisks: [{ risk: 'dropped column', why_irreversible: 'data is unrecoverable' }],
    });
    const store = new HandoffStore(repo);
    await store.write(h);
    const reloaded = await store.get(wi.id);
    // distinct field, survives serialize → parse round-trip
    expect(reloaded.critical_decisions).toEqual([
      { decision: 'chose option B', rationale: 'A is irreversible' },
    ]);
    expect(reloaded.irreversible_risks).toEqual([
      { risk: 'dropped column', why_irreversible: 'data is unrecoverable' },
    ]);
    // not folded into decisions_made
    expect(reloaded.decisions_made).toEqual(['ordinary decision']);
    expect(JSON.stringify(reloaded.decisions_made)).not.toContain('chose option B');
  });

  test('decisions_made is unchanged (no rename regression)', async () => {
    const wi = await workItem();
    const h = buildHandoff({
      workItem: wi,
      fromContext: 'c',
      currentState: 's',
      nextFirstCheck: 'c',
      decisionsMade: ['still here'],
    });
    expect(h.decisions_made).toEqual(['still here']);
  });

  test('tier rule: an irreversible-risk substance is preserved inline (not pointer-only)', async () => {
    const wi = await workItem();
    const substance = 'production data deleted; no backup exists for the affected rows';
    const h = buildHandoff({
      workItem: wi,
      fromContext: 'c',
      currentState: 's',
      nextFirstCheck: 'c',
      irreversibleRisks: [{ risk: 'destructive migration', why_irreversible: substance }],
    });
    // substance is carried in-band, not replaced by a re-fetch pointer
    expect(h.irreversible_risks[0]?.why_irreversible).toBe(substance);
  });
});

// wi_260714xpw: scope union (ac-3, ac-5), session-scope handoffs, and the committed
// REMOTE channel (ac-1, ac-4, ac-8) with soft consume markers.
describe('HandoffStore — scope union, session + remote channel', () => {
  const git = (args: string[], cwd = repo) =>
    Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const out = (r: ReturnType<typeof git>) => (r.stdout?.toString() ?? '').trim();
  function initGitRepo(branch: string) {
    git(['init', '-q']);
    git(['config', 'user.email', 'dev@example.com']);
    git(['config', 'user.name', 'Dev']);
    git(['checkout', '-q', '-b', branch]);
    // born HEAD so the first writeRemote is not on an unborn (detached-looking) branch
    git(['commit', '-q', '--allow-empty', '-m', 'init']);
  }

  // ac-3: a session-scope handoff parses into listActive by its OWN required set
  // (session_id, no work_item_id) — it is included, not fail-open dropped.
  test('ac-3: a session-scope handoff is written + parsed into listActive', async () => {
    const store = new HandoffStore(repo);
    const rel = await store.write(
      buildSessionHandoff({
        sessionId: 'sess-42',
        originalIntent: 'resume the thing',
        fromContext: 'ctx',
        currentState: 'session-state',
        nextFirstCheck: 'c',
      }),
    );
    expect(rel).toBe('.ditto/local/handoff/session__sess-42.md');
    const { active, failures } = await store.listActiveDetailed();
    expect(failures).toHaveLength(0);
    expect(active).toHaveLength(1);
    expect(active[0]?.handoff.scope).toEqual({ kind: 'session', session_id: 'sess-42' });
    expect(active[0]?.body).toContain('session-state');
  });

  // ac-3 Root C: a session file present but unparsable is SURFACED as a failure, not
  // silently dropped (list is the sole discovery channel).
  test('ac-3: a malformed session file is surfaced as a failure (not silently dropped)', async () => {
    const dir = join(repo, '.ditto/local/handoff');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'session__broken.md'), 'no frontmatter — cannot parse\n');
    const store = new HandoffStore(repo);
    const { active, failures } = await store.listActiveDetailed();
    expect(active).toHaveLength(0);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.scope).toBe('session');
    expect(failures[0]?.path).toContain('session__broken.md');
  });

  // ac-5: an existing on-disk WI-key handoff (top-level work_item_id, NO scope) is
  // still read — the schema back-compat preprocess lifts it into scope.work_item.
  test('ac-5: a legacy WI-key handoff (top-level work_item_id, no scope) still reads', async () => {
    const dir = join(repo, '.ditto/local/handoff');
    await mkdir(dir, { recursive: true });
    const legacy = {
      schema_version: '0.1.0',
      work_item_id: 'wi_legacy0001',
      from_context: 'old session',
      original_intent: 'do the thing',
      current_state: 'midway',
      next_first_check: 'run tests',
      created_at: '2026-06-01T00:00:00.000Z',
    };
    await writeFile(
      join(dir, 'wi_legacy0001.md'),
      `---\n${JSON.stringify(legacy)}\n---\n\n# Handoff: wi_legacy0001\n`,
    );
    const store = new HandoffStore(repo);
    const got = await store.getActive('wi_legacy0001');
    expect(got?.handoff.scope).toEqual({ kind: 'work_item', work_item_id: 'wi_legacy0001' });
    expect((await store.listActive()).map((a) => a.handoff.scope)).toContainEqual({
      kind: 'work_item',
      work_item_id: 'wi_legacy0001',
    });
  });

  // ac-4: a remote handoff is committed to the work item's branch, git-tracked (NOT
  // gitignored), delivered on checkout — and never pushed.
  test('ac-4: writeRemote commits to the work item branch, git-tracked, never pushes', async () => {
    const wi = await workItem();
    initGitRepo(`ditto/${wi.id}`);
    // an upstream that must stay un-advanced (proves no auto-push)
    const bare = await mkdtemp(join(tmpdir(), 'ditto-ho-bare-'));
    git(['init', '--bare', '-q'], bare);
    git(['remote', 'add', 'origin', bare]);

    const store = new HandoffStore(repo);
    const h = buildHandoff({
      workItem: wi,
      fromContext: 'ctx',
      currentState: 'remote-state',
      nextFirstCheck: 'c',
    });
    const res = await store.writeRemote(h, { author: 'alice' });

    expect(res.branch).toBe(`ditto/${wi.id}`);
    expect(res.rel).toBe(`.ditto/handoff/${wi.id}__alice.md`);
    // committed + git-tracked, NOT gitignored
    expect(out(git(['ls-files', res.rel]))).toBe(res.rel);
    expect(git(['check-ignore', '-q', '--', res.rel]).exitCode).toBe(1);
    expect(out(git(['log', '--oneline', '-1']))).toContain(`${wi.id}__alice`);
    // body + pointer land in the committed file (delivered on checkout)
    expect(await Bun.file(join(repo, res.rel)).text()).toContain('remote-state');
    // NO push: the upstream ref was never created/advanced
    expect(git(['rev-parse', '--verify', '-q', `origin/ditto/${wi.id}`]).exitCode).not.toBe(0);

    await rm(bare, { recursive: true, force: true });
  });

  // ac-1: two concurrent authors on the SAME scope land in SEPARATE files — no shared
  // single file, neither overwrites the other, no merge conflict.
  test('ac-1: two authors leave separate remote files, neither overwriting the other', async () => {
    const wi = await workItem();
    initGitRepo(`ditto/${wi.id}`);
    const store = new HandoffStore(repo);
    const h = buildHandoff({
      workItem: wi,
      fromContext: 'ctx',
      currentState: 's',
      nextFirstCheck: 'c',
    });
    const a = await store.writeRemote(h, { author: 'alice' });
    const b = await store.writeRemote(h, { author: 'bob' });
    expect(a.rel).not.toBe(b.rel);
    expect(a.rel).toBe(`.ditto/handoff/${wi.id}__alice.md`);
    expect(b.rel).toBe(`.ditto/handoff/${wi.id}__bob.md`);
    const tracked = out(git(['ls-files', '.ditto/handoff/']));
    expect(tracked).toContain(`${wi.id}__alice.md`);
    expect(tracked).toContain(`${wi.id}__bob.md`);
  });

  // ac-1 (index.lock retry serialization): `runGit` in handoff-store.ts retries a
  // git exec that fails on a locked index (`.git/index.lock`) — two concurrent
  // producers serialize instead of one failing. This covers the retry loop
  // (maxAttempts=5, lock detected by /index\.lock/ on stderr) which is what lets the
  // concurrent-writer safety of ac-1 hold when both authors race the same index.
  //
  // Mocked at the exec boundary (Bun.spawnSync — the only seam `runGit` uses): the
  // FIRST `git add` attempt returns a synthetic index.lock failure, the retry falls
  // through to real git and succeeds. Assert writeRemote RETRIES (2 add attempts) and
  // the file still lands committed — a transient lock does not fail the write.
  test('ac-1: writeRemote retries a transient index.lock and still commits (no fail)', async () => {
    const wi = await workItem();
    initGitRepo(`ditto/${wi.id}`);
    const store = new HandoffStore(repo);
    const h = buildHandoff({
      workItem: wi,
      fromContext: 'ctx',
      currentState: 'retry-state',
      nextFirstCheck: 'c',
    });

    const realSpawnSync = Bun.spawnSync.bind(Bun);
    let addAttempts = 0;
    const spy = spyOn(Bun, 'spawnSync').mockImplementation(((cmd: unknown, opts: unknown) => {
      if (Array.isArray(cmd) && cmd[1] === 'add') {
        addAttempts += 1;
        if (addAttempts === 1) {
          // transient locked index — git's real message (matched by /index\.lock/)
          return {
            exitCode: 128,
            stdout: Buffer.from(''),
            stderr: Buffer.from(
              `fatal: Unable to create '${join(repo, '.git/index.lock')}': File exists.`,
            ),
          };
        }
      }
      // biome-ignore lint/suspicious/noExplicitAny: pass-through to the real exec boundary
      return realSpawnSync(cmd as any, opts as any);
      // biome-ignore lint/suspicious/noExplicitAny: bun spyOn signature is loose here
    }) as any);

    let res: Awaited<ReturnType<HandoffStore['writeRemote']>>;
    try {
      res = await store.writeRemote(h, { author: 'alice' });
    } finally {
      spy.mockRestore();
    }
    // it retried exactly once: attempt 1 = synthetic lock, attempt 2 = real success.
    expect(addAttempts).toBe(2);
    // and the write completed — the file is committed/tracked despite the transient lock.
    expect(out(git(['ls-files', res.rel]))).toBe(res.rel);
    expect(await Bun.file(join(repo, res.rel)).text()).toContain('retry-state');
  });

  // ac-1 (exhaustion): if the index.lock NEVER clears, the retry budget is exhausted
  // (maxAttempts=5) and writeRemote SURFACES the failure (HandoffRemoteWriteError,
  // code 'add_failed') — it does NOT silently proceed or lose the handoff. The worst
  // case for a concurrent writer is a surfaced, retriable error, never an overwrite.
  test('ac-1: writeRemote surfaces the error when the index.lock never clears (no silent proceed)', async () => {
    const wi = await workItem();
    initGitRepo(`ditto/${wi.id}`);
    const store = new HandoffStore(repo);
    const h = buildHandoff({
      workItem: wi,
      fromContext: 'ctx',
      currentState: 'stuck-state',
      nextFirstCheck: 'c',
    });

    const realSpawnSync = Bun.spawnSync.bind(Bun);
    let addAttempts = 0;
    const spy = spyOn(Bun, 'spawnSync').mockImplementation(((cmd: unknown, opts: unknown) => {
      if (Array.isArray(cmd) && cmd[1] === 'add') {
        addAttempts += 1;
        // the lock NEVER clears — every attempt fails on index.lock
        return {
          exitCode: 128,
          stdout: Buffer.from(''),
          stderr: Buffer.from(
            `fatal: Unable to create '${join(repo, '.git/index.lock')}': File exists.`,
          ),
        };
      }
      // biome-ignore lint/suspicious/noExplicitAny: pass-through to the real exec boundary
      return realSpawnSync(cmd as any, opts as any);
      // biome-ignore lint/suspicious/noExplicitAny: bun spyOn signature is loose here
    }) as any);

    let caught: unknown;
    try {
      await store.writeRemote(h, { author: 'alice' });
    } catch (err) {
      caught = err;
    } finally {
      spy.mockRestore();
    }
    // surfaced, not swallowed: a typed retriable error (never a silent no-op)
    expect(caught).toBeInstanceOf(HandoffRemoteWriteError);
    expect((caught as HandoffRemoteWriteError).code).toBe('add_failed');
    // it burned the FULL retry budget (maxAttempts=5) before surfacing — proof it
    // retried the lock rather than giving up on the first failure.
    expect(addAttempts).toBe(5);
    // and nothing was committed — the handoff was not lost or half-landed.
    expect(out(git(['ls-files', '.ditto/handoff/']))).toBe('');
  });

  // ac-4 guard: refuse to commit to whatever branch happens to be checked out — a
  // wrong-branch land is SURFACED (throws) and writes nothing.
  test('writeRemote refuses to commit to the wrong branch (surfaces, no wrong land)', async () => {
    const wi = await workItem();
    initGitRepo('main'); // NOT ditto/<wi>
    const store = new HandoffStore(repo);
    const h = buildHandoff({
      workItem: wi,
      fromContext: 'ctx',
      currentState: 's',
      nextFirstCheck: 'c',
    });
    await expect(store.writeRemote(h, { author: 'alice' })).rejects.toThrow(/expected 'ditto\//);
    expect(out(git(['ls-files', '.ditto/handoff/']))).toBe(''); // nothing committed/written
  });

  // ac-4 Root D: the committed body is token-scrubbed (git history is irreversible).
  test('writeRemote token-scrubs secrets from the committed body', async () => {
    const wi = await workItem();
    initGitRepo(`ditto/${wi.id}`);
    const store = new HandoffStore(repo);
    const token = `ghp_${'A'.repeat(36)}`;
    const h = buildHandoff({
      workItem: wi,
      fromContext: 'ctx',
      currentState: `leaked ${token} here`,
      nextFirstCheck: 'c',
      evidenceRefs: [{ kind: 'note', summary: `also ${token}` }],
    });
    const res = await store.writeRemote(h, { author: 'alice' });
    const committed = await Bun.file(join(repo, res.rel)).text();
    expect(committed).not.toContain(token);
    expect(committed).toContain('[redacted]');
  });

  // ac-8: remote consume = per-recipient LOCAL marker only — no git delete/commit/push;
  // per-recipient (a second recipient still sees it); markers + remote files stay OUT
  // of the local mtime age-sweep set.
  test('ac-8: consumeRemote writes a per-recipient marker and never deletes/commits/pushes', async () => {
    const wi = await workItem();
    initGitRepo(`ditto/${wi.id}`);
    const store = new HandoffStore(repo);
    const h = buildHandoff({
      workItem: wi,
      fromContext: 'ctx',
      currentState: 'remote-state',
      nextFirstCheck: 'c',
    });
    const res = await store.writeRemote(h, { author: 'alice' });
    const commitsBefore = out(git(['rev-list', '--count', 'HEAD']));

    const waiting = await store.listRemote('bob');
    const [first] = waiting.handoffs;
    expect(first).toBeDefined();
    if (!first) throw new Error('unreachable');
    const consumed = await store.consumeRemote(first, 'bob');
    expect(consumed.body).toContain('remote-state');

    // per-recipient LOCAL marker; committed remote file untouched (NOT deleted)
    expect(await store.hasConsumedMarker('bob', `remote-${res.stem}`)).toBe(true);
    expect(await Bun.file(join(repo, res.rel)).exists()).toBe(true);
    // no new commit for the marker (no auto-commit), and no push
    expect(out(git(['rev-list', '--count', 'HEAD']))).toBe(commitsBefore);
    // per-recipient: bob's next list excludes it; alice (a different recipient) still sees it
    expect((await store.listRemote('bob')).handoffs).toHaveLength(0);
    expect((await store.listRemote('alice')).handoffs).toHaveLength(1);

    // remote files + consumed-markers are OUTSIDE the local mtime age-sweep set:
    // even a far-future clock leaves both intact.
    await store.sweepStaleActive(new Date(Date.now() + 100 * 24 * 60 * 60 * 1000));
    expect(await Bun.file(join(repo, res.rel)).exists()).toBe(true);
    expect(await store.hasConsumedMarker('bob', `remote-${res.stem}`)).toBe(true);
  });

  // charset guard: a session_id that would escape the fs path / git arg is rejected
  // BEFORE it reaches join()/git.
  test('write rejects an unsafe session_id before it touches an fs path', async () => {
    const store = new HandoffStore(repo);
    const evil = buildSessionHandoff({
      sessionId: '../escape',
      originalIntent: 'x',
      fromContext: 'c',
      currentState: 's',
      nextFirstCheck: 'c',
    });
    await expect(store.write(evil)).rejects.toThrow(/session_id/);
  });
});
