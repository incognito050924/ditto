import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assembleCompletionFromGraph, deriveAcVerdicts } from '~/core/autopilot-complete';
import { probePlaywright, runJourney } from '~/core/e2e/browser';
import { type Autopilot, type AutopilotNode, autopilot } from '~/schemas/autopilot';
import type { WorkItem } from '~/schemas/work-item';

/**
 * AC-3 regression (wi_2606168oh, node n5-playwright-absent-regression).
 *
 * playwright-absent → the e2e axis comes back `blocked` (browser absent). This
 * pins what autopilot completion derives in that world, exercising the REAL
 * completion-derivation (assembleCompletionFromGraph / deriveAcVerdicts) and the
 * REAL absence→blocked precondition (probePlaywright / runJourney) — no mock of
 * the logic under test.
 *
 * CASE 1 — DoD≠e2e (route-around completes): the e2e node is blocked but axis-3
 * is N/A for this AC, so the e2e node does NOT carry the AC (covered_by axis-2/-1
 * per e2e/applicability.ts). A non-e2e verify node passed with runnable evidence
 * and closes the AC → final_verdict=pass. The blocked e2e node does not prevent
 * completion because another axis carries the AC.
 *
 * FALSE-GREEN GUARD (route-around semantics, made precise): the route-around is
 * "the e2e node does not claim the AC", NOT "a still-addressing blocked node is
 * silently ignored". A blocked e2e node that STILL lists the AC in its
 * acceptance_refs caps the AC at `unverified` even alongside a passing verify —
 * the worst-fold refuses to let a non-terminal addressing node be masked. This is
 * the protection that keeps a blocked browser run from being papered over.
 *
 * CASE 2 — DoD=e2e (honest unverified): the blocked e2e node is the ONLY node
 * addressing the AC (no other evidence). The worst-fold
 * (autopilot-complete.ts:26-27,51-58) lands it at `unverified` (a blocked node is
 * non-terminal → unverified, never `pass`) and final_verdict is NOT pass — an
 * honest unverified, not a fabricated pass.
 */

const NOW = new Date('2026-06-16T00:00:00.000Z');

const node = (over: Partial<AutopilotNode> & Pick<AutopilotNode, 'id'>): AutopilotNode => ({
  kind: 'verify',
  owner: 'verifier',
  purpose: 'verify',
  status: 'passed',
  depends_on: [],
  acceptance_refs: [],
  evidence_refs: [],
  ac_verdicts: [],
  attempts: { fix: 0, switch: 0 },
  ...over,
});

const graphWith = (nodes: AutopilotNode[]): Autopilot =>
  autopilot.parse({
    schema_version: '0.1.0',
    autopilot_id: 'orch_pwabsentreg',
    work_item_id: 'wi_pwabsentreg',
    root_goal: 'goal',
    approval_gate: { status: 'not_required', source: 'small_reversible_policy' },
    nodes,
    caps: { fix_per_node: 2, switch_per_node: 1, converge_rounds: 3 },
    continue_policy: {},
    stop_conditions: [],
  });

const workItemWith = (acIds: string[]): WorkItem =>
  ({
    id: 'wi_pwabsentreg',
    changed_files: ['src/x.ts'],
    goal: 'the goal',
    acceptance_criteria: acIds.map((id) => ({
      id,
      statement: `${id} is met`,
      verdict: 'unverified',
      evidence: [],
    })),
  }) as unknown as WorkItem;

const ev = (path: string) => ({ kind: 'file' as const, path, summary: `evidence ${path}` });

// A blocked e2e node: the exact graph shape a playwright-absent run produces
// (e2e/browser.ts runJourney → blockedJourney → status 'blocked' on the node).
const blockedE2eNode = (over: Partial<AutopilotNode> & Pick<AutopilotNode, 'id'>): AutopilotNode =>
  node({ kind: 'e2e', owner: 'playwright-e2e', status: 'blocked', evidence_refs: [], ...over });

