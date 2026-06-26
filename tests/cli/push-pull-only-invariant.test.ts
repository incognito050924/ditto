import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type CharterContext, charterProjection } from '~/core/charter';

// ac-6 (wi_260626wnv) — Part C: the PULL-ONLY invariant. Push/deploy is the user's
// irreversible decision (charter §4-8). ditto must NEVER proactively propose or
// suggest a push anywhere. The strong push-readiness signal is surfaced ONLY by the
// `work push-ready` command, which the user runs. This guard encodes that invariant
// so a future change that adds a proactive push surface fails CI.

// A push/deploy SUGGESTION the charter/CLI must never emit. Matched case-insensitively
// against rendered output (not source). "git operations are exceptions" and Array
// .push() are not advisory text, so the rendered charter never contains these words.
const PUSH_SUGGESTION = /\b(push|deploy)\b/i;

// Every boolean advisory flag charterProjection can toggle. The guard checks ALL
// 2^N combinations so no flag (or combination) sneaks in a push suggestion.
const BOOLEAN_FLAGS = [
  'workItemGuide',
  'placeholderAcceptanceCriteria',
  'deepInterviewDirective',
  'selfAnswerHint',
] as const;

function* allFlagCombinations(): Generator<CharterContext> {
  const n = BOOLEAN_FLAGS.length;
  for (let mask = 0; mask < 1 << n; mask++) {
    const ctx: CharterContext = {};
    BOOLEAN_FLAGS.forEach((flag, i) => {
      if (mask & (1 << i)) ctx[flag] = true;
    });
    yield ctx;
  }
}

describe('ac-6 C: pull-only invariant — no proactive push surface', () => {
  test('charterProjection emits NO push/deploy suggestion for ANY flag combination', () => {
    let checked = 0;
    for (const ctx of allFlagCombinations()) {
      const out = charterProjection(ctx);
      expect(out).not.toMatch(PUSH_SUGGESTION);
      checked++;
    }
    // Also the richest context (work-item header + a pending handoff hint).
    const rich = charterProjection({
      workItemId: 'wi_test1234',
      workItemTitle: 'sample',
      workItemStatus: 'in_progress',
      pendingHandoff: '.ditto/local/work-items/wi_test1234/handoff.json',
      placeholderAcceptanceCriteria: true,
      deepInterviewDirective: true,
      selfAnswerHint: true,
      workItemGuide: true,
    });
    expect(rich).not.toMatch(PUSH_SUGGESTION);
    expect(checked).toBe(1 << BOOLEAN_FLAGS.length); // exhaustive, not vacuous
  });

  // The CLI side of the invariant: the lifecycle commands a user runs all the time
  // (work status, work done) must not nudge the user to push. push-readiness is
  // surfaced ONLY by `work push-ready` (covered in work-push-ready.test.ts).
  let dir: string;
  function ditto(args: string[]) {
    const proc = Bun.spawnSync(['bun', join(process.cwd(), 'src/cli/index.ts'), ...args], {
      cwd: dir,
      env: { ...process.env },
    });
    return {
      stdout: proc.stdout?.toString() ?? '',
      stderr: proc.stderr?.toString() ?? '',
      exitCode: proc.exitCode,
    };
  }
  function start(): string {
    const s = ditto([
      'work',
      'start',
      'a step',
      '--request',
      'do the thing',
      '--criteria',
      'the command returns 0',
      '--output',
      'json',
    ]);
    expect(s.exitCode).toBe(0);
    return JSON.parse(s.stdout).work_item_id as string;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ditto-pullonly-'));
    await mkdir(join(dir, '.ditto'), { recursive: true });
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('`work status` output never suggests a push', () => {
    const wid = start();
    const r = ditto(['work', 'status', wid]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toMatch(PUSH_SUGGESTION);
  });

  test('`work done` success output never suggests a push', () => {
    const wid = start();
    const wiPath = join(dir, '.ditto', 'local', 'work-items', wid, 'work-item.json');
    expect(ditto(['verify', wid, '--criterion', 'ac-1', '--', 'cat', wiPath]).exitCode).toBe(0);
    const r = ditto(['work', 'done', wid]);
    expect(r.exitCode).toBe(0);
    // "Archive with: ditto work archive" is the only follow-up nudge — no push.
    expect(r.stdout).not.toMatch(PUSH_SUGGESTION);
  });
});
