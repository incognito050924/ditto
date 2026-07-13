/**
 * 2-mode deterministic coverage oracle (wi_260706n4w n4, ac-1/ac-7).
 *
 * presence = the cited file:line really exists; absence = "pattern does not
 * occur under scope_path", refute-or-confirm via `git grep`. No LLM judgment
 * inside the oracle. Claims are UNTRUSTED LLM output: the shape gate + argv
 * exec (-F, -e binding, `--` pathspec cut, containment) is the trust boundary.
 *
 * Fixtures are real git repos under os.tmpdir (git grep searches TRACKED
 * files, so fixture files are committed).
 *
 * Empirical divergence from the design contract (probed 2026-07-07, git on
 * this host): `git grep -F -e tok -- no/such/path` and `-- ':(exclude)*'`
 * BOTH exit 1 (no-match), not >=2 — so a fabricated / exclude-magic scope
 * would coerce to CONFIRMED absent through the exit 3-branch alone. The
 * executor therefore (a) rejects `:`-leading scope_path (pathspec magic) at
 * the shape gate and (b) requires scope_path to exist under repoRoot before
 * exec; both route to advisory, never to a hard verdict.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  correlateFabrication,
  enforcementTierForCategory,
  evaluateOracleClaim,
  isHardRejected,
  runAbsenceCheck,
} from '~/core/coverage-oracle';
import { type OracleClaim, oracleVerdict } from '~/schemas/coverage';

let repoRoot: string;

function git(args: string[], cwd: string): void {
  const proc = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${proc.stderr?.toString()}`);
  }
}

// 5 content lines + trailing newline. Contains `dangerousEval` (refute target)
// and a literal `-rf` (leading-dash fixed-string probe). Deliberately NO
// literal `.*` anywhere (the -F regex-neutralization probe relies on it).
const FILE_A = [
  'export const one = 1;',
  'const dangerousEval = 1;',
  '// flag -rf literal',
  'export const four = 4;',
  'export const five = 5;',
].join('\n');

beforeAll(async () => {
  repoRoot = await mkdtemp(join(tmpdir(), 'ditto-oracle-'));
  git(['init', '-q'], repoRoot);
  git(['config', 'user.email', 't@t'], repoRoot);
  git(['config', 'user.name', 't'], repoRoot);
  await mkdir(join(repoRoot, 'src', 'sub'), { recursive: true });
  await writeFile(join(repoRoot, 'src', 'a.ts'), `${FILE_A}\n`, 'utf8');
  await writeFile(join(repoRoot, 'src', 'sub', 'b.ts'), 'export const subOnly = 2;\n', 'utf8');
  git(['add', '-A'], repoRoot);
  git(['commit', '-q', '-m', 'init'], repoRoot);
});

afterAll(async () => {
  await rm(repoRoot, { recursive: true, force: true });
});

const absence = (pattern: string, scope_path: string): OracleClaim => ({
  mode: 'absence',
  pattern,
  scope_path,
});

const evaluate = (claim: OracleClaim, category_id?: string) =>
  evaluateOracleClaim(
    { claim_id: 'c1', ...(category_id !== undefined ? { category_id } : {}), claim },
    repoRoot,
  );

describe('absence mode — exit 3-way branch (ac-1)', () => {
  test('pattern truly absent in scope → exit 1 → confirmed', () => {
    const v = evaluate(absence('zzz_never_present_zzz', 'src'));
    expect(v.outcome).toBe('confirmed');
    expect(v.exit_code).toBe(1);
  });

  test('claimed-absent pattern actually present → exit 0 → refuted (fabricated claim)', () => {
    const v = evaluate(absence('dangerousEval', 'src'));
    expect(v.outcome).toBe('refuted');
    expect(v.exit_code).toBe(0);
  });

  test('scope narrows the check: token present in src but not src/sub → confirmed', () => {
    const v = evaluate(absence('dangerousEval', 'src/sub'));
    expect(v.outcome).toBe('confirmed');
  });

  test('nonexistent scope_path is NEVER coerced to confirmed-absent → advisory', () => {
    // Probed: git grep exits 1 (no-match) on a nonexistent pathspec, so the
    // exit branch alone would false-confirm; the executor must catch it first.
    const v = evaluate(absence('anything', 'does/not/exist'));
    expect(v.outcome).toBe('advisory_unverified');
    expect(v.advisory_reason).toBe('shape_gate');
  });
});

describe('absence mode — runAbsenceCheck executor', () => {
  test('3-way: no-match → confirmed_absent, match → refuted_present', () => {
    expect(runAbsenceCheck('zzz_never_present_zzz', 'src', repoRoot).kind).toBe('confirmed_absent');
    expect(runAbsenceCheck('dangerousEval', 'src', repoRoot).kind).toBe('refuted_present');
  });

  test('shape gate lives INSIDE the executor: whitespace pattern never execs', () => {
    const r = runAbsenceCheck('no eval anywhere', 'src', repoRoot);
    expect(r.kind).toBe('shape_rejected');
  });
});

const presence = (maps_to: string): OracleClaim => ({ mode: 'presence', maps_to });

describe('presence mode — cited file:line really exists (ac-1)', () => {
  test('existing file + existing line → confirmed', () => {
    expect(evaluate(presence('src/a.ts:3')).outcome).toBe('confirmed');
  });

  test('last line of a trailing-newline file counts as existing', () => {
    expect(evaluate(presence('src/a.ts:5')).outcome).toBe('confirmed');
  });

  test('line beyond EOF → refuted (fabricated citation)', () => {
    expect(evaluate(presence('src/a.ts:6')).outcome).toBe('refuted');
  });

  test('line 0 never exists → refuted', () => {
    expect(evaluate(presence('src/a.ts:0')).outcome).toBe('refuted');
  });

  test('cited file does not exist → refuted', () => {
    expect(evaluate(presence('src/missing.ts:1')).outcome).toBe('refuted');
  });

  test('in-bounds line range N-M → confirmed', () => {
    expect(evaluate(presence('src/a.ts:2-4')).outcome).toBe('confirmed');
  });

  test('reversed range is malformed, not decidable → advisory shape_gate', () => {
    const v = evaluate(presence('src/a.ts:4-2'));
    expect(v.outcome).toBe('advisory_unverified');
    expect(v.advisory_reason).toBe('shape_gate');
  });

  test('non-numeric suffix (path:symbol) is not line-checkable → advisory shape_gate', () => {
    const v = evaluate(presence('src/a.ts:dangerousEval'));
    expect(v.outcome).toBe('advisory_unverified');
    expect(v.advisory_reason).toBe('shape_gate');
  });

  test('prose citation fails the codePointerMapsTo grammar → advisory shape_gate', () => {
    const v = evaluate(presence('the file exists somewhere'));
    expect(v.outcome).toBe('advisory_unverified');
    expect(v.advisory_reason).toBe('shape_gate');
  });

  test('path traversal / absolute citation is contained → advisory shape_gate', () => {
    for (const mapsTo of ['../outside.ts:1', '/tmp/x.ts:1']) {
      const v = evaluate(presence(mapsTo));
      expect(v.outcome).toBe('advisory_unverified');
      expect(v.advisory_reason).toBe('shape_gate');
    }
  });
});

describe('risk tier — injection/secret fail closed on decidable-refuted (ac-1)', () => {
  test('injection category + refuted absence → hard_reject, isHardRejected', () => {
    const v = evaluate(absence('dangerousEval', 'src'), 'injection');
    expect(v.outcome).toBe('refuted');
    expect(v.tier).toBe('hard_reject');
    expect(isHardRejected(v)).toBe(true);
  });

  test('cov-cat- prefixed secret-exposure category also maps to hard_reject', () => {
    const v = evaluate(absence('dangerousEval', 'src'), 'cov-cat-secret-exposure');
    expect(v.tier).toBe('hard_reject');
    expect(isHardRejected(v)).toBe(true);
  });

  test('risk-tier CONFIRMED claim is not hard-rejected', () => {
    const v = evaluate(absence('zzz_never_present_zzz', 'src'), 'injection');
    expect(v.outcome).toBe('confirmed');
    expect(isHardRejected(v)).toBe(false);
  });

  test('non-decidable claim is advisory regardless of tier (shape gate first)', () => {
    const v = evaluate(absence('no eval anywhere in src', 'src'), 'injection');
    expect(v.outcome).toBe('advisory_unverified');
    expect(v.advisory_reason).toBe('shape_gate');
    expect(isHardRejected(v)).toBe(false);
  });

  test('non-risk category refuted claim stays advisory-tier', () => {
    const v = evaluate(absence('dangerousEval', 'src'), 'observability');
    expect(v.outcome).toBe('refuted');
    expect(v.tier).toBe('advisory');
    expect(isHardRejected(v)).toBe(false);
  });

  test('enforcementTierForCategory: no category → advisory', () => {
    expect(enforcementTierForCategory(undefined)).toBe('advisory');
    expect(enforcementTierForCategory('injection')).toBe('hard_reject');
    expect(enforcementTierForCategory('secret-exposure')).toBe('hard_reject');
    expect(enforcementTierForCategory('compat-version')).toBe('advisory');
  });
});

describe('injection defense — claim is untrusted LLM output (argv + -F + -e + -- + containment)', () => {
  test('leading-dash pattern is bound by -e, treated as a fixed string (present → refuted, not a flag error)', () => {
    const v = evaluate(absence('-rf', 'src'));
    expect(v.outcome).toBe('refuted');
    expect(v.exit_code).toBe(0);
  });

  test('flag-shaped absent pattern (--help) execs as data → confirmed, not intercepted as an option', () => {
    const v = evaluate(absence('--help', 'src'));
    expect(v.outcome).toBe('confirmed');
    expect(v.exit_code).toBe(1);
  });

  test('regex metas are inert under -F: ".*" as a fixed string is absent → confirmed', () => {
    // As a REGEX `.*` would match every line (refuted); fixed-string search
    // confirms absence — this pins the -F guarantee.
    const v = evaluate(absence('.*', 'src'));
    expect(v.outcome).toBe('confirmed');
  });

  test('shell-metachar pattern is a plain argv word (no shell ever runs) → confirmed', () => {
    const v = evaluate(absence('x";`id`;$(reboot)"', 'src'));
    expect(v.outcome).toBe('confirmed');
  });

  test('path/arg escape attempts in scope_path are contained → advisory shape_gate', () => {
    for (const scope of ['../secrets', '/etc', ':(exclude)*', ':/']) {
      const v = evaluate(absence('token', scope));
      expect(v.outcome).toBe('advisory_unverified');
      expect(v.advisory_reason).toBe('shape_gate');
    }
  });

  test('oversized pattern is rejected by the shape gate (length cap)', () => {
    const v = evaluate(absence('x'.repeat(201), 'src'));
    expect(v.outcome).toBe('advisory_unverified');
    expect(v.advisory_reason).toBe('shape_gate');
  });
});

describe('tool-absent degradation (ac-7, ADR-0018)', () => {
  test('missing git binary → advisory_unverified/tool_absent, never a hard verdict', () => {
    const v = evaluateOracleClaim(
      { claim_id: 'c1', category_id: 'injection', claim: absence('dangerousEval', 'src') },
      repoRoot,
      { gitBin: '/nonexistent/ditto-oracle-git' },
    );
    expect(v.outcome).toBe('advisory_unverified');
    expect(v.advisory_reason).toBe('tool_absent');
    // Even in the risk tier, tool absence must not fail closed into a reject
    // (a missing optional tool cannot block intent realization).
    expect(isHardRejected(v)).toBe(false);
  });
});

describe('fabrication correlation — deterministic CORRELATE slot (ac-5, n9)', () => {
  test('empty sets → zero counts and NULL rates (0/0 is unmeasurable, never 0%)', () => {
    const c = correlateFabrication([], []);
    expect(c.oracle).toEqual({ claims: 0, confirmed: 0, refuted: 0, advisory_unverified: 0 });
    expect(c.labeler).toEqual({ claims: 0, real: 0, fabricated: 0 });
    expect(c.joint.pairs).toBe(0);
    expect(c.unmatched).toEqual({ oracle_only: 0, labeler_only: 0 });
    expect(c.rates.oracle_fabrication_rate).toBeNull();
    expect(c.rates.labeler_fabrication_rate).toBeNull();
    expect(c.rates.decidable_agreement_rate).toBeNull();
  });

  const oVerdict = (
    claim_id: string,
    outcome: 'confirmed' | 'refuted' | 'advisory_unverified',
  ): Parameters<typeof correlateFabrication>[0][number] => ({
    claim_id,
    claim: absence('tok', 'src'),
    outcome,
    tier: 'advisory',
    ...(outcome === 'advisory_unverified' ? { advisory_reason: 'shape_gate' as const } : {}),
  });
  const lLabel = (
    claim_id: string,
    label: 'real' | 'fabricated',
  ): Parameters<typeof correlateFabrication>[1][number] => ({ claim_id, label });

  test('joins the two independent sets on claim_id into the contingency matrix + rates', () => {
    const c = correlateFabrication(
      [
        oVerdict('c1', 'confirmed'),
        oVerdict('c2', 'refuted'),
        oVerdict('c3', 'refuted'),
        oVerdict('c4', 'advisory_unverified'),
        oVerdict('c5', 'confirmed'), // unlabeled → oracle_only
      ],
      [
        lLabel('c1', 'real'),
        lLabel('c2', 'fabricated'),
        lLabel('c3', 'real'),
        lLabel('c4', 'fabricated'),
      ],
    );
    expect(c.oracle).toEqual({ claims: 5, confirmed: 2, refuted: 2, advisory_unverified: 1 });
    expect(c.labeler).toEqual({ claims: 4, real: 2, fabricated: 2 });
    expect(c.joint).toEqual({
      pairs: 4,
      confirmed_real: 1,
      confirmed_fabricated: 0,
      refuted_real: 1,
      refuted_fabricated: 1,
      advisory_real: 0,
      advisory_fabricated: 1,
    });
    expect(c.unmatched).toEqual({ oracle_only: 1, labeler_only: 0 });
    // oracle: 2 refuted / 4 decidable; labeler: 2 fabricated / 4 labeled.
    expect(c.rates.oracle_fabrication_rate).toBe(0.5);
    expect(c.rates.labeler_fabrication_rate).toBe(0.5);
    // decidable joint pairs = c1, c2, c3 (advisory c4 excluded); agree on c1 + c2.
    expect(c.rates.decidable_agreement_rate).toBeCloseTo(2 / 3);
  });

  test('duplicate claim_id last-wins in BOTH sets (mirrors the sidecar claim_id merge)', () => {
    const c = correlateFabrication(
      [oVerdict('c1', 'confirmed'), oVerdict('c1', 'refuted')],
      [lLabel('c1', 'real'), lLabel('c1', 'fabricated')],
    );
    expect(c.oracle).toEqual({ claims: 1, confirmed: 0, refuted: 1, advisory_unverified: 0 });
    expect(c.labeler).toEqual({ claims: 1, real: 0, fabricated: 1 });
    expect(c.joint.pairs).toBe(1);
    expect(c.joint.refuted_fabricated).toBe(1);
  });

  test('a label with no matching verdict stays visible as labeler_only (blind-spot guard)', () => {
    // A claim self-declaring a user-intent category bypasses the oracle and never
    // lands in the sidecar — a label outside the ENFORCE set is an anomaly the
    // measurement must surface, never silently drop.
    const c = correlateFabrication([], [lLabel('ghost', 'fabricated')]);
    expect(c.unmatched).toEqual({ oracle_only: 0, labeler_only: 1 });
    expect(c.joint.pairs).toBe(0);
    expect(c.rates.oracle_fabrication_rate).toBeNull();
    expect(c.rates.labeler_fabrication_rate).toBe(1);
  });
});

describe('verdicts satisfy the schema layer (ADR-0002 — no local reshaping)', () => {
  test('confirmed / refuted / every advisory variant parse as oracleVerdict', () => {
    const verdicts = [
      evaluate(absence('zzz_never_present_zzz', 'src'), 'injection'),
      evaluate(absence('dangerousEval', 'src'), 'injection'),
      evaluate(absence('no eval anywhere', 'src')),
      evaluate(presence('src/a.ts:3')),
      evaluate(presence('src/missing.ts:1')),
      evaluateOracleClaim({ claim_id: 'c9', claim: absence('tok', 'src') }, repoRoot, {
        gitBin: '/nonexistent/ditto-oracle-git',
      }),
    ];
    for (const v of verdicts) {
      expect(oracleVerdict.safeParse(v).success).toBe(true);
    }
  });
});
