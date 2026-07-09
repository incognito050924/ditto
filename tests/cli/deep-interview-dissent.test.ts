import { beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acknowledgeIntentDissent,
  finalizeInterview,
  finalizePayload,
  recordIntentDissent,
  recordTurn,
  startInterview,
} from '~/core/interview-driver';
import { WorkItemStore } from '~/core/work-item-store';
import { interviewDissentVerdicts } from '~/schemas/interview-state';

/**
 * `ditto deep-interview` intent-dissent seam (wi_260709x5w). Ports prism's live opponent
 * path (briefs emit → host spawns agent → record --json feedback) to the intent layer:
 * `dissent-briefs` (no model call), `dissent-record` (validated + fail-closed record-back),
 * and the `recordIntentDissent` driver primitive that wires the persisted dissent into the
 * finalize block. Mock-free unit + CLI-subprocess tests over an isolated temp repo.
 */

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const USAGE_ERROR_EXIT = 65;
const RUNTIME_ERROR_EXIT = 1;

// Build through the schema so PAYLOAD carries the exact FinalizePayload type (avoids the
// object-literal excess-property drift the sibling claim test still has).
const PAYLOAD = finalizePayload.parse({
  goal: 'returns integer score 0..100 for a password',
  in_scope: ['POST /password-strength'],
  out_of_scope: [],
  acceptance_criteria: [
    {
      id: 'ac-1',
      statement: 'returns integer 0..100',
      verdict: 'unverified',
      evidence: [],
      evidence_required: ['test'],
    },
  ],
  unknowns: [],
  follow_up_candidates: [],
  question_policy: 'ask_only_if_user_only_can_answer',
  risk: { non_local: false, irreversible: false, unaudited: false },
  user_confirmation: { confirmed: true, statement: '네, 이 의도가 맞습니다' },
});

async function makeReadyWi(): Promise<{ repo: string; id: string }> {
  const repo = await mkdtemp(join(tmpdir(), 'ditto-dissent-'));
  const store = new WorkItemStore(repo);
  const wi = await store.create({
    title: 'pw',
    source_request: 'add a /password-strength endpoint',
    goal: 'returns a score',
    acceptance_criteria: [{ id: 'ac-1', statement: 'TBD', verdict: 'unverified', evidence: [] }],
  });
  await startInterview(repo, { workItemId: wi.id });
  await recordTurn(repo, {
    workItemId: wi.id,
    payload: {
      dimension: {
        id: 'd-shape',
        critical: true,
        state: 'resolved',
        ambiguity: 0.05,
        notes: 'response shape',
      },
      question: { text: 'shape?', why_matters: 'response', info_gain_estimate: 'high' },
      answer: { text: 'integer 0..100', kind: 'user' },
      readiness_score: 0.85,
    },
  });
  return { repo, id: wi.id };
}

describe('interviewDissentVerdicts schema (wi_260709x5w)', () => {
  test('valid payload parses', () => {
    const r = interviewDissentVerdicts.safeParse({
      verdicts: [{ dimension_id: 'd-shape', text: 'sharper reading' }],
    });
    expect(r.success).toBe(true);
  });
  test('empty verdicts array rejected (min1)', () => {
    expect(interviewDissentVerdicts.safeParse({ verdicts: [] }).success).toBe(false);
  });
  test('empty text rejected (min1 first defense)', () => {
    expect(
      interviewDissentVerdicts.safeParse({ verdicts: [{ dimension_id: 'd', text: '' }] }).success,
    ).toBe(false);
  });
  test('missing dimension_id rejected', () => {
    expect(interviewDissentVerdicts.safeParse({ verdicts: [{ text: 'x' }] }).success).toBe(false);
  });
});

