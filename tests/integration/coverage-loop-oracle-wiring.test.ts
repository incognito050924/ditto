import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextCoverageNode, recordCoverageRound } from '~/core/coverage-loop';
import { CoverageStore } from '~/core/coverage-store';
import { localDir } from '~/core/ditto-paths';
import { WorkItemStore } from '~/core/work-item-store';
import { oracleProvenance } from '~/schemas/coverage';

/**
 * wi_260706n4w n5 (ac-1 runtime / ac-6 additive-only): the coverage-round seam
 * routes disposition='code-verify' claims through the deterministic 2-mode
 * oracle (src/core/coverage-oracle.ts) ON THE RUNTIME SWEEP PATH — not in unit
 * isolation. Verdicts persist to the oracle-provenance.json sidecar
 * (relevance-provenance precedent) and the enforcement tier is applied to the
 * live round payload: a decidable-refuted claim in the risk tier
 * (injection/secret-exposure) blocks the close (fail-closed); every advisory
 * verdict — including tool_absent (ADR-0018, ac-7) — stays fail-open.
 *
 * The temp repo is a REAL git repo (git grep is the absence executor) with one
 * tracked file carrying a known token, so refuted-vs-confirmed is decided
 * against an actual working tree.
 */

let repo: string;
let WI: string;
const NOW = new Date('2026-06-01T00:00:00.000Z');

/** The token the tracked file really contains — an absence claim over it is fabricated. */
const REAL_TOKEN = 'dangerousEvalSinkToken';

