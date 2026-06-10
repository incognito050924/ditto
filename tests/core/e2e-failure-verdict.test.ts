import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendFailureVerdict,
  appendFlakyHistory,
  featureFixAllowed,
  readFailureVerdicts,
} from '~/core/e2e/failure-verdict';
import { parseJourneyDoc } from '~/core/e2e/journey-dsl';
import { e2eFailureVerdict } from '~/schemas/e2e-failure-verdict';

/**
 * wi_260610p9h ac-12 — feature-code fixes on an e2e failure are locked behind a
 * user-confirmed verdict. The ledger (`e2e-verdicts.jsonl`) only admits
 * `confirmed_by_user: true` records (literal — an unconfirmed verdict cannot
 * exist), and `featureFixAllowed` opens ONLY on classification '기능'.
 */

let repoRoot: string;
const WI = 'wi_test01';

beforeEach(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'ditto-e2e-verdict-'));
});
afterEach(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

function verdict(classification: '기능' | '스크립트' | '환경' | 'flaky') {
  return {
    journey_id: 'jrn-login',
    case_name: '정상 로그인',
    classification,
    confirmed_by_user: true as const,
    basis: '사용자 판정 근거',
    decided_at: '2026-06-11T00:00:00.000Z',
  };
}

describe('featureFixAllowed (ac-12: fix path locked until user verdict)', () => {
  test('no verdict recorded → allowed=false', async () => {
    const gate = await featureFixAllowed(repoRoot, WI, 'jrn-login', '정상 로그인');
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain('jrn-login');
  });

  test('unconfirmed verdict cannot be recorded at all (schema literal)', async () => {
    const bad = { ...verdict('기능'), confirmed_by_user: false };
    expect(e2eFailureVerdict.safeParse(bad).success).toBe(false);
    await expect(appendFailureVerdict(repoRoot, WI, bad as never)).rejects.toThrow();
    const gate = await featureFixAllowed(repoRoot, WI, 'jrn-login', '정상 로그인');
    expect(gate.allowed).toBe(false);
  });

  test('스크립트/환경/flaky verdicts → allowed=false', async () => {
    for (const c of ['스크립트', '환경', 'flaky'] as const) {
      await appendFailureVerdict(repoRoot, WI, verdict(c));
    }
    const gate = await featureFixAllowed(repoRoot, WI, 'jrn-login', '정상 로그인');
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain('flaky');
  });

  test('기능 verdict → allowed=true', async () => {
    await appendFailureVerdict(repoRoot, WI, verdict('기능'));
    const gate = await featureFixAllowed(repoRoot, WI, 'jrn-login', '정상 로그인');
    expect(gate.allowed).toBe(true);
    expect(gate.reason).toContain('기능');
  });

  test('기능 → 스크립트 재판정이 오면 잠금이 되돌아온다 (최신 판정 기준)', async () => {
    await appendFailureVerdict(repoRoot, WI, verdict('기능'));
    await appendFailureVerdict(repoRoot, WI, verdict('스크립트'));
    const gate = await featureFixAllowed(repoRoot, WI, 'jrn-login', '정상 로그인');
    expect(gate.allowed).toBe(false);
    expect(gate.reason).toContain('스크립트');
  });

  test('스크립트 → 기능 재판정이 오면 잠금이 풀린다 (최신 판정 기준)', async () => {
    await appendFailureVerdict(repoRoot, WI, verdict('스크립트'));
    await appendFailureVerdict(repoRoot, WI, verdict('기능'));
    const gate = await featureFixAllowed(repoRoot, WI, 'jrn-login', '정상 로그인');
    expect(gate.allowed).toBe(true);
  });

  test('기능 verdict for ANOTHER case does not open the gate for this one', async () => {
    await appendFailureVerdict(repoRoot, WI, { ...verdict('기능'), case_name: '다른 케이스' });
    const gate = await featureFixAllowed(repoRoot, WI, 'jrn-login', '정상 로그인');
    expect(gate.allowed).toBe(false);
  });

  test('ledger is append-only jsonl and round-trips through the schema', async () => {
    await appendFailureVerdict(repoRoot, WI, verdict('스크립트'));
    await appendFailureVerdict(repoRoot, WI, verdict('기능'));
    const raw = await readFile(
      join(repoRoot, '.ditto', 'local', 'work-items', WI, 'e2e-verdicts.jsonl'),
      'utf8',
    );
    expect(raw.trim().split('\n')).toHaveLength(2);
    const verdicts = await readFailureVerdicts(repoRoot, WI);
    expect(verdicts.map((v) => v.classification)).toEqual(['스크립트', '기능']);
  });
});

const JOURNEY = `---
ditto_journey: v1
id: jrn-login
name: 로그인 여정
description: 로그인 흐름 보호
surfaces:
  - "page:/login"
---

## 단계

1. [s1] 사용자가 /login에 간다
2. [s2] 사용자가 "로그인" 버튼을 누른다

본문은 한 바이트도 달라지면 안 된다.
`;

describe('appendFlakyHistory (flaky verdict → journey front-matter)', () => {
  test('adds a {date,case,note} entry and leaves the body byte-identical', async () => {
    const path = join(repoRoot, 'login.journey.md');
    await Bun.write(path, JOURNEY);
    await appendFlakyHistory(path, {
      date: '2026-06-11',
      case: '정상 로그인',
      note: '네트워크 지연 의심',
    });
    const next = await readFile(path, 'utf8');
    const parsed = parseJourneyDoc(next);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.frontMatter.flaky_history).toEqual([
      { date: '2026-06-11', case: '정상 로그인', note: '네트워크 지연 의심' },
    ]);
    expect(parsed.stepIds).toEqual(['s1', 's2']);
    // body unharmed: everything after the closing fence is identical
    const bodyOf = (text: string) => text.split('\n---\n').slice(1).join('\n---\n');
    expect(bodyOf(next)).toBe(bodyOf(JOURNEY));
  });

  test('second flake appends, never overwrites', async () => {
    const path = join(repoRoot, 'login.journey.md');
    await Bun.write(path, JOURNEY);
    await appendFlakyHistory(path, { date: '2026-06-10', case: 'a', note: 'n1' });
    await appendFlakyHistory(path, { date: '2026-06-11', case: 'b', note: 'n2' });
    const parsed = parseJourneyDoc(await readFile(path, 'utf8'));
    expect(parsed.ok && parsed.frontMatter.flaky_history.length).toBe(2);
  });
});