describe('recordIntentDissent record-back (wi_260709x5w)', () => {
  test('engaged verdict on critical dim → engaged high-impact dissent persisted', async () => {
    const { repo, id } = await makeReadyWi();
    const res = await recordIntentDissent(repo, id, [
      { dimension_id: 'd-shape', text: 'the intent is a categorical band, not a raw integer' },
    ]);
    expect(res.status).toBe('recorded');
    if (res.status === 'recorded') {
      expect(res.engaged).toEqual(['d-shape']);
      expect(res.degraded).toEqual([]);
      const dim = res.state.dimensions.find((d) => d.id === 'd-shape');
      expect(dim?.dissent?.status).toBe('engaged');
      expect(dim?.dissent?.verdict).toBe('revise');
      expect(dim?.dissent?.impact).toBe('high');
      expect(dim?.dissent?.acknowledged).toBe(false);
    }
    await rm(repo, { recursive: true, force: true });
  });

  test('foreign dimension_id → status foreign, NO write (fail-closed, ADR-0018)', async () => {
    const { repo, id } = await makeReadyWi();
    const res = await recordIntentDissent(repo, id, [{ dimension_id: 'd-ghost', text: 'x' }]);
    expect(res.status).toBe('foreign');
    if (res.status === 'foreign') expect(res.foreign).toContain('d-ghost');
    await rm(repo, { recursive: true, force: true });
  });

  test('whitespace-only text → host_absent degrade (never a false engaged stamp)', async () => {
    const { repo, id } = await makeReadyWi();
    const res = await recordIntentDissent(repo, id, [{ dimension_id: 'd-shape', text: '   ' }]);
    expect(res.status).toBe('recorded');
    if (res.status === 'recorded') {
      expect(res.degraded).toEqual(['d-shape']);
      expect(res.engaged).toEqual([]);
      const dim = res.state.dimensions.find((d) => d.id === 'd-shape');
      expect(dim?.dissent?.status).toBe('host_absent');
    }
    await rm(repo, { recursive: true, force: true });
  });

  test('engaged dissent blocks finalize; acknowledge unblocks (record-back wires the gate)', async () => {
    const { repo, id } = await makeReadyWi();
    await recordIntentDissent(repo, id, [{ dimension_id: 'd-shape', text: 'sharper reading' }]);
    const blocked = await finalizeInterview(repo, { workItemId: id, payload: PAYLOAD });
    expect(blocked.status).toBe('blocked_by_dissent');
    await acknowledgeIntentDissent(repo, id, 'd-shape');
    const ok = await finalizeInterview(repo, { workItemId: id, payload: PAYLOAD });
    expect(ok.status).toBe('finalized');
    await rm(repo, { recursive: true, force: true });
  });
});

describe('deep-interview dissent CLI (wi_260709x5w)', () => {
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
  function seedWiWithCriticalDim(): string {
    const wi = JSON.parse(
      spawnDitto([
        'work',
        'start',
        'pw endpoint',
        '--request',
        'add /password-strength',
        '--output',
        'json',
      ]).stdout,
    ).work_item_id as string;
    expect(
      spawnDitto(['deep-interview', 'start', '--workItem', wi, '--output', 'json']).exitCode,
    ).toBe(0);
    const rt = spawnDitto([
      'deep-interview',
      'record-turn',
      '--workItem',
      wi,
      '--json',
      JSON.stringify({
        dimension: {
          id: 'd-shape',
          critical: true,
          state: 'resolved',
          ambiguity: 0.05,
          notes: 'response shape',
        },
        question: { text: 'shape?', why_matters: 'response', info_gain_estimate: 'high' },
        answer: { text: 'integer', kind: 'user' },
        readiness_score: 0.85,
      }),
      '--output',
      'json',
    ]);
    expect(rt.exitCode).toBe(0);
    return wi;
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ditto-dissent-cli-'));
    git(['init']);
  });

  test('dissent-briefs emits critical-dimension targets with intent from the WI Record', () => {
    const wi = seedWiWithCriticalDim();
    const res = spawnDitto([
      'deep-interview',
      'dissent-briefs',
      '--workItem',
      wi,
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      work_item_id: string;
      dissent_targets: { dimension_id: string; label: string; intent: string }[];
    };
    const target = parsed.dissent_targets.find((t) => t.dimension_id === 'd-shape');
    expect(target).toBeDefined();
    expect(target?.intent).toBe('add /password-strength');
    expect(target?.label).toBe('response shape');
  });

  test('dissent-record invalid JSON → USAGE_ERROR (map unchanged)', () => {
    const wi = seedWiWithCriticalDim();
    const res = spawnDitto([
      'deep-interview',
      'dissent-record',
      '--workItem',
      wi,
      '--json',
      '{ not json',
    ]);
    expect(res.exitCode).toBe(USAGE_ERROR_EXIT);
  });

  test('dissent-record foreign dimension_id → RUNTIME_ERROR fail-closed', () => {
    const wi = seedWiWithCriticalDim();
    const res = spawnDitto([
      'deep-interview',
      'dissent-record',
      '--workItem',
      wi,
      '--json',
      JSON.stringify({ verdicts: [{ dimension_id: 'd-ghost', text: 'x' }] }),
    ]);
    expect(res.exitCode).toBe(RUNTIME_ERROR_EXIT);
    expect(res.stderr).toContain('d-ghost');
  });

  test('dissent-record valid engaged verdict → persisted, json reports engaged', () => {
    const wi = seedWiWithCriticalDim();
    const res = spawnDitto([
      'deep-interview',
      'dissent-record',
      '--workItem',
      wi,
      '--json',
      JSON.stringify({
        verdicts: [{ dimension_id: 'd-shape', text: 'sharper reading of the intent' }],
      }),
      '--briefed',
      'd-shape',
      '--output',
      'json',
    ]);
    expect(res.exitCode).toBe(0);
    const parsed = JSON.parse(res.stdout) as { engaged: string[]; unanswered: string[] };
    expect(parsed.engaged).toEqual(['d-shape']);
    expect(parsed.unanswered).toEqual([]);
  });
});
