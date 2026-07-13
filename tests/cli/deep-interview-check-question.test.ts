import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `ditto deep-interview check-question` gate at the CLI boundary (impl-di-recommended-answer,
 * ac-1). The command runs the pure `validateQuestionContext` over a --json candidate and exits
 * NON-ZERO when the presentation contract is unmet. This asserts the recommended_answer clause
 * end-to-end: a candidate missing/blank recommended_answer is REJECTED (non-zero exit), one that
 * carries it PASSES (exit 0) — mirroring the pre-existing user_explanation treatment. No work
 * item / filesystem state needed (the gate is a pure structural check).
 */

const cliEntry = join(process.cwd(), 'src/cli/index.ts');
const RUNTIME_ERROR_EXIT = 1;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ditto-checkq-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function spawnDitto(args: string[]): { stdout: string; stderr: string; exitCode: number | null } {
  const proc = Bun.spawnSync(['bun', cliEntry, ...args], { cwd: dir, env: { ...process.env } });
  return {
    stdout: proc.stdout?.toString() ?? '',
    stderr: proc.stderr?.toString() ?? '',
    exitCode: proc.exitCode,
  };
}

// A fully-contextualized candidate MINUS recommended_answer — every other contract field is
// present and clean (no leaked identifier), so recommended_answer is the ONLY variable.
const WITHOUT = {
  text: '비밀번호 해시는 무엇을 쓸까요?',
  why_matters: '저장 형식을 좌우합니다.',
  user_explanation: '비밀번호를 안전하게 저장하는 방식을 정하는 질문이에요.',
};

describe('deep-interview check-question — recommended_answer gate (ac-1)', () => {
  test('missing recommended_answer → non-zero exit, names the field', () => {
    const r = spawnDitto(['deep-interview', 'check-question', '--json', JSON.stringify(WITHOUT)]);
    expect(r.exitCode).toBe(RUNTIME_ERROR_EXIT);
    expect(r.stderr).toContain('recommended_answer');
  });

  test('blank recommended_answer → non-zero exit', () => {
    const r = spawnDitto([
      'deep-interview',
      'check-question',
      '--json',
      JSON.stringify({ ...WITHOUT, recommended_answer: '   ' }),
    ]);
    expect(r.exitCode).toBe(RUNTIME_ERROR_EXIT);
    expect(r.stderr).toContain('recommended_answer');
  });

  test('recommended_answer present → exit 0 (contract satisfied)', () => {
    const r = spawnDitto([
      'deep-interview',
      'check-question',
      '--json',
      JSON.stringify({ ...WITHOUT, recommended_answer: 'bcrypt(cost 12)를 추천합니다.' }),
    ]);
    expect(r.exitCode).toBe(0);
  });
});

/**
 * `ditto deep-interview select-single` — the runtime enforcement seam for the
 * deep-interview single-fire limit (impl-di-recommended-answer, ac-2: the top-1 cap
 * must be "결정적 함수로 강제"). The SKILL runs this AFTER the gate to collapse the
 * gate-selected candidates to AT MOST ONE (highest info_gain, deterministic input-order
 * tiebreak) before asking. This drives the pure `selectSingleFire` through the CLI
 * boundary so the pure function is no longer an orphan: it has a runtime call site.
 *
 * Cases pinned:
 *  - multiple candidates → exactly 1, the highest info_gain_estimate.
 *  - tie on info_gain    → exactly 1, the FIRST among equals (stable input order).
 *  - empty array         → empty selection (no single-fire, no crash).
 */
describe('deep-interview select-single — deterministic single-fire (ac-2)', () => {
  function runSelect(candidates: unknown[]): { selected: Array<{ id?: string }> } {
    const r = spawnDitto([
      'deep-interview',
      'select-single',
      '--json',
      JSON.stringify(candidates),
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    return JSON.parse(r.stdout) as { selected: Array<{ id?: string }> };
  }

  test('multiple candidates → exactly the highest info_gain', () => {
    const out = runSelect([
      { id: 'q-low', info_gain_estimate: 'low' },
      { id: 'q-high', info_gain_estimate: 'high' },
      { id: 'q-medium', info_gain_estimate: 'medium' },
    ]);
    expect(out.selected).toHaveLength(1);
    expect(out.selected[0]?.id).toBe('q-high');
  });

  test('tie on info_gain → the first among equals (deterministic input order)', () => {
    const out = runSelect([
      { id: 'q-a', info_gain_estimate: 'high' },
      { id: 'q-b', info_gain_estimate: 'high' },
    ]);
    expect(out.selected).toHaveLength(1);
    expect(out.selected[0]?.id).toBe('q-a');
  });

  test('empty array → empty selection', () => {
    const out = runSelect([]);
    expect(out.selected).toHaveLength(0);
  });
});
