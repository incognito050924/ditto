import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

// Write a glossary into the spawned repo root (cwd=dir) so check-question resolves it via
// resolveRepoRootForCreate + loadGlossaryVocab. Placing `.ditto` in `dir` makes `dir` the
// deterministic repo root (findRepoRoot matches `.ditto` at the start dir — no walk-up).
async function writeGlossary(forbidden: string[]): Promise<void> {
  await mkdir(join(dir, '.ditto', 'knowledge'), { recursive: true });
  await writeFile(
    join(dir, '.ditto', 'knowledge', 'glossary.json'),
    JSON.stringify({ entries: [{ forbidden_abbreviations: forbidden }] }),
    'utf8',
  );
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

// ac-1 WIRING: check-question was FLOOR-ONLY — it validated with NO caller-injected opaqueVocab,
// so a glossary `forbidden_abbreviations` term was NOT rejected (unlike recordTurn/prism, which
// resolve loadGlossaryVocab and inject it). Wiring resolveRepoRootForCreate + loadGlossaryVocab
// into the handler unions the glossary set with the hardcoded floor. A candidate whose text
// carries an un-glossed glossary forbidden-abbreviation must now be REJECTED (was passing).
describe('deep-interview check-question — glossary forbidden-abbreviation floor (ac-1 wiring)', () => {
  // A fully clean, contract-complete candidate whose ONLY offense is the glossary-listed term
  // 'ZQX' surfaced un-glossed — isolates the glossary injection as the sole rejection cause.
  const withZqx = {
    text: 'ZQX 방식을 쓸까요?',
    why_matters: '방식을 정합니다.',
    user_explanation: '어떤 방식을 쓸지 정하는 질문이에요.',
    recommended_answer: '기본값을 추천합니다.',
  };

  test('candidate carrying a glossary forbidden-abbreviation → REJECTED, names the term', async () => {
    await writeGlossary(['ZQX']);
    const r = spawnDitto(['deep-interview', 'check-question', '--json', JSON.stringify(withZqx)]);
    expect(r.exitCode).toBe(RUNTIME_ERROR_EXIT);
    expect(r.stderr).toContain('ZQX');
  });

  test('same candidate with NO glossary present → PASSES (floor-only; proves glossary is the cause)', () => {
    const r = spawnDitto(['deep-interview', 'check-question', '--json', JSON.stringify(withZqx)]);
    expect(r.exitCode).toBe(0);
  });
});

// ac-2 WIRING: the display-time seam. check-question normalizes the candidate's user-facing
// fields (text / user_explanation / recommended_answer) via normalizePresentedText so the
// question reaches the user CLEAN, and validation runs on the SAME normalized form recordTurn
// persists (no "validate one form, persist another" gap). The JSON verdict echoes the cleaned
// text so the SKILL asks the normalized question.
describe('deep-interview check-question — display-seam normalization (ac-2 wiring)', () => {
  test('em-dash / U+FFFD / curly-quote in the candidate → JSON echoes the NORMALIZED (plain) text', () => {
    const candidate = {
      text: '정수인가요 — 소수인가요?', // em-dash U+2014
      why_matters: '형식을 정합니다.',
      user_explanation: '형식을 정하는 질문이에요�', // U+FFFD
      recommended_answer: '정수를 “추천”합니다.', // curly double quotes
    };
    const r = spawnDitto([
      'deep-interview',
      'check-question',
      '--json',
      JSON.stringify(candidate),
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as {
      ok: boolean;
      normalized?: { text: string; user_explanation?: string; recommended_answer?: string };
    };
    expect(out.ok).toBe(true);
    expect(out.normalized?.text).toBe('정수인가요 - 소수인가요?');
    expect(out.normalized?.text).not.toContain('—');
    expect(out.normalized?.user_explanation).toBe('형식을 정하는 질문이에요');
    expect(out.normalized?.recommended_answer).toBe('정수를 "추천"합니다.');
  });
});

// ac-4: the deterministic floor (validateQuestionContext) is UNIFORM — check-question runs
// per-candidate with NO critical/non-critical branch (unlike reviewer routing, which gates the
// session-blind reviewer on `critical`). A non-critical (cosmetic) question is subject to the
// IDENTICAL leak + normalization floor as any other candidate.
describe('deep-interview check-question — floor is uniform across critical/non-critical (ac-4)', () => {
  test('a NON-critical (cosmetic) candidate leaking a glossary term is REJECTED identically', async () => {
    await writeGlossary(['ZQX']);
    const nonCritical = {
      text: '버튼 색상은 ZQX로 할까요?',
      why_matters: '외형만 정합니다.',
      user_explanation: '버튼 색을 정하는 사소한 질문이에요.',
      recommended_answer: '기본 색을 추천합니다.',
    };
    const r = spawnDitto([
      'deep-interview',
      'check-question',
      '--json',
      JSON.stringify(nonCritical),
    ]);
    expect(r.exitCode).toBe(RUNTIME_ERROR_EXIT);
    expect(r.stderr).toContain('ZQX');
  });

  test('a NON-critical candidate with an em-dash is normalized identically (uniform display seam)', () => {
    const nonCritical = {
      text: '버튼은 파랑 — 초록 중 무엇으로 할까요?',
      why_matters: '외형만 정합니다.',
      user_explanation: '색을 정하는 사소한 질문이에요.',
      recommended_answer: '파랑을 추천합니다.',
    };
    const r = spawnDitto([
      'deep-interview',
      'check-question',
      '--json',
      JSON.stringify(nonCritical),
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { normalized?: { text: string } };
    expect(out.normalized?.text).toBe('버튼은 파랑 - 초록 중 무엇으로 할까요?');
  });
});

// gap-fix WIRING (loanword advisory): `findLoanwords` (a bounded closed seed of 외래어 with a
// plain-Korean equivalent — 밸런스/케이스/이슈/리스크) was ORPHANED: zero callers in src/, so at
// runtime NO register advisory ever surfaced. This wires it into the check-question pre-ask gate
// as an ADVISORY (non-blocking) `loanword_advisory: string[]` field over the SAME normalized
// user-facing fields (text / user_explanation / recommended_answer). ADVISORY = it MUST NOT change
// the exit code: a candidate whose only smell is a loanword (no hard violation) still exits 0.
//
// Each case below pins a clause of that contract:
//  - a free-standing loanword (밸런스, plain-Korean-equivalent) → flagged in loanword_advisory AND
//    exit 0 (proves NON-blocking), with the candidate otherwise contract-clean.
//  - a clean candidate → EMPTY loanword_advisory + exit 0 (no false positive).
//  - a loanword INSIDE a code fence → NOT flagged (the stripCode exemption preserved end-to-end).
describe('deep-interview check-question — loanword advisory (non-blocking)', () => {
  test('candidate with a loanword (밸런스) but otherwise clean → exit 0 (advisory) AND loanword_advisory contains 밸런스', () => {
    const withLoanword = {
      text: '밸런스를 어떻게 맞출까요?',
      why_matters: '어디에 무게를 둘지 정합니다.',
      user_explanation: '무엇을 우선할지 정하는 질문이에요.',
      recommended_answer: '기본값을 추천합니다.',
    };
    const r = spawnDitto([
      'deep-interview',
      'check-question',
      '--json',
      JSON.stringify(withLoanword),
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { ok: boolean; loanword_advisory?: string[] };
    expect(out.ok).toBe(true);
    expect(out.loanword_advisory).toContain('밸런스');
  });

  test('clean candidate (no loanword) → empty loanword_advisory, exit 0', () => {
    const clean = {
      text: '비밀번호 해시는 무엇을 쓸까요?',
      why_matters: '저장 형식을 좌우합니다.',
      user_explanation: '비밀번호를 안전하게 저장하는 방식을 정하는 질문이에요.',
      recommended_answer: '기본값을 추천합니다.',
    };
    const r = spawnDitto([
      'deep-interview',
      'check-question',
      '--json',
      JSON.stringify(clean),
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { loanword_advisory?: string[] };
    expect(out.loanword_advisory).toEqual([]);
  });

  test('loanword INSIDE a code fence → NOT flagged (exemption preserved end-to-end)', () => {
    const fenced = {
      text: '이 코드에서 ```밸런스``` 변수를 어떻게 초기화할까요?',
      why_matters: '초기화 방식을 정합니다.',
      user_explanation: '변수를 어떻게 초기화할지 정하는 질문이에요.',
      recommended_answer: '기본값을 추천합니다.',
    };
    const r = spawnDitto([
      'deep-interview',
      'check-question',
      '--json',
      JSON.stringify(fenced),
      '--output',
      'json',
    ]);
    expect(r.exitCode).toBe(0);
    const out = JSON.parse(r.stdout) as { loanword_advisory?: string[] };
    expect(out.loanword_advisory).not.toContain('밸런스');
    expect(out.loanword_advisory).toEqual([]);
  });
});