describe('playwright-absent regression: autopilot completion derivation (ac-3)', () => {
  test('CASE 1 (DoD≠e2e): blocked e2e routes around → non-e2e axis closes the AC → final_verdict=pass', () => {
    // Route-around: axis-3 is N/A for this AC, so the blocked e2e node does NOT
    // claim it (acceptance_refs empty). A verify node passed with runnable evidence
    // and carries the AC.
    const graph = graphWith([
      blockedE2eNode({ id: 'E2E', acceptance_refs: [] }),
      node({
        id: 'V',
        kind: 'verify',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        evidence_refs: [ev('bun-test.log')],
      }),
    ]);

    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('pass'); // closed by the non-e2e axis

    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), { now: NOW });
    expect(c.acceptance.map((a) => a.verdict)).toEqual(['pass']);
    expect(c.final_verdict).toBe('pass'); // blocked e2e did NOT prevent completion
  });

  test('FALSE-GREEN GUARD: a blocked e2e node that STILL claims the AC caps it at unverified (no masked block)', () => {
    // The route-around is the e2e node NOT claiming the AC — NOT silently ignoring
    // a still-addressing blocked node. If the e2e node keeps ac-1 in its
    // acceptance_refs, the worst-fold caps the AC at unverified even though a verify
    // node passed with evidence: a non-terminal (blocked) addressing node is never
    // masked by a sibling pass. This is the false-green protection working.
    const graph = graphWith([
      blockedE2eNode({ id: 'E2E', acceptance_refs: ['ac-1'] }),
      node({
        id: 'V',
        kind: 'verify',
        acceptance_refs: ['ac-1'],
        status: 'passed',
        evidence_refs: [ev('bun-test.log')],
      }),
    ]);
    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    expect(v?.verdict).toBe('unverified'); // NOT pass — the blocked sibling caps it
    expect(v?.verdict).not.toBe('pass');
  });

  test('CASE 2 (DoD=e2e): a blocked-only AC derives an HONEST unverified (NOT a fabricated pass)', () => {
    // The blocked e2e node is the ONLY node addressing ac-1 — no other evidence.
    const graph = graphWith([blockedE2eNode({ id: 'E2E', acceptance_refs: ['ac-1'] })]);

    const [v] = deriveAcVerdicts(graph, ['ac-1']);
    // The worst-fold (SEVERITY/worst) lands a blocked-only AC at unverified: a
    // blocked node is non-terminal → unverified, and nothing raises it.
    expect(v?.verdict).toBe('unverified');
    // NON-VACUOUS: this is the line that would fail if completion fabricated a pass
    // for the DoD=e2e case.
    expect(v?.verdict).not.toBe('pass');

    const c = assembleCompletionFromGraph(graph, workItemWith(['ac-1']), { now: NOW });
    expect(c.final_verdict).not.toBe('pass'); // no fabrication when only e2e covers it
    expect(c.acceptance.find((a) => a.criterion_id === 'ac-1')?.verdict).toBe('unverified');
  });

  test('precondition: a no-browser session yields probe {available:false} and runJourney result=blocked', async () => {
    // The absence→blocked precondition, via the REAL functions. A fresh temp dir
    // has no playwright/cached Chromium, so the probe degrades and runJourney
    // returns a blocked journey — exactly what feeds the blocked e2e node above.
    const repoRoot = mkdtempSync(join(tmpdir(), 'pwabsentreg-'));
    const probe = await probePlaywright(repoRoot);
    expect(probe.available).toBe(false);

    const rj = await runJourney(repoRoot, 'run_pwabsentreg', {
      journey: 'smoke',
      url: 'https://example.com',
      steps: [{ action: 'goto', target: 'https://example.com' }],
      assertions: [{ description: 'page loads' }],
    });
    expect(rj.journey.result).toBe('blocked');
  });
});