function git(args: string[], cwd: string): void {
  const proc = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${proc.stderr.toString()}`);
  }
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'ditto-cov-oracle-'));
  git(['init', '-q'], repo);
  git(['config', 'user.email', 't@t'], repo);
  git(['config', 'user.name', 't'], repo);
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src', 'a.ts'), `export const ${REAL_TOKEN} = 1;\n`, 'utf8');
  git(['add', '-A'], repo);
  git(['commit', '-q', '-m', 'init'], repo);

  const wi = await new WorkItemStore(repo).create(
    {
      title: 'oracle wiring test',
      source_request: 'wire the oracle into the coverage round',
      goal: 'code-verify claims are oracle-checked at the runtime round seam',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'tier applies at runtime', verdict: 'unverified', evidence: [] },
      ],
    },
    NOW,
  );
  WI = wi.id;
  // Seed the category-complete tree so cov-cat-* nodes carry their dispositions.
  await nextCoverageNode({ repoRoot: repo, workItemId: WI, seedCategories: true });
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

const passingSignals = {
  neutrality: { opponent_ran: true, verdict: 'accept' as const },
};

async function readSidecar() {
  const raw = await Bun.file(join(localDir(repo, 'runs', WI), 'oracle-provenance.json')).text();
  return oracleProvenance.parse(JSON.parse(raw));
}

describe('coverage-round oracle wiring (ac-1 runtime path)', () => {
  test('a code-verify claim is routed through the oracle and its verdict persists to oracle-provenance.json', async () => {
    // boundary-edge: code-verify disposition, NON-risk tier. Confirmed absence.
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: 'cov-cat-boundary-edge',
        admissibleBranchesAdded: 0,
        close_as: 'resolved',
        derived_nodes: [],
        discovered_nodes: [],
        axis_signals: passingSignals,
      },
      oracleClaims: [
        {
          claim_id: 'clm-absent-ok',
          category_id: 'boundary-edge',
          claim: { mode: 'absence', pattern: 'zz_never_present_zz', scope_path: 'src' },
        },
      ],
    });
    expect(r.terminated).toBe(false);
    if (r.terminated) return;
    expect(r.closed).toBe(true); // confirmed claim never blocks

    const sidecar = await readSidecar();
    expect(sidecar.oracle_verdicts).toHaveLength(1);
    expect(sidecar.oracle_verdicts[0]?.claim_id).toBe('clm-absent-ok');
    expect(sidecar.oracle_verdicts[0]?.outcome).toBe('confirmed');
    expect(sidecar.oracle_verdicts[0]?.tier).toBe('advisory');
    expect(sidecar.tally.oracle.confirmed).toBe(1);
    expect(sidecar.tally.claims).toBe(1);
  });
});

describe('runtime tier enforcement (ac-1)', () => {
  test('a REFUTED risk-tier (injection) claim hard-rejects the close — node stays open on disk', async () => {
    // Fabricated absence claim: the tracked file REALLY contains REAL_TOKEN.
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: 'cov-cat-injection',
        admissibleBranchesAdded: 0,
        close_as: 'resolved',
        derived_nodes: [],
        discovered_nodes: [],
        axis_signals: passingSignals,
      },
      oracleClaims: [
        {
          claim_id: 'clm-fabricated',
          category_id: 'injection',
          claim: { mode: 'absence', pattern: REAL_TOKEN, scope_path: 'src' },
        },
      ],
    });
    expect(r.terminated).toBe(false);
    if (r.terminated) return;
    expect(r.closed).toBe(false); // fail-closed: the verdict changed the round result
    expect(r.reasons.some((x) => x.includes('oracle hard-rejected'))).toBe(true);
    expect(r.reasons.some((x) => x.includes('clm-fabricated'))).toBe(true);

    // The node really stayed open on disk (runtime artifact, not just the result).
    const map = await new CoverageStore(repo).getMap(WI);
    expect(map.nodes.find((n) => n.id === 'cov-cat-injection')?.state).toBe('open');

    // The hard verdict persisted as evidence: refuted + hard_reject + exit 0.
    const sidecar = await readSidecar();
    const v = sidecar.oracle_verdicts.find((x) => x.claim_id === 'clm-fabricated');
    expect(v?.outcome).toBe('refuted');
    expect(v?.tier).toBe('hard_reject');
    expect(v?.exit_code).toBe(0);
  });

  test('a REFUTED non-risk claim stays advisory — the close proceeds (fail-open)', async () => {
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: 'cov-cat-boundary-edge',
        admissibleBranchesAdded: 0,
        close_as: 'resolved',
        derived_nodes: [],
        discovered_nodes: [],
        axis_signals: passingSignals,
      },
      oracleClaims: [
        {
          claim_id: 'clm-nonrisk-refuted',
          category_id: 'boundary-edge',
          claim: { mode: 'absence', pattern: REAL_TOKEN, scope_path: 'src' },
        },
      ],
    });
    expect(r.terminated).toBe(false);
    if (r.terminated) return;
    expect(r.closed).toBe(true); // advisory never gates
    const sidecar = await readSidecar();
    const v = sidecar.oracle_verdicts.find((x) => x.claim_id === 'clm-nonrisk-refuted');
    expect(v?.outcome).toBe('refuted');
    expect(v?.tier).toBe('advisory');
  });
});

describe('fail-open degradations + routing (ac-7 / ADR-0018)', () => {
  test('tool_absent (missing git binary) degrades to advisory and does NOT block the close', async () => {
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: 'cov-cat-injection',
        admissibleBranchesAdded: 0,
        close_as: 'resolved',
        derived_nodes: [],
        discovered_nodes: [],
        axis_signals: passingSignals,
      },
      oracleClaims: [
        {
          claim_id: 'clm-toolless',
          category_id: 'injection', // even in the RISK tier: no tool → advisory, never a gate
          claim: { mode: 'absence', pattern: REAL_TOKEN, scope_path: 'src' },
        },
      ],
      oracleExec: { gitBin: '/nonexistent/ditto-test-git' },
    });
    expect(r.terminated).toBe(false);
    if (r.terminated) return;
    expect(r.closed).toBe(true); // ADR-0018: tool absence never blocks intent realization
    const sidecar = await readSidecar();
    const v = sidecar.oracle_verdicts.find((x) => x.claim_id === 'clm-toolless');
    expect(v?.outcome).toBe('advisory_unverified');
    expect(v?.advisory_reason).toBe('tool_absent');
  });

  test('a user-intent claim is NOT oracle-routed: no verdict, no sidecar', async () => {
    // authorization-model carries disposition 'user-intent' on the seeded node;
    // a claim without category_id inherits the round node's route (ancestor walk).
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: 'cov-cat-authorization-model',
        admissibleBranchesAdded: 0,
        derived_nodes: [],
        discovered_nodes: [],
      },
      oracleClaims: [
        {
          claim_id: 'clm-explicit-ui',
          category_id: 'authorization-model',
          claim: { mode: 'absence', pattern: REAL_TOKEN, scope_path: 'src' },
        },
        {
          claim_id: 'clm-inherited-ui',
          claim: { mode: 'absence', pattern: REAL_TOKEN, scope_path: 'src' },
        },
      ],
    });
    expect(r.terminated).toBe(false);
    const exists = await Bun.file(
      join(localDir(repo, 'runs', WI), 'oracle-provenance.json'),
    ).exists();
    expect(exists).toBe(false); // nothing routed ⇒ no ENFORCE record (no gate = no record)
  });

  test('a round WITHOUT oracleClaims writes no sidecar (additive-only, ac-6)', async () => {
    const r = await recordCoverageRound({
      repoRoot: repo,
      workItemId: WI,
      payload: {
        node_id: 'cov-cat-boundary-edge',
        admissibleBranchesAdded: 0,
        derived_nodes: [],
        discovered_nodes: [],
      },
    });
    expect(r.terminated).toBe(false);
    const exists = await Bun.file(
      join(localDir(repo, 'runs', WI), 'oracle-provenance.json'),
    ).exists();
    expect(exists).toBe(false);
  });
});

describe('sidecar merge semantics across rounds', () => {
  test('new claim_ids append; a re-evaluated claim_id REPLACES its verdict; tally is recomputed', async () => {
    const round = (claimId: string, pattern: string) =>
      recordCoverageRound({
        repoRoot: repo,
        workItemId: WI,
        payload: {
          node_id: 'cov-cat-boundary-edge',
          admissibleBranchesAdded: 0,
          derived_nodes: [],
          discovered_nodes: [],
        },
        oracleClaims: [
          {
            claim_id: claimId,
            category_id: 'boundary-edge',
            claim: { mode: 'absence', pattern, scope_path: 'src' },
          },
        ],
      });

    await round('clm-a', 'zz_absent_a_zz'); // confirmed
    await round('clm-b', REAL_TOKEN); // refuted (advisory tier)
    let sidecar = await readSidecar();
    expect(sidecar.oracle_verdicts).toHaveLength(2);
    expect(sidecar.tally).toEqual({
      claims: 2,
      oracle: { confirmed: 1, refuted: 1, advisory_unverified: 0 },
      labeler: { real: 0, fabricated: 0 },
    });

    // Re-evaluate clm-b with a now-absent pattern: replaced, not double-counted.
    await round('clm-b', 'zz_absent_b_zz');
    sidecar = await readSidecar();
    expect(sidecar.oracle_verdicts).toHaveLength(2);
    expect(sidecar.oracle_verdicts.find((v) => v.claim_id === 'clm-b')?.outcome).toBe('confirmed');
    expect(sidecar.tally.oracle).toEqual({ confirmed: 2, refuted: 0, advisory_unverified: 0 });
  });
});
