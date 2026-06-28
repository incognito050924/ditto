import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AutopilotDecision, AutopilotStore } from '~/core/autopilot-store';
import { createFakeGhClient } from '~/core/gh-client';
import { postUnpostedDecisions } from '~/core/github-progress';
import { buildPublicSafeSummary, sanitizeFragment } from '~/core/github-redaction';
import { reflectTermination } from '~/core/github-reflection';
import { WorkItemStore } from '~/core/work-item-store';
import type { DittoConfigGithub } from '~/schemas/ditto-config';
import type { WorkItem } from '~/schemas/work-item';

// impl-redaction node (wi_260628d79, M9 — ac-15). EVERY external write routes through
// the allow-list redaction layer in github-redaction.ts. The public-safe body is
// CONSTRUCTED from only the safe fields (commit SHA, per-AC verdict, 1-line summary);
// internal absolute paths are relativized, raw failure logs + internal wi ids are not
// emitted. Asserted on the body actually handed to the FAKE gh-client.

const REPO = '/Users/x/dev/repo';
const ABS = `${REPO}/src/foo.ts`;
const RAW_LOG = 'Error: boom\n  at frame1\n  at frame2';
const SHA = 'a'.repeat(40);

describe('ac-15: redaction unit — allow-list construction + fragment hardening', () => {
  test('buildPublicSafeSummary INCLUDES sha + per-AC verdict + 1-line summary', () => {
    const body = buildPublicSafeSummary({
      summaryLine: 'Add retry to fetch',
      sha: SHA,
      finalVerdict: 'pass',
      acVerdicts: [
        { id: 'ac-1', verdict: 'pass' },
        { id: 'ac-2', verdict: 'fail' },
      ],
      repoRoot: REPO,
    });
    expect(body).toContain(SHA);
    expect(body).toContain('ac-1 [pass]');
    expect(body).toContain('ac-2 [fail]');
    expect(body).toContain('Add retry to fetch');
  });

  test('buildPublicSafeSummary EXCLUDES wi id, relativizes abs path, drops raw log', () => {
    const body = buildPublicSafeSummary({
      summaryLine: `fixed ${ABS} for wi_260628d79\n${RAW_LOG}`,
      sha: SHA,
      acVerdicts: [{ id: 'ac-1', verdict: 'pass' }],
      repoRoot: REPO,
    });
    expect(body).not.toContain('wi_260628d79');
    expect(body).not.toContain(ABS);
    expect(body).toContain('src/foo.ts');
    expect(body).not.toContain('frame1');
    expect(body).not.toContain('frame2');
  });

  test('sanitizeFragment scrubs a leaked token (defense-in-depth)', () => {
    const tok = `ghp_${'A'.repeat(36)}`;
    const out = sanitizeFragment(`leaked ${tok} here`, REPO);
    expect(out).not.toContain('gh' + 'p_');
    expect(out).toContain('[redacted]');
  });
});

// ── integration: both callers route their external-write body through redaction ──

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: 'wi_260628d79',
    title: `Add retry at ${ABS}`,
    goal: 'goal',
    status: 'done',
    started_at_sha: SHA,
    acceptance_criteria: [
      { id: 'ac-1', statement: 'fetch retries', verdict: 'pass', evidence: [] },
    ],
    github_issue: { repo: 'owner/app', number: 42 },
    ...overrides,
  } as unknown as WorkItem;
}

function cfg(): DittoConfigGithub {
  return {
    project: { owner: 'owner', number: 5, node_id: 'PVT_p' },
    status_map: { done: 'opt_done', abandoned: 'opt_dropped' },
    auto_reflect: true,
  };
}

describe('ac-15: github-reflection routes the completion comment through redaction', () => {
  test('posted body keeps SHA + verdict, relativizes the abs path, drops the wi id', () => {
    const { client, calls } = createFakeGhClient();
    reflectTermination({ client, config: cfg() }, { workItem: workItem(), trigger: 'done' });
    const comment = calls.find((c) => c.method === 'issueComment');
    const body = String(comment?.args[2]);
    expect(body).toContain(SHA);
    expect(body).toContain('ac-1 [pass]');
    expect(body).not.toContain(ABS); // internal absolute path relativized away
    expect(body).toContain('foo.ts'); // reduced to basename (path outside cwd)
    expect(body).not.toContain('/Users/x/dev'); // no internal dir prefix leaks
    expect(body).not.toContain('wi_260628d79');
  });
});

describe('ac-15: github-progress routes the decision rollup through redaction', () => {
  let dir: string;
  let wis: WorkItemStore;
  let aps: AutopilotStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ditto-ghred-'));
    await mkdir(join(dir, '.ditto'), { recursive: true });
    wis = new WorkItemStore(dir);
    aps = new AutopilotStore(dir);
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('a decision reason carrying an abs path + raw log is relativized + log-stripped', async () => {
    const created = await wis.create({
      title: 'wi',
      source_request: 'req',
      goal: 'goal',
      acceptance_criteria: [
        { id: 'ac-1', statement: 'x is observable', verdict: 'unverified', evidence: [] },
      ],
    });
    await wis.update(created.id, (cur) => ({
      ...cur,
      github_issue: { repo: 'owner/app', number: 42 },
    }));
    const decision: AutopilotDecision = {
      ts: '2026-06-28T00:00:00.000Z',
      node_id: 'N1',
      failure_class: 'user_decision_needed',
      decision: 'escalate',
      reason: `blocked at ${ABS}\n${RAW_LOG}`,
    };
    await aps.appendDecision(created.id, decision);
    const { client, calls } = createFakeGhClient();
    const res = await postUnpostedDecisions({ client, store: wis, aps }, created.id);
    expect(res.kind).toBe('posted');
    const body = String(calls[0]?.args[2]);
    expect(body).toContain('foo.ts'); // relativized to basename
    expect(body).not.toContain(ABS); // raw absolute path not emitted
    expect(body).not.toContain('/Users/x/dev'); // no internal dir prefix leaks
    expect(body).not.toContain('frame1'); // raw failure-log tail dropped
  });
});
